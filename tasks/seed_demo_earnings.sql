-- Demo earnings for ONE account, so the Earnings screen can be looked at with
-- something in it. Written 2026-09-10 at the owner's request.
--
-- THIS IS NOT REAL MONEY AND MUST NOT BE LEFT LYING AROUND. payout_item is the
-- table a real disbursement rail will one day read. Rows seeded here would be
-- indistinguishable from genuine obligations to anything that starts consuming
-- it later, so run the rollback at the bottom once you have seen the screen.
--
-- Everything written is tagged:
--   * payout_item.idempotency_key starts with 'demo-earnings-'
--   * any payout_cycle created here has holiday_source_version = 'demo-seed'
-- which is what lets the rollback remove exactly this and nothing else.
--
-- Safe to re-run: every insert is ON CONFLICT DO NOTHING against those keys.

do $$
declare
  v_email     text := 'jiayutee97@gmail.com';   -- the account to seed
  v_worker    uuid;
  v_cycle     uuid;
  v_month     date;
  v_inserted  int  := 0;
  v_row       record;
  -- amount, how many months back, status, error_message
  v_plan constant text[][] := array[
    ['420.00', '4', 'processed_internal', null],
    ['275.50', '3', 'processed_internal', null],
    ['610.00', '2', 'processed_internal', null],
    ['180.00', '1', 'processed_internal', null],
    ['345.00', '0', 'ready',              null],
    ['128.00', '0', 'held',               'worker_banking_not_verified']
  ];
begin
  select id into v_worker from auth.users where lower(email) = lower(v_email);
  if v_worker is null then
    raise exception
      'No account with email %. Nothing was written. Check the address, or sign up first.', v_email;
  end if;
  raise notice 'Seeding demo earnings for % (%)', v_email, v_worker;

  for i in 1 .. array_length(v_plan, 1) loop
    v_month := date_trunc('month', current_date) - ((v_plan[i][2])::int * interval '1 month');

    -- One cycle per month. Reuse a real one if it exists -- only tag cycles this
    -- script actually creates, so the rollback can never delete a real one.
    select id into v_cycle from public.payout_cycle
     where cycle_month = to_char(v_month, 'YYYY-MM');

    if v_cycle is null then
      insert into public.payout_cycle
        (cycle_month, nominal_pay_date, adjusted_pay_date, adjustment_reason,
         holiday_source_version, status)
      values
        (to_char(v_month, 'YYYY-MM'),
         (v_month + interval '1 month - 1 day')::date,
         (v_month + interval '1 month - 1 day')::date,
         'none', 'demo-seed', 'draft')
      returning id into v_cycle;
    end if;

    insert into public.payout_item
      (payout_cycle_id, worker_id, amount, currency, scheduled_date, status,
       source_refs, idempotency_key, error_message, processed_at)
    values
      (v_cycle, v_worker, (v_plan[i][1])::numeric, 'MYR',
       (v_month + interval '1 month - 1 day')::date,
       v_plan[i][3],
       jsonb_build_object('reason', 'shift_completed', 'demo', true),
       'demo-earnings-' || v_worker::text || '-' || i::text,
       v_plan[i][4],
       case when v_plan[i][3] = 'processed_internal'
            then (v_month + interval '1 month - 1 day')::timestamptz
            else null end)
    on conflict (idempotency_key) do nothing;

    if found then v_inserted := v_inserted + 1; end if;
  end loop;

  raise notice '% payout_item row(s) inserted (0 means they were already there).', v_inserted;

  for v_row in
    select status, count(*) n, sum(amount) total
      from public.payout_item
     where worker_id = v_worker and idempotency_key like 'demo-earnings-%'
     group by status order by status
  loop
    raise notice '  %  x%  RM %', rpad(v_row.status, 20), v_row.n, v_row.total;
  end loop;
end $$;

-- What the account now shows. The Earnings screen sums these into its hero
-- figure, counts 'ready' and 'held' into their own tiles, and groups the list
-- under month headers from scheduled_date.
select
  to_char(scheduled_date, 'YYYY-MM')          as month,
  status,
  amount,
  coalesce(error_message, '—')                as hold_reason
from public.payout_item
where idempotency_key like 'demo-earnings-%'
  and worker_id = (select id from auth.users where lower(email) = lower('jiayutee97@gmail.com'))
order by scheduled_date;

-- ── ROLLBACK — run this once you have seen the screen ───────────────────────
-- Removes exactly what the block above created and nothing else: the payout
-- items by their tagged key, then only those cycles this script created that no
-- other row still points at.
--
-- do $$
-- declare v_worker uuid;
-- begin
--   select id into v_worker from auth.users where lower(email) = lower('jiayutee97@gmail.com');
--   delete from public.payout_item
--    where worker_id = v_worker and idempotency_key like 'demo-earnings-%';
--   delete from public.payout_cycle c
--    where c.holiday_source_version = 'demo-seed'
--      and not exists (select 1 from public.payout_item p where p.payout_cycle_id = c.id);
--   raise notice 'Demo earnings removed.';
-- end $$;

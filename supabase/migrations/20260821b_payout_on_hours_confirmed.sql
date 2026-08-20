-- Pay the worker when a shift is actually completed.
--
-- THE GAP THIS CLOSES. Until now, finishing a shift produced no payment
-- record at all. Every `insert into public.payout_item` in the schema sat
-- inside a *cancellation* function; employer_confirm_checkout stamped
-- employer_hours_confirmed_at and inserted nothing; no trigger watched that
-- column; and the live table held zero rows with any non-cancellation reason.
-- A worker who applied, was booked, worked the shift, checked out and had
-- their hours confirmed received nothing -- the only way to be paid was for
-- the shift to be CANCELLED.
--
-- Fires on employer_hours_confirmed_at going null -> not null, which is the
-- one moment both sides have agreed what was worked: the worker submitted the
-- hours and the employer confirmed rather than disputed them.
--
-- TWO JUDGEMENT CALLS, stated because they decide what someone is paid:
--
-- 1. Paid on worker_reported_hours, with break minutes NOT deducted. The
--    checkout form asks for "Hours worked" and "Break minutes (optional)" as
--    separate fields, so the hours figure already excludes the break --
--    subtracting it again would silently underpay every worker who recorded
--    one. Break minutes stay on the record for disputes.
--
-- 2. The worker is paid the full agreed rate. The 15% platform fee is charged
--    ON TOP to the employer ("plus 15% platform fee" in their own budget
--    tooltip), so it is not deducted here. Fee collection is separate and does
--    not exist yet.
--
-- Reported hours are already capped at 150% of the contracted duration when
-- the worker submits them (20260726d), so this cannot be inflated arbitrarily.
-- Where genuine overtime pushes the payout above the employer's hold, the
-- payout still records the full entitlement and the capture simply takes what
-- was held -- the worker's claim is never trimmed to fit the deposit.

create or replace function public.create_payout_on_hours_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift record;
  v_hours numeric;
  v_amount numeric;
begin
  -- Only on the transition, and only when the employer confirmed rather than
  -- disputed. A re-confirmation after a dispute cannot double-pay: the
  -- idempotency key below is per application.
  if new.employer_hours_confirmed_at is null
     or old.employer_hours_confirmed_at is not null
     or coalesce(new.employer_hours_disputed, false) then
    return null;
  end if;

  select s.id, s.employer_id, s.title into v_shift
  from public.shifts s where s.id = new.shift_id;

  v_hours := coalesce(new.worker_reported_hours, 0);
  if v_hours <= 0 then
    -- Nothing was reported, so there is nothing to pay yet. Loud enough to
    -- find in the log, quiet enough not to block the confirmation.
    raise warning 'hours confirmed for application % but worker_reported_hours is %; no payout created',
      new.id, new.worker_reported_hours;
    return null;
  end if;

  v_amount := round(coalesce(new.wage_ask, 0) * v_hours, 2);
  if v_amount <= 0 then
    return null;
  end if;

  insert into public.payout_item (
    payout_cycle_id, worker_id, employer_id, amount, currency, scheduled_date,
    status, source_refs, idempotency_key
  ) values (
    null, new.worker_id, v_shift.employer_id, v_amount, 'MYR', current_date,
    'queued',
    jsonb_build_object('application_id', new.id, 'shift_id', new.shift_id,
                       'reason', 'shift_completed', 'hours', v_hours),
    'shift_work:' || new.id::text
  )
  on conflict (idempotency_key) do nothing;

  -- Turn the employer's hold into money owed. Capped at what is held, and any
  -- remainder released -- a worker who finished early should not leave the
  -- rest of the employer's deposit tied up.
  begin
    perform set_config('app.wallet_trusted_write', 'true', true);
    perform public.employer_capture_hold(new.id, v_amount, 'Shift completed and hours confirmed');
    perform set_config('app.wallet_trusted_write', 'false', true);
  exception when others then
    -- The payout is the thing that must survive. A missed capture leaves the
    -- ledger reconcilable; an aborted payout leaves a worker unpaid.
    raise warning 'wallet capture failed for application %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists trg_create_payout_on_hours_confirmed on public.applications;
create trigger trg_create_payout_on_hours_confirmed
after update of employer_hours_confirmed_at on public.applications
for each row execute function public.create_payout_on_hours_confirmed();

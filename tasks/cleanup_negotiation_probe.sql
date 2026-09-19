-- Clear the three shifts used to verify Decline & Modify live (2026-09-19).
-- Each has an accepted worker, so guard_delete_of_booked_shift refuses a plain
-- delete; they are already cancelled/closed (hidden from the public feed).
--
-- Two of them confirmed hours, which genuinely queued two QA payouts
-- (RM84.00 and RM67.50). admin_purge_shift refuses while money is in flight,
-- correctly, so those fake payouts are deleted first -- by idempotency_key,
-- so this can only match the rows the test created, and only while still
-- 'queued'. Deleted rather than settled: nobody is owed this money.

do $cleanup$
declare
  v_shifts uuid[] := array[
    'a3016ccc-de63-4213-8ad3-a29deef9277d',   -- first probe (cancelled)
    '9ad6c04d-552b-48dc-a220-74e07056aee5',   -- reject path (closed)
    '32b9fcfa-6ded-4d7f-b196-b81a497bb1bb'    -- accept path (closed)
  ];
  v_keys text[] := array[
    'shift_work:9f2b6d8f-9888-4bd8-a6b3-faf434fc735b',
    'shift_work:c0a463bd-7483-4b6c-9669-e1e860dfcc68'
  ];
  v_key text;
  v_shift uuid;
  v_status text;
  v_left int;
begin
  foreach v_key in array v_keys loop
    select status into v_status from public.payout_item where idempotency_key = v_key;
    if v_status is null then
      raise notice 'no payout for % -- already cleared', v_key;
    elsif v_status <> 'queued' then
      raise exception 'payout % is % (not queued) -- stopping rather than deleting a payout that may have been sent', v_key, v_status;
    else
      delete from public.payout_item where idempotency_key = v_key;
      raise notice 'deleted QA payout %', v_key;
    end if;
  end loop;

  foreach v_shift in array v_shifts loop
    if exists (select 1 from public.shifts where id = v_shift) then
      perform public.admin_purge_shift(v_shift, 'QA cleanup after hours-negotiation test');
    end if;
  end loop;

  select count(*) into v_left from public.shifts where id = any (v_shifts);
  if v_left > 0 then raise exception '% probe shift(s) survived the purge', v_left; end if;
  select count(*) into v_left from public.payout_item where idempotency_key = any (v_keys);
  if v_left > 0 then raise exception '% QA payout(s) survived', v_left; end if;

  raise notice 'cleanup verified: 3 probe shifts, their applications and 2 QA payouts removed';
end
$cleanup$;

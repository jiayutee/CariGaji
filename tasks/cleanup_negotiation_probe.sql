-- Clear every shift used to verify hours negotiation / dispute lifecycle live
-- (2026-09-19). Each has an accepted worker, so guard_delete_of_booked_shift
-- refuses a plain delete; admin_purge_shift removes shift + application (+ its
-- disputes/notifications by cascade).
--
-- Those that confirmed hours genuinely queued QA payouts. admin_purge_shift
-- refuses while money is in flight, correctly, so the fake payouts are deleted
-- first -- by idempotency_key, only while still 'queued', and never anything
-- that has moved. Deleted rather than settled: nobody is owed this money.

do $cleanup$
declare
  v_shifts uuid[] := array[
    'a3016ccc-de63-4213-8ad3-a29deef9277d',
    '9ad6c04d-552b-48dc-a220-74e07056aee5',
    '32b9fcfa-6ded-4d7f-b196-b81a497bb1bb',
    'eece9603-3a6c-4725-a36b-9a84ad1afa9d',
    'd7dc1a42-2683-47fc-a151-6d8531ed248e',
    '0b36169f-fb66-4648-a4c9-740f4cd9b61d'
  ];
  v_keys text[] := array[
    'shift_work:9f2b6d8f-9888-4bd8-a6b3-faf434fc735b',
    'shift_work:c0a463bd-7483-4b6c-9669-e1e860dfcc68',
    'shift_work:0bb4d240-256c-41f2-99ce-19c0cd4f5822',
    'shift_work:0ccd2038-1e19-4e12-95c1-3ccc160f9796',
    'shift_work:b0bc6ded-a25b-4ab3-bd16-33146c754cbc'
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

  raise notice 'cleanup verified: probe shifts, applications, disputes and QA payouts removed';
end
$cleanup$;

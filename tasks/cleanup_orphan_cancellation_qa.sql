-- Clear the last of the QA fiction: the RM30 cancellation payout from
-- 2026-07-17, plus the six notifications that outlived their shift.
--
-- This one is an ORPHAN, not a live booking. Shift 0bfa70ff ("DF cancel late")
-- and application c780807b are both already gone -- deleted back when that path
-- had no guard, which is also why the payout survived: admin_purge_shift's
-- money-in-flight check did not exist yet on 07-17. So there is no shift to
-- purge here, only rows pointing at things that no longer exist.
--
-- The block asserts that absence before deleting anything. If either row still
-- existed, this would be a live booking with a real 50% cancellation payment
-- owed to a worker, and the script stops rather than deletes.
--
-- The notifications are removed rather than left to render as tombstones. That
-- fallback exists so a real worker keeps the record that they were selected and
-- then cancelled on -- history worth preserving. Nobody was cancelled on here;
-- these are artefacts of a test, and keeping them just leaves permanent fake
-- entries in a QA account's bell.

do $cleanup$
declare
  v_shift uuid := '0bfa70ff-0dbb-4638-9d2c-b34a963d6175';
  v_app   uuid := 'c780807b-ac6d-4231-a64a-ee12cb13845f';
  v_key   text := 'cancellation:c780807b-ac6d-4231-a64a-ee12cb13845f';
  v_links text[] := array[
    '/worker/shifts/0bfa70ff-0dbb-4638-9d2c-b34a963d6175',
    '/employer/shifts/0bfa70ff-0dbb-4638-9d2c-b34a963d6175',
    '/worker/applications/c780807b-ac6d-4231-a64a-ee12cb13845f'
  ];
  v_status text;
  v_amount numeric;
  v_notifs int;
  v_left int;
begin
  if exists (select 1 from public.shifts where id = v_shift)
     or exists (select 1 from public.applications where id = v_app) then
    raise exception 'shift or application still exists -- this is a live booking, not the orphan this script was written for';
  end if;

  select amount, status into v_amount, v_status
  from public.payout_item where idempotency_key = v_key;

  if v_amount is null then
    raise notice 'no payout for % -- already cleared', v_key;
  else
    if v_status <> 'queued' then
      raise exception 'payout % is % (not queued) -- stopping rather than deleting a payout that may have been sent', v_key, v_status;
    end if;
    delete from public.payout_item where idempotency_key = v_key;
    raise notice 'deleted orphaned QA payout % (RM%)', v_key, v_amount;
  end if;

  delete from public.notifications where link = any(v_links);
  get diagnostics v_notifs = row_count;
  raise notice 'deleted % orphaned notification(s)', v_notifs;

  select count(*) into v_left from public.payout_item where idempotency_key = v_key;
  if v_left > 0 then raise exception 'payout row survived'; end if;

  select count(*) into v_left from public.notifications where link = any(v_links);
  if v_left > 0 then raise exception '% notification(s) survived', v_left; end if;

  raise notice 'cleanup verified: no QA payouts or orphaned notifications remain';
end
$cleanup$;

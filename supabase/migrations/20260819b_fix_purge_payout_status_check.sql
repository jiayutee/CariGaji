-- Fix the outstanding-payout guard in admin_purge_shift, which tested status
-- values that do not exist.
--
-- It refused to purge while any payout was
--     status not in ('paid', 'cancelled', 'failed')
-- but payout_item's real check constraint (20260519, reconciled 20260703) is
--     status in ('queued','ready','scheduled','processed_internal','failed_internal','held')
--
-- None of 'paid', 'cancelled' or 'failed' is a valid value, so that NOT IN
-- matched every row. The guard therefore treated EVERY payout as outstanding
-- -- including ones already paid out -- meaning any shift that ever generated
-- a payout could never be purged, permanently. The exact problem
-- admin_purge_shift was written to solve.
--
-- I invented those status names rather than reading the constraint, and the
-- same invention went into the cleanup SQL I handed the owner, which failed
-- with 23514 payout_item_status_check. That error is what surfaced this.
--
-- Correct split:
--   settled     -> processed_internal (paid), failed_internal (won't be retried)
--   outstanding -> queued, ready, scheduled, held
-- Only the outstanding set should block a purge; money that has landed or
-- definitively failed is no longer in flight.

create or replace function public.admin_purge_shift(
  p_shift_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  v_shift record;
  v_apps int;
  v_pending_payouts int;
begin
  if not (is_admin or is_direct_sql) then
    raise exception 'Not authorized';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to purge a shift';
  end if;

  select id, title, employer_id, status into v_shift
  from public.shifts where id = p_shift_id;

  if v_shift.id is null then
    raise exception 'Shift not found';
  end if;

  -- Money still in flight is the hard stop. Listed positively against the real
  -- constraint, so an invented value silently matches nothing instead of
  -- everything.
  select count(*) into v_pending_payouts
  from public.payout_item p
  join public.applications a
    on a.id = (p.source_refs ->> 'application_id')::uuid
  where a.shift_id = p_shift_id
    and p.status in ('queued', 'ready', 'scheduled', 'held');

  if v_pending_payouts > 0 then
    raise exception 'Cannot purge: % payout(s) for this shift are still outstanding. Settle or release them first.', v_pending_payouts;
  end if;

  select count(*) into v_apps from public.applications where shift_id = p_shift_id;

  raise warning 'admin_purge_shift: % ("%") by % (direct_sql=%) -- % application(s) -- reason: %',
    p_shift_id, coalesce(v_shift.title, '?'), coalesce(auth.uid()::text, 'sql-session'), is_direct_sql, v_apps, p_reason;

  delete from public.ratings
  where application_id in (select id from public.applications where shift_id = p_shift_id);

  delete from public.notifications
  where link = '/worker/shifts/' || p_shift_id::text
     or link = '/employer/shifts/' || p_shift_id::text
     or link in (
       select '/worker/applications/' || a.id::text
       from public.applications a where a.shift_id = p_shift_id
     );

  -- Applications FIRST: guard_delete_of_booked_shift refuses while any of them
  -- is 'accepted', so removing them makes the shift delete legitimate rather
  -- than exempt.
  delete from public.applications where shift_id = p_shift_id;

  delete from public.shifts where id = p_shift_id;

  return jsonb_build_object(
    'shift_id', p_shift_id,
    'title', v_shift.title,
    'applications_removed', v_apps,
    'reason', p_reason
  );
end;
$$;

revoke all on function public.admin_purge_shift(uuid, text) from public;
grant execute on function public.admin_purge_shift(uuid, text) to authenticated;

-- ── clear the QA payouts and the shift they pin, then verify ─────────────────
-- These two payout rows are from verification runs against test accounts, for
-- shifts that were never worked. Deleted outright rather than moved to a
-- terminal status: inventing a settlement for money that was never owed would
-- put fiction into the payout ledger.
do $cleanup$
declare
  v_shift uuid := 'a60f4e0c-a08d-4746-9188-d443b4c8e6f0';  -- "Q near"
  v_left int;
begin
  delete from public.payout_item
  where id in (
    'e31de2e7-ee96-4a50-a97f-59bac1fd51c2',
    'a9bcbf6c-df83-4361-9b56-920a0d8f953e'
  );

  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after quote verification');
  end if;

  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then
    raise exception 'Purge did not remove the QA shift';
  end if;
  raise notice 'QA cleanup verified: payouts cleared and shift purged';
end
$cleanup$;

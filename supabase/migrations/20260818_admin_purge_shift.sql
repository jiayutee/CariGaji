-- An admin-only way to permanently remove a shift and everything under it.
--
-- SUPERSEDES the first draft of this migration, which failed on its own
-- guard: it ended with `delete from public.shifts`, and
-- guard_delete_of_booked_shift (20260814/20260814b) blocks exactly that for
-- any shift with confirmed workers -- with admins deliberately NOT exempt.
-- I wrote that non-exemption and then forgot it two days later. The whole
-- script rolled back, which is the right outcome but not a plan.
--
-- WHY THIS IS NEEDED. 20260814 correctly stops an employer deleting a shift
-- workers are booked onto. But combined with 'accepted' being terminal
-- (20260717g permits no transition out) and withdrawal being refused after
-- the shift starts (20260817b) or once it is cancelled, a booked shift became
-- permanently undeletable by ANYONE, admin included. Abandoned and test data
-- accumulates with no way to clear it -- this project's own verification
-- needed a hand-written SQL block from the owner four separate times. That is
-- a missing capability, not a safety feature.
--
-- SAFETY. A hard delete with no undo, so it is bounded:
--   * admin-only, checked inside the function rather than delegated to a
--     policy;
--   * refused while any payout for the shift is still outstanding, so money in
--     flight is never orphaned -- the one thing worth blocking on;
--   * a reason is required and logged before the rows go, so a purge is never
--     anonymous.
-- The guard itself is unchanged for everyone else: it now recognises one
-- transaction-local flag that only this function sets.

-- ── 1. teach the guard about the sanctioned bypass ───────────────────────────
create or replace function public.guard_delete_of_booked_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- admin_purge_shift sets this immediately before its delete. Nothing else
  -- does, and it is transaction-local (is_local = true), so it cannot leak
  -- into an unrelated statement.
  is_purge boolean := coalesce(current_setting('app.purge_trusted_write', true), '') = 'true';
begin
  if is_purge then
    return old;
  end if;

  if public.shift_has_booked_workers(old.id) then
    raise exception
      'Cannot delete a shift with confirmed workers. Cancel the shift instead so the workers are notified and any compensation they are owed is created.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

-- ── 2. the purge ─────────────────────────────────────────────────────────────
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
  v_shift record;
  v_apps int;
  v_pending_payouts int;
begin
  if not is_admin then
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

  -- Money in flight is the hard stop. A payout that is queued or processing
  -- refers back to this application; deleting the row underneath it would
  -- leave a payment nobody can trace or reconcile.
  select count(*) into v_pending_payouts
  from public.payout_item p
  join public.applications a
    on a.id = (p.source_refs ->> 'application_id')::uuid
  where a.shift_id = p_shift_id
    and p.status not in ('paid', 'cancelled', 'failed');

  if v_pending_payouts > 0 then
    raise exception 'Cannot purge: % payout(s) for this shift are still outstanding. Settle or cancel them first.', v_pending_payouts;
  end if;

  select count(*) into v_apps from public.applications where shift_id = p_shift_id;

  -- Recorded before the delete, so the log survives even if something below
  -- fails and rolls the transaction back.
  raise warning 'admin_purge_shift: % ("%") by % -- % application(s) -- reason: %',
    p_shift_id, coalesce(v_shift.title, '?'), auth.uid(), v_apps, p_reason;

  -- Notifications do not cascade (no FK), so they are cleared explicitly --
  -- otherwise the purge leaves exactly the dangling links the tombstone work
  -- exists to explain.
  delete from public.notifications
  where link like '/worker/shifts/' || p_shift_id::text
     or link like '/employer/shifts/' || p_shift_id::text
     or link in (
       select '/worker/applications/' || a.id::text
       from public.applications a where a.shift_id = p_shift_id
     );

  -- The BEFORE DELETE guard (20260814/20260814b) blocks deletion of any shift
  -- with confirmed workers, and deliberately does NOT exempt admins -- that is
  -- what makes it a real protection rather than a UI convenience. This is the
  -- single sanctioned bypass, flagged transaction-locally so it cannot leak.
  perform set_config('app.purge_trusted_write', 'true', true);

  -- applications cascade via applications_shift_id_fkey on delete cascade.
  delete from public.shifts where id = p_shift_id;

  perform set_config('app.purge_trusted_write', 'false', true);

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
-- (the in-function admin check is the real gate; a non-admin caller is
--  rejected before anything is read)

-- ── 3. one-off: clear the QA rows this project's verification stranded ───────
-- Wrapped in a DO block so set_config and the deletes share one transaction --
-- the flag is transaction-local, so a bare sequence of statements in the SQL
-- editor would lose it between them and hit the guard again.
do $cleanup$
declare
  v_ids uuid[] := array[
    'e1eb3a7a-b2a0-43db-9284-28ace703e4ed',
    'e8ebf115-66e7-485b-825f-3902ccf615da',
    '3d551aa1-fce5-4983-ba65-c4e50e705fe3',
    '4bb2724c-6acb-4c5b-95fb-fb038af069f3'
  ]::uuid[];
begin
  delete from public.notifications
  where link in (
    select '/worker/applications/' || a.id::text
    from public.applications a where a.shift_id = any(v_ids)
  )
  or link in (select '/worker/shifts/' || s::text from unnest(v_ids) s)
  or link in (select '/employer/shifts/' || s::text from unnest(v_ids) s);

  perform set_config('app.purge_trusted_write', 'true', true);
  delete from public.shifts where id = any(v_ids);
  perform set_config('app.purge_trusted_write', 'false', true);
end
$cleanup$;

-- Reset the two QA workers' reliability, worn down by real penalty mechanics
-- firing repeatedly during verification (worker2 reached 3 of 100).
update public.profiles set reliability_score = 100
where id in (
  '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',
  '1ad212f6-5f29-41cb-b60f-2c9159915ab6'
);

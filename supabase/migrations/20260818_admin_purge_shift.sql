-- An admin-only way to permanently remove a shift and everything under it.
--
-- WHY THIS IS NEEDED. 20260814 correctly stops an employer deleting a shift
-- that workers are booked onto -- an accepted worker has a signed contract and
-- possibly a payout entitlement, and erasing that silently is the hole that
-- migration closed. But it left NO path at all: once an application reaches
-- 'accepted' nothing can move it back (20260717g permits no transition out),
-- worker_withdraw_from_shift now refuses after the shift starts (20260817b),
-- and a cancelled shift refuses withdrawal too. So a booked shift becomes
-- permanently undeletable by anyone, admin included.
--
-- In practice that means abandoned and test data accumulates with no way to
-- clear it -- during this project's own verification it required a hand-written
-- SQL block from the owner four separate times. That is a missing capability,
-- not a safety feature.
--
-- SAFETY. This is deliberately a hard delete with no undo, so it is:
--   * admin-only, checked inside the function rather than relying on a policy;
--   * refusing while any payout for the shift is still owed, so money in
--     flight is never orphaned -- that is the one thing worth blocking on;
--   * requiring an explicit reason, recorded in the Postgres log before the
--     rows go, so a purge is never anonymous.
-- Employers and workers get no access to this whatsoever.

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

  -- applications cascade via applications_shift_id_fkey on delete cascade.
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
revoke all on function public.admin_purge_shift(uuid, text) from authenticated;
grant execute on function public.admin_purge_shift(uuid, text) to authenticated;
-- (the in-function admin check is the real gate; the grant only makes it
--  callable, and a non-admin caller is rejected before anything is read)

-- ── one-off: clear the QA rows this project's own verification stranded ──────
delete from public.notifications
where link in (
  select '/worker/applications/' || a.id::text
  from public.applications a
  where a.shift_id in (
    'e1eb3a7a-b2a0-43db-9284-28ace703e4ed',
    'e8ebf115-66e7-485b-825f-3902ccf615da',
    '3d551aa1-fce5-4983-ba65-c4e50e705fe3',
    '4bb2724c-6acb-4c5b-95fb-fb038af069f3'
  )
);
delete from public.shifts where id in (
  'e1eb3a7a-b2a0-43db-9284-28ace703e4ed',
  'e8ebf115-66e7-485b-825f-3902ccf615da',
  '3d551aa1-fce5-4983-ba65-c4e50e705fe3',
  '4bb2724c-6acb-4c5b-95fb-fb038af069f3'
);

-- Reset the two QA workers' reliability, worn down by real penalty mechanics
-- firing during verification (worker2 reached 3 of 100).
update public.profiles set reliability_score = 100
where id in (
  '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',
  '1ad212f6-5f29-41cb-b60f-2c9159915ab6'
);

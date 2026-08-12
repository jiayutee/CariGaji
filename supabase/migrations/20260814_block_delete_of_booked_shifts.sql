-- Stop an employer deleting a shift that workers are already booked onto.
--
-- VERIFIED HOLE (2026-08-12). shifts_employer_delete (20260629) allows an
-- employer to delete any shift they own, unconditionally, and
-- applications.shift_id is ON DELETE CASCADE. Reproduced end-to-end against
-- the live database: shift created, worker taken to accepted + contract-signed,
-- then DELETE /rest/v1/shifts?id=eq.<id> with the employer's own token ->
-- HTTP 204. Shift gone. Application gone. Signed contract gone. No
-- shift_cancelled notification, no payout row, no trace.
--
-- The consequence is bigger than lost rows: it makes the whole 50%/100%
-- late-cancellation compensation system OPTIONAL. An employer facing a payout
-- can delete the shift instead of cancelling it and owe nothing. Every rule we
-- add on top of cancellation is bypassable until this is closed, which is why
-- this ships first and on its own.
--
-- The app exposes no delete button, but the REST API is public and
-- authenticated -- "the UI doesn't offer it" is not access control.
--
-- Cancelling remains available and is the correct path: status = 'cancelled'
-- is what notify_shift_cancelled, notify_cancellation_choice_pending and
-- create_cancellation_payout all hang off. Deleting a shift nobody has been
-- booked onto stays allowed.

-- ── membership check, via SECURITY DEFINER ───────────────────────────────────
-- NOT a direct subquery on public.applications. That is precisely what broke
-- production once already: 20260717i added a shifts policy that subqueried
-- applications while several applications policies subquery shifts back, and
-- Postgres errored with "infinite recursion detected in policy for relation
-- applications", taking out ALL authenticated shift and application reads.
-- 20260717j fixed it with this idiom, which is reused verbatim here: the
-- function runs as the table owner, bypassing RLS on applications, so
-- evaluating a shifts policy never re-enters the applications policies.
-- It returns a single boolean for one shift id -- no data is exposed.
create or replace function public.shift_has_booked_workers(p_shift_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.applications a
    where a.shift_id = p_shift_id
      and a.status = 'accepted'
  );
$$;

revoke all on function public.shift_has_booked_workers(uuid) from public;
grant execute on function public.shift_has_booked_workers(uuid) to authenticated;

-- ── 1. narrow the delete policy ──────────────────────────────────────────────
drop policy if exists shifts_employer_delete on public.shifts;
create policy shifts_employer_delete
  on public.shifts for delete to authenticated
  using (
    auth.uid() = employer_id
    and not public.shift_has_booked_workers(id)
  );

-- ── 2. defence in depth ──────────────────────────────────────────────────────
-- The policy alone would make a blocked delete return "0 rows deleted", which
-- reads as success to a client and tells nobody why. It also would not cover
-- an admin acting through shifts_admin_all, or any future policy that grants
-- delete. A BEFORE DELETE trigger raises a real error with a real reason.
--
-- Admins are deliberately NOT exempt: an accepted worker has a signed contract
-- and possibly a payout entitlement, and deleting that should require
-- deliberately cancelling first, whoever is asking.
create or replace function public.guard_delete_of_booked_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.shift_has_booked_workers(old.id) then
    raise exception
      'Cannot delete a shift with confirmed workers. Cancel the shift instead so the workers are notified and any compensation they are owed is created.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_guard_delete_of_booked_shift on public.shifts;
create trigger trg_guard_delete_of_booked_shift
before delete on public.shifts
for each row execute function public.guard_delete_of_booked_shift();

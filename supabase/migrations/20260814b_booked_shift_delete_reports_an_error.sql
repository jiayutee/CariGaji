-- Follow-up to 20260814. The hole IS closed -- deleting a booked shift no
-- longer destroys anything, verified against production. This fixes what the
-- caller is TOLD.
--
-- Observed after 20260814: DELETE on a shift with an accepted, contract-signed
-- worker returns HTTP 204 with the row still present. 204 means "success, no
-- content". Nothing was deleted, and nothing said so.
--
-- Cause: RLS filters rows out BEFORE row-level triggers run. The narrowed
-- shifts_employer_delete policy matched zero rows, so the delete became a
-- no-op and trg_guard_delete_of_booked_shift -- whose entire job is to explain
-- the refusal -- never fired.
--
-- "Appears to succeed while doing nothing" is exactly the failure mode that
-- made the 20260812 outage take an hour to find: the employer's shift edit
-- silently did nothing and the UI showed no error. Same shape, so it gets
-- fixed rather than tolerated, even though no user-facing delete button exists
-- today. If one is ever added, it would report "Shift deleted" over a shift
-- that is still there.
--
-- Fix: move the booked-ness test OFF the policy and onto the trigger alone.
-- The policy goes back to ownership only, so the row IS selected, the trigger
-- DOES run, and it raises a real error naming the reason.
--
-- This is not a weakening. A BEFORE DELETE trigger is the stronger guard of
-- the two: it runs for every DELETE on the table whatever policy allowed it
-- through, including the admin path (shifts_admin_all), which the policy check
-- never covered. Disabling it requires table ownership. The policy's copy of
-- the check was the redundant one -- and it was actively harmful, because it
-- masked the trigger.

drop policy if exists shifts_employer_delete on public.shifts;
create policy shifts_employer_delete
  on public.shifts for delete to authenticated
  using (auth.uid() = employer_id);

-- trg_guard_delete_of_booked_shift and shift_has_booked_workers() are
-- unchanged from 20260814 and remain the enforcement point. Restated here so
-- this file is self-contained if replayed.
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

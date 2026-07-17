-- Live-verification of the late-cancellation payout flow found the entire
-- worker-side choice UI unreachable: shifts_read_open (20260629) only
-- exposes status in ('open','filled','completed'), so the moment an
-- employer cancels a shift it vanishes for the very worker who was
-- accepted + signed on it. The My Bids embedded join (shift:shifts(...))
-- returns null, shiftStatus never reads 'cancelled', and neither the
-- basic "shift cancelled" notice nor the 50%/show-up choice buttons can
-- render — the card degrades to "Shift · TBA" with a dangling Check In
-- button.
--
-- Fix: a worker may read any shift they hold an application on, whatever
-- its status. No information leak — they could already see the full row
-- while it was open (that's how they applied). Mirrors the narrow
-- relationship-scoped pattern of profiles_read_by_employer_of_applicant
-- (20260712e).

drop policy if exists shifts_read_by_applicant on public.shifts;
create policy shifts_read_by_applicant
  on public.shifts for select
  to authenticated
  using (
    exists (
      select 1 from public.applications a
      where a.shift_id = shifts.id
        and a.worker_id = auth.uid()
    )
  );

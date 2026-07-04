-- Allow anonymous (not-signed-in) visitors to browse open/filled/completed
-- shifts, so listings show on the landing page before sign-up. Sensitive
-- data (worker PII, exact addresses for accepted_only) stays protected by
-- their own tables/policies; listing cards only ever show coarse location.
-- Idempotent.

drop policy if exists shifts_read_open_public on public.shifts;
create policy shifts_read_open_public
  on public.shifts for select to anon
  using (status in ('open', 'filled', 'completed'));

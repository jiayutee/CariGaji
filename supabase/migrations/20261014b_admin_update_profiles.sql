-- Admins could never write to anyone else's profiles row.
--
-- profiles has exactly one write policy, profiles_owner_write (auth.uid() =
-- id). The admin portal's KYC approve/reject and company verify/reject all
-- update another user's row, so RLS filtered them to 0 rows -- which
-- PostgREST reports as success, not an error. The UI toasted "approved",
-- dropped the item from the queue, and nothing was saved. Found 2026-10-14
-- while adding rejection reasons (an admin update in a rolled-back
-- transaction changed 0 rows). guard_kyc_level and
-- guard_employer_verification_status already let an admin JWT through; only
-- the policy was missing.
--
-- UPDATE only: admins get no INSERT/DELETE on profiles from this.

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
  on public.profiles for update
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

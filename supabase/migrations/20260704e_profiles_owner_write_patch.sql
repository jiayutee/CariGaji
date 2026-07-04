-- The profiles table is missing its owner-write RLS policy on the live DB
-- (same drift pattern as before — 20260628_profiles.sql's write policy
-- appears to have never been applied, even though the read policies were
-- later hardened in 20260702). Without it, a signed-in user cannot insert
-- or update their own profiles row, which the app does on registration and
-- avatar/name updates. Idempotent.

drop policy if exists profiles_owner_write on public.profiles;
create policy profiles_owner_write
on public.profiles for all
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

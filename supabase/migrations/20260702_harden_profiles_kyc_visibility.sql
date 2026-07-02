-- Harden profiles table: restrict kyc_level='pending_review' visibility.
-- Any authenticated user can read profiles UNLESS kyc_level='pending_review'.
-- Owners and admins can always read their own / all rows.
-- PostgreSQL RLS uses OR between policies for SELECT, so two narrow policies
-- replace the original broad `using (true)`.

drop policy if exists profiles_read_authenticated on public.profiles;

-- Non-sensitive rows visible to all authenticated users
create policy profiles_read_public
on public.profiles for select
to authenticated
using (kyc_level <> 'pending_review');

-- Full row visibility for the profile owner and admins
create policy profiles_read_owner_or_admin
on public.profiles for select
to authenticated
using (
  auth.uid() = id
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

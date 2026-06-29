-- Allow admins to update any profile row (needed for KYC approval flow).
-- Without this, approveKyc / rejectKyc updates are silently dropped by RLS.

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write
on public.profiles for update
to authenticated
using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

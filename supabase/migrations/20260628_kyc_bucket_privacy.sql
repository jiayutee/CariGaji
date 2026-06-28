-- Force the KYC bucket private and restrict access to the owner + admins.
-- KYC files hold national-ID images and selfies — they must never be public.

-- 1. Make sure the bucket is NOT public.
update storage.buckets set public = false where id = 'kyc-documents';

-- 2. Remove any permissive policies that may have been auto-created.
drop policy if exists kyc_owner_read on storage.objects;
drop policy if exists kyc_owner_write on storage.objects;
drop policy if exists kyc_owner_update on storage.objects;
drop policy if exists kyc_admin_read on storage.objects;

-- 3. A user can read only files under their own "<auth.uid()>/..." folder.
create policy kyc_owner_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'kyc-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- 4. A user can upload/replace only files under their own folder.
create policy kyc_owner_write
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'kyc-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy kyc_owner_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'kyc-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- 5. Admins (app_metadata.role = 'admin') can read any KYC file for review.
create policy kyc_admin_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'kyc-documents'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

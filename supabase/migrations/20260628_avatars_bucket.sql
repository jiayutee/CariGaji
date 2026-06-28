-- Public-read avatar bucket so employers can see applicant profile photos.
-- Profile pictures are low-sensitivity (unlike KYC docs, which stay private).

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Anyone can read avatars (public bucket).
drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
on storage.objects
for select
using (bucket_id = 'avatars');

-- A user may write/update/delete only files under their own user-id folder,
-- e.g. "<auth.uid()>/avatar.jpg".
drop policy if exists avatars_owner_write on storage.objects;
create policy avatars_owner_write
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

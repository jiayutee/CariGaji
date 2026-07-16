-- Private bucket for late-cancellation show-up proof photos. Same privacy
-- model as kyc-documents (20260628_kyc_bucket_privacy.sql) — these photos
-- can contain a worker's face/location, just as sensitive as KYC docs — but
-- keyed by application id rather than worker id, since the employer whose
-- shift it is also needs read access (via a join through applications ->
-- shifts, mirroring kyc_admin_read's role check but ownership-based
-- instead of admin-based).
-- Expected object path convention: "<application_id>/<timestamp>-proof.jpg"

insert into storage.buckets (id, name, public)
values ('cancellation-proof', 'cancellation-proof', false)
on conflict (id) do update set public = false;

drop policy if exists cancellation_proof_worker_write on storage.objects;
drop policy if exists cancellation_proof_worker_read on storage.objects;
drop policy if exists cancellation_proof_employer_read on storage.objects;
drop policy if exists cancellation_proof_admin_read on storage.objects;

create policy cancellation_proof_worker_write
on storage.objects for insert to authenticated
with check (
  bucket_id = 'cancellation-proof'
  and exists (
    select 1 from public.applications a
    where a.id::text = (storage.foldername(name))[1]
      and a.worker_id = auth.uid()
      and a.cancellation_choice = 'show_up_100'
  )
);

create policy cancellation_proof_worker_read
on storage.objects for select to authenticated
using (
  bucket_id = 'cancellation-proof'
  and exists (
    select 1 from public.applications a
    where a.id::text = (storage.foldername(name))[1]
      and a.worker_id = auth.uid()
  )
);

create policy cancellation_proof_employer_read
on storage.objects for select to authenticated
using (
  bucket_id = 'cancellation-proof'
  and exists (
    select 1 from public.applications a
    join public.shifts s on s.id = a.shift_id
    where a.id::text = (storage.foldername(name))[1]
      and s.employer_id = auth.uid()
  )
);

create policy cancellation_proof_admin_read
on storage.objects for select to authenticated
using (
  bucket_id = 'cancellation-proof'
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

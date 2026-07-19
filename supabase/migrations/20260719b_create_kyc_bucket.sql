-- Latent production bug found while verifying the SSM-certificate upload
-- (20260719): the kyc-documents bucket never existed. 20260628_kyc_bucket_privacy.sql
-- hardened it (public=false + owner/admin policies) but no migration ever
-- CREATED it — the update was a silent no-op on zero rows, and every
-- storage upload against it returns "Bucket not found". This has silently
-- broken ALL worker KYC document uploads (MyKad/selfie in the details
-- gate and the deferred-KYC banner) in production, plus the new SSM
-- certificate upload.
--
-- Same idempotent create idiom as avatars (20260628) and
-- cancellation-proofs (20260717d). The privacy policies from 20260628
-- already exist and apply the moment the bucket does; re-asserting
-- public=false here for safety.

insert into storage.buckets (id, name, public)
values ('kyc-documents', 'kyc-documents', false)
on conflict (id) do nothing;

update storage.buckets set public = false where id = 'kyc-documents';

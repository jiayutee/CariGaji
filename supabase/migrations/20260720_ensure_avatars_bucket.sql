-- Live-verifying the new registration-time avatar picker (profile photo
-- guideline feature) surfaced "Bucket not found" from Supabase Storage on
-- every upload attempt — the exact same bug class as the kyc-documents
-- bucket (20260719b): 20260628_avatars_bucket.sql already contains the
-- correct `insert into storage.buckets ... on conflict do update`, but
-- since the error is live in production, that original migration was
-- evidently never actually run. Re-asserting just the bucket creation here
-- (idempotent — safe whether or not 20260628 ran) rather than guessing.
-- The RLS policies from 20260628 are unaffected either way; they only take
-- effect once the bucket exists, so re-running them isn't necessary here.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

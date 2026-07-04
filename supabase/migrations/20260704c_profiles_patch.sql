-- The live `profiles` table pre-existed before 20260628_profiles.sql, so
-- create-table-if-not-exists skipped it and never added avatar_url,
-- kyc_level, rating. This broke the employer applicant pool (embeds
-- profiles.kyc_level), the worker profile page (rating), and avatar upload.
-- Idempotent explicit ALTERs.

alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists kyc_level  text not null default 'Basic',
  add column if not exists rating     numeric(2,1) not null default 0;

-- Worker "My Profile" (Sedcard) — owner-approved, benchmarked against a real
-- Instaff "Profil Details" screen. Bio/languages/qualifications only (no CV
-- upload — doesn't fit a casual short-term-shift marketplace, owner call).
-- No new table or storage bucket: profiles is already broadly readable by
-- any authenticated user (profiles_read_authenticated, 20260628_profiles.sql)
-- and owner-writable (profiles_owner_write), which is exactly the visibility
-- this employer-facing, non-sensitive data needs.

alter table public.profiles
  add column if not exists bio text,
  add column if not exists languages_spoken text[] not null default '{}',
  add column if not exists qualifications text[] not null default '{}',
  add column if not exists qualifications_other text;

-- PostgREST can only auto-embed a related resource (worker:profiles(...))
-- when it detects a direct foreign key between the two tables being joined.
-- applications.worker_id only references auth.users(id) — a schema
-- PostgREST doesn't expose — so every `worker:profiles(...)` embed in the
-- app (employer applicant pool, chat conversation list) silently returned
-- null instead of erroring. Adding a second FK straight to public.profiles
-- (safe: profiles.id already equals auth.users.id via its own FK, and every
-- account now gets a profiles row on registration) lets PostgREST resolve
-- the embed. Idempotent.

-- NOT VALID: register the FK for future inserts/PostgREST embedding without
-- validating existing rows (there may be old applications whose worker_id
-- pre-dates the profiles-write-policy fix and has no profiles row yet).
alter table public.applications drop constraint if exists applications_worker_id_profiles_fkey;
alter table public.applications
  add constraint applications_worker_id_profiles_fkey
  foreign key (worker_id) references public.profiles(id) on delete cascade
  not valid;

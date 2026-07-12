-- T&C consent must be enforced for every sign-up path, including OAuth
-- (Google/Apple/Facebook), which previously skipped it entirely — there was
-- no server-side record of consent for ANY user, even email/password
-- signups (the checkbox was a client-side submit-button gate only). Adding
-- a nullable timestamp so a null value means "hasn't accepted yet" and the
-- app-shell-level TnCGateModal (carigaji-app.jsx) can block on it regardless
-- of how the account was created.
--
-- No new RLS policy needed: profiles_owner_write (20260628_profiles.sql)
-- already grants the owner `for all` on their own row.

alter table public.profiles
  add column if not exists tnc_accepted_at timestamptz;

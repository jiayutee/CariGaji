-- Set a known password on a test account whose reset email you cannot read.
-- Run in the Supabase SQL editor. This is your own project's auth schema.

-- ── 1. Confirm what the account actually is, BEFORE changing anything ────────
-- If `provider` is google/facebook there is no password to reset: that account
-- signs in through the provider and this whole exercise is moot.
-- Note the id: if it is 3446faa8-8601-4f22-8fec-5b9566a9601c, this is the
-- "Demo Staff" employer that owns the shifts on the public Discover feed.
select
  u.id,
  u.email,
  u.raw_app_meta_data ->> 'provider' as provider,
  u.email_confirmed_at,
  u.last_sign_in_at,
  p.full_name,
  p.role
from auth.users u
left join public.profiles p on p.id = u.id
where u.email = 'carigaji-staff1783119259@mailinator.com';

-- ── 2. Set the password ─────────────────────────────────────────────────────
-- bcrypt, which is the scheme GoTrue itself uses, so the new hash is a normal
-- one -- nothing about the account becomes special afterwards.
-- CHANGE THE PASSWORD BELOW before running.
update auth.users
set encrypted_password = extensions.crypt('ChangeThisPass123!', extensions.gen_salt('bf')),
    updated_at = now()
where email = 'carigaji-staff1783119259@mailinator.com';

-- If that errors with "function extensions.crypt does not exist", pgcrypto is
-- installed elsewhere on this project -- drop the schema qualifier and use
-- crypt(...) / gen_salt('bf') unqualified instead.

-- ── 3. Make sure it can actually sign in ────────────────────────────────────
-- An unconfirmed email is refused at login with a confusing "Invalid login
-- credentials", which looks identical to a wrong password.
update auth.users
set email_confirmed_at = coalesce(email_confirmed_at, now())
where email = 'carigaji-staff1783119259@mailinator.com';

-- ── 4. Verify ───────────────────────────────────────────────────────────────
select email, email_confirmed_at is not null as confirmed, updated_at
from auth.users
where email = 'carigaji-staff1783119259@mailinator.com';

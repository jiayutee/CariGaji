-- Grant the admin role. `app_metadata` is the right home for it: unlike
-- user_metadata, the account holder cannot write to it -- only the service role
-- or SQL can, which is why every guard in the schema trusts it.
--
-- WHICH ACCOUNT. Recommended: your OWN account, not a QA fixture. You are the
-- real operator, you need this in production anyway, and it keeps the admin
-- separate from the employer being credited, which is what the top-up flow
-- actually looks like in real life.
--
-- WHAT IT UNLOCKS. Client-side: the Admin Dashboard button in Settings, and
-- admin accounts land there on sign-in. Server-side: admin_record_topup,
-- admin_purge_shift, and the wallet movement functions.
--
-- WHAT IT ALSO DOES, and this is the part worth pausing on: 23 migrations
-- short-circuit their guard triggers for an admin --
--   if is_admin then return new; end if;
-- covering profile reputation/role, KYC level, application status transitions,
-- attendance columns, cancellation choice, ratings, and the new platform fee.
-- So an admin account is NOT a valid fixture for testing that those guards
-- work: it is precisely the account they let through. Keep using the QA
-- worker/employer accounts for guard testing.

-- ── 1. see who exists, before changing anything ──────────────────────────────
select
  u.id,
  u.email,
  p.full_name,
  p.role                                   as app_role,
  coalesce(u.raw_app_meta_data ->> 'role', '(none)') as admin_flag
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at;

-- ── 2. grant it ──────────────────────────────────────────────────────────────
-- Keyed on id (stable) rather than email. Replace with the id you picked from
-- the list above. This one is "Jiayu Tee".
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where id = '6d73be79-cfae-4d3e-b4a5-e0e7d7cf671b';

-- ── 3. verify the flag landed ────────────────────────────────────────────────
select id, email, raw_app_meta_data ->> 'role' as admin_flag
from auth.users
where raw_app_meta_data ->> 'role' = 'admin';

-- ── 4. THEN SIGN OUT AND BACK IN ─────────────────────────────────────────────
-- The role is baked into the JWT when it is issued. An existing session is
-- carrying a token that still says "not admin", so nothing changes until a new
-- token is minted. Sign out, sign in, and the Admin Dashboard appears in
-- Settings. Skipping this step is the usual reason "I granted it and nothing
-- happened".

-- ── to REVOKE later ──────────────────────────────────────────────────────────
-- Removes the key entirely rather than setting it to something falsy, so the
-- guards' `= 'admin'` comparison sees no key at all.
--   update auth.users
--   set raw_app_meta_data = raw_app_meta_data - 'role'
--   where id = '6d73be79-cfae-4d3e-b4a5-e0e7d7cf671b';
-- Sign out and back in again afterwards, for the same reason.

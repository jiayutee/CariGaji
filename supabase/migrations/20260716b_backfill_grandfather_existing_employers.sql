-- Grandfather pre-existing employer accounts that predate the posting-gate
-- enforcement shipped today in 20260716_require_verified_employer_for_shift_insert.sql.
--
-- profiles.employer_verification_status defaults to 'unverified' for every
-- row (20260712b_employer_verification.sql), including accounts created
-- long before that column existed. Until today, an unverified employer could
-- still post shifts (shifts_employer_insert's WITH CHECK never referenced
-- the column). 20260716 correctly closes that for NEW sign-ups (which go
-- through SSM -> pending_review -> admin-verify), but also retroactively
-- locked out every employer who signed up before verification existed and
-- never had a chance to submit an SSM number (live bug reported 2026-07-16:
-- "failed to post shift: new row violates row-level security").
--
-- One-time backfill, self-limiting: this file runs exactly once, against
-- whatever employers are 'unverified' at that moment, so it can never
-- retroactively sweep up a future sign-up (those also start 'unverified'
-- but this migration won't run again to catch them). Mirrors the one-time
-- backfill idiom already used in 20260713_progressive_signup.sql.
--
-- guard_employer_verification_status (20260712b) rejects any non-admin
-- write to this column, and a migration applied via the Supabase SQL
-- editor/CLI carries no request.jwt.claims, so auth.jwt() is null and the
-- trigger's is_admin check is false — a plain UPDATE would silently no-op
-- the status column rather than error. Disable the trigger for the scope
-- of this one statement instead.

alter table public.profiles disable trigger profiles_guard_verification_status;

update public.profiles
set employer_verification_status = 'verified',
    updated_at = now()
where role = 'employer'
  and employer_verification_status = 'unverified';

alter table public.profiles enable trigger profiles_guard_verification_status;

-- Sanity check: surface it loudly if any employer is still unverified after
-- this runs, instead of deploying a silently-incomplete fix.
do $$
declare
  v_remaining int;
begin
  select count(*) into v_remaining
  from public.profiles
  where role = 'employer'
    and employer_verification_status = 'unverified';
  if v_remaining > 0 then
    raise warning 'backfill: % employer profile(s) still unverified after backfill', v_remaining;
  end if;
end $$;

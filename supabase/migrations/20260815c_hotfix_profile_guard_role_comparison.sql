-- HOTFIX for 20260815b. Run immediately: until it is applied, EVERY UPDATE to
-- public.profiles fails with
--   42883 operator does not exist: user_role = text
-- which breaks profile editing, avatar changes, the details gate, the T&C
-- gate, and the OAuth full_name backfill.
--
-- My fault, and avoidable. 20260725k ended the role branch with an
-- unconditional restore:
--
--     if tg_op = 'INSERT' then
--       if new.role not in ('worker', 'employer') then new.role := 'worker'; end if;
--     else
--       new.role := prior_role;
--     end if;
--
-- While rewriting the function to add the reliability trusted-write hatch I
-- "tidied" that into `elsif new.role is distinct from prior_role then`. That
-- comparison puts new.role (type user_role) against prior_role (declared
-- text), and Postgres has no such operator. The original never compared them
-- -- it just assigned -- so it never hit the mismatch.
--
-- Note the schema drift underneath: 20260628_profiles.sql declares
-- `role text not null default 'worker' check (...)`, but live it is a
-- user_role ENUM. Third instance of the same pattern in this codebase after
-- shifts.status and profiles.reliability_score. The declared type in the
-- migration history cannot be trusted; only the live database can.
--
-- Fix: restore the original unconditional assignment. The comparison bought
-- nothing -- assigning the same value is not a write worth avoiding inside a
-- BEFORE trigger.
--
-- prior_role stays `text` to match 20260725k exactly. It is only ever
-- assigned FROM new.role/old.role (implicit cast on assignment is fine) and
-- assigned back TO new.role (likewise). Only an explicit comparison between
-- the two types fails, and there is no longer one.

create or replace function public.guard_profile_reputation_and_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_ratings_trusted_write boolean := coalesce(current_setting('app.ratings_trusted_write', true), '') = 'true';
  is_reliability_trusted_write boolean := coalesce(current_setting('app.reliability_trusted_write', true), '') = 'true';
  prior_rating numeric(2,1) := case when tg_op = 'INSERT' then 0 else old.rating end;
  prior_reliability numeric := case when tg_op = 'INSERT' then 0 else old.reliability_score end;
  prior_role text := case when tg_op = 'INSERT' then 'worker' else old.role end;
begin
  if is_admin then
    return new;
  end if;

  if new.rating is distinct from prior_rating then
    if not is_ratings_trusted_write then
      new.rating := prior_rating;
    end if;
  end if;

  if new.reliability_score is distinct from prior_reliability then
    if not is_reliability_trusted_write then
      new.reliability_score := prior_reliability;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.role not in ('worker', 'employer') then
      new.role := 'worker';
    end if;
  else
    -- Unconditional, exactly as 20260725k had it. Do NOT reintroduce a
    -- `new.role is distinct from prior_role` guard here: new.role is user_role
    -- and prior_role is text, and that comparison has no operator.
    new.role := prior_role;
  end if;

  return new;
end;
$$;

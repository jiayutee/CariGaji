-- The Ratings table feature (20260725b) now ships the real server-side
-- computation for profiles.rating that guard_profile_reputation_and_role
-- (20260718) said didn't exist yet -- its recompute_profile_rating()
-- trigger needs to write profiles.rating, but the guard unconditionally
-- pins that column to its prior value for every non-admin writer,
-- including this new trusted trigger.
--
-- Re-declaring the function body only (one dated file per change --
-- 20260718 is not edited), adding the same trusted-write bypass idiom
-- already used for app.application_status_trusted_write (20260717g):
-- the ratings trigger brackets its UPDATE with
-- set_config('app.ratings_trusted_write', 'true'/'false', true), and this
-- guard now lets new.rating through whenever that flag is set, instead of
-- pinning it to prior_rating.
--
-- profiles.reliability_score and profiles.role are untouched -- still no
-- trusted write path for either, so they stay pinned exactly as before.

create or replace function public.guard_profile_reputation_and_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_ratings_trusted_write boolean := coalesce(current_setting('app.ratings_trusted_write', true), '') = 'true';
  prior_rating numeric(2,1) := case when tg_op = 'INSERT' then 0 else old.rating end;
  prior_reliability int := case when tg_op = 'INSERT' then 0 else old.reliability_score end;
  prior_role text := case when tg_op = 'INSERT' then 'worker' else old.role end;
begin
  if is_admin then
    return new;
  end if;

  -- recompute_profile_rating() (20260725b) is the one legitimate
  -- server-side write path for this column -- let it through when the
  -- trusted-write flag is set, otherwise pin as before.
  if new.rating is distinct from prior_rating then
    if not is_ratings_trusted_write then
      new.rating := prior_rating;
    end if;
  end if;

  -- No client or scheduled-job write path exists yet for this one --
  -- still pinned to the prior/default value until a real server-side
  -- computation lands.
  if new.reliability_score is distinct from prior_reliability then
    new.reliability_score := prior_reliability;
  end if;

  -- Sign-up (handleRegister) only ever upserts 'worker' or 'employer' on
  -- the initial INSERT; anything else collapses to 'worker'. Once a row
  -- exists, role is permanently pinned for non-admins -- no worker<->
  -- employer flip after account creation, closing the gap the security
  -- reviewer found in an earlier draft of this guard (a not-in-allow-list
  -- check alone would still have permitted that flip).
  if tg_op = 'INSERT' then
    if new.role not in ('worker', 'employer') then
      new.role := 'worker';
    end if;
  else
    new.role := prior_role;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_reputation_and_role on public.profiles;
create trigger profiles_guard_reputation_and_role
before insert or update on public.profiles
for each row execute function public.guard_profile_reputation_and_role();

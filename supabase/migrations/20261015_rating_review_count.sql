-- A rating shown without the evidence behind it.
--
-- Found dogfooding 2026-10-15: Test Worker Two showed 3.0 stars on the employer's
-- applicant card, but opening the rating said "No ratings yet". profiles.rating is a
-- stored aggregate of the rows in public.ratings, and for this one profile the
-- aggregate (3.0) had nothing behind it (0 rows). Origin unknown; it was the only
-- profile out of 7 affected, so this is residue, not a live defect in the trigger.
--
-- Two changes so it cannot mislead again:
--   1. profiles.rating_count stores how many reviews the rating is made of, kept by
--      the same trigger and protected by the same guard as rating. The UI can now say
--      "3.0 - 3 reviews" or "No ratings yet" instead of a bare number whose
--      parentheses were read as a review count.
--   2. Every profile's rating and count are recomputed from the real rows, which
--      repairs Test Worker Two (3.0 -> unrated).

alter table public.profiles
  add column if not exists rating_count integer not null default 0 check (rating_count >= 0);

create or replace function public.recompute_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ratee_id uuid := coalesce(new.ratee_id, old.ratee_id);
begin
  perform set_config('app.ratings_trusted_write', 'true', true);

  update public.profiles
  set rating = coalesce((
        select round(avg(overall)::numeric, 1)
        from public.ratings
        where ratee_id = v_ratee_id
      ), 0),
      rating_count = (
        select count(*) from public.ratings where ratee_id = v_ratee_id
      )
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

-- Same guard as before (20260725k) plus rating_count under the same "ratings trusted
-- write" flag, so nobody can claim review counts for themselves any more than a rating.
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
  prior_rating_count integer := case when tg_op = 'INSERT' then 0 else old.rating_count end;
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

  if new.rating_count is distinct from prior_rating_count then
    if not is_ratings_trusted_write then
      new.rating_count := prior_rating_count;
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

-- Repair: make every stored rating and count match the rows behind it.
do $backfill$
declare v_fixed int;
begin
  perform set_config('app.ratings_trusted_write', 'true', true);
  update public.profiles p
  set rating = coalesce((select round(avg(r.overall)::numeric, 1) from public.ratings r where r.ratee_id = p.id), 0),
      rating_count = (select count(*) from public.ratings r where r.ratee_id = p.id)
  where p.rating is distinct from coalesce((select round(avg(r.overall)::numeric, 1) from public.ratings r where r.ratee_id = p.id), 0)
     or p.rating_count is distinct from (select count(*) from public.ratings r where r.ratee_id = p.id);
  get diagnostics v_fixed = row_count;
  perform set_config('app.ratings_trusted_write', 'false', true);
  raise notice 'rating backfill: % profile(s) recomputed from their rating rows', v_fixed;
end $backfill$;

-- The public trust signal (signed-out Discover) carries the count too. The return type
-- changes, so it is dropped and recreated with the same access as before.
drop function if exists public.get_public_employer_trust_signals(uuid[]);
create function public.get_public_employer_trust_signals(p_employer_ids uuid[])
returns table(id uuid, full_name text, reliability_score integer, rating numeric, rating_count integer, employer_verification_status text)
language sql
stable
security definer
set search_path = public
as $$ select id, full_name, reliability_score, rating, rating_count, employer_verification_status from public.profiles where id = any(p_employer_ids) and role = 'employer'; $$;

revoke all on function public.get_public_employer_trust_signals(uuid[]) from public;
grant execute on function public.get_public_employer_trust_signals(uuid[]) to anon, authenticated;

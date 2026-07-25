-- Live QA found profiles.rating still stuck at 0.0 after successfully
-- inserting ratings and confirming recompute_profile_rating() runs
-- (overall computed correctly, RPC returns the row). A direct client PATCH
-- to profiles.rating is correctly reverted by the guard trigger, proving
-- the guard IS active — but the trigger's TRUSTED write (via
-- set_config('app.ratings_trusted_write', ...)) is also being reverted,
-- which should only happen if the live guard_profile_reputation_and_role
-- function is still the original 20260718 version with no ratings bypass
-- at all — i.e. 20260725c was written but, per the drift pattern found
-- twice already in this same QA pass, was apparently never actually run.
--
-- Re-issuing its exact content here (create or replace is idempotent, so
-- this is safe whether or not 20260725c ran before).

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

  if new.rating is distinct from prior_rating then
    if not is_ratings_trusted_write then
      new.rating := prior_rating;
    end if;
  end if;

  if new.reliability_score is distinct from prior_reliability then
    new.reliability_score := prior_reliability;
  end if;

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

-- Backfill: recompute rating for anyone who already has rating rows from
-- the brief broken-guard window (this QA session's test ratings). A plain
-- UPDATE from the SQL editor has no auth.jwt() and never sets the
-- trusted-write flag, so it would be reverted by the very guard just
-- redefined above -- disable the trigger for the scope of this one
-- statement, same idiom as the employer-grandfather backfill (20260716b).
alter table public.profiles disable trigger profiles_guard_reputation_and_role;

update public.profiles p
set rating = (
  select round(avg(overall)::numeric, 1)
  from public.ratings r
  where r.ratee_id = p.id
)
where exists (select 1 from public.ratings r where r.ratee_id = p.id);

alter table public.profiles enable trigger profiles_guard_reputation_and_role;

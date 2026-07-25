-- Live QA (multiple employers/workers interacting) found the ratings
-- feature from 20260725b completely non-functional in production, despite
-- the app code and migration file both looking correct.
--
-- ROOT CAUSE: a stale stub `ratings` table already existed (id, rater_id,
-- ratee_id, stars, comment, created_at — an old, incompatible shape,
-- confirmed via REST column probing, 0 rows). 20260725b's
-- `create table if not exists public.ratings (...)` silently no-op'd
-- against that pre-existing table instead of creating the real shape, so
-- application_id/direction/aspects/overall were never added. The very
-- next statement in that file — `create policy ratings_owner_insert ...`
-- — references application_id in its WITH CHECK clause and would have
-- failed outright on a column that doesn't exist, which halted the rest
-- of the script: the compute_rating_overall/recompute_profile_rating
-- triggers and the get_ratee_ratings RPC were never created either.
-- Confirmed live: every insert attempt hit a generic RLS-violation (no
-- working insert policy), and the RPC was reported missing from
-- PostgREST's schema cache entirely.
--
-- Fix: the stub has zero rows (confirmed via Content-Range: */0), so it's
-- safe to drop outright and recreate with the correct schema — no data
-- migration needed. This file is the exact content of 20260725b, run
-- again after clearing the naming collision.

drop table if exists public.ratings cascade;

create table public.ratings (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  rater_id       uuid not null references auth.users(id) on delete cascade,
  ratee_id       uuid not null references auth.users(id) on delete cascade,
  direction      text not null check (direction in ('employer_to_worker','worker_to_employer')),
  aspects        jsonb not null,
  overall        numeric(2,1) not null check (overall between 1 and 5),
  created_at     timestamptz not null default now(),
  unique (application_id, direction)
);

alter table public.ratings enable row level security;

create policy ratings_owner_insert
  on public.ratings for insert to authenticated
  with check (
    auth.uid() = rater_id
    and exists (
      select 1 from public.applications a
      join public.shifts s on s.id = a.shift_id
      where a.id = application_id
        and a.status = 'accepted'
        and s.status = 'completed'
        and (
          (direction = 'employer_to_worker' and s.employer_id = auth.uid() and a.worker_id = ratee_id)
          or
          (direction = 'worker_to_employer' and a.worker_id = auth.uid() and s.employer_id = ratee_id)
        )
    )
  );

create policy ratings_participant_read
  on public.ratings for select to authenticated
  using (auth.uid() = rater_id or auth.uid() = ratee_id);

create or replace function public.compute_rating_overall()
returns trigger
language plpgsql
as $$
declare
  computed numeric(2,1);
begin
  select round(avg(value::numeric), 1) into computed
  from jsonb_each_text(new.aspects)
  where value ~ '^[0-9]+(\.[0-9]+)?$';

  if computed is null then
    raise exception 'ratings.aspects must contain at least one numeric aspect score';
  end if;

  new.overall := computed;
  return new;
end;
$$;

drop trigger if exists trg_compute_rating_overall on public.ratings;
create trigger trg_compute_rating_overall
before insert on public.ratings
for each row execute function public.compute_rating_overall();

create or replace function public.recompute_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.ratings_trusted_write', 'true', true);

  update public.profiles
  set rating = (
    select round(avg(overall)::numeric, 1)
    from public.ratings
    where ratee_id = new.ratee_id
  )
  where id = new.ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return new;
end;
$$;

drop trigger if exists trg_recompute_profile_rating on public.ratings;
create trigger trg_recompute_profile_rating
after insert on public.ratings
for each row execute function public.recompute_profile_rating();

create or replace function public.get_ratee_ratings(p_ratee_id uuid, p_direction text)
returns table (aspects jsonb, overall numeric)
language sql
security definer
set search_path = public
stable
as $$
  select r.aspects, r.overall
  from public.ratings r
  where r.ratee_id = p_ratee_id
    and r.direction = p_direction;
$$;

grant execute on function public.get_ratee_ratings(uuid, text) to authenticated;

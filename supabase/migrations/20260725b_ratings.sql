-- Two-sided ratings (v1): workers rate employers, employers rate workers,
-- after a shift completes. Mirrors the disputes table shape (20260712)
-- for RLS style. v1 scope: no edit/delete, no rating-of-a-rating disputes,
-- no notifications, no admin moderation, no reliability_score computation
-- -- just the rating record + a trigger that recomputes profiles.rating.
--
-- Avoids the shifts<->applications RLS recursion bug class fixed on
-- 2026-07-17 (20260717j) by writing the insert policy as a single EXISTS
-- join from ratings -> applications -> shifts, with no policy on ratings
-- referencing another policy on ratings itself.
--
-- Security review (2026-07-25) flagged and this file fixes two HIGH
-- findings before this ever ran in prod:
--   1. The insert policy originally checked only shift.status = 'completed',
--      not application.status = 'accepted' -- any never-hired applicant on a
--      since-completed shift could rate (or be rated by) the employer,
--      manipulating profiles.rating. Fixed by requiring a.status = 'accepted'.
--   2. The original read policy was `using (true)`, which exposes full rows
--      (including rater_id, application_id) to every authenticated user via
--      REST, de-anonymizing raters despite the "aggregate-only" intent.
--      Fixed by restricting direct table SELECT to the two participants on
--      a rating, and adding a SECURITY DEFINER RPC (get_ratee_ratings) that
--      returns only (aspects, overall) for the "view anyone's rating
--      breakdown" UI path.
-- Also closes a LOW finding: `overall` is now computed server-side from
-- `aspects` (not trusted from the client), so the displayed breakdown and
-- the score that moves profiles.rating can't diverge.
--
-- Run in Supabase SQL Editor after 20260629_shifts_and_applications.sql
-- and 20260718_guard_profile_reputation_role_and_signature_columns.sql.

-- ── ratings ──────────────────────────────────────────────────────────────────
create table if not exists public.ratings (
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

-- ── RLS — ratings ────────────────────────────────────────────────────────────
alter table public.ratings enable row level security;

drop policy if exists ratings_owner_insert    on public.ratings;
drop policy if exists ratings_read_all        on public.ratings;
drop policy if exists ratings_participant_read on public.ratings;

-- A rating may only be filed by the rater themselves, on an application that
-- actually reached 'accepted' (i.e. they were the hired worker / the
-- employer who hired them -- not merely one of many applicants) on a shift
-- that has since completed, and only in the direction that matches who they
-- actually were on that application -- not a self-rating or a rating of an
-- unrelated party who happened to apply/post and never transacted.
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

-- Direct table reads are restricted to the two participants on a given
-- rating row (so a rater can confirm what they filed, and the
-- myRatedApplicationIds "already rated" prefetch -- which filters by
-- rater_id = auth.uid() -- keeps working). Anyone-can-view-anyone's-
-- aggregate-rating is served through get_ratee_ratings() below instead of
-- a broad `using (true)`, so rater_id/application_id are never exposed to
-- non-participants.
create policy ratings_participant_read
  on public.ratings for select to authenticated
  using (auth.uid() = rater_id or auth.uid() = ratee_id);

-- No update/delete policy for non-admins -- ratings are immutable once filed.

-- ── trigger: compute overall from aspects server-side ───────────────────────
-- The client posts per-aspect 1-5 scores; `overall` is derived here rather
-- than trusted from the request body, so the score that moves
-- profiles.rating can never diverge from the aspect breakdown shown in the
-- "expand details" view.
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

-- ── trigger: recompute profiles.rating on new rating ────────────────────────
-- SECURITY DEFINER so it can write profiles.rating despite the
-- guard_profile_reputation_and_role trigger (20260718) normally pinning
-- that column for non-admin writers. Sets the ratings-trusted-write flag
-- (see 20260725c) around the write so the guard lets it through, exactly
-- like notify_not_selected_when_filled does for
-- app.application_status_trusted_write (20260717g).
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

-- ── RPC: aggregate-safe read of any ratee's ratings ─────────────────────────
-- SECURITY DEFINER so it can bypass ratings_participant_read and return
-- (aspects, overall) for ANY ratee -- powering the "click any user's star
-- rating to see the aspect breakdown" UI -- while never exposing rater_id
-- or application_id, unlike the direct table (see fix #2 above).
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

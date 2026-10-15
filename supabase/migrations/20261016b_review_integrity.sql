-- Review integrity: make a revenge review pointless, and give the person reviewed a way to challenge one.
--
--   1. Reveal together. A rating is hidden from the person it is about (and from every
--      average) until BOTH sides have rated the shift, or 7 days after the first one.
--      Neither side can rate in reaction to the other's score. Held while a (non-review)
--      dispute on the same shift is open. Ratings that already existed are grandfathered.
--   2. Hide, never delete. An admin can hide a review (reason required): it stops
--      counting and stops being shown, the row and who hid it stay on record, and it can be
--      restored. profiles.rating / rating_count only ever count revealed, un-hidden rows.
--   3. Report a review. The person a review is about opens a dispute of category
--      'review_report' (rating_id set): same thread, evidence and history as any dispute.
--      One report per review; at most 3 reports per person per 30 days.
--   4. Flag suspicious ratings for the admin: repeated lows from the same rater to the
--      same person, and raters whose recent ratings are all low.

-- 1. columns (before any trigger is changed, so the backfill touches nothing) ----------
alter table public.ratings
  add column if not exists revealed_at timestamptz,
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references auth.users(id),
  add column if not exists hide_reason text,
  add column if not exists flagged_reason text;

update public.ratings set revealed_at = created_at where revealed_at is null;

alter table public.ratings drop constraint if exists ratings_flagged_reason_check;
alter table public.ratings add constraint ratings_flagged_reason_check
  check (flagged_reason is null or flagged_reason in ('repeat_low', 'habitually_low'));

-- 2. aggregates count only revealed, un-hidden ratings -----------------------------------
-- Same function as 20261015_rating_review_count.sql; ONLY the two where-clauses change.
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
        where ratee_id = v_ratee_id and revealed_at is not null and hidden_at is null
      ), 0),
      rating_count = (
        select count(*) from public.ratings
        where ratee_id = v_ratee_id and revealed_at is not null and hidden_at is null
      )
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_recompute_profile_rating on public.ratings;
create trigger trg_recompute_profile_rating
  after insert or delete or update of revealed_at, hidden_at on public.ratings
  for each row execute function public.recompute_profile_rating();

-- 3. who can read a rating -------------------------------------------------------------------
drop policy if exists ratings_participant_read on public.ratings;
create policy ratings_participant_read on public.ratings for select to authenticated
  using (
    auth.uid() = rater_id
    or (auth.uid() = ratee_id and revealed_at is not null and hidden_at is null)
    or public.is_app_admin()
  );

create or replace function public.get_ratee_ratings(p_ratee_id uuid, p_direction text)
returns table(aspects jsonb, overall numeric)
language sql
security definer
set search_path = public
as $$
  select r.aspects, r.overall
  from public.ratings r
  where r.ratee_id = p_ratee_id
    and r.direction = p_direction
    and r.revealed_at is not null
    and r.hidden_at is null;
$$;

-- 4. reveal logic ---------------------------------------------------------------------------------
create or replace function public.try_reveal_ratings(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_both boolean;
  v_oldest timestamptz;
begin
  -- An open dispute about the shift itself holds its reviews until it is settled.
  -- A report about a review is not such a dispute.
  if exists (
    select 1 from public.disputes d
    where d.application_id = p_application_id
      and d.category <> 'review_report'
      and d.status in ('open', 'under_review', 'awaiting_info')
  ) then
    return;
  end if;

  select count(distinct direction) = 2, min(created_at)
  into v_both, v_oldest
  from public.ratings
  where application_id = p_application_id;

  if v_both or (v_oldest is not null and v_oldest <= now() - interval '7 days') then
    update public.ratings set revealed_at = now()
    where application_id = p_application_id and revealed_at is null;
  end if;
end;
$$;

create or replace function public.reveal_due_ratings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select distinct application_id from public.ratings
    where revealed_at is null and created_at <= now() - interval '7 days'
  loop
    perform public.try_reveal_ratings(r.application_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.try_reveal_ratings(uuid) from public, anon, authenticated;
revoke all on function public.reveal_due_ratings() from public, anon, authenticated;

create or replace function public.ratings_after_insert_reveal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.try_reveal_ratings(new.application_id);
  return null;
exception when others then
  raise warning 'ratings_after_insert_reveal failed: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_ratings_after_insert_reveal on public.ratings;
create trigger trg_ratings_after_insert_reveal after insert on public.ratings
  for each row execute function public.ratings_after_insert_reveal();

create or replace function public.disputes_settled_reveal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.try_reveal_ratings(new.application_id);
  return null;
exception when others then
  raise warning 'disputes_settled_reveal failed: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_disputes_settled_reveal on public.disputes;
create trigger trg_disputes_settled_reveal after update of status on public.disputes
  for each row when (new.status in ('resolved', 'dismissed') and old.status is distinct from new.status)
  execute function public.disputes_settled_reveal();

do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'reveal-ratings') then
    perform cron.unschedule('reveal-ratings');
  end if;
  perform cron.schedule('reveal-ratings', '7 * * * *', 'select public.reveal_due_ratings()');
exception when others then
  raise warning 'could not schedule reveal-ratings: %', sqlerrm;
end
$cron$;

-- 5. flag suspicious ratings (never blocks the insert) -------------------------------------------------
create or replace function public.flag_suspicious_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prior_low integer;
  v_n integer;
  v_avg numeric;
begin
  if new.overall <= 2 then
    select count(*) into v_prior_low
    from public.ratings
    where rater_id = new.rater_id and ratee_id = new.ratee_id and overall <= 2;
    if v_prior_low >= 1 then
      new.flagged_reason := 'repeat_low';
    else
      select count(*), avg(overall) into v_n, v_avg
      from (select overall from public.ratings where rater_id = new.rater_id order by created_at desc limit 5) x;
      if v_n >= 5 and v_avg < 2.5 then
        new.flagged_reason := 'habitually_low';
      end if;
    end if;
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_flag_suspicious_rating on public.ratings;
create trigger trg_flag_suspicious_rating before insert on public.ratings
  for each row execute function public.flag_suspicious_rating();

-- 6. reporting a review -----------------------------------------------------------------------------------
create unique index if not exists disputes_one_report_per_rating
  on public.disputes (rating_id) where rating_id is not null and category = 'review_report';

create or replace function public.dispute_review_report_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rating record;
begin
  if new.category = 'review_report' and new.rating_id is null then
    raise exception 'A review report must say which review it is about';
  end if;
  if new.rating_id is not null and new.category <> 'review_report' then
    raise exception 'Only a review report can point at a review';
  end if;
  if new.category = 'review_report' then
    select ratee_id, application_id, revealed_at, hidden_at into v_rating
    from public.ratings where id = new.rating_id;
    if v_rating.ratee_id is null
       or v_rating.ratee_id <> new.filed_by
       or v_rating.application_id <> new.application_id
       or v_rating.revealed_at is null then
      raise exception 'You can only report a review that is about you';
    end if;
    if (select count(*) from public.disputes
        where filed_by = new.filed_by and category = 'review_report'
          and created_at > now() - interval '30 days') >= 3 then
      raise exception 'You have reached the limit of 3 review reports in 30 days';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dispute_review_report_guard on public.disputes;
create trigger trg_dispute_review_report_guard before insert on public.disputes
  for each row execute function public.dispute_review_report_guard();

-- 7. the admin outcome ----------------------------------------------------------------------------------------
-- Called by the admin console (a real admin session). Not for the SQL editor, which has no JWT.
create or replace function public.admin_set_review_visibility(p_rating_id uuid, p_hide boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rating record;
  v_title text;
  v_shift uuid;
  v_variant text := case when p_hide then 'hidden' else 'restored' end;
begin
  if not public.is_app_admin() then
    raise exception 'Not authorized';
  end if;
  if p_hide and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to hide a review';
  end if;

  update public.ratings
  set hidden_at = case when p_hide then now() else null end,
      hidden_by = case when p_hide then auth.uid() else null end,
      hide_reason = case when p_hide then left(btrim(p_reason), 500) else null end
  where id = p_rating_id
  returning rater_id, ratee_id, application_id, direction into v_rating;

  if v_rating.rater_id is null then
    raise exception 'Review not found';
  end if;

  select s.title, s.id into v_title, v_shift
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = v_rating.application_id;

  -- employer_to_worker: the rater is the employer and the ratee is the worker.
  perform public.notify_safe(v_rating.rater_id, 'review_visibility',
    case when p_hide then 'A review you wrote was hidden' else 'A review you wrote was restored' end,
    case when p_hide then 'Your review for "' || coalesce(v_title, 'a shift') || '" no longer counts towards their rating.'
         else 'Your review for "' || coalesce(v_title, 'a shift') || '" counts towards their rating again.' end,
    case when v_rating.direction = 'employer_to_worker' then '/employer/shifts/' || v_shift
         else '/worker/applications/' || v_rating.application_id end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', v_variant, 'audience', 'rater'));
  perform public.notify_safe(v_rating.ratee_id, 'review_visibility',
    case when p_hide then 'A review about you was hidden' else 'A review about you was restored' end,
    case when p_hide then 'A review for "' || coalesce(v_title, 'a shift') || '" no longer counts towards your rating.'
         else 'A review for "' || coalesce(v_title, 'a shift') || '" counts towards your rating again.' end,
    case when v_rating.direction = 'employer_to_worker' then '/worker/applications/' || v_rating.application_id
         else '/employer/shifts/' || v_shift end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', v_variant, 'audience', 'ratee'));
end;
$$;

revoke all on function public.admin_set_review_visibility(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_review_visibility(uuid, boolean, text) to authenticated;

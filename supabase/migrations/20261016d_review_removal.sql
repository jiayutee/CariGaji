-- Remove (as opposed to hide) a review.
--
--   hide   - reversible. The review stops counting and showing; everything is kept so it can be restored.
--   remove - permanent. For abuse, the wrong person, or retaliation the team has judged. The written comment is
--            wiped, the review can never be restored, and it counts and shows nowhere. The row itself stays
--            (stars, who removed it, why, when) so there is an audit trail and so the rater cannot simply
--            rate the shift again.

alter table public.ratings
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references auth.users(id),
  add column if not exists remove_reason text;

-- Same function as 20261016b; ONLY `removed_at is null` is added to the two where-clauses.
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
        where ratee_id = v_ratee_id and revealed_at is not null and hidden_at is null and removed_at is null
      ), 0),
      rating_count = (
        select count(*) from public.ratings
        where ratee_id = v_ratee_id and revealed_at is not null and hidden_at is null and removed_at is null
      )
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_recompute_profile_rating on public.ratings;
create trigger trg_recompute_profile_rating
  after insert or delete or update of revealed_at, hidden_at, removed_at on public.ratings
  for each row execute function public.recompute_profile_rating();

drop policy if exists ratings_participant_read on public.ratings;
create policy ratings_participant_read on public.ratings for select to authenticated
  using (
    auth.uid() = rater_id
    or (auth.uid() = ratee_id and revealed_at is not null and hidden_at is null and removed_at is null)
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
    and r.hidden_at is null
    and r.removed_at is null;
$$;

-- A removed review cannot be brought back by the hide/restore function.
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
  v_kind text := case when p_hide then 'hidden' else 'restored' end;
begin
  if not public.is_app_admin() then
    raise exception 'Not authorized';
  end if;
  if p_hide and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to hide a review';
  end if;
  if exists (select 1 from public.ratings where id = p_rating_id and removed_at is not null) then
    raise exception 'This review was removed permanently and cannot be hidden or restored';
  end if;

  update public.ratings
  set hidden_at = case when p_hide then now() else null end,
      hidden_by = case when p_hide then auth.uid() else null end,
      hide_reason = case when p_hide then left(btrim(p_reason), 500) else null end,
      flagged_reason = null
  where id = p_rating_id
  returning rater_id, ratee_id, application_id, direction into v_rating;

  if v_rating.rater_id is null then
    raise exception 'Review not found';
  end if;

  select s.title, s.id into v_title, v_shift
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = v_rating.application_id;

  perform public.notify_safe(v_rating.rater_id, 'review_visibility',
    case when p_hide then 'A review you wrote was hidden' else 'A review you wrote was restored' end,
    case when p_hide then 'Your review for "' || coalesce(v_title, 'a shift') || '" no longer counts towards their rating.'
         else 'Your review for "' || coalesce(v_title, 'a shift') || '" counts towards their rating again.' end,
    case when v_rating.direction = 'employer_to_worker' then '/employer/shifts/' || v_shift
         else '/worker/applications/' || v_rating.application_id end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', v_kind || '_rater'));
  perform public.notify_safe(v_rating.ratee_id, 'review_visibility',
    case when p_hide then 'A review about you was hidden' else 'A review about you was restored' end,
    case when p_hide then 'A review for "' || coalesce(v_title, 'a shift') || '" no longer counts towards your rating.'
         else 'A review for "' || coalesce(v_title, 'a shift') || '" counts towards your rating again.' end,
    case when v_rating.direction = 'employer_to_worker' then '/worker/applications/' || v_rating.application_id
         else '/employer/shifts/' || v_shift end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', v_kind || '_ratee'));
end;
$$;

create or replace function public.admin_remove_review(p_rating_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rating record;
  v_title text;
  v_shift uuid;
begin
  if not public.is_app_admin() then
    raise exception 'Not authorized';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to remove a review';
  end if;
  if exists (select 1 from public.ratings where id = p_rating_id and removed_at is not null) then
    raise exception 'This review was already removed';
  end if;

  update public.ratings
  set removed_at = now(),
      removed_by = auth.uid(),
      remove_reason = left(btrim(p_reason), 500),
      comment = null,
      flagged_reason = null
  where id = p_rating_id
  returning rater_id, ratee_id, application_id, direction into v_rating;

  if v_rating.rater_id is null then
    raise exception 'Review not found';
  end if;

  select s.title, s.id into v_title, v_shift
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = v_rating.application_id;

  perform public.notify_safe(v_rating.rater_id, 'review_visibility',
    'A review you wrote was removed',
    'Your review for "' || coalesce(v_title, 'a shift') || '" was removed by our team and no longer counts.',
    case when v_rating.direction = 'employer_to_worker' then '/employer/shifts/' || v_shift
         else '/worker/applications/' || v_rating.application_id end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', 'removed_rater'));
  perform public.notify_safe(v_rating.ratee_id, 'review_visibility',
    'A review about you was removed',
    'A review for "' || coalesce(v_title, 'a shift') || '" was removed by our team and no longer counts towards your rating.',
    case when v_rating.direction = 'employer_to_worker' then '/worker/applications/' || v_rating.application_id
         else '/employer/shifts/' || v_shift end,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'variant', 'removed_ratee'));
end;
$$;

revoke all on function public.admin_remove_review(uuid, text) from public, anon;
grant execute on function public.admin_remove_review(uuid, text) to authenticated;

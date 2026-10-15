-- 20261016c: two touch-ups to the review-moderation functions in 20261016b.
--   * the "review hidden / restored" notifications carry a variant that already includes who they
--     are for (hidden_rater, hidden_ratee, ...), because the app picks its translated text by variant only;
--   * an admin can clear a flag after looking at a flagged rating (it stays visible, just no longer queued).

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

  -- employer_to_worker: the rater is the employer and the ratee is the worker.
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

create or replace function public.admin_clear_review_flag(p_rating_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_app_admin() then
    raise exception 'Not authorized';
  end if;
  update public.ratings set flagged_reason = null where id = p_rating_id;
end;
$$;

revoke all on function public.admin_clear_review_flag(uuid) from public, anon;
grant execute on function public.admin_clear_review_flag(uuid) to authenticated;

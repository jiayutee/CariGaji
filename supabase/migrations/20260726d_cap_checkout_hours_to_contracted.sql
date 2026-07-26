-- worker_submit_checkout only sanity-checked p_hours against a flat 0-100
-- range, so a worker could report e.g. 99 hours on a 3-hour shift and have
-- it stand until an employer happened to notice and dispute it. Caps
-- reported hours to 150% of the shift's scheduled duration instead, so an
-- inflated report is rejected server-side up front. Skipped when the shift
-- has no computable duration (data gap) rather than blocking checkout
-- outright.

create or replace function public.shift_contracted_hours(p_shift_id uuid)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_shift record;
  v_hours numeric := 0;
  v_occ jsonb;
  v_mins numeric;
begin
  select occurrences, start_at, end_at into v_shift from public.shifts where id = p_shift_id;

  if v_shift.occurrences is not null and jsonb_array_length(v_shift.occurrences) > 0 then
    for v_occ in select * from jsonb_array_elements(v_shift.occurrences) loop
      if v_occ->>'start' is null or v_occ->>'end' is null then continue; end if;
      v_mins := (split_part(v_occ->>'end', ':', 1)::int * 60 + split_part(v_occ->>'end', ':', 2)::int)
              - (split_part(v_occ->>'start', ':', 1)::int * 60 + split_part(v_occ->>'start', ':', 2)::int);
      if v_mins < 0 then v_mins := v_mins + 24 * 60; end if;
      v_hours := v_hours + (v_mins / 60.0);
    end loop;
    return v_hours;
  elsif v_shift.start_at is not null and v_shift.end_at is not null then
    return greatest(0, extract(epoch from (v_shift.end_at - v_shift.start_at)) / 3600.0);
  else
    return 0;
  end if;
end;
$$;

create or replace function public.worker_submit_checkout(
  p_application_id uuid,
  p_hours numeric,
  p_break_minutes int,
  p_note text
)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_contracted_hours numeric;
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.checked_in_at, a.checked_out_at,
         a.employer_hours_confirmed_at, a.employer_hours_disputed
  into v_app
  from public.applications a
  where a.id = p_application_id
  for update;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  if v_app.worker_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.status is distinct from 'accepted' or v_app.checked_in_at is null then
    raise exception 'Cannot check out before checking in';
  end if;

  if v_app.checked_out_at is not null and not v_app.employer_hours_disputed then
    raise exception 'Checkout already submitted';
  end if;

  if p_hours is null or p_hours <= 0 or p_hours > 100 then
    raise exception 'Enter a valid number of hours';
  end if;

  v_contracted_hours := public.shift_contracted_hours(v_app.shift_id);
  if v_contracted_hours > 0 and p_hours > v_contracted_hours * 1.5 then
    raise exception 'Reported hours (%) exceed 150%% of the shift''s scheduled duration (% h). Contact support if you worked significant overtime.', p_hours, v_contracted_hours;
  end if;

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set checked_out_at = now(),
      worker_reported_hours = round(p_hours, 2),
      worker_reported_break_minutes = greatest(coalesce(p_break_minutes, 0), 0),
      worker_checkout_note = nullif(trim(coalesce(p_note, '')), ''),
      employer_hours_confirmed_at = null,
      employer_hours_disputed = false,
      employer_hours_dispute_note = null
  where id = p_application_id
  returning * into v_app;

  insert into public.notifications (user_id, type, title, body, link)
  select s.employer_id, 'shift_checkout_submitted', 'Worker submitted checkout hours',
    'A worker reported ' || round(p_hours, 2) || ' hours for "' || coalesce(s.title, 'a shift') || '". Please confirm or dispute.',
    '/employer/shifts/' || v_app.shift_id
  from public.shifts s where s.id = v_app.shift_id;

  return v_app;
end;
$$;

revoke all on function public.worker_submit_checkout(uuid, numeric, int, text) from public;
grant execute on function public.worker_submit_checkout(uuid, numeric, int, text) to authenticated;

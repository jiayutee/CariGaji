-- End-of-shift checkout (Instaff-inspired backlog item, owner go-ahead
-- 2026-07-26): today the payout scheduler pays every accepted application
-- wage_ask * 1 regardless of hours worked at all (see scheduler.js -- amount
-- was literally `Number(row.wage_ask)`, no hours multiplication whatsoever).
-- This adds a worker-submitted, employer-confirmable actual-hours checkout
-- step, and the scheduler fix (separate JS change) will use the confirmed
-- hours when present, contracted hours otherwise -- fixing the missing
-- multiplication for every shift, checkout or not.

alter table public.applications
  add column if not exists checked_out_at timestamptz,
  add column if not exists worker_reported_hours numeric(6,2),
  add column if not exists worker_reported_break_minutes int,
  add column if not exists worker_checkout_note text,
  add column if not exists employer_hours_confirmed_at timestamptz,
  add column if not exists employer_hours_disputed boolean not null default false,
  add column if not exists employer_hours_dispute_note text;

-- Sum of one shift's occurrence durations in hours (mirrors carigaji-app.jsx's
-- occurrenceHours/totalOccurrenceHours), falling back to start_at/end_at for
-- shifts with no occurrences array. Used to cap worker-reported checkout
-- hours so a check-in can't be paid out at an arbitrarily inflated figure.
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

  -- Allow re-submission only while the employer has disputed the previous
  -- figures and not yet confirmed them; otherwise a submitted+confirmed (or
  -- submitted+pending) checkout is locked.
  if v_app.checked_out_at is not null and not v_app.employer_hours_disputed then
    raise exception 'Checkout already submitted';
  end if;

  if p_hours is null or p_hours <= 0 or p_hours > 100 then
    raise exception 'Enter a valid number of hours';
  end if;

  -- Cap reported hours to 150% of the shift's scheduled duration so a
  -- check-in can't be inflated into an arbitrarily large payout (e.g. 100h
  -- reported on a 4h shift) -- skipped when the shift has no computable
  -- duration (data gap) rather than blocking checkout outright.
  v_contracted_hours := public.shift_contracted_hours(v_app.shift_id);
  if v_contracted_hours > 0 and p_hours > v_contracted_hours * 1.5 then
    raise exception 'Reported hours (%) exceed 150%% of the shift''s scheduled duration (% h). Contact support if you worked significant overtime.', p_hours, v_contracted_hours;
  end if;

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

create or replace function public.employer_confirm_checkout(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_employer_id uuid;
begin
  select a.id, a.shift_id, a.checked_out_at into v_app
  from public.applications a where a.id = p_application_id for update;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  select employer_id into v_employer_id from public.shifts where id = v_app.shift_id;
  if v_employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.checked_out_at is null then
    raise exception 'No checkout submitted yet';
  end if;

  update public.applications
  set employer_hours_confirmed_at = now(),
      employer_hours_disputed = false,
      employer_hours_dispute_note = null
  where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$$;

revoke all on function public.employer_confirm_checkout(uuid) from public;
grant execute on function public.employer_confirm_checkout(uuid) to authenticated;

create or replace function public.employer_dispute_checkout(p_application_id uuid, p_note text)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_employer_id uuid;
begin
  select a.id, a.shift_id, a.worker_id, a.checked_out_at into v_app
  from public.applications a where a.id = p_application_id for update;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  select employer_id into v_employer_id from public.shifts where id = v_app.shift_id;
  if v_employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.checked_out_at is null then
    raise exception 'No checkout submitted yet';
  end if;

  update public.applications
  set employer_hours_disputed = true,
      employer_hours_dispute_note = nullif(trim(coalesce(p_note, '')), ''),
      employer_hours_confirmed_at = null
  where id = p_application_id;

  insert into public.notifications (user_id, type, title, body, link)
  select v_app.worker_id, 'shift_checkout_disputed', 'Employer disputed your checkout hours',
    coalesce('Reason: ' || nullif(trim(coalesce(p_note, '')), ''), 'The employer disputed the hours you reported. Please resubmit.'),
    '/worker/applications/' || v_app.id;

  if not exists (
    select 1 from public.disputes
    where application_id = v_app.id and category = 'hours_disputed' and status = 'open'
  ) then
    insert into public.disputes (application_id, filed_by, filed_by_role, category, description)
    values (
      v_app.id, auth.uid(), 'employer', 'hours_disputed',
      coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Employer disputed worker-reported checkout hours.')
    );
  end if;

  select * into v_app from public.applications where id = p_application_id;
  return v_app;
end;
$$;

revoke all on function public.employer_dispute_checkout(uuid, text) from public;
grant execute on function public.employer_dispute_checkout(uuid, text) to authenticated;

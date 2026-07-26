-- The applications_worker_sign / applications_employer_update RLS policies
-- (20260703b, 20260705e) only constrain the `status` column in their WITH
-- CHECK -- they don't restrict which OTHER columns a permitted UPDATE also
-- touches. That means a worker or employer can already PATCH
-- checked_in_at/checked_out_at/employer_hours_confirmed_at/
-- employer_hours_disputed directly via REST, bypassing worker_check_in,
-- worker_submit_checkout, employer_confirm_checkout and
-- employer_dispute_checkout entirely -- defeating the point of the
-- rotating-code check-in and the employer confirm/dispute step. Same
-- "trusted write" idiom already used for profiles.rating
-- (guard_profile_reputation_and_role) and the cancellation-choice flow
-- (app.cancellation_trusted_write): a BEFORE UPDATE trigger reverts these
-- columns to their prior value unless the write goes through a
-- security-definer RPC that sets the session flag first, or the caller is
-- admin.

create or replace function public.guard_applications_attendance_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.attendance_trusted_write', true), '') = 'true';
begin
  if is_admin or is_trusted_write then
    return new;
  end if;

  new.checked_in_at := old.checked_in_at;
  new.checked_out_at := old.checked_out_at;
  new.worker_reported_hours := old.worker_reported_hours;
  new.worker_reported_break_minutes := old.worker_reported_break_minutes;
  new.worker_checkout_note := old.worker_checkout_note;
  new.employer_hours_confirmed_at := old.employer_hours_confirmed_at;
  new.employer_hours_disputed := old.employer_hours_disputed;
  new.employer_hours_dispute_note := old.employer_hours_dispute_note;

  return new;
end;
$$;

drop trigger if exists applications_guard_attendance_columns on public.applications;
create trigger applications_guard_attendance_columns
before update on public.applications
for each row execute function public.guard_applications_attendance_columns();

-- Every RPC that legitimately writes these columns must set the flag,
-- scoped to the current transaction only (is_local = true), before its
-- UPDATE.

drop function if exists public.worker_check_in(uuid, text);

create or replace function public.worker_check_in(p_application_id uuid, p_code text)
returns public.applications
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_app record;
  v_secret text;
  v_now timestamptz := now();
  v_bucket bigint;
  v_expected text;
  v_ok boolean := false;
  v_offset int;
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at,
         s.employer_id
  into v_app
  from public.applications a
  join public.shifts s on s.id = a.shift_id
  where a.id = p_application_id;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  if v_app.worker_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.status is distinct from 'accepted' or v_app.worker_signed_at is null then
    raise exception 'Cannot check in before contract is signed';
  end if;

  if v_app.checked_in_at is not null then
    raise exception 'Already checked in';
  end if;

  select secret into v_secret from public.shift_checkin_secrets where shift_id = v_app.shift_id;
  if v_secret is null then
    insert into public.shift_checkin_secrets (shift_id) values (v_app.shift_id)
    on conflict (shift_id) do nothing
    returning secret into v_secret;
    if v_secret is null then
      select secret into v_secret from public.shift_checkin_secrets where shift_id = v_app.shift_id;
    end if;
  end if;

  for v_offset in -1..1 loop
    v_bucket := floor(extract(epoch from v_now) / 30) + v_offset;
    v_expected := lpad((abs(('x' || substr(encode(digest(v_secret || ':' || v_bucket::text, 'sha256'), 'hex'), 1, 8))::bit(32)::int) % 1000000)::text, 6, '0');
    if v_expected = p_code then
      v_ok := true;
      exit;
    end if;
  end loop;

  if not v_ok then
    raise exception 'Invalid or expired code';
  end if;

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications set checked_in_at = v_now where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$$;

revoke all on function public.worker_check_in(uuid, text) from public;
grant execute on function public.worker_check_in(uuid, text) to authenticated;

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

  perform set_config('app.attendance_trusted_write', 'true', true);
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

  perform set_config('app.attendance_trusted_write', 'true', true);
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

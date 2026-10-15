-- Dogfood 2026-10-15, the rules the database was missing.
--
--   1. Legal minimum wage. The app tells employers they must not post below
--      RM8.72/hour (contract clause 2, minimum-wage notice), but the only floor
--      the database enforced was RM5. Nothing below RM8.72 exists today (checked
--      before writing this), so the constraint can simply be replaced.
--   2. A booking that is "on hold until you confirm the new terms" could still be
--      checked in to. worker_check_in now refuses until the worker confirms.
--   3. The overtime error leaked raw numerics: "(6.0000000000000000 h)".
--   4. Two employer notifications carried no name ("Someone applied", "A worker
--      reported"). They now send the worker's name as a `named` variant; rows
--      written before this keep their old wording.

-- 1 ---------------------------------------------------------------------------
alter table public.shifts drop constraint if exists shifts_wage_min_check;
alter table public.shifts
  add constraint shifts_wage_min_check check (wage_min >= 8.72);

-- 2 ---------------------------------------------------------------------------
create or replace function public.worker_check_in(p_application_id uuid, p_code text)
returns applications
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_app record;
  v_secret text;
  v_now timestamptz := now();
  v_bucket bigint;
  v_expected text;
  v_ok boolean := false;
  v_offset int;
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at, a.no_show_at,
         a.terms_changed_at, a.terms_reconfirmed_at,
         s.employer_id, s.start_at, s.status as shift_status,
         public.shift_ends_at(s.occurrences, s.end_at) as ends_at
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

  if v_app.shift_status = 'cancelled' then
    raise exception 'This shift was cancelled';
  end if;

  if v_app.no_show_at is not null then
    raise exception 'You were reported as not attending this shift. Ask the employer to review it, or raise a dispute.';
  end if;

  -- The booking is on hold while changed terms await the worker's yes.
  if v_app.terms_changed_at is not null
     and (v_app.terms_reconfirmed_at is null or v_app.terms_reconfirmed_at < v_app.terms_changed_at) then
    raise exception 'The employer changed this shift. Confirm the new terms before checking in.';
  end if;

  if v_now < v_app.start_at - interval '2 hours' then
    raise exception 'Check-in opens 2 hours before the shift starts';
  end if;

  if v_app.ends_at is not null and v_now > v_app.ends_at then
    raise exception 'The shift has ended, so check-in with the code is closed. Ask the employer to check you in.';
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
  update public.applications
  set checked_in_at = v_now, checked_in_method = 'code'
  where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$function$;

-- 3 + 4 (checkout) ---------------------------------------------------------------
create or replace function public.worker_submit_checkout(p_application_id uuid, p_hours numeric, p_break_minutes integer, p_note text)
returns applications
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_app record;
  v_contracted_hours numeric;
  v_ends timestamptz;
  v_worker_name text;
  v_title text;
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.checked_in_at, a.checked_out_at,
         a.employer_hours_confirmed_at, a.employer_hours_disputed,
         a.employer_proposed_hours, a.hours_resubmitted
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

  if v_app.employer_proposed_hours is not null then
    raise exception 'The employer has proposed hours for you. Accept them or reject them first.';
  end if;

  select public.shift_ends_at(s.occurrences, s.end_at) into v_ends
  from public.shifts s where s.id = v_app.shift_id;
  if v_app.checked_out_at is null and not coalesce(v_app.hours_resubmitted, false)
     and v_ends is not null and now() > v_ends + interval '48 hours' then
    raise exception 'The 48-hour check-out window has closed. Ask the employer to submit your hours, or raise a dispute.';
  end if;

  if p_hours is null or p_hours <= 0 or p_hours > 100 then
    raise exception 'Enter a valid number of hours';
  end if;

  v_contracted_hours := public.shift_contracted_hours(v_app.shift_id);
  if v_contracted_hours > 0 and p_hours > v_contracted_hours * 1.5 then
    raise exception 'Reported hours (%) exceed 150%% of the shift''s scheduled duration (% h). Contact support if you worked significant overtime.',
      trim_scale(round(p_hours, 2)), trim_scale(round(v_contracted_hours, 2));
  end if;

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set checked_out_at = now(),
      checked_out_method = 'worker',
      worker_reported_hours = round(p_hours, 2),
      worker_reported_break_minutes = greatest(coalesce(p_break_minutes, 0), 0),
      worker_checkout_note = nullif(trim(coalesce(p_note, '')), ''),
      employer_hours_confirmed_at = null,
      employer_hours_disputed = false,
      employer_hours_dispute_note = null
  where id = p_application_id
  returning * into v_app;

  select coalesce(nullif(trim(full_name), ''), 'A worker') into v_worker_name
  from public.profiles where id = v_app.worker_id;
  v_title := coalesce((select s.title from public.shifts s where s.id = v_app.shift_id), 'a shift');

  perform public.notify_safe(
    (select s.employer_id from public.shifts s where s.id = v_app.shift_id),
    'shift_checkout_submitted', 'Worker submitted checkout hours',
    coalesce(v_worker_name, 'A worker') || ' reported ' || round(p_hours, 2) || ' hours for "' || v_title || '". Please confirm or dispute.',
    '/employer/shifts/' || v_app.shift_id,
    jsonb_build_object('variant', 'named', 'worker_name', coalesce(v_worker_name, 'A worker'),
                       'shift_title', v_title, 'hours', round(p_hours, 2))
  );

  return v_app;
end;
$function$;

-- 4 (new application) -----------------------------------------------------------
create or replace function public.notify_bid_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_employer_id uuid;
  v_shift_title text;
  v_worker_name text;
begin
  select employer_id, title into v_employer_id, v_shift_title
  from public.shifts
  where id = new.shift_id;

  select coalesce(nullif(trim(full_name), ''), 'Someone') into v_worker_name
  from public.profiles where id = new.worker_id;

  if v_employer_id is not null then
    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      v_employer_id,
      'bid_received',
      'New application received',
      coalesce(v_worker_name, 'Someone') || ' applied for "' || coalesce(v_shift_title, 'your shift') || '".',
      '/employer/shifts/' || new.shift_id,
      jsonb_build_object('variant', 'named', 'worker_name', coalesce(v_worker_name, 'Someone'),
                         'shift_title', coalesce(v_shift_title, 'your shift'))
    );
  end if;

  return null;

exception when others then
  raise warning 'notify_bid_received failed: %', sqlerrm;
  return null;
end;
$function$;

-- Attendance windows, missed check-in/out recovery, and reminders.
--
-- WHAT WAS WRONG (live DB, 2026-09-19)
--   * worker_check_in had NO time window: the 2h-before / 2h-after guard in
--     20260725d was dropped when 20260726b rewrote the function. A worker could
--     check in days after the shift ended.
--   * worker_submit_checkout had no deadline either.
--   * A worker who forgot to check in/out had no route at all: no way to tell
--     the employer, and the employer had no way to check someone in or submit
--     hours for them. employer_mark_no_show existed but nothing reversed it.
--   * No reminders (no scheduler at all until now).
--
-- WHAT THIS ADDS
--   Windows      check-in: 2h before start -> last occurrence end.
--                check-out: -> 48h after last occurrence end (bypassed once a
--                proposal has been rejected: the resubmission must still work).
--   Recovery     worker_request_attendance          worker asks the employer
--                employer_check_in_worker           employer checks the worker in
--                employer_decline_attendance_request
--                employer_submit_hours_for_worker   employer submits hours; the
--                                                   worker must still accept them
--                employer_undo_no_show              employer reverses their mark
--                admin_apply_attendance_correction  final say on a dispute
--   Reminders    send_attendance_reminders(), run by pg_cron every 10 minutes:
--                missed check-in (once), check-out reminder right after the
--                shift then every 8h until the window closes, window-closed
--                notice, and employer nudges for hours awaiting confirmation.
--
-- MONEY SAFETY: every path that confirms hours still goes through the existing
-- employer_hours_confirmed_at null -> not-null transition the payout trigger
-- watches (20260821b); nothing here writes a payout directly.

-- ── audit columns ───────────────────────────────────────────────────────────
alter table public.applications
  add column if not exists checked_in_method  text check (checked_in_method  in ('code', 'employer', 'admin')),
  add column if not exists checked_out_method text check (checked_out_method in ('worker', 'employer', 'admin'));

do $backfill$
begin
  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications set checked_in_method  = 'code'   where checked_in_at  is not null and checked_in_method  is null;
  update public.applications set checked_out_method = 'worker' where checked_out_at is not null and checked_out_method is null;
  perform set_config('app.attendance_trusted_write', 'false', true);
end $backfill$;

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
  new.checked_in_method := old.checked_in_method;
  new.checked_out_method := old.checked_out_method;
  new.worker_reported_hours := old.worker_reported_hours;
  new.worker_reported_break_minutes := old.worker_reported_break_minutes;
  new.worker_checkout_note := old.worker_checkout_note;
  new.employer_hours_confirmed_at := old.employer_hours_confirmed_at;
  new.employer_hours_disputed := old.employer_hours_disputed;
  new.employer_hours_dispute_note := old.employer_hours_dispute_note;

  return new;
end;
$$;

-- ── requests: the worker's "please fix my attendance" ───────────────────────
create table if not exists public.attendance_requests (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  kind           text not null check (kind in ('check_in', 'check_out')),
  note           text,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  response_note  text,
  created_at     timestamptz not null default now(),
  responded_at   timestamptz
);

create unique index if not exists attendance_requests_one_pending
  on public.attendance_requests (application_id, kind) where status = 'pending';

alter table public.attendance_requests enable row level security;

-- SECURITY DEFINER so the policy does not re-enter the applications/shifts
-- policies (see 20260717j: those two recurse through each other).
create or replace function public.attendance_request_visible(p_application_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
      or exists (
           select 1
           from public.applications a
           join public.shifts s on s.id = a.shift_id
           where a.id = p_application_id
             and (a.worker_id = auth.uid() or s.employer_id = auth.uid())
         );
$$;

drop policy if exists attendance_requests_read on public.attendance_requests;
create policy attendance_requests_read on public.attendance_requests
  for select to authenticated
  using (public.attendance_request_visible(application_id));
-- No insert/update/delete policies on purpose: rows are written only by the
-- SECURITY DEFINER RPCs below.
grant select on public.attendance_requests to authenticated;

create table if not exists public.attendance_reminders (
  application_id uuid not null references public.applications(id) on delete cascade,
  kind           text not null,
  sent_count     int  not null default 0,
  last_sent_at   timestamptz,
  primary key (application_id, kind)
);
alter table public.attendance_reminders enable row level security;
-- RLS on, no policies: internal bookkeeping, never client-readable.

-- ── notification types ──────────────────────────────────────────────────────
-- Full list read from the LIVE constraint on 2026-09-19 (20 types) plus 14 new.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed',
    'shift_updated', 'shift_terms_changed',
    'worker_withdrew', 'slot_reopened', 'marked_no_show',
    'payout_created',
    'shift_hours_modification_proposed', 'shift_hours_modification_rejected',
    'attendance_missed_checkin', 'attendance_employer_missed_checkin',
    'attendance_request', 'attendance_request_reminder',
    'attendance_request_approved', 'attendance_request_declined',
    'attendance_checkout_reminder', 'attendance_checkout_window_closed',
    'attendance_employer_not_checked_out', 'shift_hours_submitted_on_behalf',
    'hours_confirmation_reminder', 'hours_awaiting_employer',
    'no_show_reversed', 'attendance_admin_ruling'
  ));

do $verify$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notifications_type_check' and conrelid = 'public.notifications'::regclass
      and pg_get_constraintdef(oid) like '%attendance_admin_ruling%'
      and pg_get_constraintdef(oid) like '%payout_created%'
      and pg_get_constraintdef(oid) like '%shift_hours_modification_rejected%'
  ) then
    raise exception 'WIDEN FAILED: notifications_type_check missing expected types';
  end if;
end $verify$;

-- ── helpers ─────────────────────────────────────────────────────────────────
-- A notification must never be able to roll back the real action it announces.
create or replace function public.notify_safe(
  p_user uuid, p_type text, p_title text, p_body text, p_link text, p_params jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, title, body, link, params)
  values (p_user, p_type, p_title, p_body, p_link, coalesce(p_params, '{}'::jsonb));
exception when others then
  raise warning 'notify_safe: % notification for % failed (%)', p_type, p_user, sqlerrm;
end;
$$;
revoke all on function public.notify_safe(uuid, text, text, text, text, jsonb) from public;

create or replace function public.mark_attendance_reminder(p_application_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.attendance_reminders (application_id, kind, sent_count, last_sent_at)
  values (p_application_id, p_kind, 1, now())
  on conflict (application_id, kind)
  do update set sent_count = public.attendance_reminders.sent_count + 1, last_sent_at = now();
$$;
revoke all on function public.mark_attendance_reminder(uuid, text) from public;

-- Undo a no-show mark and give the reliability points back. Shared by the
-- employer (their own mark), employer-assisted check-in, and the admin.
create or replace function public.reverse_no_show(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker uuid;
  v_penalty int;
  v_at timestamptz;
begin
  select worker_id, no_show_penalty, no_show_at into v_worker, v_penalty, v_at
  from public.applications where id = p_application_id;
  if v_at is null then
    return;
  end if;

  perform set_config('app.no_show_trusted_write', 'true', true);
  update public.applications
  set no_show_at = null, no_show_note = null, no_show_penalty = null, updated_at = now()
  where id = p_application_id;
  perform set_config('app.no_show_trusted_write', 'false', true);

  perform set_config('app.reliability_trusted_write', 'true', true);
  update public.profiles
  set reliability_score = least(coalesce(reliability_score, 100) + coalesce(v_penalty, 0), 100)
  where id = v_worker;
  perform set_config('app.reliability_trusted_write', 'false', true);
end;
$$;
revoke all on function public.reverse_no_show(uuid) from public;

-- ── worker_check_in: add the window ─────────────────────────────────────────
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
  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at, a.no_show_at,
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
$$;

-- ── worker_submit_checkout: add the 48h window + pending-proposal guard ─────
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
  v_ends timestamptz;
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

  -- The window applies to the FIRST checkout only. A resubmission after a
  -- dispute (checked_out_at set) or after rejecting a proposal
  -- (hours_resubmitted) is part of an open negotiation and must always work.
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
    raise exception 'Reported hours (%) exceed 150%% of the shift''s scheduled duration (% h). Contact support if you worked significant overtime.', p_hours, v_contracted_hours;
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

  perform public.notify_safe(
    (select s.employer_id from public.shifts s where s.id = v_app.shift_id),
    'shift_checkout_submitted', 'Worker submitted checkout hours',
    'A worker reported ' || round(p_hours, 2) || ' hours for "' ||
      coalesce((select s.title from public.shifts s where s.id = v_app.shift_id), 'a shift') || '". Please confirm or dispute.',
    '/employer/shifts/' || v_app.shift_id,
    jsonb_build_object('shift_title', coalesce((select s.title from public.shifts s where s.id = v_app.shift_id), 'a shift'), 'hours', round(p_hours, 2))
  );

  return v_app;
end;
$$;

-- ── worker asks the employer to fix their attendance ────────────────────────
create or replace function public.worker_request_attendance(p_application_id uuid, p_kind text, p_note text default null)
returns public.attendance_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_name text;
  v_req public.attendance_requests;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_kind not in ('check_in', 'check_out') then
    raise exception 'Unknown request type';
  end if;

  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at, a.checked_out_at,
         a.employer_hours_confirmed_at, a.hours_resubmitted, a.employer_proposed_hours,
         s.employer_id, s.title, s.start_at, s.status as shift_status,
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
    raise exception 'Only a confirmed worker can make this request';
  end if;
  if v_app.shift_status = 'cancelled' then
    raise exception 'This shift was cancelled';
  end if;

  if p_kind = 'check_in' then
    if v_app.checked_in_at is not null then
      raise exception 'You are already checked in';
    end if;
    if now() < v_app.start_at then
      raise exception 'The shift has not started yet';
    end if;
  else
    if v_app.checked_in_at is null then
      raise exception 'Ask the employer to check you in first';
    end if;
    if v_app.checked_out_at is not null or v_app.employer_hours_confirmed_at is not null then
      raise exception 'Your hours have already been submitted';
    end if;
    if v_app.employer_proposed_hours is not null then
      raise exception 'The employer has already proposed hours for you';
    end if;
    -- Inside the window (or mid-negotiation) the worker can check out
    -- themselves; the request exists for when they no longer can.
    if v_app.ends_at is null or now() <= v_app.ends_at + interval '48 hours' or coalesce(v_app.hours_resubmitted, false) then
      raise exception 'You can still check out yourself';
    end if;
  end if;

  if exists (select 1 from public.attendance_requests where application_id = p_application_id and kind = p_kind and status = 'pending') then
    raise exception 'You already asked. Waiting for the employer to respond';
  end if;

  insert into public.attendance_requests (application_id, kind, note)
  values (p_application_id, p_kind, v_note)
  returning * into v_req;

  select full_name into v_name from public.profiles where id = v_app.worker_id;
  perform public.notify_safe(
    v_app.employer_id, 'attendance_request',
    case p_kind when 'check_in' then 'A worker asks to be checked in' else 'A worker asks you to submit their hours' end,
    coalesce(v_name, 'A worker') ||
      case p_kind when 'check_in' then ' says they attended "' else ' could not check out of "' end ||
      coalesce(v_app.title, 'a shift') || '"' ||
      case p_kind when 'check_in' then ' but missed check-in.' else ' in time.' end ||
      coalesce(' Note: ' || v_note, ''),
    '/employer/shifts/' || v_app.shift_id,
    jsonb_build_object('worker_name', coalesce(v_name, 'A worker'), 'shift_title', coalesce(v_app.title, 'a shift'), 'kind', p_kind, 'note', v_note)
  );

  return v_req;
end;
$$;
revoke all on function public.worker_request_attendance(uuid, text, text) from public;
grant execute on function public.worker_request_attendance(uuid, text, text) to authenticated;

-- ── employer checks the worker in on their behalf ───────────────────────────
create or replace function public.employer_check_in_worker(p_application_id uuid, p_note text default null)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at,
         s.employer_id, s.title, s.start_at, s.status as shift_status
  into v_app
  from public.applications a
  join public.shifts s on s.id = a.shift_id
  where a.id = p_application_id
  for update of a;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;
  if v_app.employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_app.status is distinct from 'accepted' or v_app.worker_signed_at is null then
    raise exception 'Only a confirmed worker who signed the contract can be checked in';
  end if;
  if v_app.shift_status = 'cancelled' then
    raise exception 'This shift was cancelled';
  end if;
  if v_app.checked_in_at is not null then
    raise exception 'This worker is already checked in';
  end if;
  if now() < v_app.start_at then
    raise exception 'The shift has not started yet';
  end if;

  -- The employer attesting attendance overrides their own earlier no-show mark.
  perform public.reverse_no_show(p_application_id);

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set checked_in_at = v_app.start_at, checked_in_method = 'employer', updated_at = now()
  where id = p_application_id
  returning * into v_app;

  update public.attendance_requests
  set status = 'approved', responded_at = now(), response_note = v_note
  where application_id = p_application_id and kind = 'check_in' and status = 'pending';

  perform public.notify_safe(
    v_app.worker_id, 'attendance_request_approved', 'The employer checked you in',
    'The employer confirmed you attended "' ||
      coalesce((select title from public.shifts where id = v_app.shift_id), 'a shift') ||
      '" and checked you in. You can now submit your hours.',
    '/worker/applications/' || v_app.id,
    jsonb_build_object('shift_title', coalesce((select title from public.shifts where id = v_app.shift_id), 'a shift'), 'kind', 'check_in')
  );

  return v_app;
end;
$$;
revoke all on function public.employer_check_in_worker(uuid, text) from public;
grant execute on function public.employer_check_in_worker(uuid, text) to authenticated;

-- ── employer declines a worker's request ────────────────────────────────────
create or replace function public.employer_decline_attendance_request(p_request_id uuid, p_note text default null)
returns public.attendance_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.attendance_requests;
  v_worker uuid;
  v_shift uuid;
  v_title text;
  v_employer uuid;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select r.* into v_req from public.attendance_requests r where r.id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Request not found';
  end if;

  select a.worker_id, a.shift_id, s.employer_id, s.title
  into v_worker, v_shift, v_employer, v_title
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = v_req.application_id;

  if v_employer is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already answered';
  end if;

  update public.attendance_requests
  set status = 'declined', responded_at = now(), response_note = v_note
  where id = p_request_id
  returning * into v_req;

  perform public.notify_safe(
    v_worker, 'attendance_request_declined',
    case v_req.kind when 'check_in' then 'The employer did not check you in' else 'The employer did not submit your hours' end,
    'For "' || coalesce(v_title, 'a shift') || '": ' ||
      coalesce(v_note, 'the employer declined your request') ||
      '. If you disagree you can raise a dispute from the shift and an admin will review it.',
    '/worker/applications/' || v_req.application_id,
    jsonb_build_object('shift_title', coalesce(v_title, 'a shift'), 'kind', v_req.kind, 'note', v_note)
  );

  return v_req;
end;
$$;
revoke all on function public.employer_decline_attendance_request(uuid, text) from public;
grant execute on function public.employer_decline_attendance_request(uuid, text) to authenticated;

-- ── employer submits hours for a worker who never checked out ───────────────
-- Recorded as a PROPOSAL, not a confirmation: the worker still has to accept
-- (which is what confirms the hours and triggers the payout). An employer can
-- never pay a worker a figure the worker has not agreed to.
create or replace function public.employer_submit_hours_for_worker(p_application_id uuid, p_hours numeric, p_note text default null)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.checked_in_at, a.checked_out_at,
         a.employer_hours_confirmed_at, a.employer_proposed_hours, a.hours_resubmitted,
         s.employer_id, s.title, public.shift_ends_at(s.occurrences, s.end_at) as ends_at
  into v_app
  from public.applications a
  join public.shifts s on s.id = a.shift_id
  where a.id = p_application_id
  for update of a;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;
  if v_app.employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_app.status is distinct from 'accepted' then
    raise exception 'Only a confirmed worker';
  end if;
  if v_app.checked_in_at is null then
    raise exception 'Check the worker in first';
  end if;
  if v_app.checked_out_at is not null then
    raise exception 'The worker already submitted their hours';
  end if;
  if v_app.employer_hours_confirmed_at is not null then
    raise exception 'Hours are already confirmed';
  end if;
  if v_app.employer_proposed_hours is not null then
    raise exception 'A proposal is already waiting for the worker';
  end if;
  if coalesce(v_app.hours_resubmitted, false) then
    raise exception 'The worker rejected a proposal and is resubmitting their own hours. Wait for them, or raise a dispute.';
  end if;
  if v_app.ends_at is not null and now() <= v_app.ends_at then
    raise exception 'The shift has not ended yet';
  end if;
  if p_hours is null or p_hours <= 0 or p_hours > 100 then
    raise exception 'Enter a valid number of hours';
  end if;

  update public.applications
  set employer_proposed_hours = round(p_hours, 2),
      employer_proposed_note  = v_note,
      employer_proposed_at    = now()
  where id = p_application_id
  returning * into v_app;

  update public.attendance_requests
  set status = 'approved', responded_at = now(), response_note = v_note
  where application_id = p_application_id and kind = 'check_out' and status = 'pending';

  perform public.notify_safe(
    v_app.worker_id, 'shift_hours_submitted_on_behalf', 'The employer submitted your hours',
    'The employer recorded ' || round(p_hours, 2) || ' hours for "' ||
      coalesce((select title from public.shifts where id = v_app.shift_id), 'a shift') ||
      '" because you did not check out.' || coalesce(' Note: ' || v_note, '') ||
      ' Accept them to be paid, or reject and submit your own.',
    '/worker/applications/' || v_app.id,
    jsonb_build_object('shift_title', coalesce((select title from public.shifts where id = v_app.shift_id), 'a shift'), 'hours', round(p_hours, 2), 'note', v_note)
  );

  return v_app;
end;
$$;
revoke all on function public.employer_submit_hours_for_worker(uuid, numeric, text) from public;
grant execute on function public.employer_submit_hours_for_worker(uuid, numeric, text) to authenticated;

-- ── worker_accept_modification: also covers employer-submitted hours ────────
-- Identical to 20260914d except an accept with no checkout on file (the
-- employer submitted the hours) stamps the checkout as employer-made.
create or replace function public.worker_accept_modification(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
begin
  select a.id, a.worker_id, a.employer_proposed_hours
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
  if v_app.employer_proposed_hours is null then
    raise exception 'No pending proposal to accept';
  end if;

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set worker_reported_hours       = employer_proposed_hours,
      checked_out_method          = case when checked_out_at is null then 'employer' else checked_out_method end,
      checked_out_at              = coalesce(checked_out_at, now()),
      employer_hours_confirmed_at = now(),
      employer_hours_disputed     = false,
      employer_proposed_hours     = null,
      employer_proposed_note      = null,
      employer_proposed_at        = null
  where id = p_application_id
  returning * into v_app;

  perform public.close_hours_dispute(p_application_id, 'Auto-resolved: the worker accepted the employer''s proposed hours.');

  return v_app;
end;
$$;

-- ── employer reverses their own no-show mark ────────────────────────────────
create or replace function public.employer_undo_no_show(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
begin
  select a.id, a.worker_id, a.shift_id, a.no_show_at, s.employer_id, s.title
  into v_app
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = p_application_id;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;
  if v_app.employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_app.no_show_at is null then
    raise exception 'This worker is not marked as a no-show';
  end if;

  perform public.reverse_no_show(p_application_id);

  perform public.notify_safe(
    v_app.worker_id, 'no_show_reversed', 'Your no-show report was withdrawn',
    'The employer withdrew the no-show report for "' || coalesce(v_app.title, 'a shift') || '" and your reliability points were restored.',
    '/worker/applications/' || v_app.id,
    jsonb_build_object('shift_title', coalesce(v_app.title, 'a shift'))
  );

  select * into v_app from public.applications where id = p_application_id;
  return v_app;
end;
$$;
revoke all on function public.employer_undo_no_show(uuid) from public;
grant execute on function public.employer_undo_no_show(uuid) to authenticated;

-- ── admin: final say on an attendance dispute ───────────────────────────────
create or replace function public.admin_apply_attendance_correction(
  p_dispute_id uuid, p_outcome text, p_hours numeric default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  v_disp record;
  v_app record;
  v_tier public.cancellation_tiers;
  v_penalty int;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_label text;
begin
  if not is_admin then
    raise exception 'Not authorized';
  end if;
  if p_outcome not in ('grant_attendance', 'confirm_no_show', 'reverse_no_show') then
    raise exception 'Unknown outcome';
  end if;

  select d.id, d.application_id, d.status into v_disp from public.disputes d where d.id = p_dispute_id for update;
  if v_disp.id is null then
    raise exception 'Dispute not found';
  end if;
  if v_disp.status in ('resolved', 'dismissed') then
    raise exception 'This dispute is already closed';
  end if;

  select a.id, a.worker_id, a.shift_id, a.checked_in_at, a.checked_out_at, a.no_show_at,
         a.employer_hours_confirmed_at, s.employer_id, s.title, s.start_at,
         public.shift_ends_at(s.occurrences, s.end_at) as ends_at
  into v_app
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = v_disp.application_id
  for update of a;

  if p_outcome = 'grant_attendance' then
    if p_hours is null or p_hours <= 0 or p_hours > 100 then
      raise exception 'Enter the hours to pay (between 0 and 100)';
    end if;
    if v_app.employer_hours_confirmed_at is not null then
      raise exception 'Hours are already confirmed and paid; this cannot be re-paid here';
    end if;
    perform public.reverse_no_show(v_app.id);
    perform set_config('app.attendance_trusted_write', 'true', true);
    update public.applications
    set checked_in_method = case when checked_in_at is null then 'admin' else checked_in_method end,
        checked_in_at = coalesce(checked_in_at, v_app.start_at),
        checked_out_method = case when checked_out_at is null then 'admin' else checked_out_method end,
        checked_out_at = coalesce(checked_out_at, least(now(), coalesce(v_app.ends_at, now()))),
        worker_reported_hours = round(p_hours, 2),
        employer_hours_confirmed_at = now(),
        employer_hours_disputed = false,
        employer_hours_dispute_note = null,
        employer_proposed_hours = null, employer_proposed_note = null, employer_proposed_at = null,
        updated_at = now()
    where id = v_app.id;
    v_label := 'Attendance granted and ' || round(p_hours, 2) || ' hours confirmed for payment';

  elsif p_outcome = 'confirm_no_show' then
    if v_app.checked_in_at is not null then
      raise exception 'The worker has a check-in on record, so this cannot be a no-show';
    end if;
    if v_app.no_show_at is null then
      v_tier := public.cancellation_tier_for('worker_no_show', 0);
      v_penalty := coalesce(v_tier.reliability_penalty, 25);
      perform set_config('app.no_show_trusted_write', 'true', true);
      update public.applications
      set no_show_at = now(), no_show_note = coalesce(v_note, 'Confirmed by admin'), no_show_penalty = v_penalty, updated_at = now()
      where id = v_app.id;
      perform set_config('app.no_show_trusted_write', 'false', true);
      perform set_config('app.reliability_trusted_write', 'true', true);
      update public.profiles set reliability_score = greatest(coalesce(reliability_score, 100) - v_penalty, 0) where id = v_app.worker_id;
      perform set_config('app.reliability_trusted_write', 'false', true);
    end if;
    v_label := 'No-show confirmed';

  else
    if v_app.no_show_at is null then
      raise exception 'There is no no-show mark to reverse';
    end if;
    perform public.reverse_no_show(v_app.id);
    v_label := 'No-show reversed and reliability points restored';
  end if;

  update public.disputes
  set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
      admin_notes = case when coalesce(admin_notes, '') = '' then v_label || coalesce('. ' || v_note, '')
                         else admin_notes || E'\n' || v_label || coalesce('. ' || v_note, '') end
  where id = p_dispute_id;

  perform public.notify_safe(v_app.worker_id, 'attendance_admin_ruling', 'An admin ruled on your dispute',
    v_label || ' for "' || coalesce(v_app.title, 'a shift') || '".' || coalesce(' ' || v_note, ''),
    '/worker/applications/' || v_app.id,
    jsonb_build_object('shift_title', coalesce(v_app.title, 'a shift'), 'outcome', p_outcome, 'note', v_note));
  perform public.notify_safe(v_app.employer_id, 'attendance_admin_ruling', 'An admin ruled on an attendance dispute',
    v_label || ' for "' || coalesce(v_app.title, 'a shift') || '".' || coalesce(' ' || v_note, ''),
    '/employer/shifts/' || v_app.shift_id,
    jsonb_build_object('shift_title', coalesce(v_app.title, 'a shift'), 'outcome', p_outcome, 'note', v_note));

  return jsonb_build_object('outcome', p_outcome, 'summary', v_label);
end;
$$;
revoke all on function public.admin_apply_attendance_correction(uuid, text, numeric, text) from public;
grant execute on function public.admin_apply_attendance_correction(uuid, text, numeric, text) to authenticated;

-- ── reminders ───────────────────────────────────────────────────────────────
-- Bounded on purpose: every rule only looks at a recent window, so the first
-- run cannot flood users about shifts that ended long ago.
create or replace function public.send_attendance_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_sent int := 0;
  v_hours_left int;
begin
  -- 1. Missed check-in (once, within 7 days of the shift ending).
  for r in
    select a.id as app_id, a.worker_id, s.id as shift_id, s.employer_id, s.title, w.full_name
    from public.applications a
    join public.shifts s on s.id = a.shift_id
    left join public.profiles w on w.id = a.worker_id
    where a.status = 'accepted' and a.worker_signed_at is not null
      and a.checked_in_at is null and a.no_show_at is null
      and s.status <> 'cancelled'
      and public.shift_ends_at(s.occurrences, s.end_at) < now()
      and public.shift_ends_at(s.occurrences, s.end_at) > now() - interval '7 days'
      and not exists (select 1 from public.attendance_reminders m where m.application_id = a.id and m.kind = 'missed_checkin')
  loop
    perform public.notify_safe(r.worker_id, 'attendance_missed_checkin', 'You missed check-in',
      'The shift "' || coalesce(r.title, 'a shift') || '" has ended and you did not check in. If you attended, open the shift and ask the employer to check you in. If they disagree you can raise a dispute.',
      '/worker/applications/' || r.app_id, jsonb_build_object('shift_title', coalesce(r.title, 'a shift')));
    perform public.notify_safe(r.employer_id, 'attendance_employer_missed_checkin', 'A worker did not check in',
      coalesce(r.full_name, 'A worker') || ' did not check in for "' || coalesce(r.title, 'a shift') || '". If they attended, check them in on their behalf; otherwise report a no-show.',
      '/employer/shifts/' || r.shift_id, jsonb_build_object('worker_name', coalesce(r.full_name, 'A worker'), 'shift_title', coalesce(r.title, 'a shift')));
    perform public.mark_attendance_reminder(r.app_id, 'missed_checkin');
    v_sent := v_sent + 2;
  end loop;

  -- 2. Check-out reminders: right after the shift, then every 8 hours until
  --    the 48h window closes. A worker who rejected a proposal and owes a
  --    resubmission keeps being nudged (capped at 14 days) even past the window.
  for r in
    select a.id as app_id, a.worker_id, s.title, a.hours_resubmitted,
           public.shift_ends_at(s.occurrences, s.end_at) as ends_at
    from public.applications a
    join public.shifts s on s.id = a.shift_id
    left join public.attendance_reminders m on m.application_id = a.id and m.kind = 'checkout'
    where a.status = 'accepted' and a.checked_in_at is not null and a.checked_out_at is null
      and a.employer_hours_confirmed_at is null and a.employer_proposed_hours is null
      and s.status <> 'cancelled'
      and public.shift_ends_at(s.occurrences, s.end_at) < now()
      and ( now() <= public.shift_ends_at(s.occurrences, s.end_at) + interval '48 hours'
            or (coalesce(a.hours_resubmitted, false) and now() <= public.shift_ends_at(s.occurrences, s.end_at) + interval '14 days') )
      and (m.application_id is null or m.last_sent_at <= now() - interval '7 hours 55 minutes')
  loop
    if coalesce(r.hours_resubmitted, false) then
      perform public.notify_safe(r.worker_id, 'attendance_checkout_reminder', 'Resubmit your hours',
        'You rejected the employer''s proposal for "' || coalesce(r.title, 'a shift') || '". Please submit your own hours so the employer can review them.',
        '/worker/applications/' || r.app_id, jsonb_build_object('shift_title', coalesce(r.title, 'a shift'), 'variant', 'resubmit'));
    else
      v_hours_left := greatest(ceil(extract(epoch from (r.ends_at + interval '48 hours' - now())) / 3600.0)::int, 1);
      perform public.notify_safe(r.worker_id, 'attendance_checkout_reminder', 'Check out of your shift',
        'Please submit your hours for "' || coalesce(r.title, 'a shift') || '". You have about ' || v_hours_left || ' hours left to check out.',
        '/worker/applications/' || r.app_id, jsonb_build_object('shift_title', coalesce(r.title, 'a shift'), 'hours_left', v_hours_left, 'variant', 'window'));
    end if;
    perform public.mark_attendance_reminder(r.app_id, 'checkout');
    v_sent := v_sent + 1;
  end loop;

  -- 3. Check-out window closed (once, both sides).
  for r in
    select a.id as app_id, a.worker_id, s.id as shift_id, s.employer_id, s.title, w.full_name
    from public.applications a
    join public.shifts s on s.id = a.shift_id
    left join public.profiles w on w.id = a.worker_id
    where a.status = 'accepted' and a.checked_in_at is not null and a.checked_out_at is null
      and a.employer_hours_confirmed_at is null and a.employer_proposed_hours is null
      and not coalesce(a.hours_resubmitted, false)
      and s.status <> 'cancelled'
      and public.shift_ends_at(s.occurrences, s.end_at) + interval '48 hours' < now()
      and public.shift_ends_at(s.occurrences, s.end_at) + interval '48 hours' > now() - interval '14 days'
      and not exists (select 1 from public.attendance_reminders m where m.application_id = a.id and m.kind = 'checkout_closed')
  loop
    perform public.notify_safe(r.worker_id, 'attendance_checkout_window_closed', 'Check-out window closed',
      'The 48-hour window to check out of "' || coalesce(r.title, 'a shift') || '" has closed. Ask the employer to submit your hours on your behalf, or raise a dispute.',
      '/worker/applications/' || r.app_id, jsonb_build_object('shift_title', coalesce(r.title, 'a shift')));
    perform public.notify_safe(r.employer_id, 'attendance_employer_not_checked_out', 'A worker did not check out',
      coalesce(r.full_name, 'A worker') || ' did not check out of "' || coalesce(r.title, 'a shift') || '" within 48 hours. You can submit their hours on their behalf.',
      '/employer/shifts/' || r.shift_id, jsonb_build_object('worker_name', coalesce(r.full_name, 'A worker'), 'shift_title', coalesce(r.title, 'a shift')));
    perform public.mark_attendance_reminder(r.app_id, 'checkout_closed');
    v_sent := v_sent + 2;
  end loop;

  -- 4. Employer: submitted hours still unconfirmed. Daily from 24h, for 7 days.
  for r in
    select a.id as app_id, s.id as shift_id, s.employer_id, s.title, w.full_name
    from public.applications a
    join public.shifts s on s.id = a.shift_id
    left join public.profiles w on w.id = a.worker_id
    left join public.attendance_reminders m on m.application_id = a.id and m.kind = 'confirm_hours'
    where a.status = 'accepted' and a.checked_out_at is not null
      and a.employer_hours_confirmed_at is null and not coalesce(a.employer_hours_disputed, false)
      and a.employer_proposed_hours is null
      and s.status <> 'cancelled'
      and a.checked_out_at <= now() - interval '24 hours' and a.checked_out_at > now() - interval '7 days'
      and (m.application_id is null or m.last_sent_at <= now() - interval '23 hours 55 minutes')
  loop
    perform public.notify_safe(r.employer_id, 'hours_confirmation_reminder', 'Hours are waiting for your confirmation',
      coalesce(r.full_name, 'A worker') || ' submitted hours for "' || coalesce(r.title, 'a shift') || '". Please confirm them, propose different hours, or dispute.',
      '/employer/shifts/' || r.shift_id, jsonb_build_object('worker_name', coalesce(r.full_name, 'A worker'), 'shift_title', coalesce(r.title, 'a shift')));
    perform public.mark_attendance_reminder(r.app_id, 'confirm_hours');
    v_sent := v_sent + 1;
  end loop;

  -- 5. Worker: still no answer after 72h -- tell them what they can do (once).
  for r in
    select a.id as app_id, a.worker_id, s.title
    from public.applications a
    join public.shifts s on s.id = a.shift_id
    where a.status = 'accepted' and a.checked_out_at is not null
      and a.employer_hours_confirmed_at is null and not coalesce(a.employer_hours_disputed, false)
      and a.employer_proposed_hours is null
      and s.status <> 'cancelled'
      and a.checked_out_at <= now() - interval '72 hours' and a.checked_out_at > now() - interval '14 days'
      and not exists (select 1 from public.attendance_reminders m where m.application_id = a.id and m.kind = 'confirm_hours_worker')
  loop
    perform public.notify_safe(r.worker_id, 'hours_awaiting_employer', 'Still waiting for the employer',
      'The employer has not responded to the hours you submitted for "' || coalesce(r.title, 'a shift') || '". If it stays unanswered you can raise a dispute from the shift and an admin will review it.',
      '/worker/applications/' || r.app_id, jsonb_build_object('shift_title', coalesce(r.title, 'a shift')));
    perform public.mark_attendance_reminder(r.app_id, 'confirm_hours_worker');
    v_sent := v_sent + 1;
  end loop;

  -- 6. Employer: an attendance request unanswered for 24h (once per request kind).
  for r in
    select a.id as app_id, s.id as shift_id, s.employer_id, s.title, w.full_name, q.kind
    from public.attendance_requests q
    join public.applications a on a.id = q.application_id
    join public.shifts s on s.id = a.shift_id
    left join public.profiles w on w.id = a.worker_id
    where q.status = 'pending' and q.created_at <= now() - interval '24 hours'
      and a.no_show_at is null and s.status <> 'cancelled'
      and not exists (select 1 from public.attendance_reminders m where m.application_id = a.id and m.kind = 'request_' || q.kind)
  loop
    perform public.notify_safe(r.employer_id, 'attendance_request_reminder', 'A worker is still waiting for you',
      coalesce(r.full_name, 'A worker') || ' asked ' ||
        case r.kind when 'check_in' then 'to be checked in' else 'you to submit their hours' end ||
        ' for "' || coalesce(r.title, 'a shift') || '" more than a day ago. Please respond so it can be settled without an admin.',
      '/employer/shifts/' || r.shift_id, jsonb_build_object('worker_name', coalesce(r.full_name, 'A worker'), 'shift_title', coalesce(r.title, 'a shift'), 'kind', r.kind));
    perform public.mark_attendance_reminder(r.app_id, 'request_' || r.kind);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;
revoke all on function public.send_attendance_reminders() from public;

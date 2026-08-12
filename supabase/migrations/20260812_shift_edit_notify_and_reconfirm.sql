-- Notify applicants when an employer edits a shift they applied to, and make
-- material changes require re-confirmation from workers who already signed.
--
-- Today nothing fires on a shift edit: the only two triggers on public.shifts
-- (trg_notify_shift_cancelled, trg_notify_cancellation_choice_pending) are
-- both `after update OF STATUS ... when (new.status is distinct from
-- old.status)`, and the employer's save path is a plain UPDATE. So an employer
-- can move a shift's date, place or pay and nobody is told -- including a
-- worker who already signed a contract for the old terms.
--
-- Run as ONE script; no enum values are added, so no transaction split is
-- needed (cf. 20260811a).

-- ── 1. notification types ────────────────────────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed',
    -- new:
    'shift_updated',        -- any watched field changed; informational
    'shift_terms_changed'   -- material change; signed worker must re-confirm
  ));

-- ── 2. re-confirmation state ─────────────────────────────────────────────────
-- Deliberately NOT modelled as a `status` value: that would collide with the
-- 20260717g status-transition guard, and it would conflate "where is this
-- application in the hiring funnel" with "are the agreed terms still the ones
-- the worker signed". worker_signed_at is never cleared either -- it is
-- evidence that they DID sign, and destroying it to mean "must re-sign" throws
-- that evidence away.
alter table public.applications
  add column if not exists terms_changed_at     timestamptz,
  add column if not exists terms_reconfirmed_at timestamptz,
  add column if not exists terms_change_summary text;

comment on column public.applications.terms_changed_at is
  'Set when the employer materially changed the shift after this worker signed. Booking needs re-confirmation while this is newer than terms_reconfirmed_at.';

-- Needs re-confirmation  <=>  terms_changed_at is not null
--                             and (terms_reconfirmed_at is null
--                                  or terms_reconfirmed_at < terms_changed_at)
-- The deadline is derived at read time as min(shift.start_at,
-- terms_changed_at + 24h) -- no scheduler flipping rows, so nothing can be
-- left in a stale state if a job fails to run.

-- ── 3. guard the new columns ─────────────────────────────────────────────────
-- Same trusted-write idiom as guard_applications_attendance_columns
-- (20260726b). Without this, an employer could simply PATCH terms_changed_at
-- back to null over REST and keep a worker bound to terms they never agreed
-- to -- which is precisely what this feature exists to prevent. A worker
-- could equally stamp their own terms_reconfirmed_at without ever seeing the
-- change.
create or replace function public.guard_applications_terms_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.terms_trusted_write', true), '') = 'true';
begin
  if is_admin or is_trusted_write then
    return new;
  end if;

  new.terms_changed_at := old.terms_changed_at;
  new.terms_reconfirmed_at := old.terms_reconfirmed_at;
  new.terms_change_summary := old.terms_change_summary;

  return new;
end;
$$;

drop trigger if exists applications_guard_terms_columns on public.applications;
create trigger applications_guard_terms_columns
before update on public.applications
for each row execute function public.guard_applications_terms_columns();

-- ── 4. worker re-confirms the new terms ──────────────────────────────────────
create or replace function public.worker_reconfirm_terms(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_now timestamptz := now();
begin
  select a.id, a.worker_id, a.status, a.worker_signed_at,
         a.terms_changed_at, a.terms_reconfirmed_at
  into v_app
  from public.applications a
  where a.id = p_application_id;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  if v_app.worker_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.terms_changed_at is null
     or (v_app.terms_reconfirmed_at is not null
         and v_app.terms_reconfirmed_at >= v_app.terms_changed_at) then
    raise exception 'Nothing to re-confirm';
  end if;

  perform set_config('app.terms_trusted_write', 'true', true);
  update public.applications
  set terms_reconfirmed_at = v_now
  where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$$;

revoke all on function public.worker_reconfirm_terms(uuid) from public;
grant execute on function public.worker_reconfirm_terms(uuid) to authenticated;

-- ── 5. the edit trigger ──────────────────────────────────────────────────────
-- Order-insensitive fingerprint of a shift's occurrence list. The employer's
-- save path writes `sortedOccurrences` on EVERY save, so a plain
-- `jsonb is distinct from` would report "dates changed" the first time an
-- older, unsorted row is re-saved -- even if the employer changed nothing.
-- That false positive is expensive here: it would drop already-signed workers
-- into re-confirmation limbo over a no-op edit. Compare the set of
-- start/end pairs instead, so only a genuine change registers.
create or replace function public.occurrences_fingerprint(o jsonb)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(t, '|' order by t), '')
  from (
    select (e ->> 'start_at') || '~' || (e ->> 'end_at') as t
    from jsonb_array_elements(coalesce(o, '[]'::jsonb)) e
  ) s;
$$;

create or replace function public.notify_shift_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed text[] := '{}';
  material boolean := false;
  summary text;
begin
  -- Watched fields. `description` is deliberately absent: employers polish
  -- wording constantly and it changes nothing about whether a worker can
  -- show up.
  --
  -- start_at / end_at / occurrences collapse into ONE label. They always move
  -- together (start_at and end_at are derived from the occurrence list), so
  -- listing them separately would produce "start time, end time, dates" for
  -- what a worker experiences as a single change.
  if new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or public.occurrences_fingerprint(new.occurrences)
        is distinct from public.occurrences_fingerprint(old.occurrences)
  then changed := changed || 'date/time'; material := true; end if;

  if new.location is distinct from old.location
  then changed := changed || 'location';  material := true; end if;

  if new.wage_min is distinct from old.wage_min
     or new.wage_max is distinct from old.wage_max
  then changed := changed || 'pay';       material := true; end if;

  -- Notify-only: real changes a worker should know about, but not grounds to
  -- unwind a signed contract.
  if new.title        is distinct from old.title        then changed := changed || 'title';        end if;
  if new.headcount    is distinct from old.headcount    then changed := changed || 'headcount';    end if;
  if new.dress_code   is distinct from old.dress_code   then changed := changed || 'dress code';   end if;
  if new.requirements is distinct from old.requirements then changed := changed || 'requirements'; end if;

  if array_length(changed, 1) is null then
    return null;
  end if;

  summary := array_to_string(changed, ', ');

  -- Everyone with a live stake. 'rejected' / 'withdrawn' / 'expired' are
  -- deliberately excluded -- they have no reason to hear about it.
  insert into public.notifications (user_id, type, title, body, link)
  select
    a.worker_id,
    'shift_updated',
    'Shift details changed',
    'The employer changed the ' || summary || ' for "' || coalesce(new.title, 'a shift') ||
      '". Open the shift to see the updated details.',
    '/worker/shifts/' || new.id
  from public.applications a
  where a.shift_id = new.id
    and a.status in ('pending', 'shortlisted', 'offered', 'accepted');

  -- Material change + already signed => the agreed terms no longer match what
  -- they agreed to. Flag for re-confirmation and tell them specifically.
  if material then
    perform set_config('app.terms_trusted_write', 'true', true);
    update public.applications
    set terms_changed_at = now(),
        terms_change_summary = summary
    where shift_id = new.id
      and status = 'accepted'
      and worker_signed_at is not null;

    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_terms_changed',
      'Confirm the new shift terms',
      'The ' || summary || ' changed for "' || coalesce(new.title, 'a shift') ||
        '" after you signed. Your booking is on hold until you confirm the new terms.',
      '/worker/applications/' || a.id
    from public.applications a
    where a.shift_id = new.id
      and a.status = 'accepted'
      and a.worker_signed_at is not null;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_notify_shift_updated on public.shifts;
create trigger trg_notify_shift_updated
after update on public.shifts
for each row
-- Only while the shift is still live afterwards. Editing a cancelled or
-- completed shift is bookkeeping -- the cancellation notice already went out,
-- and nobody is turning up.
--
-- This fires on every shifts UPDATE, including sync_shift_filled_count's
-- `set filled_count = ..., updated_at = now()`. That is harmless and
-- deliberately not special-cased: filled_count/updated_at are not watched, so
-- the function finds no changes and returns before writing anything. It also
-- cannot recurse -- the function updates `applications`, and that table's
-- filled-count trigger is `of status`, which this never touches.
when (new.status in ('open', 'filled', 'closed'))
execute function public.notify_shift_updated();

-- ── 6. pre-existing bug: 'offered' workers are never told about cancellation ──
-- notify_shift_cancelled (20260704d, 4 July) filters
-- `status in ('pending','shortlisted','accepted')`. The 'offered' status was
-- added to the enum the very next day by 20260705d and this filter was never
-- updated -- so a worker holding a live, unexpired offer is not notified when
-- the employer cancels the shift. They are among the most likely to be
-- counting on it.
-- (also adds the `set search_path` the 20260704d original was missing, since
-- this replaces the function wholesale anyway)
create or replace function public.notify_shift_cancelled()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_cancelled',
      'Shift cancelled',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled by the employer.',
      '/worker/shifts/' || new.id
    from public.applications a
    where a.shift_id = new.id
      and a.status in ('pending', 'shortlisted', 'offered', 'accepted');
  end if;
  return null;
end;
$$;

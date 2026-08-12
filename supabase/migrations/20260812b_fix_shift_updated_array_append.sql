-- HOTFIX for 20260812. Run this immediately: until it is applied, employers
-- CANNOT EDIT SHIFTS AT ALL. Every PATCH to a shift whose status is
-- open/filled/closed fails with:
--   22P02 malformed array literal: "title"
--
-- Cause: `changed := changed || 'title'` is ambiguous. Postgres has both
-- `anyarray || anyelement` and `anyarray || anyarray`, and an unquoted string
-- literal is of unknown type, so it resolved to array-to-array concatenation
-- and tried to parse 'title' AS an array literal. The AFTER UPDATE trigger
-- then raised, which aborted the employer's UPDATE entirely -- so the edit
-- silently did nothing rather than failing loudly in a way that pointed here.
--
-- Fix: array_append(), which has exactly one meaning and cannot be resolved
-- to the wrong operator.
--
-- (If for any reason this cannot be run right now, the one-line mitigation
-- that restores shift editing is:
--    drop trigger if exists trg_notify_shift_updated on public.shifts;
--  -- that only disables the new notifications; nothing else depends on it.)

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
  then changed := array_append(changed, 'date/time'); material := true; end if;

  if new.location is distinct from old.location
  then changed := array_append(changed, 'location');  material := true; end if;

  if new.wage_min is distinct from old.wage_min
     or new.wage_max is distinct from old.wage_max
  then changed := array_append(changed, 'pay');       material := true; end if;

  -- Notify-only: real changes a worker should know about, but not grounds to
  -- unwind a signed contract.
  if new.title        is distinct from old.title        then changed := array_append(changed, 'title');        end if;
  if new.headcount    is distinct from old.headcount    then changed := array_append(changed, 'headcount');    end if;
  if new.dress_code   is distinct from old.dress_code   then changed := array_append(changed, 'dress code');   end if;
  if new.requirements is distinct from old.requirements then changed := array_append(changed, 'requirements'); end if;

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

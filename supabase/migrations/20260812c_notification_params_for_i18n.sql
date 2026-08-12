-- Make notification text translatable.
--
-- Notification bodies are written by database triggers, which have no access
-- to the app's TRANSLATIONS table -- so every notification in this app has
-- always been English, regardless of the reader's language setting. Worse, the
-- language is frozen at write time: a row written today would stay English
-- even if the worker switched to BM tomorrow.
--
-- Fix: alongside the English prose (kept as a fallback), store the same event
-- as DATA. The app renders `notif.<type>.title` / `notif.<type>.body` from
-- TRANSLATIONS, interpolating these params, in whatever language the reader
-- has selected -- and re-renders in the other language the moment they switch.
--
-- The app falls back to the stored prose whenever a row has no params or the
-- type has no translation yet, so this is safe to apply before every trigger
-- has been converted. Types converted here: shift_updated,
-- shift_terms_changed, shift_cancelled. The remaining types keep working
-- exactly as they do today until they are converted the same way.

alter table public.notifications
  add column if not exists params jsonb not null default '{}'::jsonb;

comment on column public.notifications.params is
  'The event as data (shift_title, changed[], ...) so the app can render this notification in the reader''s language. The title/body columns hold English prose as a fallback for rows written before their type was converted.';

-- ── shift_updated / shift_terms_changed ──────────────────────────────────────
-- `changed` now carries CODES ('datetime','pay') rather than English prose.
-- Prose could only ever be English; codes are looked up in TRANSLATIONS at
-- display time. terms_change_summary stores the same codes, comma-separated,
-- for the same reason -- the worker-facing re-confirm banner renders from it.
create or replace function public.notify_shift_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  codes text[] := '{}';
  material boolean := false;
  code_csv text;
  english text;
  label_map jsonb := jsonb_build_object(
    'datetime', 'date/time', 'location', 'location', 'pay', 'pay',
    'title', 'title', 'headcount', 'headcount',
    'dress_code', 'dress code', 'requirements', 'requirements'
  );
begin
  if new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or public.occurrences_fingerprint(new.occurrences)
        is distinct from public.occurrences_fingerprint(old.occurrences)
  then codes := array_append(codes, 'datetime'); material := true; end if;

  if new.location is distinct from old.location
  then codes := array_append(codes, 'location'); material := true; end if;

  if new.wage_min is distinct from old.wage_min
     or new.wage_max is distinct from old.wage_max
  then codes := array_append(codes, 'pay');      material := true; end if;

  if new.title        is distinct from old.title        then codes := array_append(codes, 'title');        end if;
  if new.headcount    is distinct from old.headcount    then codes := array_append(codes, 'headcount');    end if;
  if new.dress_code   is distinct from old.dress_code   then codes := array_append(codes, 'dress_code');   end if;
  if new.requirements is distinct from old.requirements then codes := array_append(codes, 'requirements'); end if;

  if array_length(codes, 1) is null then
    return null;
  end if;

  code_csv := array_to_string(codes, ',');
  -- English rendering of the same list, for the fallback prose only.
  select coalesce(string_agg(label_map ->> t.c, ', '), 'details') into english
  from unnest(codes) as t(c);

  insert into public.notifications (user_id, type, title, body, link, params)
  select
    a.worker_id,
    'shift_updated',
    'Shift details changed',
    'The employer changed the ' || english || ' for "' || coalesce(new.title, 'a shift') ||
      '". Open the shift to see the updated details.',
    '/worker/shifts/' || new.id,
    jsonb_build_object('shift_title', coalesce(new.title, 'a shift'), 'changed', to_jsonb(codes))
  from public.applications a
  where a.shift_id = new.id
    and a.status in ('pending', 'shortlisted', 'offered', 'accepted');

  if material then
    perform set_config('app.terms_trusted_write', 'true', true);
    update public.applications
    set terms_changed_at = now(),
        terms_change_summary = code_csv
    where shift_id = new.id
      and status = 'accepted'
      and worker_signed_at is not null;

    insert into public.notifications (user_id, type, title, body, link, params)
    select
      a.worker_id,
      'shift_terms_changed',
      'Confirm the new shift terms',
      'The ' || english || ' changed for "' || coalesce(new.title, 'a shift') ||
        '" after you signed. Your booking is on hold until you confirm the new terms.',
      '/worker/applications/' || a.id,
      jsonb_build_object('shift_title', coalesce(new.title, 'a shift'), 'changed', to_jsonb(codes))
    from public.applications a
    where a.shift_id = new.id
      and a.status = 'accepted'
      and a.worker_signed_at is not null;
  end if;

  return null;

exception when others then
  -- HARD-LEARNED: 20260812 shipped a bug in this function that raised inside
  -- an AFTER UPDATE trigger, which aborted the employer's UPDATE -- shift
  -- editing broke entirely, and silently, because the edit just appeared to
  -- do nothing. A notification is a side effect; it must never be able to
  -- take down the write that triggered it. Degrading to "no notification
  -- sent" restores the previous status quo, whereas raising takes out a core
  -- feature. The warning goes to the Postgres log for diagnosis.
  raise warning 'notify_shift_updated failed for shift %: %', new.id, sqlerrm;
  return null;
end;
$$;

-- ── shift_cancelled ──────────────────────────────────────────────────────────
create or replace function public.notify_shift_cancelled()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link, params)
    select
      a.worker_id,
      'shift_cancelled',
      'Shift cancelled',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled by the employer.',
      '/worker/shifts/' || new.id,
      jsonb_build_object('shift_title', coalesce(new.title, 'a shift'))
    from public.applications a
    where a.shift_id = new.id
      and a.status in ('pending', 'shortlisted', 'offered', 'accepted');
  end if;
  return null;

exception when others then
  -- Same reasoning as above: a failure here must not block the employer from
  -- cancelling a shift.
  raise warning 'notify_shift_cancelled failed for shift %: %', new.id, sqlerrm;
  return null;
end;
$$;

-- ── cleanup: today's QA test notifications ───────────────────────────────────
-- Rows created while verifying this feature, whose shift/application has since
-- been deleted. Left behind because `notifications` has no DELETE policy for
-- anyone -- worth knowing separately: nothing cascades notifications when a
-- shift is deleted, so real workers can accumulate rows whose link 404s.
delete from public.notifications
where id in (
  '93db8c2d-cd3d-403a-a8a6-55dd748453f7',
  '08c5a105-25bf-4075-82d0-382d99da7236',
  '039fed48-04b1-4eeb-bb07-85da848cb9d6',
  'a066226f-572e-45e7-92f8-e70bb9b7b93c',
  '4da358de-946c-488f-b9a1-a463de0c852f',
  'aecafb68-3acc-4f46-ac18-649aec266bb2',
  'eda7be6d-1b83-4640-be7e-eb67fd5a4100',
  'e317fd45-882b-4f08-ae0c-d34f2ac9f33a',
  '76de1fd5-97dd-4065-a7c7-c9f0c1a5cfd5',
  -- from the browser verification of the re-confirm banner
  '37207664-b03c-4b7b-9cf1-0c6cd1047224',
  '6bb2679b-a64c-4f0f-83e1-1f574acf164e',
  '5f593b86-39a8-4670-8b8c-33abe3b14d29',
  '435be100-47d6-499a-8b47-672f987456de',
  '97681927-725c-4012-bcd4-5149d1df3450',
  '5bdbdf67-04aa-4d18-902b-efb301f4e725'
);

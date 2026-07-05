-- Hiring workflow: employer selects candidate(s) -> worker must confirm or
-- decline within a deadline -> confirmed workers proceed to the existing
-- digital contract signing step -> once headcount is fully staffed, all
-- other applicants are notified they were not selected.
--
-- New application lifecycle:
--   pending -> shortlisted (soft interest, unlocks chat; unchanged)
--   pending/shortlisted -> offered (employer selected this worker for a
--     slot; offer_expires_at set; worker must respond)
--   offered -> accepted (worker confirmed; existing contract-sign flow
--     continues from here exactly as before)
--   offered -> rejected (worker declined the offer)
--   offered -> expired (deadline passed with no response — a best-effort
--     client-side sweep flips this; a real pg_cron job is a future upgrade)
--   pending/shortlisted -> rejected (marked "not selected" once the shift
--     is fully staffed, or manually rejected by employer)

-- ── applications: status values + offer deadline ────────────────────────────
-- NOTE: applications.status is a native Postgres enum (application_status),
-- not text+check. The 'offered'/'expired' values must already be added via
-- supabase/migrations/20260705d_widen_application_status_enum.sql — RUN THAT
-- FILE FIRST, in its own separate execution, before this one.

alter table public.applications
  add column if not exists offer_expires_at timestamptz;

-- ── RLS: worker may respond to their own offer ───────────────────────────────
-- (existing applications_worker_update only allowed pending->withdrawn;
-- add a second policy for offered->accepted/rejected.)
drop policy if exists applications_worker_respond_offer on public.applications;
create policy applications_worker_respond_offer
  on public.applications for update to authenticated
  using  (auth.uid() = worker_id and status = 'offered')
  with check (auth.uid() = worker_id and status in ('accepted', 'rejected'));

-- Employer needs to be able to set status='offered' (previously only
-- 'shortlisted'/'accepted'/'rejected' were reachable via the employer
-- update policy's implicit check — the existing applications_employer_update
-- policy already has no status allowlist in its WITH CHECK beyond ownership,
-- so no change needed there. Re-affirm it exists and is unrestricted on
-- status value, since our app enforces the workflow client-side.)

-- Employer or worker may also flip an application to 'expired' as part of
-- the lazy sweep (whichever side loads the screen first).
drop policy if exists applications_expire_offer on public.applications;
create policy applications_expire_offer
  on public.applications for update to authenticated
  using (
    status = 'offered'
    and offer_expires_at is not null
    and offer_expires_at < now()
    and (
      auth.uid() = worker_id
      or exists (select 1 from public.shifts s where s.id = shift_id and s.employer_id = auth.uid())
    )
  )
  with check (status = 'expired');

-- ── notifications: widen event types ─────────────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected'
  ));

-- ── trigger: notify worker when offered a slot ───────────────────────────────
create or replace function public.notify_shift_offer()
returns trigger language plpgsql security definer as $$
declare
  v_shift_title text;
begin
  if new.status = 'offered' and old.status is distinct from 'offered' then
    select title into v_shift_title from public.shifts where id = new.shift_id;
    insert into public.notifications (user_id, type, title, body, link)
    values (
      new.worker_id,
      'shift_offer',
      'You''ve been selected!',
      'You were selected for "' || coalesce(v_shift_title, 'a shift') ||
        '". Please confirm or decline before ' ||
        to_char(new.offer_expires_at, 'DD Mon HH24:MI') || '.',
      '/worker/applications/' || new.id
    );
  end if;
  return null;
end;
$$;

drop trigger if exists trg_notify_shift_offer on public.applications;
create trigger trg_notify_shift_offer
after update of status on public.applications
for each row
when (new.status is distinct from old.status)
execute function public.notify_shift_offer();

-- ── trigger: notify employer when worker confirms / declines / expires ──────
create or replace function public.notify_offer_response()
returns trigger language plpgsql security definer as $$
declare
  v_shift_title text;
  v_employer_id uuid;
  v_worker_name text;
begin
  if old.status = 'offered' and new.status in ('rejected', 'expired') then
    select s.title, s.employer_id into v_shift_title, v_employer_id
    from public.shifts s where s.id = new.shift_id;
    select full_name into v_worker_name from public.profiles where id = new.worker_id;

    if v_employer_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_employer_id,
        'offer_declined_or_expired',
        'Pick a substitute',
        coalesce(v_worker_name, 'A worker') || ' ' ||
          (case when new.status = 'expired' then 'did not respond in time for' else 'declined' end) ||
          ' "' || coalesce(v_shift_title, 'your shift') || '". Choose another applicant.',
        '/employer/shifts/' || new.shift_id
      );
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_notify_offer_response on public.applications;
create trigger trg_notify_offer_response
after update of status on public.applications
for each row
when (new.status is distinct from old.status)
execute function public.notify_offer_response();

-- ── trigger: once headcount is fully staffed, notify everyone else "not selected" ──
create or replace function public.notify_not_selected_when_filled()
returns trigger language plpgsql security definer as $$
declare
  v_headcount int;
  v_accepted_count int;
  v_shift_title text;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select headcount, title into v_headcount, v_shift_title
    from public.shifts where id = new.shift_id;

    select count(*) into v_accepted_count
    from public.applications
    where shift_id = new.shift_id and status = 'accepted';

    if v_accepted_count >= v_headcount then
      insert into public.notifications (user_id, type, title, body, link)
      select
        a.worker_id,
        'not_selected',
        'Not selected this time',
        'The shift "' || coalesce(v_shift_title, 'you applied for') || '" has been fully staffed. You were not selected.',
        '/worker/applications/' || a.id
      from public.applications a
      where a.shift_id = new.shift_id
        and a.status in ('pending', 'shortlisted');

      update public.applications
      set status = 'rejected', updated_at = now()
      where shift_id = new.shift_id
        and status in ('pending', 'shortlisted');
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_notify_not_selected on public.applications;
create trigger trg_notify_not_selected
after update of status on public.applications
for each row
when (new.status is distinct from old.status)
execute function public.notify_not_selected_when_filled();

-- Make a no-show cost more than an honest withdrawal.
--
-- THE PROBLEM THIS FIXES, and it is one I introduced half of. After
-- 20260815b, the only thing that moves reliability_score is a withdrawal
-- penalty: 15 points for pulling out under 24 hours. A worker who simply does
-- not turn up loses NOTHING -- no-show exists only as a dispute *category*
-- that an employer can file manually, with no effect on any score.
--
-- So the incentives currently run backwards. The worker who tells the
-- employer 30 hours ahead (letting them refill the slot) is punished, and the
-- worker who says nothing and leaves the employer short-staffed on the day
-- walks away clean. The withdrawal penalty is only defensible once this
-- exists.
--
-- WHY EMPLOYER-INITIATED rather than a scheduled sweep: there is no pg_cron in
-- this project (confirmed -- 20260811b and 20260705 both note its absence), so
-- nothing can run at shift-end. Marking is also more accurate this way. A
-- worker can legitimately have worked without checking in -- a flat phone, a
-- broken QR code -- and only the employer knows whether someone actually
-- turned up. An automatic "no check-in means no-show" rule would punish
-- workers for the app's own failures.
--
-- The trade-off is that this is a serious reputational hit applied by a
-- counterparty, so it is bounded: only after the shift started, only on an
-- accepted worker who never checked in, once per application, and the worker
-- is told plainly that they can contest it.

-- ── 1. penalty configuration ─────────────────────────────────────────────────
-- Reuses cancellation_tiers so every reputational penalty in the system is
-- readable from one place. The penalty MUST exceed the worst withdrawal tier
-- (15), or the incentive stays inverted.
alter table public.cancellation_tiers drop constraint if exists cancellation_tiers_party_check;
alter table public.cancellation_tiers
  add constraint cancellation_tiers_party_check
  check (party in ('employer', 'worker', 'worker_no_show'));

insert into public.cancellation_tiers (party, min_notice_hours, compensation_rate, reliability_penalty, label)
values ('worker_no_show', 0, null, 25, 'Did not turn up and gave no notice')
on conflict (party, min_notice_hours) do nothing;

-- ── 2. record on the application ─────────────────────────────────────────────
alter table public.applications
  add column if not exists no_show_at      timestamptz,
  add column if not exists no_show_note    text,
  add column if not exists no_show_penalty int;

-- ── 3. notification type ─────────────────────────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed',
    'shift_updated', 'shift_terms_changed',
    'worker_withdrew', 'slot_reopened',
    'marked_no_show'   -- to the worker: the employer reported they did not attend
  ));

-- ── 4. guard the new columns ─────────────────────────────────────────────────
-- Same trusted-write idiom as the terms and attendance columns. Without it an
-- employer could PATCH no_show_at directly, bypassing every precondition
-- below, and a worker could clear it.
create or replace function public.guard_applications_no_show_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.no_show_trusted_write', true), '') = 'true';
begin
  if is_admin or is_trusted_write then
    return new;
  end if;
  new.no_show_at := old.no_show_at;
  new.no_show_note := old.no_show_note;
  new.no_show_penalty := old.no_show_penalty;
  return new;
end;
$$;

drop trigger if exists applications_guard_no_show_columns on public.applications;
create trigger applications_guard_no_show_columns
before update on public.applications
for each row execute function public.guard_applications_no_show_columns();

-- ── 5. the RPC ───────────────────────────────────────────────────────────────
create or replace function public.employer_mark_no_show(
  p_application_id uuid,
  p_note text default null
)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_shift record;
  v_tier public.cancellation_tiers;
  v_penalty int;
  v_now timestamptz := now();
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.checked_in_at, a.no_show_at
  into v_app
  from public.applications a
  where a.id = p_application_id;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  select s.id, s.title, s.employer_id, s.start_at
  into v_shift
  from public.shifts s where s.id = v_app.shift_id;

  if v_shift.employer_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  -- Preconditions, each one bounding how much damage a mistaken or malicious
  -- mark can do.
  if v_shift.start_at > v_now then
    raise exception 'Cannot report a no-show before the shift has started';
  end if;

  if v_app.status is distinct from 'accepted' then
    raise exception 'Only a confirmed worker can be reported as a no-show';
  end if;

  if v_app.checked_in_at is not null then
    raise exception 'This worker checked in, so they cannot be reported as a no-show';
  end if;

  if v_app.no_show_at is not null then
    raise exception 'This worker has already been reported as a no-show';
  end if;

  v_tier := public.cancellation_tier_for('worker_no_show', 0);
  v_penalty := coalesce(v_tier.reliability_penalty, 25);

  perform set_config('app.no_show_trusted_write', 'true', true);
  update public.applications
  set no_show_at = v_now,
      no_show_note = nullif(trim(coalesce(p_note, '')), ''),
      no_show_penalty = v_penalty,
      updated_at = v_now
  where id = p_application_id
  returning * into v_app;
  perform set_config('app.no_show_trusted_write', 'false', true);

  perform set_config('app.reliability_trusted_write', 'true', true);
  update public.profiles
  set reliability_score = greatest(coalesce(reliability_score, 100) - v_penalty, 0)
  where id = v_app.worker_id;
  perform set_config('app.reliability_trusted_write', 'false', true);

  -- The worker is told plainly, including that they can contest it. A
  -- reputational penalty applied by the other party to the contract must be
  -- appealable, and the disputes table already has admin resolution built.
  insert into public.notifications (user_id, type, title, body, link, params)
  values (
    v_app.worker_id,
    'marked_no_show',
    'You were reported as not attending',
    'The employer reported that you did not attend "' || coalesce(v_shift.title, 'a shift') ||
      '". This costs ' || v_penalty || ' reliability points. If you did attend, open the shift and raise a dispute.',
    '/worker/applications/' || v_app.id,
    jsonb_build_object(
      'shift_title', coalesce(v_shift.title, 'a shift'),
      'points', v_penalty,
      'note', nullif(trim(coalesce(p_note, '')), '')
    )
  );

  return v_app;
end;
$$;

revoke all on function public.employer_mark_no_show(uuid, text) from public;
grant execute on function public.employer_mark_no_show(uuid, text) to authenticated;

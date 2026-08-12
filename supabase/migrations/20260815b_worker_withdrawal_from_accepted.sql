-- Let a worker withdraw from a booking they already accepted, with
-- consequences that scale with how much notice they give.
--
-- TODAY: 'accepted' is a terminal state for BOTH parties. Verified live --
-- guard_application_status_transitions (20260717g) permits no transition out
-- of it, and an employer's accepted -> rejected is silently reverted. So a
-- worker who falls ill has no route at all, and an employer who agrees to
-- release someone cannot. The only exit is cancelling the whole shift, which
-- under the new compensation rules means paying off every OTHER worker on it
-- too.
--
-- WHY NO EMPLOYER APPROVAL. Requiring the employer to approve a withdrawal
-- does not produce attendance -- it produces no-shows. A worker who is ill or
-- has an emergency will simply not turn up, and the employer discovers it at
-- 9am instead of three days earlier. The single most valuable thing the
-- employer can get is NOTICE, and an approval gate destroys exactly that.
-- It would also give one party a veto over another person's labour.
--
-- So: withdrawal is always permitted, and the deterrent is reputational and
-- proportionate to lateness.

-- ── 1. tier configuration ────────────────────────────────────────────────────
-- A table, not constants, for two reasons: rates change without a migration,
-- and a payout can keep the rate it was quoted at even after the rate moves.
-- Serves both directions -- employer cancellation compensation and worker
-- withdrawal penalties -- because they are the same shape and should be
-- reasoned about together.
create table if not exists public.cancellation_tiers (
  party                text    not null check (party in ('employer', 'worker')),
  min_notice_hours     numeric not null check (min_notice_hours >= 0),
  -- employer rows: fraction of the worker's contracted wage owed to them
  compensation_rate    numeric check (compensation_rate >= 0 and compensation_rate <= 1),
  -- worker rows: reliability points deducted
  reliability_penalty  int     check (reliability_penalty >= 0),
  label                text    not null,
  primary key (party, min_notice_hours)
);

-- The applicable tier is the one with the GREATEST min_notice_hours that is
-- still <= the notice actually given.
insert into public.cancellation_tiers (party, min_notice_hours, compensation_rate, reliability_penalty, label) values
  ('employer', 168, 0.00, null, 'More than 7 days notice'),
  ('employer',  48, 0.25, null, '48 hours to 7 days notice'),
  ('employer',  24, 0.50, null, '24 to 48 hours notice'),
  ('employer',   0, 0.50, null, 'Under 24 hours notice'),
  ('worker',   168, null,     0, 'More than 7 days notice'),
  ('worker',    48, null,     2, '48 hours to 7 days notice'),
  ('worker',    24, null,     5, '24 to 48 hours notice'),
  ('worker',     0, null,    15, 'Under 24 hours notice')
on conflict (party, min_notice_hours) do nothing;

alter table public.cancellation_tiers enable row level security;

drop policy if exists cancellation_tiers_read on public.cancellation_tiers;
create policy cancellation_tiers_read
  on public.cancellation_tiers for select to authenticated using (true);

drop policy if exists cancellation_tiers_admin on public.cancellation_tiers;
create policy cancellation_tiers_admin
  on public.cancellation_tiers for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create or replace function public.cancellation_tier_for(p_party text, p_notice_hours numeric)
returns public.cancellation_tiers
language sql
security definer
set search_path = public
stable
as $$
  select *
  from public.cancellation_tiers
  where party = p_party
    and min_notice_hours <= greatest(coalesce(p_notice_hours, 0), 0)
  order by min_notice_hours desc
  limit 1;
$$;

revoke all on function public.cancellation_tier_for(text, numeric) from public;
grant execute on function public.cancellation_tier_for(text, numeric) to authenticated;

-- ── 2. withdrawal record on the application ──────────────────────────────────
alter table public.applications
  add column if not exists withdrawn_at            timestamptz,
  add column if not exists withdrawal_reason       text,
  add column if not exists withdrawal_notice_hours numeric,
  add column if not exists withdrawal_penalty      int;

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
    'worker_withdrew',   -- to the employer: a booked worker pulled out
    'slot_reopened'      -- to prior applicants: a slot on this shift is free again
  ));

-- ── 4. let a trusted server path move reliability_score ──────────────────────
-- guard_profile_reputation_and_role currently HARD-PINS reliability_score --
-- only an admin JWT can move it, and nothing server-side ever does, so the
-- number displayed to employers has never actually meant anything. This adds
-- the same trusted-write escape hatch `rating` already has (20260725k), so the
-- withdrawal RPC below can move it and nothing else can.
create or replace function public.guard_profile_reputation_and_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_ratings_trusted_write boolean := coalesce(current_setting('app.ratings_trusted_write', true), '') = 'true';
  is_reliability_trusted_write boolean := coalesce(current_setting('app.reliability_trusted_write', true), '') = 'true';
  prior_rating numeric(2,1) := case when tg_op = 'INSERT' then 0 else old.rating end;
  -- numeric, not int. The original declared this `int` while the live column
  -- holds 100.00 -- so on an untrusted write the guard would RESTORE a
  -- truncated value, silently rounding a fractional score down. Latent today
  -- because nothing ever wrote the column; fixed here rather than left in
  -- place now that something does.
  prior_reliability numeric := case when tg_op = 'INSERT' then 0 else old.reliability_score end;
  prior_role text := case when tg_op = 'INSERT' then 'worker' else old.role end;
begin
  if is_admin then
    return new;
  end if;

  if new.rating is distinct from prior_rating then
    if not is_ratings_trusted_write then
      new.rating := prior_rating;
    end if;
  end if;

  if new.reliability_score is distinct from prior_reliability then
    if not is_reliability_trusted_write then
      new.reliability_score := prior_reliability;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.role not in ('worker', 'employer') then
      new.role := 'worker';
    end if;
  elsif new.role is distinct from prior_role then
    new.role := prior_role;
  end if;

  return new;
end;
$$;

-- ── 5. the withdrawal itself ─────────────────────────────────────────────────
create or replace function public.worker_withdraw_from_shift(
  p_application_id uuid,
  p_reason text default null
)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_shift record;
  v_notice_hours numeric;
  v_tier public.cancellation_tiers;
  v_penalty int;
  v_worker_name text;
  v_now timestamptz := now();
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.withdrawn_at
  into v_app
  from public.applications a
  where a.id = p_application_id;

  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  if v_app.worker_id is distinct from auth.uid() then
    raise exception 'Not authorized';
  end if;

  if v_app.status is distinct from 'accepted' then
    raise exception 'Only a confirmed booking can be withdrawn from';
  end if;

  select s.id, s.title, s.employer_id, s.start_at, s.status, s.headcount
  into v_shift
  from public.shifts s where s.id = v_app.shift_id;

  if v_shift.status = 'cancelled' then
    raise exception 'This shift was already cancelled';
  end if;

  v_notice_hours := greatest(extract(epoch from (v_shift.start_at - v_now)) / 3600.0, 0);
  v_tier := public.cancellation_tier_for('worker', v_notice_hours);
  v_penalty := coalesce(v_tier.reliability_penalty, 0);

  -- The status guard only permits worker withdrawal from 'pending'; this is a
  -- legitimate server-side path, so it sets the same trusted-write flag the
  -- guard already recognises rather than being widened for everyone.
  perform set_config('app.application_status_trusted_write', 'true', true);
  update public.applications
  set status = 'withdrawn',
      withdrawn_at = v_now,
      withdrawal_reason = nullif(trim(coalesce(p_reason, '')), ''),
      withdrawal_notice_hours = round(v_notice_hours, 2),
      withdrawal_penalty = v_penalty,
      updated_at = v_now
  where id = p_application_id
  returning * into v_app;
  perform set_config('app.application_status_trusted_write', 'false', true);

  -- Reputation is the deterrent, not a cash penalty. It is enforceable (no
  -- collection problem), it is visible to employers in the applicant pool,
  -- and it is proportionate -- see the plan notes on why fining casual
  -- workers is both hard to collect and regressive.
  -- NOTE ON THE COLUMN: 20260628_profiles.sql declares reliability_score as
  -- `int not null default 0`, but live rows hold 100.00 -- the type and default
  -- were changed out-of-band at some point and no migration in this repo
  -- records it (same drift class as shifts.status turning out to be an enum).
  -- greatest(...) is written to be correct either way.
  if v_penalty > 0 then
    perform set_config('app.reliability_trusted_write', 'true', true);
    update public.profiles
    set reliability_score = greatest(coalesce(reliability_score, 100) - v_penalty, 0)
    where id = v_app.worker_id;
    perform set_config('app.reliability_trusted_write', 'false', true);
  end if;

  select full_name into v_worker_name from public.profiles where id = v_app.worker_id;

  -- The employer's real problem is being unstaffed, not the money. Reopening
  -- the shift immediately is the part that actually helps: filled_count is
  -- recomputed by trg_sync_filled_count on the status change, and a shift that
  -- had been marked 'filled' becomes discoverable again so it can be refilled.
  if v_shift.status = 'filled' then
    update public.shifts set status = 'open', updated_at = v_now where id = v_shift.id;
  end if;

  insert into public.notifications (user_id, type, title, body, link, params)
  values (
    v_shift.employer_id,
    'worker_withdrew',
    'A worker withdrew',
    coalesce(v_worker_name, 'A worker') || ' withdrew from "' ||
      coalesce(v_shift.title, 'your shift') || '" with ' ||
      round(v_notice_hours) || ' hours notice. The slot is open again.',
    '/employer/shifts/' || v_shift.id,
    jsonb_build_object(
      'shift_title', coalesce(v_shift.title, 'your shift'),
      'worker_name', coalesce(v_worker_name, 'A worker'),
      'notice_hours', round(v_notice_hours),
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  -- Tell everyone who applied to this shift and was not selected that a slot
  -- is free again. Refilling fast is worth more to the employer than any
  -- penalty collected from the worker who left.
  insert into public.notifications (user_id, type, title, body, link, params)
  select
    a.worker_id,
    'slot_reopened',
    'A slot reopened',
    'A slot has reopened on "' || coalesce(v_shift.title, 'a shift') || '". Apply again if you are still free.',
    '/worker/shifts/' || v_shift.id,
    jsonb_build_object('shift_title', coalesce(v_shift.title, 'a shift'))
  from public.applications a
  where a.shift_id = v_shift.id
    -- 'rejected' only. 'not_selected' is a NOTIFICATION type, not an
    -- application status -- notify_not_selected_when_filled sets those rows to
    -- 'rejected'. Using it here would have raised on an invalid enum value.
    and a.status = 'rejected'
    and a.worker_id is distinct from v_app.worker_id;

  return v_app;
end;
$$;

revoke all on function public.worker_withdraw_from_shift(uuid, text) from public;
grant execute on function public.worker_withdraw_from_shift(uuid, text) to authenticated;

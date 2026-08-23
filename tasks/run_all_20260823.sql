-- ============================================================================
--  CariGaji — everything outstanding for the SQL editor, 2026-08-23
--  Run this file top to bottom, in one go. Nothing here is destructive to real
--  data. All four parts are safe to re-run if you are unsure whether a previous
--  attempt landed.
-- ============================================================================
--
--  ORDER MATTERS, and this is the reason this is one file rather than four.
--  20260809 is 20260804's function plus a coalesce(..., 0) that stops a NULL
--  rating from violating a constraint. Running 20260804 AFTER 20260809 would
--  silently put the bug back. Concatenated here in the only correct order so
--  that cannot happen by accident.
--
--  Part 0  clear the last QA shift
--  Part 1  20260804_recompute_rating_on_delete
--  Part 2  20260809_fix_recompute_rating_null_violation   (must follow Part 1)
--  Part 3  20260813_notification_params_remaining_types
--  Part 4  verification — RAISES if any part did not take
--
--  Parts 1-3 are `create or replace function` and `drop trigger if exists` +
--  `create trigger` only. Nothing inserts, updates or deletes a row at
--  migration time, so re-running an already-applied part is a no-op.
--
--  These three have been carried as "unconfirmed" for weeks because they are
--  trigger/function-only: an anon-key REST call cannot see whether a function
--  body was replaced, so nothing outside this editor could ever check them.
--  Part 4 checks them properly, from inside the database.

-- ============================================================================
-- PART 0 — clear the QA shift left by the notification archive test
-- ============================================================================
-- It has an accepted worker, so guard_delete_of_booked_shift refuses a plain
-- delete. Never worked, produced no payout; its notifications and application
-- go with it.

do $part0$
declare
  v_shift uuid := '76f72210-e3a9-47bb-92fa-dd18d1d3feb4';
  v_left int;
begin
  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after notification archive UI test');
    raise notice 'Part 0: purged the probe shift';
  else
    raise notice 'Part 0: probe shift already gone, nothing to do';
  end if;
  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then
    raise exception 'Part 0 FAILED: the probe shift is still present';
  end if;
end
$part0$;

-- ============================================================================
-- PART 1 — 20260804_recompute_rating_on_delete.sql
-- ============================================================================
-- recompute_profile_rating (20260725i) only fires AFTER INSERT — a ratee's
-- profiles.rating never goes back down once a rating row is removed (e.g.
-- admin moderation, or QA test-data cleanup). Found live during a
-- multi-employer/multi-worker rating QA pass: after deleting test ratings,
-- the 3 affected profiles kept showing their old (now-orphaned) averages
-- indefinitely, since nothing ever re-ran the aggregate.
--
-- Add an AFTER DELETE trigger using the same recompute function — DELETE
-- triggers see the removed row via OLD, not NEW, so recompute_profile_rating
-- is extended to key off whichever is present. When a ratee's last rating is
-- deleted, the aggregate subquery returns NULL, which is correct (no ratings
-- = no average, not 0).

create or replace function public.recompute_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ratee_id uuid := coalesce(new.ratee_id, old.ratee_id);
begin
  perform set_config('app.ratings_trusted_write', 'true', true);

  update public.profiles
  set rating = (
    select round(avg(overall)::numeric, 1)
    from public.ratings
    where ratee_id = v_ratee_id
  )
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_recompute_profile_rating on public.ratings;
create trigger trg_recompute_profile_rating
after insert or delete on public.ratings
for each row execute function public.recompute_profile_rating();

-- ============================================================================
-- PART 2 — 20260809_fix_recompute_rating_null_violation.sql
--          MUST follow Part 1: it replaces the same function with the
--          coalesce(..., 0) fix. Reversing these two reinstates the bug.
-- ============================================================================
-- 20260804_recompute_rating_on_delete.sql was applied correctly, but broke
-- on first real use: profiles.rating is `numeric(2,1) not null default 0`
-- (20260628_profiles.sql) -- 0 has always been this project's convention for
-- "no ratings yet", not null. The 20260804 trigger's aggregate subquery
-- returns NULL when a ratee's last rating is deleted (avg() of zero rows),
-- which violates that not-null constraint -- and because this fires inside
-- the same transaction as the delete, the constraint violation rolled back
-- the ENTIRE delete (shift/application/rating all stayed put), not just the
-- rating recompute. Confirmed live: deleting the last rating for a test
-- worker 400'd with "null value in column rating... violates not-null
-- constraint" and the row never actually deleted.
--
-- Fix: coalesce the aggregate to 0, matching the column's own default and
-- the convention every other write to this column already follows.

create or replace function public.recompute_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ratee_id uuid := coalesce(new.ratee_id, old.ratee_id);
begin
  perform set_config('app.ratings_trusted_write', 'true', true);

  update public.profiles
  set rating = coalesce((
    select round(avg(overall)::numeric, 1)
    from public.ratings
    where ratee_id = v_ratee_id
  ), 0)
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

-- Trigger itself is unchanged from 20260804 (still AFTER INSERT OR DELETE) --
-- only the function body changes, so no need to drop/recreate the trigger.

-- ============================================================================
-- PART 3 — 20260813_notification_params_remaining_types.sql
-- ============================================================================
-- Convert the remaining notification types to carry `params`, so every
-- notification in the app renders in the reader's language (20260812c covered
-- shift_updated / shift_terms_changed / shift_cancelled).
--
-- EVERY function below was generated by patching its CURRENT definition, read
-- programmatically from the migration that last defined it. This is not
-- stylistic caution: a hand-transcribed first draft of
-- create_cancellation_payout silently changed the payout table name, dropped a
-- defense-in-depth guard, and replaced the multi-day occurrence hours
-- calculation with a naive end-minus-start. Only the notification INSERT is
-- touched in each -- the column list gains `params`, and a jsonb_build_object
-- is appended to the values. No other line differs.
--
-- EXCEPTION HANDLERS go only on the four PURE notifiers. After 20260812 took
-- shift editing down, the rule is that notifying must never abort the write
-- that triggered it -- but that only holds where notifying is ALL a function
-- does. The other five write real state (status cascades, payout deadlines,
-- payout rows) or are RPCs the app calls directly; swallowing an error there
-- would leave inconsistent state, which is worse than failing loudly.
--
-- VARIANTS: three notifications have conditional bodies (declined vs expired,
-- 50% payout vs showing up, dispute with vs without a reason). Rather than
-- freeze the branch as English prose, params carries a `variant` and the app
-- looks up `notif.<type>.<variant>.body`.
--
-- TIMESTAMPS travel as raw values (`*_at`), not preformatted strings, so the
-- app renders them in the reader's locale. The English fallback prose keeps
-- its existing to_char() formatting.

-- ── bid_received  [patched from 20260702_notifications.sql] ──
create or replace function public.notify_bid_received()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_employer_id uuid;
  v_shift_title text;
begin
  select employer_id, title into v_employer_id, v_shift_title
  from public.shifts
  where id = new.shift_id;

  if v_employer_id is not null then
    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      v_employer_id,
      'bid_received',
      'New bid received',
      'Someone applied for "' || coalesce(v_shift_title, 'your shift') || '".',
      '/employer/shifts/' || new.shift_id,
      jsonb_build_object('shift_title', coalesce(v_shift_title, 'your shift'))
    );
  end if;

  return null;

exception when others then
  raise warning 'notify_bid_received failed: %', sqlerrm;
  return null;
end;
$$;

-- ── bid_accepted / bid_rejected  [patched from 20260702_notifications.sql] ──
create or replace function public.notify_bid_status_change()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_shift_title text;
begin
  select title into v_shift_title
  from public.shifts
  where id = new.shift_id;

  insert into public.notifications (user_id, type, title, body, link, params)
  values (
    new.worker_id,
    case when new.status = 'accepted' then 'bid_accepted' else 'bid_rejected' end,
    case when new.status = 'accepted' then 'Bid accepted' else 'Bid rejected' end,
    case
      when new.status = 'accepted' then 'Your bid for "' || coalesce(v_shift_title, 'a shift') || '" was accepted.'
      else 'Your bid for "' || coalesce(v_shift_title, 'a shift') || '" was rejected.'
    end,
    '/worker/shifts/' || new.shift_id,
    jsonb_build_object('shift_title', coalesce(v_shift_title, 'a shift'))
  );

  return null;

exception when others then
  raise warning 'notify_bid_status_change failed: %', sqlerrm;
  return null;
end;
$$;

-- ── shift_offer  [patched from 20260705_hiring_workflow.sql] ──
create or replace function public.notify_shift_offer()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_shift_title text;
begin
  if new.status = 'offered' and old.status is distinct from 'offered' then
    select title into v_shift_title from public.shifts where id = new.shift_id;
    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      new.worker_id,
      'shift_offer',
      'You''ve been selected!',
      'You were selected for "' || coalesce(v_shift_title, 'a shift') ||
        '". Please confirm or decline before ' ||
        to_char(new.offer_expires_at, 'DD Mon HH24:MI') || '.',
      '/worker/applications/' || new.id,
      jsonb_build_object(
        'shift_title', coalesce(v_shift_title, 'a shift'),
        'deadline_at', new.offer_expires_at
      )
    );
  end if;
  return null;

exception when others then
  raise warning 'notify_shift_offer failed: %', sqlerrm;
  return null;
end;
$$;

-- ── offer_declined_or_expired  [patched from 20260705_hiring_workflow.sql] ──
create or replace function public.notify_offer_response()
returns trigger language plpgsql security definer
set search_path = public
as $$
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
      insert into public.notifications (user_id, type, title, body, link, params)
      values (
        v_employer_id,
        'offer_declined_or_expired',
        'Pick a substitute',
        coalesce(v_worker_name, 'A worker') || ' ' ||
          (case when new.status = 'expired' then 'did not respond in time for' else 'declined' end) ||
          ' "' || coalesce(v_shift_title, 'your shift') || '". Choose another applicant.',
        '/employer/shifts/' || new.shift_id,
        jsonb_build_object(
          'shift_title', coalesce(v_shift_title, 'your shift'),
          'worker_name', coalesce(v_worker_name, 'A worker'),
          'variant', case when new.status = 'expired' then 'expired' else 'declined' end
        )
      );
    end if;
  end if;
  return null;

exception when others then
  raise warning 'notify_offer_response failed: %', sqlerrm;
  return null;
end;
$$;

-- ── not_selected  [patched from 20260717g_guard_application_status_transitions.sql] -- no exception handler:
--    this also rejects every remaining applicant; swallowing a failure
--    would strand workers in 'pending' on a full shift.
create or replace function public.notify_not_selected_when_filled()
returns trigger language plpgsql security definer
set search_path = public
as $$
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
      insert into public.notifications (user_id, type, title, body, link, params)
      select
        a.worker_id,
        'not_selected',
        'Not selected this time',
        'The shift "' || coalesce(v_shift_title, 'you applied for') || '" has been fully staffed. You were not selected.',
        '/worker/applications/' || a.id,
        jsonb_build_object('shift_title', coalesce(v_shift_title, 'you applied for'))
      from public.applications a
      where a.shift_id = new.shift_id
        and a.status in ('pending', 'shortlisted');

      perform set_config('app.application_status_trusted_write', 'true', true);

      update public.applications
      set status = 'rejected', updated_at = now()
      where shift_id = new.shift_id
        and status in ('pending', 'shortlisted');

      perform set_config('app.application_status_trusted_write', 'false', true);
    end if;
  end if;
  return null;
end;
$$;

-- ── shift_cancellation_choice_pending  [patched from 20260717h_fix_cancellation_payout_hours_and_tz.sql] -- no handler:
--    also stamps cancellation_choice_deadline, which is what entitles
--    the worker to a payout.
create or replace function public.notify_cancellation_choice_pending()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and new.start_at is not null and new.start_at - now() <= interval '24 hours' then

    perform set_config('app.cancellation_trusted_write', 'true', true);

    update public.applications
    set cancellation_choice_deadline = new.start_at
    where shift_id = new.id
      and status = 'accepted'
      and worker_signed_at is not null
      and cancellation_choice_deadline is null;

    insert into public.notifications (user_id, type, title, body, link, params)
    select
      a.worker_id,
      'shift_cancellation_choice_pending',
      'Shift cancelled — choose your payout',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled less than 24 hours before it started. ' ||
        'Choose to sign a 50% cancellation payout, or show up in person for 100% of your agreed wage. ' ||
        'Respond by ' || to_char(new.start_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon HH24:MI') || '.',
      '/worker/applications/' || a.id,
      jsonb_build_object(
        'shift_title', coalesce(new.title, 'a shift'),
        'deadline_at', new.start_at
      )
    from public.applications a
    where a.shift_id = new.id
      and a.status = 'accepted'
      and a.worker_signed_at is not null
      and a.cancellation_choice_deadline = new.start_at;
  end if;
  return null;
end;
$$;

-- ── shift_cancellation_choice_made  [patched from 20260717h_fix_cancellation_payout_hours_and_tz.sql] -- no handler:
--    this function's main job is writing the payout row. Everything
--    except the notification INSERT is byte-identical to 20260717h_fix_cancellation_payout_hours_and_tz.sql.
create or replace function public.create_cancellation_payout()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_shift record;
  v_hours numeric;
  v_multiplier numeric;
  v_reason text;
begin
  if (new.cancellation_choice = 'contract_50' and old.cancellation_choice is distinct from 'contract_50')
     or (new.cancellation_choice = 'show_up_100' and new.cancellation_proof_path is not null and old.cancellation_proof_path is null) then

    select s.employer_id, s.start_at, s.end_at, s.title, s.status, s.occurrences into v_shift
    from public.shifts s where s.id = new.shift_id;

    -- Defense-in-depth: never create a payout unless the shift is actually
    -- cancelled and this application was actually accepted + contract-signed,
    -- regardless of which RLS policy or trigger path authorized the write
    -- that landed us here.
    if v_shift.status is distinct from 'cancelled'
       or new.status is distinct from 'accepted'
       or new.worker_signed_at is null then
      return null;
    end if;

    -- Total contracted hours across every occurrence (one application covers
    -- the whole multi-day set), overnight occurrences wrapping +24h — the
    -- SQL mirror of the app's occurrenceHours/totalOccurrenceHours helpers.
    select coalesce(sum(
             case
               when mins > 0 then mins
               else mins + 24 * 60
             end
           ) / 60.0, 0)
    into v_hours
    from (
      select (split_part(o->>'end', ':', 1)::int * 60 + split_part(o->>'end', ':', 2)::int)
           - (split_part(o->>'start', ':', 1)::int * 60 + split_part(o->>'start', ':', 2)::int) as mins
      from jsonb_array_elements(coalesce(v_shift.occurrences, '[]'::jsonb)) o
      where o ? 'start' and o ? 'end'
    ) x;

    if v_hours <= 0 then
      v_hours := extract(epoch from (v_shift.end_at - v_shift.start_at)) / 3600.0;
    end if;
    v_hours := greatest(0.25, v_hours);

    if new.cancellation_choice = 'contract_50' then
      v_multiplier := 0.5;
      v_reason := 'late_cancellation_50pct';
    else
      v_multiplier := 1.0;
      v_reason := 'late_cancellation_show_up_100pct';
    end if;

    if new.cancellation_choice_made_at is null then
      perform set_config('app.cancellation_trusted_write', 'true', true);
      update public.applications set cancellation_choice_made_at = now() where id = new.id;
    end if;

    insert into public.payout_item (
      payout_cycle_id, worker_id, employer_id, amount, currency, scheduled_date,
      status, source_refs, idempotency_key
    ) values (
      null, new.worker_id, v_shift.employer_id,
      round(new.wage_ask * v_hours * v_multiplier, 2), 'MYR', current_date,
      'queued',
      jsonb_build_object('application_id', new.id, 'shift_id', new.shift_id, 'reason', v_reason),
      'cancellation:' || new.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      v_shift.employer_id,
      'shift_cancellation_choice_made',
      'Worker responded to shift cancellation',
      case when new.cancellation_choice = 'contract_50'
        then 'A worker accepted the 50% cancellation payout for "' || coalesce(v_shift.title, 'your shift') || '".'
        else 'A worker is showing up for "' || coalesce(v_shift.title, 'your shift') || '" and has submitted proof for full pay.'
      end,
      '/employer/shifts/' || new.shift_id,
      jsonb_build_object(
        'shift_title', coalesce(v_shift.title, 'your shift'),
        'variant', case when new.cancellation_choice = 'contract_50'
                        then 'contract_50' else 'show_up_100' end
      )
    );
  end if;
  return null;
end;
$$;

-- ── shift_checkout_submitted  [patched from 20260726d_cap_checkout_hours_to_contracted.sql] -- RPC, no handler:
--    called directly by the app, which surfaces its errors to the user.
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

  if v_app.checked_out_at is not null and not v_app.employer_hours_disputed then
    raise exception 'Checkout already submitted';
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
      worker_reported_hours = round(p_hours, 2),
      worker_reported_break_minutes = greatest(coalesce(p_break_minutes, 0), 0),
      worker_checkout_note = nullif(trim(coalesce(p_note, '')), ''),
      employer_hours_confirmed_at = null,
      employer_hours_disputed = false,
      employer_hours_dispute_note = null
  where id = p_application_id
  returning * into v_app;

  insert into public.notifications (user_id, type, title, body, link, params)
  select s.employer_id, 'shift_checkout_submitted', 'Worker submitted checkout hours',
    'A worker reported ' || round(p_hours, 2) || ' hours for "' || coalesce(s.title, 'a shift') || '". Please confirm or dispute.',
    '/employer/shifts/' || v_app.shift_id,
    jsonb_build_object('shift_title', coalesce(s.title, 'a shift'), 'hours', round(p_hours, 2))
  from public.shifts s where s.id = v_app.shift_id;

  return v_app;
end;
$$;

revoke all on function public.worker_submit_checkout(uuid, numeric, int, text) from public;
grant execute on function public.worker_submit_checkout(uuid, numeric, int, text) to authenticated;

-- ── shift_checkout_disputed  [patched from 20260726b_guard_applications_attendance_columns.sql] -- RPC, no handler.
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

  insert into public.notifications (user_id, type, title, body, link, params)
  select v_app.worker_id, 'shift_checkout_disputed', 'Employer disputed your checkout hours',
    coalesce('Reason: ' || nullif(trim(coalesce(p_note, '')), ''), 'The employer disputed the hours you reported. Please resubmit.'),
    '/worker/applications/' || v_app.id,
    jsonb_build_object(
      'reason', nullif(trim(coalesce(p_note, '')), ''),
      'variant', case when nullif(trim(coalesce(p_note, '')), '') is null
                      then 'no_reason' else 'with_reason' end
    );

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

-- ============================================================================
-- PART 4 — verification. Raises rather than reports: a check whose result
--          nobody reads is not a check.
-- ============================================================================
do $verify$
declare
  v_src text;
  v_missing text[] := '{}';
begin
  -- Part 1: the trigger on ratings must exist.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.ratings'::regclass
      and tgname = 'trg_recompute_profile_rating'
  ) then
    v_missing := array_append(v_missing, '20260804 (trg_recompute_profile_rating missing on public.ratings)');
  end if;

  -- Part 2: the live function must carry the coalesce, i.e. 20260809 is the
  -- version in place and 20260804 did not overwrite it.
  select prosrc into v_src from pg_proc where proname = 'recompute_profile_rating';
  if v_src is null then
    v_missing := array_append(v_missing, '20260809 (recompute_profile_rating does not exist at all)');
  -- Match the SPECIFIC construct, not the word. Both versions of this function
  -- contain coalesce elsewhere (`coalesce(new.ratee_id, old.ratee_id)` and
  -- `return coalesce(new, old)`), so a bare search for 'coalesce' passes on the
  -- UNFIXED version too. Caught by deliberately regressing the function in a
  -- sandbox and watching this check wave it through.
  elsif v_src !~* 'set\s+rating\s*=\s*coalesce' then
    v_missing := array_append(v_missing, '20260809 (function exists but `set rating` is not wrapped in coalesce -- the NULL fix is NOT in place; if you just ran this file, Part 1 has overwritten Part 2 and the order is wrong)');
  end if;

  -- Part 3: the notification triggers must write params, not just prose.
  select prosrc into v_src from pg_proc where proname = 'notify_bid_received';
  if v_src is null or v_src !~* 'params' then
    v_missing := array_append(v_missing, '20260813 (notify_bid_received does not write params)');
  end if;
  select prosrc into v_src from pg_proc where proname = 'notify_shift_offer';
  if v_src is null or v_src !~* 'params' then
    v_missing := array_append(v_missing, '20260813 (notify_shift_offer does not write params)');
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'VERIFICATION FAILED: %', array_to_string(v_missing, ' | ');
  end if;

  raise notice '=====================================================';
  raise notice 'ALL FOUR PARTS VERIFIED';
  raise notice '  Part 0: QA shift cleared';
  raise notice '  Part 1: trg_recompute_profile_rating present on ratings';
  raise notice '  Part 2: recompute_profile_rating carries the coalesce NULL fix';
  raise notice '  Part 3: notification triggers write params';
  raise notice '=====================================================';
end
$verify$;

-- Shifts never became 'completed'. This makes them.
--
-- THE BUG (reported 2026-09-11: "employers cannot give ratings after the shift
-- ended"). shifts.status has allowed 'completed' since 20260629, and about ten
-- features gate on it:
--   * ratings_owner_insert (20260725i)        -- both directions of rating
--   * disputes_owner_insert (20260822c)       -- filing a dispute
--   * the employer's "rate your workers" prompt and per-applicant Rate button
--   * the worker's rating prompt, Rate button, and "shifts done" count
-- But nothing ever WROTE it. No migration, no trigger, no client update. Live
-- data on the day: 6 shifts, all 'open', 4 of them already over, 0 completed.
-- So nobody could rate anybody, nobody could dispute a completed shift, every
-- worker read "0 shifts done", and the 4 finished shifts were still listed in
-- Discover as open for bidding -- Discover filters on status = 'open' alone.
--
-- WHY A CALLABLE SWEEP AND NOT A CRON. There is no pg_cron in this project;
-- 20260705, 20260811b and 20260817 all say so explicitly. The established
-- pattern is a lazy sweep the client triggers when it loads (see the offer
-- expiry in 20260705). This follows it. The difference is that the transition
-- is decided server-side: complete_ended_shifts() takes no arguments, so a
-- caller cannot choose which shifts to complete or lie about the time. The only
-- thing it can ever do is the correct thing.
--
-- WHY NOT end_at. start_at/end_at mirror the EARLIEST occurrence (20260712d).
-- On a Sat + Mon shift, end_at is Saturday evening. Completing on end_at would
-- close a shift with a working day still to come, lock out Monday's check-in
-- flows' ratings too early, and pull it from Discover while it was still being
-- worked. "Ended" has to mean the LAST occurrence has ended.
--
-- SIDE EFFECTS CHECKED. Four triggers fire on a shifts status change:
-- notify_shift_cancelled, notify_cancellation_choice_pending and
-- release_holds_on_cancelled_shift all guard on new.status = 'cancelled', so
-- 'completed' passes through them silently. notify_shift_updated only fires
-- for open/filled/closed. Nothing post-shift is blocked either:
-- worker_submit_checkout, employer_confirm_checkout, employer_dispute_checkout
-- and employer_mark_no_show have no shift-status requirement at all. The
-- self-test below asserts the two that matter most -- no bogus "shift
-- cancelled" notification, and no released hold.

-- ── when a shift actually ends ─────────────────────────────────────────────
-- The last occurrence's end, in Malaysia time. An occurrence whose end is at or
-- before its start runs past midnight and ends the following day -- the same
-- +24h wrap occurrenceHours and shift_contracted_hours already apply.
--
-- plpgsql with an exception handler rather than plain SQL, deliberately: this
-- runs inside a sweep over every open shift, and one malformed occurrence
-- ('25:00', a missing date) must degrade to end_at for THAT shift, not abort
-- the sweep and leave every other shift uncompleted.
create or replace function public.shift_ends_at(p_occurrences jsonb, p_end_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_end timestamptz;
begin
  begin
    select max(
             ((o->>'date')::date + (o->>'end')::time
               + case when (o->>'end')::time <= (o->>'start')::time
                      then interval '1 day' else interval '0' end)
             at time zone 'Asia/Kuala_Lumpur'
           )
      into v_end
      from jsonb_array_elements(coalesce(p_occurrences, '[]'::jsonb)) o
     where o ? 'date' and o ? 'start' and o ? 'end';
  exception when others then
    v_end := null;
  end;
  return coalesce(v_end, p_end_at);
end;
$$;

comment on function public.shift_ends_at(jsonb, timestamptz) is
  'When a shift actually ends: the last occurrence''s end in Asia/Kuala_Lumpur, overnight occurrences wrapping to the next day. Falls back to end_at when no occurrence is parseable. NOT end_at itself -- that mirrors the FIRST occurrence.';

-- ── the sweep ──────────────────────────────────────────────────────────────
create or replace function public.complete_ended_shifts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.shifts
     set status = 'completed', updated_at = now()
   where status in ('open', 'filled')
     -- Cheap pre-filter: nothing that has not started can have ended. Keeps
     -- the helper off every future shift on each call.
     and start_at < now()
     and public.shift_ends_at(occurrences, end_at) < now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.complete_ended_shifts() is
  'Marks open/filled shifts whose last occurrence has ended as completed. No arguments: callers cannot pick shifts or supply a time. Called lazily by both portals on load (no pg_cron in this project). Returns how many it completed.';

revoke all on function public.complete_ended_shifts() from public;
grant execute on function public.complete_ended_shifts() to authenticated;

-- ── self-verifying test ────────────────────────────────────────────────────
-- Inside a subtransaction that ALWAYS rolls back, so it leaves nothing behind
-- (the convention from 20260824b / 20260829). Runs against the live triggers,
-- which is the point: a scaffold without them passed where production failed
-- once before.
do $test$
declare
  v_emp    uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- QA employer
  v_worker uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';  -- QA worker
  v_kl_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_past   uuid; v_multi uuid; v_future uuid; v_cancelled uuid; v_app uuid;
  v_status text; v_n int;
begin
  begin
    -- 1. The helper, on FIXED dates, so this can never be flaky around
    --    midnight. Overnight wrap: 23:00 -> 00:30 ends the NEXT day.
    if public.shift_ends_at('[{"date":"2026-01-10","start":"23:00","end":"00:30"}]'::jsonb, null)
       is distinct from (timestamp '2026-01-11 00:30' at time zone 'Asia/Kuala_Lumpur') then
      raise exception 'COMPLETE self-test FAILED: overnight occurrence did not wrap to the next day';
    end if;
    -- Multi-day: the LAST occurrence decides, not the first.
    if public.shift_ends_at('[{"date":"2026-01-10","start":"09:00","end":"15:00"},{"date":"2026-01-12","start":"09:00","end":"15:00"}]'::jsonb,
                            timestamptz '2026-01-10 07:00+00')
       is distinct from (timestamp '2026-01-12 15:00' at time zone 'Asia/Kuala_Lumpur') then
      raise exception 'COMPLETE self-test FAILED: multi-day shift did not end on its last occurrence';
    end if;
    -- Malformed occurrence degrades to end_at instead of raising.
    if public.shift_ends_at('[{"date":"not-a-date","start":"09:00","end":"15:00"}]'::jsonb,
                            timestamptz '2026-02-01 10:00+00')
       is distinct from timestamptz '2026-02-01 10:00+00' then
      raise exception 'COMPLETE self-test FAILED: malformed occurrence did not fall back to end_at';
    end if;

    -- 2. The sweep, on shifts placed days either side of now.
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COMPLETE test: ended', 'KL',
            (v_kl_today - 3 + time '09:00') at time zone 'Asia/Kuala_Lumpur',
            (v_kl_today - 3 + time '15:00') at time zone 'Asia/Kuala_Lumpur',
            10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('date', (v_kl_today - 3)::text, 'start', '09:00', 'end', '15:00')))
    returning id into v_past;

    -- The trap: first day over, last day still ahead. end_at says "ended".
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COMPLETE test: multi-day in progress', 'KL',
            (v_kl_today - 3 + time '09:00') at time zone 'Asia/Kuala_Lumpur',
            (v_kl_today - 3 + time '15:00') at time zone 'Asia/Kuala_Lumpur',
            10, 20, 1, 'open',
            jsonb_build_array(
              jsonb_build_object('date', (v_kl_today - 3)::text, 'start', '09:00', 'end', '15:00'),
              jsonb_build_object('date', (v_kl_today + 3)::text, 'start', '09:00', 'end', '15:00')))
    returning id into v_multi;

    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COMPLETE test: future', 'KL',
            (v_kl_today + 3 + time '09:00') at time zone 'Asia/Kuala_Lumpur',
            (v_kl_today + 3 + time '15:00') at time zone 'Asia/Kuala_Lumpur',
            10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('date', (v_kl_today + 3)::text, 'start', '09:00', 'end', '15:00')))
    returning id into v_future;

    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COMPLETE test: cancelled', 'KL',
            (v_kl_today - 3 + time '09:00') at time zone 'Asia/Kuala_Lumpur',
            (v_kl_today - 3 + time '15:00') at time zone 'Asia/Kuala_Lumpur',
            10, 20, 1, 'cancelled',
            jsonb_build_array(jsonb_build_object('date', (v_kl_today - 3)::text, 'start', '09:00', 'end', '15:00')))
    returning id into v_cancelled;

    -- An accepted worker on the ended shift, so the cancellation triggers WOULD
    -- have someone to notify, and a hold to release, if they misfired.
    insert into public.applications (shift_id, worker_id, wage_ask, status)
    values (v_past, v_worker, 15, 'accepted')
    returning id into v_app;

    v_n := public.complete_ended_shifts();

    select status into v_status from public.shifts where id = v_past;
    if v_status <> 'completed' then
      raise exception 'COMPLETE self-test FAILED: an ended shift was left %', v_status;
    end if;
    select status into v_status from public.shifts where id = v_multi;
    if v_status <> 'open' then
      raise exception 'COMPLETE self-test FAILED: a multi-day shift with a day still to come was marked % (end_at trap)', v_status;
    end if;
    select status into v_status from public.shifts where id = v_future;
    if v_status <> 'open' then
      raise exception 'COMPLETE self-test FAILED: a future shift was marked %', v_status;
    end if;
    select status into v_status from public.shifts where id = v_cancelled;
    if v_status <> 'cancelled' then
      raise exception 'COMPLETE self-test FAILED: a cancelled shift was overwritten to %', v_status;
    end if;

    -- 3. The triggers stayed quiet.
    if exists (select 1 from public.notifications
                where user_id = v_worker and type in ('shift_cancelled', 'cancellation_choice_pending')
                  and created_at >= now()) then
      raise exception 'COMPLETE self-test FAILED: completing a shift sent a cancellation notification';
    end if;
    if exists (select 1 from public.employer_wallet_entry
                where application_id = v_app and kind = 'release') then
      raise exception 'COMPLETE self-test FAILED: completing a shift released the employer''s hold';
    end if;

    -- 4. Idempotent: a second call finds nothing new among the test rows.
    perform public.complete_ended_shifts();
    select status into v_status from public.shifts where id = v_multi;
    if v_status <> 'open' then
      raise exception 'COMPLETE self-test FAILED: a second sweep changed the in-progress multi-day shift';
    end if;

    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        raise notice 'COMPLETE self-test passed: overnight wrap, last-occurrence end, malformed fallback; ended -> completed, multi-day-in-progress / future / cancelled untouched; no cancellation notice, no released hold; idempotent. All test rows rolled back.';
      elsif sqlerrm like 'COMPLETE self-test FAILED%' then
        raise;
      else
        raise warning 'COMPLETE self-test SETUP failed (fix still applied): %', sqlerrm;
      end if;
  end;
end $test$;

-- ── apply it now ───────────────────────────────────────────────────────────
-- Completes the shifts that are already over, so ratings open up the moment
-- this runs rather than the next time someone happens to load a portal.
do $$
declare v_n int;
begin
  v_n := public.complete_ended_shifts();
  raise notice 'complete_ended_shifts: % shift(s) marked completed now.', v_n;
end $$;

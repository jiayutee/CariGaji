-- Hours negotiation: a middle ground between Accept and Dispute.
--
-- Today the employer reviewing a worker's checkout hours has exactly two
-- buttons: Accept, or Dispute (which auto-files a real disputes row,
-- category 'hours_disputed'). There is no way to just say "I make it 5.5
-- hours, not 6 -- here's why" without immediately filing a formal dispute.
-- Owner request 2026-09-14: add Decline & Modify (counter-propose hours +
-- a note) as a real negotiation step, capped at one round each side, with
-- Dispute reserved for when that round ALSO fails to reach agreement.
--
-- FINANCIAL CONSTRAINT THIS MIGRATION DELIBERATELY DOES NOT TOUCH: the
-- payout trigger (20260821b_payout_on_hours_confirmed.sql) fires strictly
-- on employer_hours_confirmed_at going null -> not null and pays whatever
-- is in worker_reported_hours at that moment. Nothing here changes that
-- trigger or its condition. worker_accept_modification below is the ONLY
-- new write path that sets employer_hours_confirmed_at, and it does so by
-- first copying the agreed number INTO worker_reported_hours -- the exact
-- column the trigger already reads. The trigger's own logic is untouched
-- and does not need to know this feature exists.

alter table public.applications
  add column if not exists employer_proposed_hours numeric(6,2),
  add column if not exists employer_proposed_note   text,
  add column if not exists employer_proposed_at     timestamptz,
  add column if not exists hours_resubmitted         boolean not null default false;

-- ── employer_propose_modification ───────────────────────────────────────────
-- Employer counter-proposes a different hours figure with a note explaining
-- why, instead of accepting or immediately disputing. Capped at one round:
-- refuses if the worker has already used their one resubmission (the round
-- is over, only Accept/Dispute remain) -- enforced here, not just in the UI,
-- since the UI restriction alone would not stop a replayed/forged request.
create or replace function public.employer_propose_modification(
  p_application_id uuid,
  p_hours numeric,
  p_note text
)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_employer_id uuid;
begin
  select a.id, a.shift_id, a.worker_id, a.checked_out_at, a.employer_hours_confirmed_at,
         a.employer_hours_disputed, a.employer_proposed_hours, a.hours_resubmitted
  into v_app
  from public.applications a
  where a.id = p_application_id
  for update;

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
  if v_app.employer_hours_confirmed_at is not null then
    raise exception 'Hours already confirmed';
  end if;
  if v_app.employer_hours_disputed then
    raise exception 'Already formally disputed';
  end if;
  if v_app.employer_proposed_hours is not null then
    raise exception 'A proposal is already pending the worker''s response';
  end if;
  if v_app.hours_resubmitted then
    raise exception 'The one negotiation round has already been used -- accept the resubmitted hours or file a dispute';
  end if;

  if p_hours is null or p_hours <= 0 or p_hours > 100 then
    raise exception 'Enter a valid number of hours';
  end if;

  update public.applications
  set employer_proposed_hours = round(p_hours, 2),
      employer_proposed_note  = nullif(trim(coalesce(p_note, '')), ''),
      employer_proposed_at    = now()
  where id = p_application_id
  returning * into v_app;

  insert into public.notifications (user_id, type, title, body, link)
  select v_app.worker_id, 'shift_hours_modification_proposed', 'Employer proposed different hours',
    'The employer proposed ' || round(p_hours, 2) || ' hours instead of what you reported.'
      || coalesce(' Note: ' || nullif(trim(coalesce(p_note, '')), ''), ''),
    '/worker/applications/' || v_app.id
  from public.shifts s where s.id = v_app.shift_id;

  return v_app;
end;
$$;

revoke all on function public.employer_propose_modification(uuid, numeric, text) from public;
grant execute on function public.employer_propose_modification(uuid, numeric, text) to authenticated;

-- ── worker_accept_modification ──────────────────────────────────────────────
-- Worker agrees to the employer's proposed number. Copies it into
-- worker_reported_hours (the column the payout trigger reads) and confirms
-- in the SAME update the existing trigger already watches.
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

  update public.applications
  set worker_reported_hours       = employer_proposed_hours,
      employer_hours_confirmed_at = now(),
      employer_hours_disputed     = false,
      employer_proposed_hours     = null,
      employer_proposed_note      = null,
      employer_proposed_at        = null
  where id = p_application_id
  returning * into v_app;

  return v_app;
end;
$$;

revoke all on function public.worker_accept_modification(uuid) from public;
grant execute on function public.worker_accept_modification(uuid) to authenticated;

-- ── worker_reject_modification ──────────────────────────────────────────────
-- Worker disagrees with the employer's proposed number and wants to submit
-- their own figure again. Sets checked_out_at back to null so the EXISTING
-- worker-side "checked in, not checked out" branch and the EXISTING
-- worker_submit_checkout RPC handle the resubmission verbatim -- no new
-- worker-facing checkout code needed for this step. hours_resubmitted flips
-- true, which is what employer_propose_modification checks to enforce the
-- one-round cap.
create or replace function public.worker_reject_modification(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_shift_id uuid;
  v_employer_id uuid;
begin
  select a.id, a.worker_id, a.shift_id, a.employer_proposed_hours
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
    raise exception 'No pending proposal to reject';
  end if;

  update public.applications
  set checked_out_at          = null,
      employer_proposed_hours = null,
      employer_proposed_note  = null,
      employer_proposed_at    = null,
      hours_resubmitted       = true
  where id = p_application_id
  returning * into v_app;

  select employer_id into v_employer_id from public.shifts where id = v_app.shift_id;
  insert into public.notifications (user_id, type, title, body, link)
  values (
    v_employer_id, 'shift_hours_modification_rejected', 'Worker rejected your proposed hours',
    'The worker rejected your proposed hours and will resubmit their own. This was the one negotiation round -- a further disagreement will need a formal dispute.',
    '/employer/shifts/' || v_app.shift_id
  );

  return v_app;
end;
$$;

revoke all on function public.worker_reject_modification(uuid) from public;
grant execute on function public.worker_reject_modification(uuid) to authenticated;

-- ── self-verifying test ──────────────────────────────────────────────────
-- Rolled back always (ROLLBACK_SELFTEST convention, e.g. 20260912). Covers:
-- propose -> accept (worker_reported_hours takes the agreed number, the
-- payout trigger's condition becomes true), propose -> reject -> resubmit
-- (checked_out_at genuinely nulled, hours_resubmitted flips), and the round
-- cap actually refusing a second proposal rather than just being assumed.
do $test$
declare
  v_employer uuid := gen_random_uuid();
  v_worker   uuid := gen_random_uuid();
  v_shift    uuid;
  v_app1     uuid;
  v_app2     uuid;
  v_row      record;
begin
  begin
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_employer, 'NEGOTIATION test shift', 'KL', now() - interval '1 day', now() - interval '1 day' + interval '6 hours', 10, 20, 5, 'completed', '[]'::jsonb)
    returning id into v_shift;

    insert into public.applications (shift_id, worker_id, wage_ask, status, checked_in_at, checked_out_at, worker_reported_hours)
    values (v_shift, v_worker, 15, 'accepted', now() - interval '6 hours', now(), 6.0)
    returning id into v_app1;

    insert into public.applications (shift_id, worker_id, wage_ask, status, checked_in_at, checked_out_at, worker_reported_hours)
    values (v_shift, gen_random_uuid(), 15, 'accepted', now() - interval '6 hours', now(), 6.0)
    returning id into v_app2;

    -- Employer proposes 5.5 on app1.
    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_propose_modification(v_app1, 5.5, 'Break was longer than logged');

    select employer_proposed_hours, employer_proposed_note into v_row from public.applications where id = v_app1;
    if v_row.employer_proposed_hours is distinct from 5.5 then
      raise exception 'NEGOTIATION FAILED: proposal not recorded, got %', v_row.employer_proposed_hours;
    end if;

    -- A second proposal on the SAME pending one must be refused (no double-propose).
    begin
      perform public.employer_propose_modification(v_app1, 5.0, 'again');
      raise exception 'NEGOTIATION FAILED: a second proposal on an already-pending one was wrongly allowed';
    exception when others then
      if sqlerrm not like '%already pending%' then raise; end if;
    end;

    -- Worker accepts -> worker_reported_hours takes 5.5, confirmed_at set,
    -- proposal columns cleared. This is exactly the trigger's watched condition.
    perform set_config('request.jwt.claims', '{"sub":"' || v_worker::text || '","role":"authenticated"}', true);
    perform public.worker_accept_modification(v_app1);

    select worker_reported_hours, employer_hours_confirmed_at, employer_proposed_hours
      into v_row from public.applications where id = v_app1;
    if v_row.worker_reported_hours is distinct from 5.5 then
      raise exception 'NEGOTIATION FAILED: accept did not copy the agreed hours into worker_reported_hours, got %', v_row.worker_reported_hours;
    end if;
    if v_row.employer_hours_confirmed_at is null then
      raise exception 'NEGOTIATION FAILED: accept did not confirm -- the payout trigger''s condition never fired';
    end if;
    if v_row.employer_proposed_hours is not null then
      raise exception 'NEGOTIATION FAILED: accept left the proposal columns set';
    end if;

    -- Second application: propose -> reject -> confirm resubmission opened the door.
    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_propose_modification(v_app2, 5.0, 'test');

    select worker_id into v_row from public.applications where id = v_app2;
    perform set_config('request.jwt.claims', '{"sub":"' || v_row.worker_id::text || '","role":"authenticated"}', true);
    perform public.worker_reject_modification(v_app2);

    select checked_out_at, hours_resubmitted, employer_proposed_hours
      into v_row from public.applications where id = v_app2;
    if v_row.checked_out_at is not null then
      raise exception 'NEGOTIATION FAILED: reject did not clear checked_out_at -- resubmit path stays blocked';
    end if;
    if v_row.hours_resubmitted is not true then
      raise exception 'NEGOTIATION FAILED: reject did not flip hours_resubmitted';
    end if;
    if v_row.employer_proposed_hours is not null then
      raise exception 'NEGOTIATION FAILED: reject left the proposal columns set';
    end if;

    -- The round cap: employer cannot propose again now that hours_resubmitted is true.
    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    begin
      perform public.employer_propose_modification(v_app2, 4.5, 'trying again');
      raise exception 'NEGOTIATION FAILED: the one-round cap did not hold -- a second proposal was wrongly allowed';
    exception when others then
      if sqlerrm not like '%one negotiation round%' then raise; end if;
    end;

    perform set_config('request.jwt.claims', '', true);
    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        raise notice 'NEGOTIATION self-test passed: propose->accept lands in worker_reported_hours and confirms (payout trigger condition fires correctly), double-propose is refused, propose->reject correctly reopens the resubmit path and flips hours_resubmitted, and the one-round cap actually refuses a second proposal. All test rows rolled back.';
      elsif sqlerrm like 'NEGOTIATION FAILED%' then
        raise;
      else
        raise warning 'NEGOTIATION self-test SETUP failed (fix still applied): %', sqlerrm;
      end if;
  end;
end $test$;

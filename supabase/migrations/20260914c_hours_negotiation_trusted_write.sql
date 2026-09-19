-- Hours negotiation: worker_accept_modification and worker_reject_modification
-- never actually wrote what they claimed to.
--
-- ROOT CAUSE. applications_guard_attendance_columns (20260726b) is a BEFORE
-- UPDATE trigger that silently reverts checked_out_at, worker_reported_hours,
-- employer_hours_confirmed_at, employer_hours_disputed (and friends) to their
-- old values unless the transaction first sets app.attendance_trusted_write.
-- Every existing RPC that legitimately writes those columns sets the flag.
-- The two RPCs added in 20260914 did not, so:
--
--   * worker_reject_modification: `checked_out_at = null` was reverted. The
--     worker was left "checked out" with the proposal cleared and
--     hours_resubmitted = true, so worker_submit_checkout refused the
--     resubmission ("Checkout already submitted") and the employer saw
--     Accept/Dispute on the ORIGINAL hours. Reproduced live 2026-09-19.
--
--   * worker_accept_modification: worker_reported_hours and
--     employer_hours_confirmed_at were both reverted while the proposal
--     columns (not guarded) were cleared. The agreed hours were never
--     confirmed, so the payout trigger never fired -- and had the confirm
--     landed without the hours, it would have paid the ORIGINAL figure.
--
-- Fix: set the flag before the UPDATE, exactly as the sibling RPCs do.
--
-- WHY THE 20260914 SELF-TEST DID NOT CATCH THIS. It inserted a shift with
-- occurrences '[]' (rejected by shifts_occurrences_nonempty) and random UUID
-- users, and its catch-all downgraded the resulting setup error to a warning.
-- Its assertions never ran. This test uses real profile ids and a valid
-- occurrence, refuses to swallow anything after setup, and asserts the exact
-- state that was wrong (checked_out_at cleared, hours + confirmation written,
-- payout amount = wage * AGREED hours).

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

create or replace function public.worker_reject_modification(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
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

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set checked_out_at          = null,
      employer_proposed_hours = null,
      employer_proposed_note  = null,
      employer_proposed_at    = null,
      hours_resubmitted       = true
  where id = p_application_id
  returning * into v_app;

  begin
    select employer_id into v_employer_id from public.shifts where id = v_app.shift_id;
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_employer_id, 'shift_hours_modification_rejected', 'Worker rejected your proposed hours',
      'The worker rejected your proposed hours and will resubmit their own. This was the one negotiation round -- a further disagreement will need a formal dispute.',
      '/employer/shifts/' || v_app.shift_id
    );
  exception when others then
    raise warning 'worker_reject_modification: notification insert failed for application % (%), rejection still recorded', p_application_id, sqlerrm;
  end;

  return v_app;
end;
$$;

revoke all on function public.worker_reject_modification(uuid) from public;
grant execute on function public.worker_reject_modification(uuid) to authenticated;

-- Self-test, always rolled back. Only SETUP failures are tolerated (reported
-- loudly as "assertions NOT run"); once setup succeeds every failure raises.
do $test$
declare
  v_employer uuid;
  v_worker   uuid;
  v_shift1   uuid;
  v_shift2   uuid;
  v_app1     uuid;
  v_app2     uuid;
  v_row      record;
  v_ran      boolean := false;
  v_occ      jsonb;
begin
  select id into v_employer from public.profiles order by id limit 1;
  select id into v_worker   from public.profiles where id <> v_employer order by id limit 1;
  if v_employer is null or v_worker is null then
    raise warning 'TRUSTED-WRITE self-test NOT run: needs two rows in public.profiles (fix still applied)';
    return;
  end if;

  begin
    begin
      v_occ := jsonb_build_array(jsonb_build_object(
        'date', to_char(now(), 'YYYY-MM-DD'),
        'start_at', (now() - interval '1 hour'),
        'end_at', (now() + interval '4 hours')));

      insert into public.shifts (employer_id, title, description, category, location, start_at, end_at, wage_min, wage_max, headcount, status, requirements, occurrences)
      values (v_employer, 'ZZ-TRUSTED-WRITE selftest 1', 'x', 'Other', 'KL', now() - interval '1 hour', now() + interval '4 hours', 10, 20, 1, 'open', '', v_occ)
      returning id into v_shift1;
      insert into public.shifts (employer_id, title, description, category, location, start_at, end_at, wage_min, wage_max, headcount, status, requirements, occurrences)
      values (v_employer, 'ZZ-TRUSTED-WRITE selftest 2', 'x', 'Other', 'KL', now() - interval '1 hour', now() + interval '4 hours', 10, 20, 1, 'open', '', v_occ)
      returning id into v_shift2;

      insert into public.applications (shift_id, worker_id, wage_ask, status, worker_signed_at, checked_in_at, checked_out_at, worker_reported_hours)
      values (v_shift1, v_worker, 15, 'accepted', now(), now() - interval '5 hours', now(), 5.0)
      returning id into v_app1;
      insert into public.applications (shift_id, worker_id, wage_ask, status, worker_signed_at, checked_in_at, checked_out_at, worker_reported_hours)
      values (v_shift2, v_worker, 15, 'accepted', now(), now() - interval '5 hours', now(), 5.0)
      returning id into v_app2;
    exception when others then
      raise warning 'TRUSTED-WRITE self-test SETUP failed, assertions NOT run (fix still applied): %', sqlerrm;
      raise exception 'ROLLBACK_SELFTEST';
    end;
    v_ran := true;

    -- Scenario A: propose -> REJECT -> the worker can resubmit.
    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_propose_modification(v_app1, 4.5, 'left early');
    perform set_config('request.jwt.claims', '{"sub":"' || v_worker::text || '","role":"authenticated"}', true);
    perform public.worker_reject_modification(v_app1);

    select checked_out_at, hours_resubmitted, employer_proposed_hours into v_row from public.applications where id = v_app1;
    if v_row.checked_out_at is not null then
      raise exception 'TRUSTED-WRITE FAILED: reject did not clear checked_out_at (guard trigger reverted it)';
    end if;
    if v_row.hours_resubmitted is not true or v_row.employer_proposed_hours is not null then
      raise exception 'TRUSTED-WRITE FAILED: reject did not flip hours_resubmitted / clear the proposal';
    end if;

    perform public.worker_submit_checkout(v_app1, 4.75, 0, 'resubmitting');
    select checked_out_at, worker_reported_hours into v_row from public.applications where id = v_app1;
    if v_row.checked_out_at is null or v_row.worker_reported_hours is distinct from 4.75 then
      raise exception 'TRUSTED-WRITE FAILED: resubmission after a rejection did not land (checked_out_at %, hours %)', v_row.checked_out_at, v_row.worker_reported_hours;
    end if;

    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    begin
      perform public.employer_propose_modification(v_app1, 4.0, 'second round');
      raise exception 'TRUSTED-WRITE FAILED: the one-round cap let a second proposal through';
    exception when others then
      if sqlerrm not like '%already been used%' then raise; end if;
    end;

    -- Scenario B: propose -> ACCEPT -> agreed hours confirmed and paid on.
    perform public.employer_propose_modification(v_app2, 4.5, 'break was longer');
    perform set_config('request.jwt.claims', '{"sub":"' || v_worker::text || '","role":"authenticated"}', true);
    perform public.worker_accept_modification(v_app2);

    select worker_reported_hours, employer_hours_confirmed_at, employer_proposed_hours into v_row from public.applications where id = v_app2;
    if v_row.worker_reported_hours is distinct from 4.5 then
      raise exception 'TRUSTED-WRITE FAILED: accept did not write the agreed hours, worker_reported_hours = %', v_row.worker_reported_hours;
    end if;
    if v_row.employer_hours_confirmed_at is null then
      raise exception 'TRUSTED-WRITE FAILED: accept did not confirm the hours (guard trigger reverted employer_hours_confirmed_at)';
    end if;
    if v_row.employer_proposed_hours is not null then
      raise exception 'TRUSTED-WRITE FAILED: accept left the proposal in place';
    end if;

    if not exists (
      select 1 from public.payout_item
      where idempotency_key = 'shift_work:' || v_app2::text and amount = 67.50
    ) then
      raise exception 'TRUSTED-WRITE FAILED: no payout for the AGREED hours (expected 15 x 4.5 = 67.50)';
    end if;

    perform set_config('request.jwt.claims', '', true);
    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        if v_ran then
          raise notice 'TRUSTED-WRITE self-test passed: reject clears checked_out_at and the worker can resubmit; the cap holds; accept writes the agreed hours, confirms them, and pays 15 x 4.5 = 67.50. All test rows rolled back.';
        end if;
      else
        raise;
      end if;
  end;
end $test$;

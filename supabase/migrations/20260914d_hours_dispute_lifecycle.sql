-- Hours disputes never closed, and only ever recorded the FIRST note.
--
-- Found by running a multi-round dispute/resubmit cycle live (2026-09-19):
--
--   1. employer_dispute_checkout inserts a `disputes` row only when no OPEN
--      hours_disputed row exists. Nothing ever closes that row, so a second
--      dispute in the same negotiation recorded nothing: the admin saw only
--      the first round's note, however the discussion had moved on. It also
--      ignored 'under_review' rows, so a dispute an admin had picked up would
--      have spawned a duplicate.
--
--   2. employer_confirm_checkout (and worker_accept_modification) settle the
--      hours -- and pay the worker -- but left the dispute open. The admin
--      queue filled with "open" disputes for shifts that were agreed and paid.
--
-- Fix:
--   * a later dispute on the same application appends its note to the
--     existing open/under_review row instead of being dropped;
--   * confirming (or accepting) hours closes any open/under_review
--     hours_disputed row as 'resolved', noting why. Wrapped so a disputes
--     problem can never block confirming hours or paying the worker.
--
-- Everything else in the two RPCs is reproduced verbatim from
-- 20260813 (dispute) and 20260726b (confirm), including the trusted-write flag.

create or replace function public.close_hours_dispute(p_application_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.disputes
  set status = 'resolved',
      resolved_at = now(),
      admin_notes = case when admin_notes is null or admin_notes = '' then p_reason
                         else admin_notes || E'\n' || p_reason end
  where application_id = p_application_id
    and category = 'hours_disputed'
    and status in ('open', 'under_review');
exception when others then
  raise warning 'close_hours_dispute failed for application % (%), hours still settled', p_application_id, sqlerrm;
end;
$$;

-- Internal helper: only the SECURITY DEFINER RPCs below may call it.
revoke all on function public.close_hours_dispute(uuid, text) from public;

create or replace function public.employer_confirm_checkout(p_application_id uuid)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_employer_id uuid;
begin
  select a.id, a.shift_id, a.checked_out_at into v_app
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
  set employer_hours_confirmed_at = now(),
      employer_hours_disputed = false,
      employer_hours_dispute_note = null
  where id = p_application_id
  returning * into v_app;

  perform public.close_hours_dispute(p_application_id, 'Auto-resolved: the employer confirmed the worker''s hours.');

  return v_app;
end;
$$;

revoke all on function public.employer_confirm_checkout(uuid) from public;
grant execute on function public.employer_confirm_checkout(uuid) to authenticated;

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

  perform public.close_hours_dispute(p_application_id, 'Auto-resolved: the worker accepted the employer''s proposed hours.');

  return v_app;
end;
$$;

revoke all on function public.worker_accept_modification(uuid) from public;
grant execute on function public.worker_accept_modification(uuid) to authenticated;

create or replace function public.employer_dispute_checkout(p_application_id uuid, p_note text)
returns public.applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_employer_id uuid;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_existing uuid;
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
      employer_hours_dispute_note = v_note,
      employer_hours_confirmed_at = null
  where id = p_application_id;

  insert into public.notifications (user_id, type, title, body, link, params)
  select v_app.worker_id, 'shift_checkout_disputed', 'Employer disputed your checkout hours',
    coalesce('Reason: ' || v_note, 'The employer disputed the hours you reported. Please resubmit.'),
    '/worker/applications/' || v_app.id,
    jsonb_build_object(
      'reason', v_note,
      'variant', case when v_note is null then 'no_reason' else 'with_reason' end
    );

  select id into v_existing
  from public.disputes
  where application_id = v_app.id and category = 'hours_disputed' and status in ('open', 'under_review')
  order by created_at
  limit 1;

  if v_existing is null then
    insert into public.disputes (application_id, filed_by, filed_by_role, category, description)
    values (
      v_app.id, auth.uid(), 'employer', 'hours_disputed',
      coalesce(v_note, 'Employer disputed worker-reported checkout hours.')
    );
  elsif v_note is not null then
    update public.disputes
    set description = description || E'\n\nFollow-up dispute: ' || v_note
    where id = v_existing;
  end if;

  select * into v_app from public.applications where id = p_application_id;
  return v_app;
end;
$$;

revoke all on function public.employer_dispute_checkout(uuid, text) from public;
grant execute on function public.employer_dispute_checkout(uuid, text) to authenticated;

-- Self-test, always rolled back. Only SETUP failures are tolerated (reported
-- loudly as "assertions NOT run"); after setup every failure raises.
do $test$
declare
  v_employer uuid;
  v_worker   uuid;
  v_shift    uuid;
  v_app      uuid;
  v_row      record;
  v_n        int;
  v_ran      boolean := false;
  v_occ      jsonb;
begin
  select id into v_employer from public.profiles order by id limit 1;
  select id into v_worker   from public.profiles where id <> v_employer order by id limit 1;
  if v_employer is null or v_worker is null then
    raise warning 'DISPUTE-LIFECYCLE self-test NOT run: needs two rows in public.profiles (fix still applied)';
    return;
  end if;

  begin
    begin
      v_occ := jsonb_build_array(jsonb_build_object(
        'date', to_char(now(), 'YYYY-MM-DD'),
        'start_at', (now() - interval '1 hour'),
        'end_at', (now() + interval '4 hours')));
      insert into public.shifts (employer_id, title, description, category, location, start_at, end_at, wage_min, wage_max, headcount, status, requirements, occurrences)
      values (v_employer, 'ZZ-DISPUTE-LIFECYCLE selftest', 'x', 'Other', 'KL', now() - interval '1 hour', now() + interval '4 hours', 10, 20, 1, 'open', '[]'::jsonb, v_occ)
      returning id into v_shift;
      insert into public.applications (shift_id, worker_id, wage_ask, status, worker_signed_at, checked_in_at, checked_out_at, worker_reported_hours)
      values (v_shift, v_worker, 15, 'accepted', now(), now() - interval '5 hours', now(), 5.0)
      returning id into v_app;
    exception when others then
      raise warning 'DISPUTE-LIFECYCLE self-test SETUP failed, assertions NOT run (fix still applied): %', sqlerrm;
      raise exception 'ROLLBACK_SELFTEST';
    end;
    v_ran := true;

    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_dispute_checkout(v_app, 'note one');

    perform set_config('request.jwt.claims', '{"sub":"' || v_worker::text || '","role":"authenticated"}', true);
    perform public.worker_submit_checkout(v_app, 4.5, 0, 'resub');

    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_dispute_checkout(v_app, 'note two');

    select count(*) into v_n from public.disputes where application_id = v_app and category = 'hours_disputed';
    if v_n <> 1 then
      raise exception 'DISPUTE-LIFECYCLE FAILED: expected ONE hours_disputed row across two disputes, found %', v_n;
    end if;
    select description, status into v_row from public.disputes where application_id = v_app and category = 'hours_disputed';
    if v_row.description not like '%note one%' or v_row.description not like '%note two%' then
      raise exception 'DISPUTE-LIFECYCLE FAILED: follow-up note not appended, description = %', v_row.description;
    end if;
    if v_row.status <> 'open' then
      raise exception 'DISPUTE-LIFECYCLE FAILED: dispute should still be open before confirmation, is %', v_row.status;
    end if;

    perform set_config('request.jwt.claims', '{"sub":"' || v_worker::text || '","role":"authenticated"}', true);
    perform public.worker_submit_checkout(v_app, 4.0, 0, 'ok 4');
    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_confirm_checkout(v_app);

    select status, resolved_at into v_row from public.disputes where application_id = v_app and category = 'hours_disputed';
    if v_row.status <> 'resolved' or v_row.resolved_at is null then
      raise exception 'DISPUTE-LIFECYCLE FAILED: confirming the hours did not close the dispute (status %)', v_row.status;
    end if;

    if not exists (select 1 from public.payout_item where idempotency_key = 'shift_work:' || v_app::text and amount = 60.00) then
      raise exception 'DISPUTE-LIFECYCLE FAILED: confirm no longer produces the payout (expected 15 x 4.0 = 60.00)';
    end if;

    perform set_config('request.jwt.claims', '', true);
    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        if v_ran then
          raise notice 'DISPUTE-LIFECYCLE self-test passed: two disputes -> one record with both notes; confirming closes it; payout still 15 x 4.0 = 60.00. All test rows rolled back.';
        end if;
      else
        raise;
      end if;
  end;
end $test$;

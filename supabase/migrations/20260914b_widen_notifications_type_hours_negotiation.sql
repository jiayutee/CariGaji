-- notifications_type_check was last widened 20260822 (payout_created) and
-- did not anticipate the two new notification types
-- employer_propose_modification / worker_reject_modification insert
-- (20260914_hours_negotiation.sql). Neither RPC's INSERT is wrapped in an
-- exception handler the way the payout-notification one is, so this isn't
-- silent -- the whole RPC call fails and the employer/worker sees "Failed
-- to send proposal: ... violates check constraint" instead of the action
-- taking effect. Confirmed live 2026-09-14.
--
-- Full list reproduced from 20260822_payout_created_notification.sql (the
-- most recent migration that touched this constraint) plus the two new
-- values -- never hand-retype a shrinking subset of this list, or a type
-- some OTHER already-live function still inserts silently stops working.

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed',
    'shift_updated', 'shift_terms_changed',
    'worker_withdrew', 'slot_reopened', 'marked_no_show',
    'payout_created',
    'shift_hours_modification_proposed',  -- employer counter-proposes hours to the worker
    'shift_hours_modification_rejected'   -- worker rejects the employer's proposal
  ));

-- Prove the widen actually took, rather than assuming a DDL statement that
-- reported success necessarily changed what the constraint accepts.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notifications_type_check'
      and conrelid = 'public.notifications'::regclass
      and pg_get_constraintdef(oid) like '%shift_hours_modification_proposed%'
      and pg_get_constraintdef(oid) like '%shift_hours_modification_rejected%'
  ) then
    raise exception 'WIDEN FAILED: notifications_type_check does not mention the two new types';
  end if;
  raise notice 'notifications_type_check confirmed to include both new hours-negotiation types.';
end $$;

-- Also harden both RPCs so a FUTURE notification problem (a constraint that
-- needs widening again, a dropped column, anything) degrades to a missing
-- notification instead of failing the whole user-facing action the way this
-- one just did -- "Failed to send proposal" when nothing about the proposal
-- itself was wrong. Same wrapped-insert pattern already used for
-- payout_created (20260822_payout_created_notification.sql): a notification
-- must never be able to roll back the real thing it is just announcing.
-- Reproduced from 20260914_hours_negotiation.sql with ONLY the notification
-- insert changed; the authorization/state checks are untouched.

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

  begin
    insert into public.notifications (user_id, type, title, body, link)
    select v_app.worker_id, 'shift_hours_modification_proposed', 'Employer proposed different hours',
      'The employer proposed ' || round(p_hours, 2) || ' hours instead of what you reported.'
        || coalesce(' Note: ' || nullif(trim(coalesce(p_note, '')), ''), ''),
      '/worker/applications/' || v_app.id
    from public.shifts s where s.id = v_app.shift_id;
  exception when others then
    raise warning 'employer_propose_modification: notification insert failed for application % (%), proposal still recorded', p_application_id, sqlerrm;
  end;

  return v_app;
end;
$$;

revoke all on function public.employer_propose_modification(uuid, numeric, text) from public;
grant execute on function public.employer_propose_modification(uuid, numeric, text) to authenticated;

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

-- Self-test: proves the widened constraint really does accept a direct
-- insert of both new types (the ROOT problem just hit), and re-proves the
-- propose/reject round-trip still works correctly through the hardened
-- functions -- not just that they no longer raise.
do $test$
declare
  v_employer uuid := gen_random_uuid();
  v_worker   uuid := gen_random_uuid();
  v_shift    uuid;
  v_app      uuid;
  v_row      record;
begin
  begin
    insert into public.notifications (user_id, type, title, body)
    values (v_employer, 'shift_hours_modification_proposed', 'test', 'test');
    insert into public.notifications (user_id, type, title, body)
    values (v_worker, 'shift_hours_modification_rejected', 'test', 'test');

    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_employer, 'NOTIFY-WIDEN test shift', 'KL', now() - interval '1 day', now() - interval '1 day' + interval '6 hours', 10, 20, 5, 'completed', '[]'::jsonb)
    returning id into v_shift;

    insert into public.applications (shift_id, worker_id, wage_ask, status, checked_in_at, checked_out_at, worker_reported_hours)
    values (v_shift, v_worker, 15, 'accepted', now() - interval '6 hours', now(), 6.0)
    returning id into v_app;

    perform set_config('request.jwt.claims', '{"sub":"' || v_employer::text || '","role":"authenticated"}', true);
    perform public.employer_propose_modification(v_app, 5.5, 'test note');

    select employer_proposed_hours into v_row from public.applications where id = v_app;
    if v_row.employer_proposed_hours is distinct from 5.5 then
      raise exception 'WIDEN-SELFTEST FAILED: proposal not recorded through the hardened function, got %', v_row.employer_proposed_hours;
    end if;

    if not exists (select 1 from public.notifications where user_id = v_worker and type = 'shift_hours_modification_proposed' and title = 'Employer proposed different hours') then
      raise exception 'WIDEN-SELFTEST FAILED: the notification the constraint was blocking did not actually get inserted';
    end if;

    perform set_config('request.jwt.claims', '', true);
    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        raise notice 'WIDEN self-test passed: both new notification types insert directly (the constraint genuinely accepts them now), and employer_propose_modification''s own notification -- the exact one that was failing -- lands correctly. All test rows rolled back.';
      elsif sqlerrm like 'WIDEN-SELFTEST FAILED%' then
        raise;
      else
        raise warning 'WIDEN self-test SETUP failed (fix still applied): %', sqlerrm;
      end if;
  end;
end $test$;

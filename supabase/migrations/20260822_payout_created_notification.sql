-- Tell the worker they have been paid.
--
-- 20260821b made completing a shift produce a payout, but nothing announced
-- it. The shift simply ended, and the money only surfaced if the worker
-- happened to open Earnings and look. For a platform whose whole promise is
-- "work a shift, get paid", the moment of being paid should not be silent.
--
-- The notification is wrapped in its own exception handler: a failure here
-- must never roll back the payout that triggered it. Same reasoning as the
-- wallet capture in the same function -- the money is the thing that must
-- survive.
--
-- create_payout_on_hours_confirmed is reproduced by patching its current text
-- from 20260821b_payout_on_hours_confirmed.sql; only the notification block is added.

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
    'payout_created'   -- to the worker: hours confirmed, money on its way
  ));

create or replace function public.create_payout_on_hours_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift record;
  v_hours numeric;
  v_amount numeric;
begin
  -- Only on the transition, and only when the employer confirmed rather than
  -- disputed. A re-confirmation after a dispute cannot double-pay: the
  -- idempotency key below is per application.
  if new.employer_hours_confirmed_at is null
     or old.employer_hours_confirmed_at is not null
     or coalesce(new.employer_hours_disputed, false) then
    return null;
  end if;

  select s.id, s.employer_id, s.title into v_shift
  from public.shifts s where s.id = new.shift_id;

  v_hours := coalesce(new.worker_reported_hours, 0);
  if v_hours <= 0 then
    -- Nothing was reported, so there is nothing to pay yet. Loud enough to
    -- find in the log, quiet enough not to block the confirmation.
    raise warning 'hours confirmed for application % but worker_reported_hours is %; no payout created',
      new.id, new.worker_reported_hours;
    return null;
  end if;

  v_amount := round(coalesce(new.wage_ask, 0) * v_hours, 2);
  if v_amount <= 0 then
    return null;
  end if;

  insert into public.payout_item (
    payout_cycle_id, worker_id, employer_id, amount, currency, scheduled_date,
    status, source_refs, idempotency_key
  ) values (
    null, new.worker_id, v_shift.employer_id, v_amount, 'MYR', current_date,
    'queued',
    jsonb_build_object('application_id', new.id, 'shift_id', new.shift_id,
                       'reason', 'shift_completed', 'hours', v_hours),
    'shift_work:' || new.id::text
  )
  on conflict (idempotency_key) do nothing;

  -- Tell the worker. Without this a shift simply ends and nothing says they
  -- are being paid -- the payout row exists but only surfaces in Earnings if
  -- they happen to look. Wrapped, because a notification must never be able
  -- to roll back the payout that triggered it.
  begin
    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      new.worker_id,
      'payout_created',
      'You have been paid',
      'Your hours for "' || coalesce(v_shift.title, 'a shift') || '" were confirmed. RM' ||
        to_char(v_amount, 'FM999999990.00') || ' is on its way.',
      '/worker/applications/' || new.id::text,
      jsonb_build_object(
        'shift_title', coalesce(v_shift.title, 'a shift'),
        'amount', v_amount,
        'hours', v_hours
      )
    );
  exception when others then
    raise warning 'payout notification failed for application %: %', new.id, sqlerrm;
  end;

  -- Turn the employer's hold into money owed. Capped at what is held, and any
  -- remainder released -- a worker who finished early should not leave the
  -- rest of the employer's deposit tied up.
  begin
    perform set_config('app.wallet_trusted_write', 'true', true);
    perform public.employer_capture_hold(new.id, v_amount, 'Shift completed and hours confirmed');
    perform set_config('app.wallet_trusted_write', 'false', true);
  exception when others then
    -- The payout is the thing that must survive. A missed capture leaves the
    -- ledger reconcilable; an aborted payout leaves a worker unpaid.
    raise warning 'wallet capture failed for application %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;

-- Widen notifications.type for the two new cancellation-choice events.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made'
  ));

-- ── trigger: on late cancellation, stamp each confirmed worker's choice
--    deadline and notify them ─────────────────────────────────────────────
-- Additive alongside the existing notify_shift_cancelled trigger (which
-- still handles the blanket "shift cancelled" notice for every
-- pending/shortlisted/accepted applicant) — this only concerns workers who
-- were actually confirmed (accepted + contract-signed) when the employer
-- cancels within 24h of the shift's own start time.
create or replace function public.notify_cancellation_choice_pending()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and new.start_at is not null and new.start_at - now() <= interval '24 hours' then

    update public.applications
    set cancellation_choice_deadline = new.start_at
    where shift_id = new.id
      and status = 'accepted'
      and worker_signed_at is not null
      and cancellation_choice_deadline is null;

    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_cancellation_choice_pending',
      'Shift cancelled — choose your payout',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled less than 24 hours before it started. ' ||
        'Choose to sign a 50% cancellation payout, or show up in person for 100% of your agreed wage. ' ||
        'Respond by ' || to_char(new.start_at, 'DD Mon HH24:MI') || '.',
      '/worker/applications/' || a.id
    from public.applications a
    where a.shift_id = new.id
      and a.status = 'accepted'
      and a.worker_signed_at is not null
      and a.cancellation_choice_deadline = new.start_at;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_notify_cancellation_choice_pending on public.shifts;
create trigger trg_notify_cancellation_choice_pending
after update of status on public.shifts
for each row
when (new.status is distinct from old.status)
execute function public.notify_cancellation_choice_pending();

-- ── trigger: on choice/proof, create the payout item + notify the employer ──
-- amount is computed here, server-side, from the worker's own accepted
-- wage_ask and the shift's actual duration — never trusts a client-supplied
-- amount. Fires for the 50% path as soon as the choice is made; for the
-- 100% path only once proof has actually been uploaded (choosing show-up
-- alone earns nothing until delivered).
create or replace function public.create_cancellation_payout()
returns trigger language plpgsql security definer as $$
declare
  v_shift record;
  v_hours numeric;
  v_multiplier numeric;
  v_reason text;
begin
  if (new.cancellation_choice = 'contract_50' and old.cancellation_choice is distinct from 'contract_50')
     or (new.cancellation_choice = 'show_up_100' and new.cancellation_proof_path is not null and old.cancellation_proof_path is null) then

    select s.employer_id, s.start_at, s.end_at, s.title into v_shift
    from public.shifts s where s.id = new.shift_id;

    v_hours := greatest(0.25, extract(epoch from (v_shift.end_at - v_shift.start_at)) / 3600.0);
    if new.cancellation_choice = 'contract_50' then
      v_multiplier := 0.5;
      v_reason := 'late_cancellation_50pct';
    else
      v_multiplier := 1.0;
      v_reason := 'late_cancellation_show_up_100pct';
    end if;

    if new.cancellation_choice_made_at is null then
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

    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_shift.employer_id,
      'shift_cancellation_choice_made',
      'Worker responded to shift cancellation',
      case when new.cancellation_choice = 'contract_50'
        then 'A worker accepted the 50% cancellation payout for "' || coalesce(v_shift.title, 'your shift') || '".'
        else 'A worker is showing up for "' || coalesce(v_shift.title, 'your shift') || '" and has submitted proof for full pay.'
      end,
      '/employer/shifts/' || new.shift_id
    );
  end if;
  return null;
end;
$$;

drop trigger if exists trg_create_cancellation_payout on public.applications;
create trigger trg_create_cancellation_payout
after update of cancellation_choice, cancellation_proof_path on public.applications
for each row
execute function public.create_cancellation_payout();

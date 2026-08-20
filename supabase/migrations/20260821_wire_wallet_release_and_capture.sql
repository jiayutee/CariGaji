-- Wire the deposit ledger into the lifecycle: release a hold when the booking
-- ends without work, capture it when compensation is actually owed.
--
-- Until now the ledger only ever took holds. Nothing gave them back and
-- nothing converted them, so an employer's available balance could only fall.
-- That had to land before enforcement is switched on, or the first employer to
-- be told "top up to continue" would find their money never returned.
--
-- WHAT IS NOT WIRED, and it is not an oversight: there is no capture for a
-- normally completed shift, because **completing a shift creates no payout at
-- all**. Verified three ways: every `insert into public.payout_item` in the
-- schema sits inside a cancellation function; employer_confirm_checkout only
-- stamps employer_hours_confirmed_at and inserts nothing; no trigger watches
-- that column; and the live table currently holds zero rows with any
-- non-cancellation reason. A worker who applies, is booked, works, checks out
-- and has their hours confirmed receives nothing.
--
-- So the happy path -- the platform's entire purpose -- has no payment
-- implementation. That is a separate and much larger gap than this migration,
-- and it is why "capture on payout settlement" cannot be written yet: there is
-- no settlement to hook into.

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

    -- Extracted to public.shift_contracted_hours() so the cancellation QUOTE
    -- shown to the employer and the payout actually written here can never
    -- diverge. Same maths, one definition.
    v_hours := public.shift_contracted_hours(new.shift_id);

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

    -- Convert the employer's hold into money actually owed. Capped at what is
    -- held and releasing any remainder, so a 50% payout frees the other half
    -- instead of stranding it. Wrapped so a wallet failure cannot roll back
    -- the payout itself -- the worker's entitlement is the thing that must
    -- survive; a missed capture is recoverable from the ledger.
    begin
      perform set_config('app.wallet_trusted_write', 'true', true);
      perform public.employer_capture_hold(
        new.id,
        round(new.wage_ask * v_hours * v_multiplier, 2),
        'Cancellation compensation (' || v_reason || ')');
      perform set_config('app.wallet_trusted_write', 'false', true);
    exception when others then
      raise warning 'wallet capture failed for application %: %', new.id, sqlerrm;
    end;

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

-- ── release when a booking ends without work being done ──────────────────────
create or replace function public.release_hold_on_application_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Every way an application can stop being a live booking. A hold that was
  -- never taken releases as a no-op, so this is safe for all of them.
  if new.status in ('rejected', 'expired', 'withdrawn')
     and old.status is distinct from new.status then
    begin
      perform set_config('app.wallet_trusted_write', 'true', true);
      perform public.employer_release_hold(new.id, 'Booking ended: ' || new.status);
      perform set_config('app.wallet_trusted_write', 'false', true);
    exception when others then
      raise warning 'wallet release failed for application %: %', new.id, sqlerrm;
    end;
  end if;

  -- A no-show means no work was done, so the wage is not owed. Any
  -- compensation question is handled separately by the dispute flow.
  if new.no_show_at is not null and old.no_show_at is null then
    begin
      perform set_config('app.wallet_trusted_write', 'true', true);
      perform public.employer_release_hold(new.id, 'Worker did not attend');
      perform set_config('app.wallet_trusted_write', 'false', true);
    exception when others then
      raise warning 'wallet release failed for no-show %: %', new.id, sqlerrm;
    end;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_release_hold_on_application_end on public.applications;
create trigger trg_release_hold_on_application_end
after update on public.applications
for each row execute function public.release_hold_on_application_end();

-- ── release when a shift is cancelled with nothing owed ──────────────────────
-- Inside 24h the holds must STAY: the worker still has a payout choice to
-- make, and create_cancellation_payout will capture what is owed and release
-- the rest. Outside it, nothing is owed, so the money goes back immediately
-- rather than sitting held against a shift that will never happen.
create or replace function public.release_holds_on_cancelled_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and (new.start_at is null or new.start_at - now() > interval '24 hours') then
    for v_app in
      select id from public.applications
      where shift_id = new.id and status in ('accepted', 'offered')
    loop
      begin
        perform set_config('app.wallet_trusted_write', 'true', true);
        perform public.employer_release_hold(v_app.id, 'Shift cancelled with no compensation owed');
        perform set_config('app.wallet_trusted_write', 'false', true);
      exception when others then
        raise warning 'wallet release failed for application %: %', v_app.id, sqlerrm;
      end;
    end loop;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_release_holds_on_cancelled_shift on public.shifts;
create trigger trg_release_holds_on_cancelled_shift
after update of status on public.shifts
for each row execute function public.release_holds_on_cancelled_shift();

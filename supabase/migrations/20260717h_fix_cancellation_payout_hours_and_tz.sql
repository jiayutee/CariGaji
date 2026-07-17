-- Two flaws found live-verifying the late-cancellation payout flow
-- (6554e44 / af49d5d):
--
-- 1. TIMEZONE: the worker's "Respond by ..." notification formats
--    new.start_at with a bare to_char(), which renders UTC — verified live:
--    a shift starting 18 Jul 03:10 Malaysia time produced "Respond by
--    17 Jul 19:10". Same bug class as the app-wide toLocaleTimeString fix;
--    pin to Asia/Kuala_Lumpur like every other user-facing timestamp.
--
-- 2. MULTI-DAY UNDERPAYMENT: create_cancellation_payout computed hours as
--    end_at - start_at, but for multi-day shifts start_at/end_at mirror only
--    the EARLIEST occurrence (20260712d) — a worker whose 3-day engagement
--    was late-cancelled would get a payout based on day 1's hours alone.
--    Sum shifts.occurrences instead (with the same overnight +24h wrap as
--    the app's occurrenceHours helper), falling back to end_at - start_at
--    for any legacy row with an empty occurrences array.

create or replace function public.notify_cancellation_choice_pending()
returns trigger language plpgsql security definer as $$
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

    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_cancellation_choice_pending',
      'Shift cancelled — choose your payout',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled less than 24 hours before it started. ' ||
        'Choose to sign a 50% cancellation payout, or show up in person for 100% of your agreed wage. ' ||
        'Respond by ' || to_char(new.start_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon HH24:MI') || '.',
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

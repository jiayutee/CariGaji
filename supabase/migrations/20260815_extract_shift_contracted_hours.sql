-- Plan step 2: one definition of "how many hours was this worker contracted
-- for", so the cancellation quote an employer is shown and the payout that is
-- actually written cannot drift apart.
--
-- The maths currently lives inline inside create_cancellation_payout. The
-- upcoming quote_shift_cancellation RPC needs the identical number: if the
-- quote says RM 312 and the payout writes RM 280, the employer was charged
-- something other than what they explicitly agreed to. That is the one thing
-- this feature cannot get wrong, and duplicating the calculation guarantees it
-- eventually will.
--
-- The function below is the block lifted verbatim -- multi-day occurrence sum,
-- overnight occurrences wrapping +24h, fallback to end_at - start_at when
-- there are no parseable occurrences, 0.25h floor. Nothing about the numbers
-- changes; existing payouts compute exactly as before.
--
-- create_cancellation_payout is reproduced below by PATCHING its current text
-- from 20260813_notification_params_remaining_types.sql -- only the inline block is swapped for the call.

create or replace function public.shift_contracted_hours(p_shift_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_shift record;
  v_hours numeric;
begin
  select start_at, end_at, occurrences into v_shift
  from public.shifts where id = p_shift_id;

  if v_shift is null then
    return 0;
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

  return greatest(0.25, v_hours);
end;
$$;

revoke all on function public.shift_contracted_hours(uuid) from public;
grant execute on function public.shift_contracted_hours(uuid) to authenticated;

-- ── create_cancellation_payout, patched to call it ───────────────────────────
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

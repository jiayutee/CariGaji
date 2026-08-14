-- Plan step 3: tell an employer what cancelling will cost, per worker, before
-- they do it. Today the warning names percentages and never a ringgit figure,
-- so nobody can weigh a decision they cannot see the price of.
--
-- WHAT THIS DELIBERATELY DOES *NOT* DO. It does not use the employer rows in
-- cancellation_tiers. Those rows (25% at 48h-7d, and so on) are currently dead
-- config: create_cancellation_payout hardcodes 0.5 / 1.0 and never reads them,
-- and notify_cancellation_choice_pending only offers a payout choice inside 24
-- hours. So a quote built on that ladder would promise money the system does
-- not pay.
--
-- A quote that disagrees with the payout is worse than no quote -- the
-- employer would have explicitly agreed to a figure that never materialises,
-- which is the single thing this feature cannot get wrong. It is also why
-- shift_contracted_hours was extracted in 20260815. So this function mirrors
-- what the code ACTUALLY pays today:
--
--     notice >= 24h  ->  nothing is owed, and no choice is offered
--     notice <  24h  ->  50% of contracted wages, or 100% if the worker
--                        chooses to show up in person and submits proof
--
-- Activating the tier ladder is a separate change that must move
-- notify_cancellation_choice_pending's 24h window, create_cancellation_payout's
-- multiplier, and this function together in one migration -- otherwise they
-- diverge again. Until then this reports the truth, including the RM 0.

create or replace function public.quote_shift_cancellation(p_shift_id uuid)
returns table (
  application_id   uuid,
  worker_id        uuid,
  worker_name      text,
  wage_ask         numeric,
  contracted_hours numeric,
  notice_hours     numeric,
  rate             numeric,   -- what they receive if they take the payout
  amount           numeric,
  max_rate         numeric,   -- if they instead show up in person
  max_amount       numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_shift record;
  v_notice numeric;
  v_hours numeric;
  v_rate numeric;
  v_max_rate numeric;
begin
  select s.id, s.employer_id, s.start_at into v_shift
  from public.shifts s where s.id = p_shift_id;

  if v_shift.id is null then
    raise exception 'Shift not found';
  end if;

  -- Only the shift's own employer, or an admin, may price a cancellation --
  -- the figures expose each worker's agreed rate.
  if v_shift.employer_id is distinct from auth.uid()
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception 'Not authorized';
  end if;

  v_notice := greatest(extract(epoch from (v_shift.start_at - now())) / 3600.0, 0);
  v_hours  := public.shift_contracted_hours(p_shift_id);

  -- Mirrors create_cancellation_payout exactly. If that function's multipliers
  -- change, these must change in the same migration.
  if v_notice < 24 then
    v_rate := 0.5;
    v_max_rate := 1.0;
  else
    v_rate := 0;
    v_max_rate := 0;
  end if;

  return query
  select
    a.id,
    a.worker_id,
    coalesce(p.full_name, 'Worker')::text,
    a.wage_ask,
    round(v_hours, 2),
    round(v_notice, 1),
    v_rate,
    round(a.wage_ask * v_hours * v_rate, 2),
    v_max_rate,
    round(a.wage_ask * v_hours * v_max_rate, 2)
  from public.applications a
  left join public.profiles p on p.id = a.worker_id
  where a.shift_id = p_shift_id
    -- Exactly who create_cancellation_payout will pay: accepted AND signed.
    -- A pending or offered applicant is owed nothing, so listing them would
    -- overstate the bill.
    and a.status = 'accepted'
    and a.worker_signed_at is not null
  order by coalesce(p.full_name, 'Worker');
end;
$$;

revoke all on function public.quote_shift_cancellation(uuid) from public;
grant execute on function public.quote_shift_cancellation(uuid) to authenticated;

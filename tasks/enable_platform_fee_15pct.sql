-- Turn the platform fee on: 15% for everyone outside a free window.
--
-- This is the one knob. After this runs:
--   * a NEW employer pays nothing for 2 months from their FIRST posted shift
--   * after that window, 15% on top of the wage (the worker is unaffected --
--     they are still paid their full agreed rate)
--   * every shift keeps the rate it was stamped with at post time, so a shift
--     posted free stays free through a payout weeks later
--   * the test employers exempted on 2026-08-29 keep paying nothing
--
-- IT REFUSES TO RUN IF THE EXEMPTION IS NOT IN PLACE. Enabling billing while
-- the test accounts are exposed is the one ordering mistake that costs real
-- money, so it is checked rather than trusted.

-- ── 1+2. Safety gate AND the rate change, in ONE block ─────────────────────
-- Deliberately fused. When these were separate statements the gate raised, the
-- client carried on to the next statement, and the fee was enabled anyway --
-- caught on a throwaway Postgres before this ever ran for real. A refusal that
-- does not actually refuse is worse than no check, because it reads as one.
do $$
declare
  v_exposed int;
  v_names text;
  v_rate numeric;
begin
  select count(*), string_agg(coalesce(full_name, id::text), ', ')
  into v_exposed, v_names
  from public.profiles
  where role = 'employer'
    and (fee_free_until is null or fee_free_until <= now());

  if v_exposed > 0 then
    raise exception
      'REFUSING to enable the fee: % existing employer(s) are NOT exempt and would be billed immediately: %. Run tasks/exempt_test_employers_from_fee.sql first, then re-run this.',
      v_exposed, v_names;
  end if;

  raise notice 'Safety gate passed: every existing employer is inside a free window.';

  execute $fn$
    create or replace function public.platform_fee_pct()
    returns numeric language sql immutable as $inner$ select 0.1500::numeric $inner$
  $fn$;

  select public.platform_fee_pct() into v_rate;
  if v_rate <> 0.1500 then
    raise exception 'Rate did not take: platform_fee_pct() returns %', v_rate;
  end if;
  raise notice 'Global rate is now 15 percent.';
end $$;

comment on function public.platform_fee_pct() is
  'Platform fee rate for NEW shifts posted by employers outside a free window. Set to 15% on 2026-08-29. Existing shifts keep their snapshotted rate; per-employer free windows live in profiles.fee_free_until.';

-- ── 3. Verify, per employer, that nobody unexpected is now billable ─────────
select
  p.full_name,
  p.role,
  p.fee_free_until,
  round(public.platform_fee_pct_for(p.id) * 100, 2) as rate_pct_now,
  case
    when public.platform_fee_pct_for(p.id) = 0 then 'free (inside window)'
    else 'BILLABLE'
  end as status
from public.profiles p
where p.role = 'employer'
order by p.created_at;

-- ── 4. And confirm the global rate actually changed ─────────────────────────
do $$
declare
  v_rate numeric := public.platform_fee_pct();
  v_billable int;
begin
  if v_rate <> 0.1500 then
    raise exception 'Rate did not take: platform_fee_pct() returns %', v_rate;
  end if;
  select count(*) into v_billable
  from public.profiles
  where role = 'employer' and public.platform_fee_pct_for(id) > 0;

  raise notice 'Global rate is now % percent.', round(v_rate * 100, 2);
  raise notice 'Existing employers now billable: %  (expected 0 -- all are exempt test accounts)', v_billable;
  raise notice 'New shifts from employers past their free window will hold wage + % percent and capture the fee on completion.',
    round(v_rate * 100, 2);
end $$;

-- ── TO ROLL BACK ────────────────────────────────────────────────────────────
--   create or replace function public.platform_fee_pct()
--   returns numeric language sql immutable as $$ select 0.0000::numeric $$;
-- Shifts posted while the rate was 15% keep that rate -- the snapshot is the
-- point. Rolling back only affects shifts posted afterwards.

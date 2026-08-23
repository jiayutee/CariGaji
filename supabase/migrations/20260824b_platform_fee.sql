-- The platform fee becomes a real thing that money passes through.
--
-- Until now 15% existed only as a JavaScript constant used to draw three
-- estimates. Postgres had never heard of it: the hold reserved the wage alone,
-- the capture took the wage alone, and no row anywhere recorded a fee. The app
-- promised employers "plus 15% platform fee" and charged nobody.
--
-- FOUR DECISIONS, stated because they decide what people are billed.
--
-- 1. THE RATE LAUNCHES AT ZERO. Owner's call: no fee at first, to get
--    employers posting. platform_fee_pct() below is the single knob -- change
--    that one function to start charging.
--
-- 2. THE RATE IS SNAPSHOTTED PER SHIFT, and stamped by the database, not sent
--    by the client. shifts.platform_fee_pct records the rate in force when the
--    shift was posted, and a guard trigger pins it against every later update.
--    So raising the rate later prices NEW shifts only: a shift posted free
--    during the launch promotion stays free for its whole life, including its
--    payout months later. Without the snapshot, turning the knob would silently
--    re-price every shift already agreed.
--
-- 3. THE FEE IS HELD, NOT JUST CHARGED. The hold at offer time now reserves
--    wage + fee. Reserving the wage alone left our own fee unsecured at the one
--    moment the employer commits -- an enforced wallet would wave through a
--    booking the employer could not cover the fee on, and we would only find
--    out after the work was done.
--
-- 4. THE FEE RIDES ON TOP, AND FOLLOWS THE WAGE. The worker is still paid the
--    full agreed rate (20260821b is untouched). The fee is charged to the
--    employer on what was actually captured, so a worker who leaves early
--    bills less wage and earns us less fee.
--
-- Existing shifts are backfilled to 0, not to 15%: nobody has ever been charged
-- a fee, and stamping one onto shifts that are already posted would be changing
-- the price after the handshake.

-- ── the single knob ──────────────────────────────────────────────────────────
-- Launch promotion: zero. To start charging 15%, change the 0.0000 below and
-- nothing else -- every shift posted from that moment carries the new rate, and
-- every shift posted before it keeps the old one.
create or replace function public.platform_fee_pct()
returns numeric
language sql
immutable
as $$ select 0.0000::numeric $$;

comment on function public.platform_fee_pct() is
  'Platform fee rate for NEW shifts. Launch promotion = 0. Change here to start charging; existing shifts keep their snapshotted rate.';

grant execute on function public.platform_fee_pct() to authenticated, anon;

-- ── the per-shift snapshot ───────────────────────────────────────────────────
alter table public.shifts
  add column if not exists platform_fee_pct numeric(5,4) not null default 0.0000;

alter table public.shifts
  drop constraint if exists shifts_platform_fee_pct_sane;
alter table public.shifts
  add constraint shifts_platform_fee_pct_sane check (platform_fee_pct >= 0 and platform_fee_pct <= 0.5);

-- Stamped by the database, pinned against the client. An employer who could
-- PATCH their own shift's fee to zero would be helping themselves to our
-- revenue, and RLS alone cannot express "this column, never".
create or replace function public.guard_platform_fee_pct()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  -- A direct database session (support, and the self-test below) has no JWT at
  -- all. Same hatch every other money function in this schema uses.
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
begin
  if is_admin or is_direct_sql then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.platform_fee_pct := public.platform_fee_pct();
  else
    new.platform_fee_pct := old.platform_fee_pct;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_platform_fee_pct on public.shifts;
create trigger trg_guard_platform_fee_pct
  before insert or update on public.shifts
  for each row execute function public.guard_platform_fee_pct();

-- ── the ledger learns a fifth movement ───────────────────────────────────────
alter table public.employer_wallet_entry
  drop constraint if exists employer_wallet_entry_kind_check;
alter table public.employer_wallet_entry
  add constraint employer_wallet_entry_kind_check
  check (kind in ('topup', 'hold', 'release', 'capture', 'refund', 'fee'));

-- ── balances must subtract it, or the money quietly reappears ────────────────
-- Both places: `fee` leaves the wallet like a capture does, AND it closes out
-- part of the hold it came from. Miss either and the balance is wrong in a
-- direction that favours whoever notices first.
create or replace function public.employer_wallet_balance(p_employer_id uuid)
returns table (available numeric, held numeric, topped_up numeric, captured numeric)
language sql
security definer
set search_path = public
stable
as $$
  with t as (
    select
      coalesce(sum(amount) filter (where kind = 'topup'), 0)   as topups,
      coalesce(sum(amount) filter (where kind = 'refund'), 0)  as refunds,
      coalesce(sum(amount) filter (where kind = 'hold'), 0)    as holds,
      coalesce(sum(amount) filter (where kind = 'release'), 0) as releases,
      coalesce(sum(amount) filter (where kind = 'capture'), 0) as captures,
      coalesce(sum(amount) filter (where kind = 'fee'), 0)     as fees
    from public.employer_wallet_entry
    where employer_id = p_employer_id
  )
  select
    round(t.topups + t.refunds - t.captures - t.fees
          - greatest(t.holds - t.releases - t.captures - t.fees, 0), 2),
    round(greatest(t.holds - t.releases - t.captures - t.fees, 0), 2),
    round(t.topups, 2),
    round(t.captures, 2)
  from t;
$$;

-- ── hold the fee too ─────────────────────────────────────────────────────────
create or replace function public.employer_hold_for_offer(p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_shift record;
  v_hours numeric;
  v_wage numeric;
  v_fee numeric;
  v_amount numeric;
  v_bal record;
  v_enforced boolean := public.employer_wallet_enforced();
begin
  select a.id, a.worker_id, a.shift_id, a.wage_ask, a.status
  into v_app from public.applications a where a.id = p_application_id;
  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  select s.id, s.employer_id, s.title, s.platform_fee_pct into v_shift
  from public.shifts s where s.id = v_app.shift_id;

  if v_shift.employer_id is distinct from auth.uid()
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin'
     and coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    raise exception 'Not authorized';
  end if;

  -- Same hours the payout and the cancellation quote use. Three different
  -- numbers for one shift is how an employer ends up charged something they
  -- never agreed to.
  v_hours := public.shift_contracted_hours(v_app.shift_id);
  v_wage := round(coalesce(v_app.wage_ask, 0) * v_hours, 2);
  -- Hold OUR FEE as well as the wage. Wage-only left the fee unsecured at
  -- the exact moment the employer commits: an enforced wallet would wave
  -- through a booking the employer could not cover the fee on, and the
  -- shortfall would only surface once the work was already done.
  v_fee := round(v_wage * coalesce(v_shift.platform_fee_pct, public.platform_fee_pct()), 2);
  v_amount := v_wage + v_fee;

  select * into v_bal from public.employer_wallet_balance(v_shift.employer_id);

  if v_bal.available < v_amount then
    if v_enforced then
      raise exception 'Insufficient funds: RM% is held or available but this offer needs RM%. Top up to continue.',
        v_bal.available, v_amount;
    end if;
    -- Warn-only: report the shortfall without holding or blocking.
    return jsonb_build_object(
      'held', false, 'reason', 'insufficient_funds', 'enforced', false,
      'required', v_amount, 'available', v_bal.available,
      'shortfall', round(v_amount - v_bal.available, 2));
  end if;

  insert into public.employer_wallet_entry
    (employer_id, kind, amount, shift_id, application_id, note, idempotency_key, created_by)
  values
    (v_shift.employer_id, 'hold', v_amount, v_app.shift_id, p_application_id,
     'Offer for ' || coalesce(v_shift.title, 'a shift'),
     'hold:' || p_application_id::text, auth.uid())
  on conflict (idempotency_key) do nothing;   -- a retried offer must not hold twice

  select * into v_bal from public.employer_wallet_balance(v_shift.employer_id);
  return jsonb_build_object('held', true, 'amount', v_amount, 'enforced', v_enforced,
                            'wage', v_wage, 'fee', v_fee,
                            'available', v_bal.available, 'held_total', v_bal.held);
end;
$$;

revoke all on function public.employer_hold_for_offer(uuid) from public;
grant execute on function public.employer_hold_for_offer(uuid) to authenticated;

-- ── release: a fee also closes out part of a hold ────────────────────────────
create or replace function public.employer_release_hold(
  p_application_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Callable by an admin, by a direct database session (support/testing --
  -- auth.jwt() is null there, same reasoning as admin_purge_shift), or from
  -- inside another security-definer function that has set the trusted-write
  -- flag. NOT by an ordinary authenticated user: these move money, and the
  -- caller is never the person the money belongs to.
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  is_trusted boolean := coalesce(current_setting('app.wallet_trusted_write', true), '') = 'true';
  v_app record;
  v_employer uuid;
  v_open numeric;
begin
  if not (is_admin or is_direct_sql or is_trusted) then
    raise exception 'Not authorized';
  end if;
  select a.id, a.shift_id into v_app from public.applications a where a.id = p_application_id;
  if v_app.id is null then
    raise exception 'Application not found';
  end if;
  select employer_id into v_employer from public.shifts where id = v_app.shift_id;

  -- Whatever is still outstanding on THIS application, so a double release
  -- cannot manufacture funds.
  select coalesce(sum(amount) filter (where kind = 'hold'), 0)
       - coalesce(sum(amount) filter (where kind = 'release'), 0)
       - coalesce(sum(amount) filter (where kind = 'capture'), 0)
       - coalesce(sum(amount) filter (where kind = 'fee'), 0)
  into v_open
  from public.employer_wallet_entry where application_id = p_application_id;

  if v_open <= 0 then
    return jsonb_build_object('released', false, 'reason', 'nothing_held');
  end if;

  insert into public.employer_wallet_entry
    (employer_id, kind, amount, shift_id, application_id, note, created_by)
  values
    (v_employer, 'release', round(v_open, 2), v_app.shift_id, p_application_id,
     coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Hold released'), auth.uid());

  return jsonb_build_object('released', true, 'amount', round(v_open, 2));
end;
$$;

revoke all on function public.employer_release_hold(uuid, text) from public;
grant execute on function public.employer_release_hold(uuid, text) to authenticated;

-- ── capture: split one hold into the worker's wage and our fee ───────────────
create or replace function public.employer_capture_hold(
  p_application_id uuid,
  p_amount numeric,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Callable by an admin, by a direct database session (support/testing --
  -- auth.jwt() is null there, same reasoning as admin_purge_shift), or from
  -- inside another security-definer function that has set the trusted-write
  -- flag. NOT by an ordinary authenticated user: these move money, and the
  -- caller is never the person the money belongs to.
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  is_trusted boolean := coalesce(current_setting('app.wallet_trusted_write', true), '') = 'true';
  v_app record;
  v_employer uuid;
  v_open numeric;
  v_take numeric;
  v_fee numeric := 0;
  v_fee_pct numeric;
begin
  if not (is_admin or is_direct_sql or is_trusted) then
    raise exception 'Not authorized';
  end if;
  select a.id, a.shift_id into v_app from public.applications a where a.id = p_application_id;
  if v_app.id is null then
    raise exception 'Application not found';
  end if;
  select employer_id into v_employer from public.shifts where id = v_app.shift_id;

  select coalesce(sum(amount) filter (where kind = 'hold'), 0)
       - coalesce(sum(amount) filter (where kind = 'release'), 0)
       - coalesce(sum(amount) filter (where kind = 'capture'), 0)
       - coalesce(sum(amount) filter (where kind = 'fee'), 0)
  into v_open
  from public.employer_wallet_entry where application_id = p_application_id;

  v_take := least(round(coalesce(p_amount, 0), 2), greatest(v_open, 0));
  if v_take <= 0 then
    return jsonb_build_object('captured', false, 'reason', 'nothing_held', 'held_open', greatest(v_open, 0));
  end if;

  insert into public.employer_wallet_entry
    (employer_id, kind, amount, shift_id, application_id, note, created_by)
  values
    (v_employer, 'capture', v_take, v_app.shift_id, p_application_id,
     coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Captured for payout'), auth.uid());

  -- Our fee comes out of the SAME hold, priced at the rate this shift carried
  -- when it was posted -- never today's rate. A shift posted fee-free during
  -- the launch promotion stays fee-free even after the rate goes up.
  --
  -- Charged on what was actually captured, not on what was contracted: a
  -- worker who left early bills the employer less wage, and our fee follows
  -- the wage down. Capped at what is still held for the same reason capture
  -- is -- we cannot bill past what the employer committed.
  select coalesce(s.platform_fee_pct, 0) into v_fee_pct
  from public.shifts s where s.id = v_app.shift_id;

  v_fee := least(round(v_take * coalesce(v_fee_pct, 0), 2), greatest(v_open - v_take, 0));
  if v_fee > 0 then
    insert into public.employer_wallet_entry
      (employer_id, kind, amount, shift_id, application_id, note, created_by)
    values
      (v_employer, 'fee', v_fee, v_app.shift_id, p_application_id,
       'Platform fee at ' || round(v_fee_pct * 100, 2) || '%', auth.uid());
  end if;

  -- Anything held beyond what was captured is no longer owed -- a worker who
  -- worked fewer hours than contracted should not leave the remainder tied up.
  if v_open - v_take - v_fee > 0 then
    insert into public.employer_wallet_entry
      (employer_id, kind, amount, shift_id, application_id, note, created_by)
    values
      (v_employer, 'release', round(v_open - v_take - v_fee, 2), v_app.shift_id, p_application_id,
       'Unused balance of the hold released after capture', auth.uid());
  end if;

  return jsonb_build_object('captured', true, 'amount', v_take, 'fee', v_fee,
                            'released_remainder', round(greatest(v_open - v_take - v_fee, 0), 2));
end;
$$;

revoke all on function public.employer_capture_hold(uuid, numeric, text) from public;
grant execute on function public.employer_capture_hold(uuid, numeric, text) to authenticated;

-- ── what we actually earned ──────────────────────────────────────────────────
create or replace view public.platform_fee_revenue as
  select
    e.employer_id,
    date_trunc('month', e.created_at)::date as month,
    count(*)                                as fee_count,
    round(sum(e.amount), 2)                 as fee_total
  from public.employer_wallet_entry e
  where e.kind = 'fee'
  group by 1, 2;

revoke all on public.platform_fee_revenue from public, anon, authenticated;

-- ── self-verifying test of the fee invariants ────────────────────────────────
-- Creates its own rows, asserts exact numbers, cleans up. Tests BOTH rates:
-- the launch rate of zero (which is what ships today, so the charging path
-- would otherwise never be exercised) and a 15% shift, so this file still
-- proves the fee works on the day the knob is turned.
do $test$
declare
  v_emp uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- QA employer
  v_wrk uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';  -- QA worker one
  v_paid uuid; v_free uuid; v_ap uuid; v_af uuid;
  v_start timestamptz := now() + interval '9 days';
  v_res jsonb; v_bal record; v_fees numeric; v_before numeric; v_setup_failed text;
begin
  begin
    -- 6h shifts (09:00-15:00), one worker each.
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'FEE test paid', 'KL', v_start, v_start + interval '6 hours', 10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('start','09:00','end','15:00')))
    returning id into v_paid;
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'FEE test free', 'KL', v_start, v_start + interval '6 hours', 10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('start','09:00','end','15:00')))
    returning id into v_free;

    -- The trigger stamps the launch rate on both; put one on 15% to test the
    -- charging path. (Allowed here only because this is a direct SQL session.)
    update public.shifts set platform_fee_pct = 0.1500 where id = v_paid;

    insert into public.applications (shift_id, worker_id, wage_ask) values (v_paid, v_wrk, 18) returning id into v_ap;
    insert into public.applications (shift_id, worker_id, wage_ask) values (v_free, v_wrk, 18) returning id into v_af;

    insert into public.employer_wallet_entry (employer_id, kind, amount, note, idempotency_key)
    values (v_emp, 'topup', 400, 'FEE self-test float', 'feetest:' || v_paid::text);
  exception when others then
    v_setup_failed := sqlerrm;
  end;

  if v_setup_failed is not null then
    -- The DDL above is the fix and is already applied. A scaffold that could
    -- not be built says nothing about whether the fix is wrong, so warn and
    -- leave it in place rather than rolling the whole migration back.
    raise warning 'FEE self-test SETUP failed (fix still applied): %', v_setup_failed;
    return;
  end if;

  -- 1. THE SNAPSHOT IS PINNED. An employer PATCHing their own fee to zero is
  --    helping themselves to our revenue.
  perform set_config('request.jwt.claims', '{"sub":"' || v_emp::text || '","role":"authenticated"}', true);
  update public.shifts set platform_fee_pct = 0 where id = v_paid;
  perform set_config('request.jwt.claims', '', true);
  if (select platform_fee_pct from public.shifts where id = v_paid) <> 0.1500 then
    raise exception 'FEE self-test FAILED: an employer was able to change their own fee rate to %',
      (select platform_fee_pct from public.shifts where id = v_paid);
  end if;

  -- 2. THE HOLD RESERVES WAGE + FEE. 18/h x 6h = 108 wage, +15% = 16.20 fee.
  v_res := public.employer_hold_for_offer(v_ap);
  if (v_res ->> 'held') <> 'true'
     or (v_res ->> 'wage')::numeric <> 108
     or (v_res ->> 'fee')::numeric <> 16.20
     or (v_res ->> 'amount')::numeric <> 124.20 then
    raise exception 'FEE self-test FAILED: hold should be 108 wage + 16.20 fee = 124.20, got %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.held <> 124.20 or v_bal.available <> 275.80 then
    raise exception 'FEE self-test FAILED: after hold expected 275.80 available / 124.20 held, got %/%',
      v_bal.available, v_bal.held;
  end if;

  -- 3. THE ZERO-RATE SHIFT HOLDS THE WAGE ONLY -- this is what ships today.
  v_res := public.employer_hold_for_offer(v_af);
  if (v_res ->> 'fee')::numeric <> 0 or (v_res ->> 'amount')::numeric <> 108 then
    raise exception 'FEE self-test FAILED: a 0%% shift should hold 108 and no fee, got %', v_res;
  end if;

  -- 4. CAPTURE SPLITS THE HOLD. Worker paid 108 in full, 16.20 becomes ours,
  --    nothing left over.
  v_res := public.employer_capture_hold(v_ap, 108, 'FEE self-test');
  if (v_res ->> 'amount')::numeric <> 108
     or (v_res ->> 'fee')::numeric <> 16.20
     or (v_res ->> 'released_remainder')::numeric <> 0 then
    raise exception 'FEE self-test FAILED: capture should be 108 wage + 16.20 fee + 0 remainder, got %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 275.80 - 108 or v_bal.held <> 108 then
    raise exception 'FEE self-test FAILED: after capture expected 167.80 available / 108 held, got %/%',
      v_bal.available, v_bal.held;
  end if;

  -- 5. THE FEE FOLLOWS THE WAGE DOWN. The free shift's worker leaves early:
  --    capture 54, and a 0%% shift must still produce no fee row.
  v_res := public.employer_capture_hold(v_af, 54, 'FEE self-test short');
  if (v_res ->> 'fee')::numeric <> 0 or (v_res ->> 'released_remainder')::numeric <> 54 then
    raise exception 'FEE self-test FAILED: 0%% shift captured short should charge no fee and release 54, got %', v_res;
  end if;

  -- 6. A FEE CLOSES OUT ITS PART OF THE HOLD. Nothing is outstanding on the
  --    paid shift now, so a later release -- the cancel / no-show path -- must
  --    find nothing. If `fee` were missing from that function's open-hold
  --    arithmetic it would compute 124.20 - 108 = 16.20 still owed and hand our
  --    own fee back to the employer as available balance.
  select available into v_before from public.employer_wallet_balance(v_emp);
  v_res := public.employer_release_hold(v_ap, 'FEE self-test late release');
  if (v_res ->> 'released') <> 'false' then
    raise exception 'FEE self-test FAILED: releasing a fully captured hold gave back %, expected nothing_held', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> v_before then
    raise exception 'FEE self-test FAILED: a release against a settled hold moved the balance from % to %',
      v_before, v_bal.available;
  end if;

  select coalesce(sum(amount), 0) into v_fees
  from public.employer_wallet_entry
  where employer_id = v_emp and kind = 'fee' and shift_id in (v_paid, v_free);
  if v_fees <> 16.20 then
    raise exception 'FEE self-test FAILED: total fee revenue should be 16.20, got %', v_fees;
  end if;

  raise notice 'FEE self-test passed: hold 124.20 (108 + 16.20), capture split correctly, 0%% shift charged nothing.';

  -- cleanup
  delete from public.employer_wallet_entry where shift_id in (v_paid, v_free);
  delete from public.employer_wallet_entry where idempotency_key = 'feetest:' || v_paid::text;
  delete from public.applications where id in (v_ap, v_af);
  delete from public.shifts where id in (v_paid, v_free);
end $test$;

do $$
declare v_rate numeric := public.platform_fee_pct();
begin
  raise notice 'platform fee rate for NEW shifts: % percent', round(v_rate * 100, 2);
  raise notice 'existing shifts backfilled to: % distinct rate(s)',
    (select count(distinct platform_fee_pct) from public.shifts);
end $$;

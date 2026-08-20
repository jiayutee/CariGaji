-- SECURITY FIX for 20260820b: two money-moving functions had no
-- authorization check at all.
--
-- employer_release_hold and employer_capture_hold were callable by ANY
-- authenticated user against ANY application. Verified live: a worker's token
-- called both and got a normal result rather than 'Not authorized'. They only
-- returned "nothing_held" because no hold existed yet -- against a funded
-- offer, a worker could have released an employer's hold or forced a capture.
--
-- I wrote employer_hold_for_offer with a proper employer/admin check and then
-- did not carry it to the other two, because they read as internal helpers.
-- They are not internal: every function granted to `authenticated` is a public
-- API endpoint, whatever it was written for.
--
-- These two are never called by an employer directly -- they belong to
-- server-side flows (payout settlement, cancellation, offer expiry). So they
-- now accept an admin, a direct database session (support and testing), or a
-- caller that has set app.wallet_trusted_write -- the same trusted-write idiom
-- the attendance and reliability guards already use, so a trigger can call
-- them later without widening access to everyone.
--
-- employer_hold_for_offer keeps its employer/admin check and additionally
-- allows a direct SQL session, so it can be exercised and supported from the
-- editor.

-- The only ways money moves in employer_wallet_entry. Nothing writes to the
-- ledger through the API -- there is no insert policy at all -- so these
-- security-definer functions are the complete surface.

-- ── admin records a top-up ───────────────────────────────────────────────────
-- Until FPX/DuitNow exists, funds arrive by bank transfer and are recorded
-- here by hand. `p_reference` is the bank reference, so a ledger row can
-- always be traced back to a real transfer.
create or replace function public.admin_record_topup(
  p_employer_id uuid,
  p_amount numeric,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  -- Same reasoning as admin_purge_shift: auth.jwt() is NULL in the SQL editor,
  -- so an admin-only check would lock out the very person who records
  -- transfers. PostgREST always populates request.jwt.claims for API traffic,
  -- so an empty value means a direct database session.
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  v_bal record;
begin
  if not (is_admin or is_direct_sql) then
    raise exception 'Not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Top-up amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reference, '')), '') is null then
    raise exception 'A bank reference is required so this row can be traced to a real transfer';
  end if;

  insert into public.employer_wallet_entry
    (employer_id, kind, amount, note, idempotency_key, created_by)
  values
    (p_employer_id, 'topup', round(p_amount, 2), 'Bank transfer ' || p_reference,
     'topup:' || p_reference, auth.uid());

  select * into v_bal from public.employer_wallet_balance(p_employer_id);
  return jsonb_build_object('employer_id', p_employer_id, 'amount', round(p_amount, 2),
                            'reference', p_reference, 'available', v_bal.available, 'held', v_bal.held);
end;
$$;

revoke all on function public.admin_record_topup(uuid, numeric, text) from public;
grant execute on function public.admin_record_topup(uuid, numeric, text) to authenticated;

-- ── hold the full contracted wage when an offer is made ──────────────────────
-- Returns what happened rather than raising when funds are short, so the app
-- can show "top up to continue" during the warn-only phase and refuse once
-- enforcement is on. The decision lives in one place.
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
  v_amount numeric;
  v_bal record;
  v_enforced boolean := public.employer_wallet_enforced();
begin
  select a.id, a.worker_id, a.shift_id, a.wage_ask, a.status
  into v_app from public.applications a where a.id = p_application_id;
  if v_app.id is null then
    raise exception 'Application not found';
  end if;

  select s.id, s.employer_id, s.title into v_shift
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
  v_amount := round(coalesce(v_app.wage_ask, 0) * v_hours, 2);

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
                            'available', v_bal.available, 'held_total', v_bal.held);
end;
$$;

revoke all on function public.employer_hold_for_offer(uuid) from public;
grant execute on function public.employer_hold_for_offer(uuid) to authenticated;

-- ── release a hold that is no longer owed ────────────────────────────────────
-- Offer declined, offer expired, worker withdrew, or a cancellation where no
-- compensation is due. Never releases more than is actually held for that
-- application.
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

-- ── capture: turn a hold into money the worker is actually paid ──────────────
-- Called when a payout is settled or cancellation compensation is owed.
-- Capping at what is held is deliberate: capturing more than was ever held
-- would let the platform bill an employer beyond what they committed to.
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

  -- Anything held beyond what was captured is no longer owed -- a worker who
  -- worked fewer hours than contracted should not leave the remainder tied up.
  if v_open - v_take > 0 then
    insert into public.employer_wallet_entry
      (employer_id, kind, amount, shift_id, application_id, note, created_by)
    values
      (v_employer, 'release', round(v_open - v_take, 2), v_app.shift_id, p_application_id,
       'Unused balance of the hold released after capture', auth.uid());
  end if;

  return jsonb_build_object('captured', true, 'amount', v_take,
                            'released_remainder', round(greatest(v_open - v_take, 0), 2));
end;
$$;

revoke all on function public.employer_capture_hold(uuid, numeric, text) from public;
grant execute on function public.employer_capture_hold(uuid, numeric, text) to authenticated;

-- ── self-verifying test of the money invariants ──────────────────────────────
-- Runs in this transaction, creates its own rows, and RAISES on any wrong
-- number rather than reporting success. Cleans up after itself.
do $test$
declare
  v_emp uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- QA employer
  v_wrk uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';  -- QA worker one
  v_s1 uuid; v_s2 uuid; v_a1 uuid; v_a2 uuid;
  v_start timestamptz := now() + interval '5 days';
  v_res jsonb; v_bal record; v_fail text;
begin
  -- two shifts, 20/h x 8h = RM160 each
  insert into public.shifts (employer_id, title, location, start_at, end_at,
                             wage_min, wage_max, headcount, status, occurrences)
  values (v_emp, 'WAL test A', 'KL', v_start, v_start + interval '8 hours', 15, 25, 1, 'open',
          jsonb_build_array(jsonb_build_object('start','10:00','end','18:00')))
  returning id into v_s1;
  insert into public.shifts (employer_id, title, location, start_at, end_at,
                             wage_min, wage_max, headcount, status, occurrences)
  values (v_emp, 'WAL test B', 'KL', v_start, v_start + interval '8 hours', 15, 25, 1, 'open',
          jsonb_build_array(jsonb_build_object('start','10:00','end','18:00')))
  returning id into v_s2;

  insert into public.applications (shift_id, worker_id, wage_ask) values (v_s1, v_wrk, 20) returning id into v_a1;
  insert into public.applications (shift_id, worker_id, wage_ask) values (v_s2, v_wrk, 20) returning id into v_a2;

  -- 1. top up RM200
  perform public.admin_record_topup(v_emp, 200, 'WALTEST-' || v_s1::text);
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 200 or v_bal.held <> 0 then
    raise exception 'after topup expected 200/0, got %/%', v_bal.available, v_bal.held;
  end if;

  -- 2. hold RM160 for offer A
  v_res := public.employer_hold_for_offer(v_a1);
  if (v_res ->> 'held') <> 'true' or (v_res ->> 'amount')::numeric <> 160 then
    raise exception 'hold A failed: %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 40 or v_bal.held <> 160 then
    raise exception 'after hold expected 40/160, got %/%', v_bal.available, v_bal.held;
  end if;

  -- 3. retrying the SAME offer must not hold twice
  v_res := public.employer_hold_for_offer(v_a1);
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.held <> 160 then
    raise exception 'retried hold double-charged: held is %', v_bal.held;
  end if;

  -- 4. THE DOUBLE-SPEND TEST: only RM40 is left, offer B needs RM160
  v_res := public.employer_hold_for_offer(v_a2);
  if (v_res ->> 'held') <> 'false' or (v_res ->> 'reason') <> 'insufficient_funds' then
    raise exception 'second offer should not have been funded: %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.held <> 160 then
    raise exception 'refused offer still moved money: held is %', v_bal.held;
  end if;

  -- 5. capture RM100; the unused RM60 must be released, not stranded
  v_res := public.employer_capture_hold(v_a1, 100, 'test capture');
  if (v_res ->> 'captured') <> 'true' or (v_res ->> 'released_remainder')::numeric <> 60 then
    raise exception 'capture wrong: %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 100 or v_bal.held <> 0 then
    raise exception 'after capture expected 100/0, got %/%', v_bal.available, v_bal.held;
  end if;

  -- 6. capturing again must take nothing
  v_res := public.employer_capture_hold(v_a1, 500, 'over-capture attempt');
  if (v_res ->> 'captured') <> 'false' then
    raise exception 'over-capture succeeded: %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 100 then
    raise exception 'over-capture moved money: available is %', v_bal.available;
  end if;

  -- 7. the ledger is immutable
  begin
    update public.employer_wallet_entry set amount = 1 where employer_id = v_emp;
    raise exception 'ledger accepted an UPDATE';
  exception when others then
    if sqlerrm = 'ledger accepted an UPDATE' then raise; end if;
  end;

  -- cleanup: ledger rows cannot be deleted by design, so remove them with the
  -- trigger disabled, then the shifts.
  alter table public.employer_wallet_entry disable trigger employer_wallet_entry_no_update;
  delete from public.employer_wallet_entry where employer_id = v_emp;
  alter table public.employer_wallet_entry enable trigger employer_wallet_entry_no_update;
  delete from public.applications where id in (v_a1, v_a2);
  delete from public.shifts where id in (v_s1, v_s2);

  raise notice 'wallet invariants verified: topup, hold, idempotent re-hold, double-spend refused, capture + remainder release, over-capture refused, immutability';
end
$test$;

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
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
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
  v_app record;
  v_employer uuid;
  v_open numeric;
begin
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
  v_app record;
  v_employer uuid;
  v_open numeric;
  v_take numeric;
begin
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

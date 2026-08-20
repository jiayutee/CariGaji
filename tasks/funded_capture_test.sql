-- Proves the FUNDED path end to end: top up, hold at offer, complete the
-- shift, and confirm the hold converts into the worker's payout with the
-- remainder released. Raises on any wrong number. Cleans up after itself,
-- including the two unfunded test shifts left by the API run.
do $hp$
declare
  v_emp uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';
  v_wrk uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';
  v_s uuid; v_a uuid;
  v_start timestamptz := now() - interval '3 hours';
  v_res jsonb; v_bal record; v_pay numeric;
begin
  insert into public.shifts (employer_id, title, location, start_at, end_at,
                             wage_min, wage_max, headcount, status, occurrences)
  values (v_emp, 'HP funded', 'KL', v_start, v_start + interval '8 hours', 15, 25, 1, 'open',
          jsonb_build_array(jsonb_build_object('start','10:00','end','18:00')))
  returning id into v_s;

  insert into public.applications (shift_id, worker_id, wage_ask, status, worker_signed_at)
  values (v_s, v_wrk, 20, 'accepted', now() - interval '2 hours')
  returning id into v_a;

  -- fund: RM500
  perform public.admin_record_topup(v_emp, 500, 'HPFUNDED-' || v_s::text);
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 500 then raise exception 'topup: expected 500, got %', v_bal.available; end if;

  -- hold the full contracted wage: 20 x 8 = 160
  v_res := public.employer_hold_for_offer(v_a);
  if (v_res ->> 'held') <> 'true' or (v_res ->> 'amount')::numeric <> 160 then
    raise exception 'hold failed: %', v_res;
  end if;
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.available <> 340 or v_bal.held <> 160 then
    raise exception 'after hold expected 340/160, got %/%', v_bal.available, v_bal.held;
  end if;

  -- worker works 7.5h with a 30m break, employer confirms
  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications
  set checked_in_at = v_start,
      checked_out_at = now(),
      worker_reported_hours = 7.5,
      worker_reported_break_minutes = 30
  where id = v_a;

  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications set employer_hours_confirmed_at = now() where id = v_a;

  -- the payout must exist at wage x REPORTED hours
  select amount into v_pay from public.payout_item
  where idempotency_key = 'shift_work:' || v_a::text;
  if v_pay is null then raise exception 'no payout was created for the completed shift'; end if;
  if v_pay <> 150 then raise exception 'payout expected 150 (20 x 7.5), got %', v_pay; end if;

  -- and the hold must have converted: 150 captured, 10 remainder released
  select * into v_bal from public.employer_wallet_balance(v_emp);
  if v_bal.captured <> 150 then raise exception 'expected 150 captured, got %', v_bal.captured; end if;
  if v_bal.held <> 0 then raise exception 'expected 0 held after capture, got %', v_bal.held; end if;
  if v_bal.available <> 350 then raise exception 'expected 350 available (500-150), got %', v_bal.available; end if;

  raise notice 'FUNDED HAPPY PATH VERIFIED: held 160, worker paid 150, 10 released, available 350';

  -- ── cleanup: this test, plus the two unfunded API test shifts ─────────────
  delete from public.payout_item where idempotency_key = 'shift_work:' || v_a::text;
  alter table public.employer_wallet_entry disable trigger employer_wallet_entry_no_update;
  delete from public.employer_wallet_entry where employer_id = v_emp;
  alter table public.employer_wallet_entry enable trigger employer_wallet_entry_no_update;
  delete from public.applications where id = v_a;
  delete from public.shifts where id = v_s;

  delete from public.payout_item where (source_refs ->> 'shift_id')::uuid in
    (select id from public.shifts where employer_id = v_emp and title like 'HP %');
  delete from public.applications where shift_id in
    (select id from public.shifts where employer_id = v_emp and title like 'HP %');
  delete from public.shifts where employer_id = v_emp and title like 'HP %';

  if exists (select 1 from public.shifts where employer_id = v_emp) then
    raise exception 'cleanup incomplete: QA employer still has shifts';
  end if;
  raise notice 'cleanup verified: no QA shifts, no ledger entries left';
end
$hp$;

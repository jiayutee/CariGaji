-- Re-runnable regression test for the attendance windows / recovery / reminders
-- (20260915). Run it through the Supabase MCP execute_sql (or the SQL editor):
-- everything is rolled back, and the LAST statement always raises, so
--   * "SELFTEST PASSED ..."      = every assertion ran and held
--   * "ATTENDANCE FAILED: ..."   = a real regression (message says which)
--   * any other error            = the test itself is broken; fix it, do not ignore it
-- It runs as the DB owner, so it proves LOGIC, not grants/RLS -- for those use
-- the QA accounts over REST (see tasks/lessons.md, 2026-09-19).

create or replace function pg_temp.as_user(u uuid, adm boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when adm then '{"sub":"' || u::text || '","role":"authenticated","app_metadata":{"role":"admin"}}'
         else '{"sub":"' || u::text || '","role":"authenticated"}' end, true);
end $$;

create or replace function pg_temp.expect_fail(q text, pat text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin execute q; exception when others then v_msg := sqlerrm; end;
  if v_msg is null then raise exception 'ATTENDANCE FAILED: expected an error like [%] but the call succeeded: %', pat, q; end if;
  if v_msg not like pat then raise exception 'ATTENDANCE FAILED: expected error like [%] but got [%] for %', pat, v_msg, q; end if;
end $$;

-- start offset relative to now (negative = past); returns {shift_id, app_id}
create or replace function pg_temp.mk(e uuid, w uuid, p_start_off interval, p_dur interval, p_in boolean) returns uuid[] language plpgsql as $$
declare
  v_start timestamptz := now() + p_start_off;
  v_end   timestamptz := now() + p_start_off + p_dur;
  v_kl_s timestamp := v_start at time zone 'Asia/Kuala_Lumpur';
  v_kl_e timestamp := v_end   at time zone 'Asia/Kuala_Lumpur';
  v_shift uuid; v_app uuid;
begin
  insert into public.shifts (employer_id, title, description, category, location, start_at, end_at, wage_min, wage_max, headcount, status, requirements, occurrences)
  values (e, 'ZZ-ATT-TEST', 'x', 'Other', 'KL', v_start, v_end, 10, 20, 1, 'open', '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('date', to_char(v_kl_s, 'YYYY-MM-DD'), 'start', to_char(v_kl_s, 'HH24:MI'), 'end', to_char(v_kl_e, 'HH24:MI'))))
  returning id into v_shift;
  insert into public.applications (shift_id, worker_id, wage_ask, status, worker_signed_at, checked_in_at, checked_in_method)
  values (v_shift, w, 15, 'accepted', now(), case when p_in then v_start end, case when p_in then 'code' end)
  returning id into v_app;
  return array[v_shift, v_app];
end $$;

do $test$
declare
  E uuid; W uuid;
  m uuid[]; s uuid; a uuid;
  r record; n int; v_rel0 numeric; v_rel1 numeric; v_req uuid; v_disp uuid;
begin
  select id into E from public.profiles order by id limit 1;
  select id into W from public.profiles where id <> E order by id limit 1;

  -- 1. missed check-in (shift ended 3h ago): refused with the code, request, reminder once, employer assists, paid
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); s := m[1]; a := m[2];
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.worker_check_in(%L, %L)', a, '000000'), '%shift has ended%');
  perform public.worker_request_attendance(a, 'check_in', 'I was there, forgot to scan');
  perform pg_temp.expect_fail(format('select public.worker_request_attendance(%L, %L)', a, 'check_in'), '%already asked%');
  perform public.send_attendance_reminders();
  select count(*) into n from public.notifications where user_id = W and type = 'attendance_missed_checkin' and link like '%' || a || '%';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: expected 1 missed-checkin notice, got %', n; end if;
  select count(*) into n from public.notifications where user_id = E and type = 'attendance_employer_missed_checkin' and link like '%' || s || '%';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: expected 1 employer missed-checkin notice, got %', n; end if;
  perform public.send_attendance_reminders();
  select count(*) into n from public.notifications where user_id = W and type = 'attendance_missed_checkin' and link like '%' || a || '%';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: missed-checkin notice was repeated (%)', n; end if;
  perform pg_temp.expect_fail(format('select public.employer_check_in_worker(%L)', a), '%Not authorized%');
  perform pg_temp.as_user(E);
  perform public.employer_check_in_worker(a, 'yes they were here');
  select checked_in_at, checked_in_method into r from public.applications where id = a;
  if r.checked_in_method <> 'employer' or r.checked_in_at is null then raise exception 'ATTENDANCE FAILED: employer check-in not recorded (%)', r; end if;
  select count(*) into n from public.attendance_requests where application_id = a and status = 'approved' and kind = 'check_in';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: request not marked approved'; end if;
  perform pg_temp.as_user(W);
  perform public.worker_submit_checkout(a, 1.9, 0, 'done');
  perform pg_temp.as_user(E);
  perform public.employer_confirm_checkout(a);
  if not exists (select 1 from public.payout_item where idempotency_key = 'shift_work:' || a and amount = 28.50) then
    raise exception 'ATTENDANCE FAILED: payout after employer-assisted check-in missing (expected 15 x 1.9 = 28.50)'; end if;

  -- 2. too early
  m := pg_temp.mk(E, W, interval '10 hours', interval '2 hours', false); a := m[2];
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.worker_check_in(%L, %L)', a, '000000'), '%opens 2 hours%');
  perform pg_temp.expect_fail(format('select public.worker_request_attendance(%L, %L)', a, 'check_in'), '%not started%');

  -- 3. no-show then employer attests -> reversed, points restored; employer undo
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); a := m[2];
  select coalesce(reliability_score,100) into v_rel0 from public.profiles where id = W;
  perform pg_temp.as_user(E);
  perform public.employer_mark_no_show(a, 'not here');
  select coalesce(reliability_score,100) into v_rel1 from public.profiles where id = W;
  if v_rel1 >= v_rel0 and v_rel0 > 0 then raise exception 'ATTENDANCE FAILED: no-show did not cost reliability (% -> %)', v_rel0, v_rel1; end if;
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.worker_check_in(%L, %L)', a, '000000'), '%reported as not attending%');
  perform public.worker_request_attendance(a, 'check_in', 'I did attend');
  perform pg_temp.as_user(E);
  perform public.employer_check_in_worker(a);
  select no_show_at into r from public.applications where id = a;
  if r.no_show_at is not null then raise exception 'ATTENDANCE FAILED: employer check-in did not clear the no-show'; end if;
  select coalesce(reliability_score,100) into v_rel1 from public.profiles where id = W;
  if v_rel0 >= 25 and v_rel1 <> v_rel0 then raise exception 'ATTENDANCE FAILED: reliability not restored (% -> %)', v_rel0, v_rel1; end if;
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); a := m[2];
  perform public.employer_mark_no_show(a, 'x');
  perform public.employer_undo_no_show(a);
  select no_show_at into r from public.applications where id = a;
  if r.no_show_at is not null then raise exception 'ATTENDANCE FAILED: employer_undo_no_show did not clear the mark'; end if;

  -- 4. check-out window closed (ended 50h ago): refused, request, notices, employer submits, reject + resubmit bypasses window
  m := pg_temp.mk(E, W, interval '-52 hours', interval '2 hours', true); s := m[1]; a := m[2];
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.worker_submit_checkout(%L, 2, 0, null)', a), '%48-hour%');
  perform public.worker_request_attendance(a, 'check_out', 'forgot to check out');
  perform public.send_attendance_reminders();
  if not exists (select 1 from public.notifications where user_id = W and type = 'attendance_checkout_window_closed' and link like '%' || a || '%') then
    raise exception 'ATTENDANCE FAILED: no window-closed notice for the worker'; end if;
  if not exists (select 1 from public.notifications where user_id = E and type = 'attendance_employer_not_checked_out' and link like '%' || s || '%') then
    raise exception 'ATTENDANCE FAILED: no not-checked-out notice for the employer'; end if;
  perform pg_temp.as_user(E);
  perform public.employer_submit_hours_for_worker(a, 1.5, 'left at 4pm');
  select employer_proposed_hours into r from public.applications where id = a;
  if r.employer_proposed_hours is distinct from 1.5 then raise exception 'ATTENDANCE FAILED: on-behalf proposal not recorded'; end if;
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.worker_submit_checkout(%L, 2, 0, null)', a), '%proposed hours%');
  perform public.worker_reject_modification(a);
  perform public.worker_submit_checkout(a, 1.75, 0, 'my own number');
  select worker_reported_hours, checked_out_method into r from public.applications where id = a;
  if r.worker_reported_hours <> 1.75 or r.checked_out_method <> 'worker' then raise exception 'ATTENDANCE FAILED: resubmission after rejection did not land (%)', r; end if;
  perform pg_temp.as_user(E);
  perform pg_temp.expect_fail(format('select public.employer_submit_hours_for_worker(%L, 1)', a), '%already submitted%');

  -- 5. on-behalf hours accepted by the worker => confirmed and paid
  m := pg_temp.mk(E, W, interval '-52 hours', interval '2 hours', true); a := m[2];
  perform pg_temp.as_user(E);
  perform pg_temp.expect_fail(format('select public.employer_submit_hours_for_worker(%L, 0)', a), '%valid number%');
  perform public.employer_submit_hours_for_worker(a, 1.5, null);
  perform pg_temp.as_user(W);
  perform public.worker_accept_modification(a);
  select checked_out_method, employer_hours_confirmed_at, worker_reported_hours, checked_out_at into r from public.applications where id = a;
  if r.checked_out_method <> 'employer' or r.employer_hours_confirmed_at is null or r.worker_reported_hours <> 1.5 or r.checked_out_at is null then
    raise exception 'ATTENDANCE FAILED: accepting on-behalf hours did not settle (%)', r; end if;
  if not exists (select 1 from public.payout_item where idempotency_key = 'shift_work:' || a and amount = 22.50) then
    raise exception 'ATTENDANCE FAILED: no payout for accepted on-behalf hours (expected 15 x 1.5 = 22.50)'; end if;

  -- 6. employer declines a request
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); a := m[2];
  perform pg_temp.as_user(W);
  perform public.worker_request_attendance(a, 'check_in');
  select id into v_req from public.attendance_requests where application_id = a and status = 'pending';
  perform pg_temp.as_user(E);
  perform public.employer_decline_attendance_request(v_req, 'no record of you');
  if not exists (select 1 from public.notifications where user_id = W and type = 'attendance_request_declined' and link like '%' || a || '%') then
    raise exception 'ATTENDANCE FAILED: worker not told the request was declined'; end if;
  perform pg_temp.expect_fail(format('select public.employer_decline_attendance_request(%L)', v_req), '%already answered%');

  -- 7. admin rulings
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); a := m[2];
  perform pg_temp.as_user(E);
  perform public.employer_mark_no_show(a, 'x');
  insert into public.disputes (application_id, filed_by, filed_by_role, category, description) values (a, W, 'worker', 'no_show_claim', 'I was there') returning id into v_disp;
  perform pg_temp.as_user(W);
  perform pg_temp.expect_fail(format('select public.admin_apply_attendance_correction(%L, %L, 4)', v_disp, 'grant_attendance'), '%Not authorized%');
  perform pg_temp.as_user(E, true);
  perform pg_temp.expect_fail(format('select public.admin_apply_attendance_correction(%L, %L)', v_disp, 'grant_attendance'), '%Enter the hours%');
  perform public.admin_apply_attendance_correction(v_disp, 'grant_attendance', 4, 'CCTV shows attendance');
  select checked_in_method, checked_out_method, employer_hours_confirmed_at, worker_reported_hours, no_show_at into r from public.applications where id = a;
  if r.checked_in_method <> 'admin' or r.checked_out_method <> 'admin' or r.employer_hours_confirmed_at is null or r.worker_reported_hours <> 4 or r.no_show_at is not null then
    raise exception 'ATTENDANCE FAILED: admin grant did not apply (%)', r; end if;
  if not exists (select 1 from public.payout_item where idempotency_key = 'shift_work:' || a and amount = 60.00) then
    raise exception 'ATTENDANCE FAILED: admin grant produced no payout (expected 15 x 4 = 60.00)'; end if;
  if (select status from public.disputes where id = v_disp) <> 'resolved' then raise exception 'ATTENDANCE FAILED: dispute not closed by admin ruling'; end if;
  perform pg_temp.expect_fail(format('select public.admin_apply_attendance_correction(%L, %L, 4)', v_disp, 'grant_attendance'), '%already closed%');
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', false); a := m[2];
  insert into public.disputes (application_id, filed_by, filed_by_role, category, description) values (a, E, 'employer', 'no_show_claim', 'never came') returning id into v_disp;
  perform public.admin_apply_attendance_correction(v_disp, 'confirm_no_show', null, 'no evidence of attendance');
  select no_show_at into r from public.applications where id = a;
  if r.no_show_at is null then raise exception 'ATTENDANCE FAILED: admin confirm_no_show did not mark the no-show'; end if;
  insert into public.disputes (application_id, filed_by, filed_by_role, category, description) values (a, W, 'worker', 'no_show_claim', 'appeal') returning id into v_disp;
  perform public.admin_apply_attendance_correction(v_disp, 'reverse_no_show', null, 'appeal upheld');
  select no_show_at into r from public.applications where id = a;
  if r.no_show_at is not null then raise exception 'ATTENDANCE FAILED: admin reverse_no_show left the mark'; end if;

  -- 8. reminder cadence + confirmation nudges
  m := pg_temp.mk(E, W, interval '-5 hours', interval '2 hours', true); a := m[2];
  perform public.send_attendance_reminders();
  select count(*) into n from public.notifications where user_id = W and type = 'attendance_checkout_reminder' and link like '%' || a || '%';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: expected an immediate check-out reminder, got %', n; end if;
  perform public.send_attendance_reminders();
  select count(*) into n from public.notifications where user_id = W and type = 'attendance_checkout_reminder' and link like '%' || a || '%';
  if n <> 1 then raise exception 'ATTENDANCE FAILED: check-out reminder repeated inside 8h (%)', n; end if;
  update public.attendance_reminders set last_sent_at = now() - interval '9 hours' where application_id = a and kind = 'checkout';
  perform public.send_attendance_reminders();
  select count(*) into n from public.notifications where user_id = W and type = 'attendance_checkout_reminder' and link like '%' || a || '%';
  if n <> 2 then raise exception 'ATTENDANCE FAILED: expected the 8h follow-up reminder, got %', n; end if;
  m := pg_temp.mk(E, W, interval '-80 hours', interval '2 hours', true); a := m[2];
  perform set_config('app.attendance_trusted_write', 'true', true);
  update public.applications set checked_out_at = now() - interval '73 hours', worker_reported_hours = 2, checked_out_method = 'worker' where id = a;
  perform set_config('app.attendance_trusted_write', 'false', true);
  perform public.send_attendance_reminders();
  if not exists (select 1 from public.notifications where user_id = E and type = 'hours_confirmation_reminder' and link like '%' || m[1] || '%') then
    raise exception 'ATTENDANCE FAILED: employer not nudged about unconfirmed hours'; end if;
  if not exists (select 1 from public.notifications where user_id = W and type = 'hours_awaiting_employer' and link like '%' || a || '%') then
    raise exception 'ATTENDANCE FAILED: worker not told they can escalate after 72h'; end if;

  perform set_config('request.jwt.claims', '', true);
  raise exception 'SELFTEST PASSED: check-in window, missed check-in request/assist/decline, no-show reversal, 48h check-out window, employer-submitted hours (accept + reject/resubmit), admin rulings, and every reminder rule all behaved; payouts correct. Rolled back.';
end $test$;

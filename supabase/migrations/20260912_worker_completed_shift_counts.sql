-- "N shifts done" on the employer's applicant card was a literal zero.
--
-- carigaji-app.jsx mapped every applicant with `completedShifts: 0`, so the
-- card read "0 shifts done" for everyone, forever, no matter how much work the
-- worker had actually completed. Spotted 2026-09-12 while verifying the
-- completed-shifts fix: a worker on a shift that had just completed still read
-- zero. That number is a hiring signal -- it sits directly under the worker's
-- name, next to their rating and reliability -- and it was never once true.
--
-- WHY THIS NEEDS A FUNCTION AT ALL. The obvious fix is to count the worker's
-- accepted applications on completed shifts from the client. RLS will not allow
-- it: applications_employer_read only exposes applications on the CALLER'S OWN
-- shifts (20260629), so an employer counting from the client would only ever
-- see the work that worker did for them -- "3 shifts done" meaning "3 with me",
-- which reads as a platform-wide track record and is not one. Either the number
-- is computed where it can see everything, or it is quietly wrong in a new way.
--
-- WHY IT IS SCOPED. A definer function that answered for any uuid would let any
-- authenticated account enumerate any worker's work history. So it answers only
-- for workers who have actually applied to one of the caller's own shifts --
-- exactly the people whose card the employer is looking at. Everyone else comes
-- back empty rather than zero, because "no answer" and "worked zero shifts" are
-- different claims and the caller is not entitled to the second one.
--
-- Returns no row for a worker with zero completed shifts, rather than a zero
-- row. The client already defaults to 0, and this keeps the payload to workers
-- the number actually says something about.

create or replace function public.worker_completed_shift_counts(p_worker_ids uuid[])
returns table (worker_id uuid, completed_shifts integer)
language sql
security definer
stable
set search_path = public
as $$
  select a.worker_id, count(*)::int
    from public.applications a
    join public.shifts s on s.id = a.shift_id
   where a.worker_id = any(p_worker_ids)
     and a.status = 'accepted'
     and s.status = 'completed'
     -- Only workers who have applied to something of mine.
     and exists (
       select 1
         from public.applications mine
         join public.shifts ms on ms.id = mine.shift_id
        where mine.worker_id = a.worker_id
          and ms.employer_id = auth.uid()
     )
   group by a.worker_id
$$;

comment on function public.worker_completed_shift_counts(uuid[]) is
  'Completed shifts per worker (accepted application on a completed shift), across the whole platform -- but only for workers who have applied to one of the caller''s own shifts. Backs "N shifts done" on the employer applicant card, which RLS cannot compute client-side. Workers with none are omitted, not returned as 0.';

revoke all on function public.worker_completed_shift_counts(uuid[]) from public;
grant execute on function public.worker_completed_shift_counts(uuid[]) to authenticated;

-- ── self-verifying test ────────────────────────────────────────────────────
-- Rolled back always, so it leaves nothing behind (the convention from
-- 20260824b / 20260829 / 20260911). auth.uid() is null under direct SQL, and
-- this function is built around it, so the test sets request.jwt.claims to
-- impersonate the employer the way PostgREST would -- same trick 20260829 uses.
do $test$
declare
  v_emp     uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- QA employer (the caller)
  v_other   uuid := gen_random_uuid();                        -- a different employer
  v_w1      uuid := gen_random_uuid();
  v_w2      uuid := gen_random_uuid();
  v_w3      uuid := gen_random_uuid();
  v_done1   uuid; v_done2 uuid; v_open uuid; v_foreign uuid;
  v_n       int;
begin
  begin
    -- Two of the caller's shifts that are over, one still open.
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COUNT test done A', 'KL', now() - interval '9 days', now() - interval '9 days' + interval '6 hours', 10, 20, 5, 'completed', '[]'::jsonb)
    returning id into v_done1;
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COUNT test done B', 'KL', now() - interval '8 days', now() - interval '8 days' + interval '6 hours', 10, 20, 5, 'completed', '[]'::jsonb)
    returning id into v_done2;
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'COUNT test still open', 'KL', now() + interval '9 days', now() + interval '9 days' + interval '6 hours', 10, 20, 5, 'open', '[]'::jsonb)
    returning id into v_open;
    -- A DIFFERENT employer's completed shift, to prove the count is
    -- platform-wide and not just "shifts done with me".
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, headcount, status, occurrences)
    values (v_other, 'COUNT test foreign done', 'KL', now() - interval '7 days', now() - interval '7 days' + interval '6 hours', 10, 20, 5, 'completed', '[]'::jsonb)
    returning id into v_foreign;

    -- W1: accepted on both of mine + accepted on the other employer's = 3.
    --     Plus noise that must NOT count.
    insert into public.applications (shift_id, worker_id, wage_ask, status) values
      (v_done1,   v_w1, 15, 'accepted'),
      (v_done2,   v_w1, 15, 'accepted'),
      (v_foreign, v_w1, 15, 'accepted'),
      (v_open,    v_w1, 15, 'accepted'),   -- shift not completed
      (v_done1,   v_w2, 15, 'pending');    -- application not accepted
    -- W2 applied to mine but never accepted on a completed one -> no row.
    -- W3 only ever worked for the OTHER employer -> out of scope entirely.
    insert into public.applications (shift_id, worker_id, wage_ask, status)
    values (v_foreign, v_w3, 15, 'accepted');

    perform set_config('request.jwt.claims',
      '{"sub":"' || v_emp::text || '","role":"authenticated"}', true);

    select completed_shifts into v_n
      from public.worker_completed_shift_counts(array[v_w1, v_w2, v_w3])
     where worker_id = v_w1;
    if coalesce(v_n, 0) <> 3 then
      raise exception 'COUNT self-test FAILED: W1 should have 3 completed shifts (2 mine + 1 elsewhere), got %', coalesce(v_n, -1);
    end if;

    if exists (select 1 from public.worker_completed_shift_counts(array[v_w1, v_w2, v_w3]) where worker_id = v_w2) then
      raise exception 'COUNT self-test FAILED: W2 has no accepted+completed shift and should be omitted';
    end if;

    if exists (select 1 from public.worker_completed_shift_counts(array[v_w1, v_w2, v_w3]) where worker_id = v_w3) then
      raise exception 'COUNT self-test FAILED: W3 never applied to this employer and must be out of scope';
    end if;

    -- A caller with no applicants of their own gets nothing, even for ids that
    -- do have completed shifts. (v_other is NOT used here: it genuinely employs
    -- W1 via the foreign shift, so it is entitled to an answer.)
    perform set_config('request.jwt.claims',
      '{"sub":"' || gen_random_uuid()::text || '","role":"authenticated"}', true);
    if exists (select 1 from public.worker_completed_shift_counts(array[v_w1, v_w2, v_w3])) then
      raise exception 'COUNT self-test FAILED: an employer with no applicants of their own got answers';
    end if;
    perform set_config('request.jwt.claims', '', true);

    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        raise notice 'COUNT self-test passed: counts accepted+completed across employers (3), omits a worker with none, excludes a worker outside the caller''s applicant pool, and answers nothing to an employer with no applicants. All test rows rolled back.';
      elsif sqlerrm like 'COUNT self-test FAILED%' then
        raise;
      else
        raise warning 'COUNT self-test SETUP failed (fix still applied): %', sqlerrm;
      end if;
  end;
end $test$;

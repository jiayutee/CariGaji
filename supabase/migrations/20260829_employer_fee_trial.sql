-- Two free months per employer, counted from their FIRST POSTED SHIFT.
--
-- WHY NOT FROM REGISTRATION (owner's call, 2026-08-29). Registering is a
-- low-commitment act. An employer who signs up to look around and comes back
-- three months later would have burned the whole offer without posting
-- anything -- we would have paid the acquisition cost and given away nothing
-- they noticed. The clock therefore starts when they actually use the product.
--
-- BACKSTOP. An unstarted trial does not sit open forever: if an account has
-- existed longer than TRIAL_BACKSTOP without ever posting, the offer has
-- lapsed and their first shift is billed normally. Otherwise a dormant 2026
-- signup could claim two free months in 2028.
--
-- WHAT THIS DOES NOT CHANGE. shifts.platform_fee_pct is still stamped once, at
-- post time, and pinned forever after. A shift posted on the final free day
-- stays free through a payout weeks later. That is the same snapshot rule
-- 20260824b established, and it is what makes the trial explainable: the rate
-- you saw when you posted is the rate you pay.

-- ── the two columns ─────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists fee_trial_started_at timestamptz,
  add column if not exists fee_free_until       timestamptz;

comment on column public.profiles.fee_free_until is
  'End of this employer''s fee-free window. NULL = trial not started yet. Stored rather than computed so a single employer can be extended without a deploy.';

-- ── the trial length, in one place ──────────────────────────────────────────
create or replace function public.fee_trial_length()
returns interval language sql immutable as $$ select interval '2 months' $$;

create or replace function public.fee_trial_backstop()
returns interval language sql immutable as $$ select interval '6 months' $$;

-- ── start the clock on the first shift ──────────────────────────────────────
-- SECURITY DEFINER because it writes to profiles on behalf of an employer who
-- must not be able to write these columns themselves (see the guard below).
create or replace function public.start_fee_trial_if_first_shift(p_employer uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile record;
begin
  select created_at, fee_trial_started_at, fee_free_until
  into v_profile from public.profiles where id = p_employer;

  if v_profile is null then
    return null;                       -- no profile row yet; no trial to start
  end if;

  -- Already started: return what it already is. Never restart or extend a
  -- trial from here -- that is an admin action, not something a new shift does.
  if v_profile.fee_trial_started_at is not null then
    return v_profile.fee_free_until;
  end if;

  -- Never used, and the account is older than the backstop: the offer lapsed.
  if v_profile.created_at < now() - public.fee_trial_backstop() then
    return null;
  end if;

  perform set_config('app.fee_trial_trusted_write', 'true', true);
  update public.profiles
  set fee_trial_started_at = now(),
      fee_free_until       = now() + public.fee_trial_length(),
      updated_at           = now()
  where id = p_employer;
  perform set_config('app.fee_trial_trusted_write', '', true);

  return now() + public.fee_trial_length();
end;
$$;

-- ── the rate this employer pays right now ───────────────────────────────────
create or replace function public.platform_fee_pct_for(p_employer uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  select fee_free_until into v_until from public.profiles where id = p_employer;
  if v_until is not null and now() < v_until then
    return 0.0000;
  end if;
  return public.platform_fee_pct();
end;
$$;

grant execute on function public.platform_fee_pct_for(uuid) to authenticated;
grant execute on function public.fee_trial_length() to authenticated, anon;

-- ── employers must not be able to grant themselves a trial ──────────────────
create or replace function public.guard_fee_trial_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  is_trusted boolean := coalesce(current_setting('app.fee_trial_trusted_write', true), '') = 'true';
begin
  if is_admin or is_direct_sql or is_trusted then
    return new;
  end if;
  -- Same shape as guard_platform_fee_pct: revert rather than raise, so an
  -- ordinary profile update (name, avatar) still succeeds and only these two
  -- columns are pinned.
  if tg_op = 'INSERT' then
    new.fee_trial_started_at := null;
    new.fee_free_until := null;
  else
    new.fee_trial_started_at := old.fee_trial_started_at;
    new.fee_free_until := old.fee_free_until;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_fee_trial_columns on public.profiles;
create trigger trg_guard_fee_trial_columns
  before insert or update on public.profiles
  for each row execute function public.guard_fee_trial_columns();

-- ── stamp the shift at the employer's rate, starting the trial if needed ────
create or replace function public.guard_platform_fee_pct()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
begin
  if is_admin or is_direct_sql then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- Order matters: start the clock FIRST, so the very shift that starts the
    -- trial is itself free. Stamping before starting would bill an employer
    -- for the posting that triggered their own free period.
    perform public.start_fee_trial_if_first_shift(new.employer_id);
    new.platform_fee_pct := public.platform_fee_pct_for(new.employer_id);
  else
    new.platform_fee_pct := old.platform_fee_pct;
  end if;
  return new;
end;
$$;

-- Recreate the trigger too, rather than assuming 20260824b's is still attached.
-- This migration only REPLACES the function; if the trigger were ever dropped
-- the rate would silently stop being stamped and every shift would default to
-- 0.0000 -- a revenue bug with no error message. Cheap to be certain.
drop trigger if exists trg_guard_platform_fee_pct on public.shifts;
create trigger trg_guard_platform_fee_pct
  before insert or update on public.shifts
  for each row execute function public.guard_platform_fee_pct();

-- ── self-verifying test ─────────────────────────────────────────────────────
-- Runs inside a subtransaction that is ALWAYS rolled back, so it leaves no
-- rows behind and never fights the append-only ledger (lesson from 20260824b).
do $test$
declare
  v_emp uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- QA employer
  v_start timestamptz := now() + interval '20 days';
  v_s1 uuid; v_s2 uuid; v_until timestamptz; v_pct numeric; v_saved_until timestamptz;
begin
  begin
    select fee_free_until into v_saved_until from public.profiles where id = v_emp;

    -- Force a known starting point: no trial yet.
    perform set_config('app.fee_trial_trusted_write', 'true', true);
    update public.profiles set fee_trial_started_at = null, fee_free_until = null where id = v_emp;
    perform set_config('app.fee_trial_trusted_write', '', true);

    -- Insert AS THE EMPLOYER. A psql session has no request.jwt.claims, which
    -- makes is_direct_sql true and the guard returns early by design -- so a
    -- plain psql insert would never start a trial and the test would be
    -- measuring nothing. Simulate the PostgREST path instead.
    perform set_config('request.jwt.claims',
      '{"sub":"' || v_emp::text || '","role":"authenticated"}', true);

    -- 1. THE FIRST SHIFT STARTS THE CLOCK AND IS ITSELF FREE.
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'TRIAL test A', 'KL', v_start, v_start + interval '6 hours', 10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('start','09:00','end','15:00')))
    returning id, platform_fee_pct into v_s1, v_pct;

    select fee_free_until into v_until from public.profiles where id = v_emp;
    if v_until is null then
      raise exception 'TRIAL self-test FAILED: first shift did not start the trial';
    end if;
    if v_pct <> 0 then
      raise exception 'TRIAL self-test FAILED: the shift that STARTED the trial was billed at %', v_pct;
    end if;

    -- 2. A SECOND SHIFT DOES NOT RESTART OR EXTEND IT.
    --
    -- Move the end date to a DISTINCT value first. Postgres' now() is the
    -- transaction start time, so a re-extension inside this one transaction
    -- would recompute to exactly the same timestamp and be invisible -- the
    -- first version of this test passed even with the early-return deleted.
    -- Comparing against a value that could not have been recomputed closes it.
    perform set_config('app.fee_trial_trusted_write', 'true', true);
    update public.profiles set fee_free_until = timestamptz '2027-01-01 00:00:00+00'
    where id = v_emp;
    perform set_config('app.fee_trial_trusted_write', '', true);
    v_until := timestamptz '2027-01-01 00:00:00+00';

    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, headcount, status, occurrences)
    values (v_emp, 'TRIAL test B', 'KL', v_start, v_start + interval '6 hours', 10, 20, 1, 'open',
            jsonb_build_array(jsonb_build_object('start','09:00','end','15:00')))
    returning id into v_s2;
    if (select fee_free_until from public.profiles where id = v_emp) <> v_until then
      raise exception 'TRIAL self-test FAILED: a later shift moved the trial end date';
    end if;

    -- 3. AN EMPLOYER CANNOT GRANT THEMSELVES MORE TIME (still authenticated).
    update public.profiles set fee_free_until = now() + interval '10 years' where id = v_emp;
    perform set_config('request.jwt.claims', '', true);
    if (select fee_free_until from public.profiles where id = v_emp) <> v_until then
      raise exception 'TRIAL self-test FAILED: an employer extended their own trial';
    end if;

    -- 4. ONCE EXPIRED, THE GLOBAL RATE APPLIES AGAIN.
    perform set_config('app.fee_trial_trusted_write', 'true', true);
    update public.profiles set fee_free_until = now() - interval '1 day' where id = v_emp;
    perform set_config('app.fee_trial_trusted_write', '', true);
    if public.platform_fee_pct_for(v_emp) <> public.platform_fee_pct() then
      raise exception 'TRIAL self-test FAILED: expired trial did not fall back to the global rate (got %)',
        public.platform_fee_pct_for(v_emp);
    end if;

    raise exception 'ROLLBACK_SELFTEST';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_SELFTEST' then
        raise notice 'TRIAL self-test passed: first shift starts and is free, later shifts do not extend, employers cannot self-grant, expiry falls back to the global rate. All test rows rolled back.';
      elsif sqlerrm like 'TRIAL self-test FAILED%' then
        raise;
      else
        raise warning 'TRIAL self-test SETUP failed (fix still applied): %', sqlerrm;
      end if;
  end;
end $test$;

do $$
begin
  raise notice 'fee trial: % from the first posted shift, lapsing % after signup if never used',
    public.fee_trial_length(), public.fee_trial_backstop();
  raise notice 'global rate for employers past their trial: % percent',
    round(public.platform_fee_pct() * 100, 2);
end $$;

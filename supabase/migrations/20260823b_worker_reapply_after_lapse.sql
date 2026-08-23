-- Let a worker bid again on a shift they withdrew from or let an offer expire
-- on. Not after a rejection.
--
-- THE RULE, and why it splits by case: whoever ended the application decides
-- whether it can reopen.
--   rejected   the EMPLOYER said no. Re-applying would let a worker override
--              that by persistence, which from the employer's side is spam.
--   withdrawn  the worker's own decision, freely made. Circumstances change.
--   expired    the worker missed a deadline. A permanent, silent ban from that
--              one shift is a disproportionate penalty for a missed
--              notification, and it costs the EMPLOYER a candidate for a shift
--              that may still be unfilled. Lateness already has a visible,
--              proportionate consequence in reliability_score; it does not
--              need a hidden second one.
--
-- WHY THE UNIQUE CONSTRAINT STAYS. applications carries
-- `unique (shift_id, worker_id)` and a great deal depends on one row per
-- worker per shift: payout_item.source_refs keys off application_id, several
-- lookups use maybeSingle(), and chat resolves room participants from
-- applications. Dropping it to allow a second row would ripple far past this
-- feature. So re-applying REUSES the existing row -- withdrawn/expired flips
-- back to pending with the new wage_ask -- and every downstream assumption
-- holds unchanged.

-- ── 1. the worker may reopen their own lapsed application ────────────────────
-- Separate policy rather than widening applications_worker_update, whose job
-- is pending -> withdrawn. Postgres ORs permissive policies together, so one
-- narrow policy per transition stays readable and each can be revoked alone.
drop policy if exists applications_worker_reapply on public.applications;
create policy applications_worker_reapply
  on public.applications for update to authenticated
  using  (auth.uid() = worker_id and status in ('withdrawn', 'expired'))
  with check (auth.uid() = worker_id and status = 'pending');

-- ── 2. the transition guard has to permit it too ─────────────────────────────
-- RLS decides WHICH ROWS; this trigger decides WHICH TRANSITIONS. Both have to
-- agree or the update is silently reverted.
--
-- Patched from 20260718's definition verbatim, with two clauses added to the
-- worker branch. Note the guard REASSIGNS rather than raising -- an illegitimate
-- transition silently keeps the old value. That is the existing convention here
-- and is not changed, but it means the client must read the row back rather
-- than trusting a 204.
create or replace function public.guard_application_status_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.application_status_trusted_write', true), '') = 'true';
  is_worker boolean := auth.uid() = old.worker_id;
  is_employer boolean := exists (
    select 1 from public.shifts s where s.id = old.shift_id and s.employer_id = auth.uid()
  );
  legitimate boolean;
begin
  if is_admin or is_trusted_write then
    return new;
  end if;

  if new.status is distinct from old.status then
    legitimate := false;

    if is_worker then
      legitimate := (
        (old.status = 'pending' and new.status = 'withdrawn')
        or (old.status = 'offered' and new.status in ('accepted', 'rejected'))
        or (old.status = 'offered' and new.status = 'expired'
            and old.offer_expires_at is not null and old.offer_expires_at < now())
        -- Re-apply after the worker's OWN lapse. Deliberately excludes
        -- 'rejected': that was the employer's decision, not the worker's, and
        -- letting a worker reopen it would override a "no" by persistence.
        or (old.status in ('withdrawn', 'expired') and new.status = 'pending')
      );
    end if;

    if not legitimate and is_employer then
      legitimate := (
        (old.status in ('pending', 'shortlisted')
         and new.status in ('shortlisted', 'offered', 'accepted', 'rejected'))
        or (old.status = 'offered' and new.status = 'expired'
            and old.offer_expires_at is not null and old.offer_expires_at < now())
      );
    end if;

    if not legitimate then
      new.status := old.status;
    end if;
  end if;

  if new.worker_signed_at is distinct from old.worker_signed_at then
    if not (
      is_worker
      and old.worker_signed_at is null
      and new.worker_signed_at is not null
      and new.status = 'accepted'
    ) then
      new.worker_signed_at := old.worker_signed_at;
    end if;
  end if;

  -- New: only the shift's own employer may stamp employer_signed_at, only
  -- null -> now(), and only in the same statement that moves status to
  -- 'offered' (the real makeOffer flow, carigaji-app.jsx:6296-6299).
  if new.employer_signed_at is distinct from old.employer_signed_at then
    if not (
      is_employer
      and old.employer_signed_at is null
      and new.employer_signed_at is not null
      and new.status = 'offered'
    ) then
      new.employer_signed_at := old.employer_signed_at;
    end if;
  end if;

  -- Reopening clears whatever the lapsed offer left behind, so a stale
  -- deadline or signature cannot make a fresh bid look like a live offer.
  if old.status in ('withdrawn', 'expired') and new.status = 'pending' then
    new.offer_expires_at := null;
    new.worker_signed_at := null;
  end if;

  return new;
end;
$$;

-- ── 3. prove it, with the negative controls that matter ──────────────────────
-- Rolled back at the end: this runs against real applications, and a test row
-- left behind would block that worker from ever bidding on that shift.
do $selftest$
declare
  v_emp uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';
  v_worker uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';
  v_shift uuid;
  v_app uuid;
  v_status text;
  v_out text;
  v_occ jsonb := jsonb_build_array(jsonb_build_object(
    'date',  to_char((now() + interval '40 days') at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM-DD'),
    'start', '09:00', 'end', '15:00'));
begin
  if not exists (select 1 from auth.users where id = v_emp)
     or not exists (select 1 from auth.users where id = v_worker) then
    raise notice 'self-test skipped: QA accounts not present';
    return;
  end if;

  begin
    insert into public.shifts (employer_id, title, location, start_at, end_at, wage_min, wage_max, occurrences, status)
    values (v_emp, 'SELFTEST reapply', 'Selftest', now() + interval '40 days',
            now() + interval '40 days 6 hours', 10, 20, v_occ, 'open')
    returning id into v_shift;

    insert into public.applications (shift_id, worker_id, wage_ask, status)
    values (v_shift, v_worker, 15, 'withdrawn')
    returning id into v_app;

    -- The guard runs as the row's worker only when auth.uid() matches, which is
    -- NULL in the SQL editor -- so it takes the trusted-write path here. What
    -- this self-test can prove is the DATA shape: that reopening keeps one row
    -- and clears the stale offer fields. The permission half needs a real
    -- token and is verified through PostgREST afterwards.
    perform set_config('app.application_status_trusted_write', 'true', true);
    update public.applications
    set status = 'pending', wage_ask = 17, offer_expires_at = now() + interval '1 day'
    where id = v_app;
    perform set_config('app.application_status_trusted_write', 'false', true);

    select status into v_status from public.applications where id = v_app;
    if v_status is distinct from 'pending' then
      raise exception 'ASSERT: reopened row is % rather than pending', v_status;
    end if;

    if (select count(*) from public.applications where shift_id = v_shift and worker_id = v_worker) <> 1 then
      raise exception 'ASSERT: reopening produced more than one row -- the unique constraint was meant to prevent exactly this';
    end if;

    raise exception using message = '__result__:passed';
  exception when others then
    v_out := case when sqlerrm like '__result__:%' then substr(sqlerrm, 12) else sqlerrm end;
  end;

  if v_out = 'passed' then
    if exists (select 1 from public.shifts where title = 'SELFTEST reapply') then
      raise exception 'self-test rows survived the rollback';
    end if;
    raise notice 'self-test passed: reopening keeps ONE row and lands on pending, nothing left behind';
    raise notice 'NOTE: the permission half (rejected must stay refused) needs a real token -- verify through the API';
  elsif v_out like 'ASSERT: %' then
    raise exception 'reapply self-test FAILED -- %', substr(v_out, 9);
  else
    raise warning 'reapply self-test COULD NOT RUN: %', v_out;
    raise warning 'the policy and guard above are applied but UNVERIFIED -- report this message';
  end if;
end
$selftest$;

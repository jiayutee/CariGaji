-- Closes a pre-existing, live production exploit found while independently
-- verifying 20260717f: Postgres combines multiple PERMISSIVE policies for
-- the same command by OR-ing their USING clauses and separately OR-ing
-- their WITH CHECK clauses — the USING that authorizes touching a row does
-- NOT have to come from the same policy as the WITH CHECK that authorizes
-- the new values. No RESTRICTIVE policy exists anywhere on
-- public.applications to close this off (confirmed via grep).
--
-- THE BUG: applications_worker_update's USING (auth.uid() = worker_id and
-- status = 'pending') authorizes a worker to touch their own pending
-- application. applications_worker_respond_offer's WITH CHECK (auth.uid()
-- = worker_id and status in ('accepted', 'rejected')) doesn't require
-- old.status = 'offered' — that's only enforced by that policy's OWN
-- USING clause, which Postgres does not require to have matched. So a
-- worker can UPDATE their own still-pending application straight to
-- status = 'accepted' in one statement, combining worker_update's USING
-- with worker_respond_offer's WITH CHECK — completely skipping the
-- employer's "offer" step. Once status = 'accepted', applications_worker_sign's
-- own USING now legitimately matches (status = 'accepted' and
-- worker_signed_at is null), so the worker can immediately self-sign too.
-- This forges a real accepted+signed application/contract for a shift the
-- worker was never selected for, which (after 20260717f) can also be
-- walked into a real cancellation payout if the employer later legitimately
-- cancels that shift within 24h.
--
-- THE FIX mirrors the guard-trigger pattern already used repeatedly in this
-- codebase (guard_employer_verification_status, guard_kyc_level,
-- guard_cancellation_choice_columns): re-validate the actual OLD -> NEW
-- transition against the real state machine, keyed off who the caller
-- actually is (worker vs. the shift's employer), independent of which RLS
-- policy nominally authorized the UPDATE.
--
-- ONE LEGITIMATE TRANSITION ISN'T ACTOR-SHAPED: notify_not_selected_when_filled
-- (20260705_hiring_workflow.sql) auto-rejects every other pending/shortlisted
-- applicant on a shift once headcount fills, via an internal cascading
-- UPDATE. That cascade runs with auth.uid() set to whichever party's own
-- action filled the last slot — which, on the worker-accepts-an-offer path,
-- is the WORKER, not the employer, and not the other applicants themselves.
-- Neither is_worker nor is_employer holds for those other rows, so this
-- guard would silently revert every one of those rejections. Fixed the same
-- way 20260717f protects its own internal writes: the cascade sets a
-- transaction-local trust flag right before its UPDATE, which a client can
-- never set itself (set_config isn't reachable via PostgREST — see
-- 20260717f's header for the full reasoning), and this guard honors it.

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

  -- worker_signed_at: only the row's own worker, only null -> now(), and
  -- only once new.status (post state-machine check above) is genuinely
  -- 'accepted' — closes the same self-forge path for the contract signature.
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

  return new;
end;
$$;

drop trigger if exists trg_guard_application_status_transitions on public.applications;
create trigger trg_guard_application_status_transitions
before update on public.applications
for each row
execute function public.guard_application_status_transitions();

-- Re-declare notify_not_selected_when_filled (20260705_hiring_workflow.sql)
-- only to add the trust-flag call in front of its cascade UPDATE — trigger
-- logic and firing condition are otherwise unchanged.
create or replace function public.notify_not_selected_when_filled()
returns trigger language plpgsql security definer as $$
declare
  v_headcount int;
  v_accepted_count int;
  v_shift_title text;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select headcount, title into v_headcount, v_shift_title
    from public.shifts where id = new.shift_id;

    select count(*) into v_accepted_count
    from public.applications
    where shift_id = new.shift_id and status = 'accepted';

    if v_accepted_count >= v_headcount then
      insert into public.notifications (user_id, type, title, body, link)
      select
        a.worker_id,
        'not_selected',
        'Not selected this time',
        'The shift "' || coalesce(v_shift_title, 'you applied for') || '" has been fully staffed. You were not selected.',
        '/worker/applications/' || a.id
      from public.applications a
      where a.shift_id = new.shift_id
        and a.status in ('pending', 'shortlisted');

      perform set_config('app.application_status_trusted_write', 'true', true);

      update public.applications
      set status = 'rejected', updated_at = now()
      where shift_id = new.shift_id
        and status in ('pending', 'shortlisted');

      perform set_config('app.application_status_trusted_write', 'false', true);
    end if;
  end if;
  return null;
end;
$$;

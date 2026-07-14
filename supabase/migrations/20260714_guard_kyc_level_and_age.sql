-- Two gaps surfaced by security review of the progressive sign-up feature
-- (both flagged because that feature leans on client-only enforcement):
--
-- 1. profiles.kyc_level is writable by any owner (profiles_owner_write has
--    no column restriction — same bug class as employer_verification_status,
--    already guarded by guard_employer_verification_status in
--    20260712b_employer_verification.sql). The client only ever assigns
--    'Basic' or 'pending_review' (assignKYCLevel in carigaji-app.jsx); only
--    the admin KYC review flow (approveKyc/rejectKyc) should be able to set
--    'Standard' or 'Advanced'. Without a guard, a worker can self-upsert
--    kyc_level='Advanced' with zero documents and zero admin review.
--
-- 2. The 18+ working-age gate (LEGAL_WORKING_AGE in DetailsGateModal) is
--    enforced only by disabling the submit button — nothing stops a direct
--    REST upsert of an underage date_of_birth. A DB check constraint can't
--    prove a stated DOB is truthful, but it closes the trivial bypass and
--    gives a compliance record for the stated value.

create or replace function public.guard_kyc_level()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  prior_level text := case when tg_op = 'INSERT' then 'Basic' else old.kyc_level end;
begin
  if is_admin then
    return new;
  end if;

  -- Non-admin callers may only ever land on the two levels the client's own
  -- self-assessment (assignKYCLevel) can produce; anything else (Standard,
  -- Advanced, or an arbitrary string) collapses back to the prior value.
  if new.kyc_level not in ('Basic', 'pending_review') then
    new.kyc_level := prior_level;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_kyc_level on public.profiles;
create trigger profiles_guard_kyc_level
before insert or update on public.profiles
for each row execute function public.guard_kyc_level();

alter table public.user_private
  add constraint user_private_worker_min_age
    check (date_of_birth is null or date_of_birth <= (current_date - interval '18 years'));

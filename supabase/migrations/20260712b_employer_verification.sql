-- Employer verification (SSM registration number + admin review queue),
-- mirroring the existing KYC review pattern (profiles.kyc_level).
--
-- profiles_owner_write (20260628_profiles.sql / 20260704e patch) is a
-- row-level "for all" policy with no column restriction, so an employer
-- could otherwise self-stamp employer_verification_status='verified' via a
-- direct REST call (same bug class flagged today in the stranded
-- cancellation-payout review). A BEFORE INSERT OR UPDATE trigger closes
-- that off: only an admin JWT may set the status column, on either an
-- upsert-as-insert (the client-side profile-creation path at registration
-- is an upsert, which resolves to INSERT for a brand-new row) or a plain
-- UPDATE. A non-admin's own ssm_number edit is allowed to auto-promote the
-- row to pending_review from any non-admin-set status (including a prior
-- 'verified' — changing the registration number re-triggers review rather
-- than silently keeping the old verified badge), but never straight to
-- verified.

alter table public.profiles
  add column if not exists ssm_number text,
  add column if not exists employer_verification_status text not null default 'unverified'
    check (employer_verification_status in ('unverified', 'pending_review', 'verified', 'rejected'));

alter table public.profiles
  add constraint profiles_ssm_number_length
    check (ssm_number is null or char_length(trim(ssm_number)) between 5 and 30);

create or replace function public.guard_employer_verification_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  prior_status text := case when tg_op = 'INSERT' then 'unverified' else old.employer_verification_status end;
  prior_ssm text := case when tg_op = 'INSERT' then null else old.ssm_number end;
begin
  if is_admin then
    return new;
  end if;

  -- Non-admin callers can never set the status column directly, whether
  -- via UPDATE or via an upsert that resolves to INSERT.
  new.employer_verification_status := prior_status;

  -- Submitting/changing a non-blank SSM number re-queues the row for
  -- review, regardless of its previous status. It never jumps to verified.
  if new.ssm_number is distinct from prior_ssm
     and char_length(trim(coalesce(new.ssm_number, ''))) > 0 then
    new.employer_verification_status := 'pending_review';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_verification_status on public.profiles;
create trigger profiles_guard_verification_status
before insert or update on public.profiles
for each row execute function public.guard_employer_verification_status();

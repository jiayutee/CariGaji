-- Tell people why. An admin rejecting an ID check or a company registration
-- used to leave the worker/employer with a generic message and no idea what
-- to fix. The admin now has to give a reason (required in the confirm dialog),
-- it's stored here, and the person sees it on their profile / verification
-- banner. Approving clears it.
--
-- Shown only while it still applies: the worker sees it while kyc_level is
-- 'Basic' (resubmitting moves them to 'pending_review'); the employer sees it
-- while employer_verification_status is 'rejected' (resubmitting re-queues
-- them via guard_employer_verification_status).

alter table public.profiles
  add column if not exists kyc_rejection_reason text,
  add column if not exists employer_rejection_reason text;

-- Same guard as is_test_account / is_demo_account (20261013, 20261013c):
-- end users can read their own reason but must not be able to rewrite it.
-- Reproduced from the live definition with only the two new fields added.
create or replace function public.guard_profile_test_account_flag()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    if new.is_test_account is distinct from old.is_test_account then
      new.is_test_account := old.is_test_account;
    end if;
    if new.is_demo_account is distinct from old.is_demo_account then
      new.is_demo_account := old.is_demo_account;
    end if;
    if new.kyc_rejection_reason is distinct from old.kyc_rejection_reason then
      new.kyc_rejection_reason := old.kyc_rejection_reason;
    end if;
    if new.employer_rejection_reason is distinct from old.employer_rejection_reason then
      new.employer_rejection_reason := old.employer_rejection_reason;
    end if;
  end if;
  return new;
end;
$$;

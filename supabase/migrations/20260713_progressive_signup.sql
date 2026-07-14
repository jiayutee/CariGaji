-- Progressive sign-up: registration is now just role + email + password.
-- The remaining details (name, phone, ID, DOB, address; company name + SSM
-- for employers) move to a mandatory post-T&C DetailsGateModal, and a
-- one-time WelcomeIntroModal shows a brief how-to after that. Both gates
-- follow the same tri-state pattern as profiles.tnc_accepted_at:
-- null = not done yet (gate fires), timestamp = done.
--
-- KYC document uploads are deliberately deferrable (owner decision) — a
-- worker can complete text details and upload documents later via a
-- reminder banner; kyc_level simply stays at its default until they do.

alter table public.profiles
  add column if not exists details_completed_at timestamptz,
  add column if not exists intro_seen_at timestamptz;

-- Every existing account predates this feature and registered via the old
-- full-details form — mark both gates as already satisfied so nobody who
-- already went through the long form gets re-prompted.
update public.profiles set details_completed_at = now() where details_completed_at is null;
update public.profiles set intro_seen_at = now() where intro_seen_at is null;

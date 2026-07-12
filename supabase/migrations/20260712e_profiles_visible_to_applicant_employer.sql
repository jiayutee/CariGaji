-- Bug: "Cannot see all worker names in applicant pool. They all only appear
-- as 'worker'." Root cause: 20260702_harden_profiles_kyc_visibility.sql hides
-- any profile with kyc_level = 'pending_review' from every authenticated user
-- except the owner/admin — but assignKYCLevel() (carigaji-app.jsx) sets
-- kyc_level = 'pending_review' for any worker who actually uploaded their
-- MyKad + selfie at registration (the common case for a real, verifying
-- user). So the more legitimate a worker's signup, the less visible their
-- name becomes to an employer reviewing their application — backwards from
-- intent, and exactly what the bug report describes.
--
-- Fix: add a narrow policy letting an employer read the (already
-- non-sensitive: full_name, kyc_level, reliability_score, rating) profile
-- columns of a worker who has actually applied to one of their shifts,
-- regardless of KYC review status. General public/other-worker visibility of
-- pending_review profiles is unchanged.

drop policy if exists profiles_read_by_employer_of_applicant on public.profiles;
create policy profiles_read_by_employer_of_applicant
on public.profiles for select
to authenticated
using (
  exists (
    select 1 from public.applications a
    join public.shifts s on s.id = a.shift_id
    where a.worker_id = profiles.id
      and s.employer_id = auth.uid()
  )
);

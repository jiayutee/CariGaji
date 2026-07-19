-- SSM verification workaround (owner request 2026-07-19): no free public API
-- exists for automated SSM checks (SSM MyData / CTOS are paid, post-revenue),
-- so verification stays a manual admin step. To make that review meaningful,
-- employers can now upload their SSM registration certificate; the admin
-- Employer Queue shows it next to the number so the reviewer compares the
-- certificate, the company name, and the ssm-einfo.my record instead of
-- trusting a bare string.
--
-- The file lives in the existing private kyc-documents bucket under the
-- owner's "<uid>/..." folder — owner-write + admin-read policies from
-- 20260628_kyc_bucket_privacy.sql already cover it; no new storage policy.

alter table public.profiles
  add column if not exists ssm_document_path text;

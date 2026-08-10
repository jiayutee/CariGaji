-- Anonymous visitors browsing open shifts (public/pre-signup Discover feed,
-- see the `shifts` select in carigaji-app.jsx) get every employer shown as
-- the literal word "Employer" on every single card -- profiles has no
-- `to anon` RLS policy at all (correctly -- it holds KYC/banking-adjacent
-- data and this project has a real history of over-exposure incidents on
-- this exact table, see 20260702_harden_profiles_kyc_visibility.sql), so
-- the embedded `employer:profiles(...)` join in that query silently
-- resolves to null for anon and the UI falls back to a placeholder.
--
-- The result directly undermines the one thing a public job-marketplace
-- feed most needs to do before someone signs up: look like it has real,
-- vetted employers on it. Fix: a narrow, security-definer RPC that returns
-- ONLY the four fields already safe to show any authenticated user anyway
-- (full_name, reliability_score, rating, employer_verification_status) for
-- a batch of employer ids -- never the whole profiles row, never anything
-- KYC/banking-adjacent. Same shape as the existing get_ratee_ratings RPC.

create or replace function public.get_public_employer_trust_signals(p_employer_ids uuid[])
returns table (
  id uuid,
  full_name text,
  reliability_score int,
  rating numeric,
  employer_verification_status text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, full_name, reliability_score, rating, employer_verification_status
  from public.profiles
  where id = any(p_employer_ids)
    and role = 'employer';
$$;

grant execute on function public.get_public_employer_trust_signals(uuid[]) to anon, authenticated;

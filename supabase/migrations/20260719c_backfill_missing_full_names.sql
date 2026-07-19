-- "Applicant pool shows 'Worker' instead of the name" — third occurrence,
-- new root cause (2026-07-19). The RLS policy (20260712e) and the join are
-- fine (verified live with a probe application: name renders). The affected
-- worker rows simply have full_name null, which happens two ways:
--
-- 1. OAuth accounts: the client-side self-heal (July 12) only backfills
--    full_name from user_metadata when THAT user signs in on a build
--    containing the fix. Workers who haven't signed in since keep null.
--    -> Backfill server-side from auth.users metadata, for everyone at once.
--
-- 2. Progressive-signup accounts created after the slim register form
--    shipped but before 20260713's one-time backfill ran: that backfill
--    stamped details_completed_at on EVERY existing row, including
--    slim-form accounts that had never been asked their name. They sailed
--    past the details gate permanently with full_name null.
--    -> For rows that still have no name after step 1, un-stamp
--       details_completed_at so the mandatory details gate fires at next
--       sign-in and collects the legal name properly.
--
-- Neither step touches the columns pinned by the guard triggers
-- (rating/reliability_score/role/verification status), so no trigger
-- bypass is needed.

-- Step 1: server-side name backfill from auth metadata (OAuth providers
-- set full_name and/or name).
update public.profiles p
set full_name = trim(coalesce(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name'
    )),
    updated_at = now()
from auth.users u
where u.id = p.id
  and (p.full_name is null or btrim(p.full_name) = '')
  and btrim(coalesce(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name',
      '')) <> '';

-- Step 2: any account still nameless never actually completed the details
-- step — re-arm the gate so it collects the name at next sign-in.
update public.profiles
set details_completed_at = null,
    updated_at = now()
where (full_name is null or btrim(full_name) = '')
  and details_completed_at is not null;

-- Report what happened so the result is visible in the SQL editor.
do $$
declare
  v_nameless int;
begin
  select count(*) into v_nameless
  from public.profiles
  where full_name is null or btrim(full_name) = '';
  raise notice 'profiles still without a name (gate re-armed for them): %', v_nameless;
end $$;

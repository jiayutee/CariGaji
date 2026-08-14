-- Reset the two QA workers' reliability scores.
--
-- This is the THIRD time this reset has been attempted and the third time it
-- would silently do nothing, so the reason is worth writing down properly.
--
-- guard_profile_reputation_and_role pins reliability_score unless the caller
-- is admin OR a trusted-write flag is set. Its admin test is:
--
--     coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
--
-- In the Supabase SQL editor there is NO JWT. auth.jwt() returns null, so
-- is_admin is false. **The SQL editor is not "admin" as far as any of these
-- guards is concerned** -- it is a privileged Postgres session, which is a
-- completely different thing. I told the owner earlier that the reset "works
-- from the SQL editor because admin bypasses the guard". That was wrong.
--
-- Worse, this guard REASSIGNS rather than raising -- `new.reliability_score
-- := prior_reliability` -- so a blocked update reports success and changes
-- nothing. Two earlier attempts came back with no error and no effect.
--
-- The same reasoning explains why the shift purge needed applications deleted
-- first: guard_delete_of_booked_shift's admin exemption never applied in the
-- SQL editor either. That one at least failed loudly.
--
-- Fix: set the trusted-write flag the guard already recognises, in the same
-- transaction as the update. A DO block guarantees that -- set_config with
-- is_local = true is transaction-scoped, and a bare statement sequence in the
-- SQL editor would lose it in between.

do $reset$
begin
  perform set_config('app.reliability_trusted_write', 'true', true);

  update public.profiles
  set reliability_score = 100
  where id in (
    '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',  -- Test Worker One
    '1ad212f6-5f29-41cb-b60f-2c9159915ab6'   -- Test Worker Two
  );

  perform set_config('app.reliability_trusted_write', 'false', true);
end
$reset$;

-- Verify in the same script rather than trusting the update reported success,
-- which is exactly what went wrong twice already.
do $verify$
declare
  v_bad int;
begin
  select count(*) into v_bad
  from public.profiles
  where id in (
    '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',
    '1ad212f6-5f29-41cb-b60f-2c9159915ab6'
  )
  and reliability_score is distinct from 100;

  if v_bad > 0 then
    raise exception 'Reset did not take effect on % row(s) -- the guard is still pinning the value', v_bad;
  end if;

  raise notice 'reliability reset verified: both QA workers are at 100';
end
$verify$;

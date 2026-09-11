-- Lock complete_ended_shifts() to signed-in callers. Owner's decision,
-- 2026-09-12.
--
-- WHERE anon's EXECUTE ACTUALLY COMES FROM. There are two possible sources and
-- the first draft of this migration only handled one of them:
--
--   1. Postgres grants EXECUTE on every new function to PUBLIC by default. In
--      pg_proc.proacl that shows as `=X/postgres` -- an empty grantee. anon is
--      part of PUBLIC, so it inherits EXECUTE even with no grant of its own.
--   2. Supabase additionally sets default privileges granting EXECUTE to the
--      anon and authenticated roles EXPLICITLY, which shows as `anon=X/postgres`.
--
-- `revoke ... from anon` removes (2) and leaves (1). `revoke ... from public`
-- removes (1) and leaves (2). Either alone can leave anon still able to call
-- the function -- confirmed on a throwaway Postgres, where revoking from anon
-- alone left has_function_privilege('anon', ...) true via the PUBLIC grant.
--
-- 20260911 already did `revoke all ... from public`, so production's remaining
-- source is most likely (2). Revoking both costs nothing, is correct whichever
-- it is, and is harmless if one was already gone. authenticated keeps its own
-- explicit grant and is unaffected.
--
-- KNOWN CONSEQUENCE, accepted deliberately. The sweep is what marks an ended
-- shift 'completed', and Discover lists shifts on status = 'open'. With anon
-- unable to run it, a shift that has just ended stays visible to SIGNED-OUT
-- visitors until any signed-in user loads a portal. They cannot bid without
-- signing in, and signing in runs the sweep, so the window is short -- but it
-- is real, and it is what the anon grant was incidentally covering. A
-- client-side Discover filter on the last occurrence would make this
-- independent of who triggers the sweep; not done here, separate change.

revoke execute on function public.complete_ended_shifts() from public, anon;

-- Prove it took, rather than assuming. has_function_privilege reports the
-- EFFECTIVE privilege, including anything inherited via PUBLIC -- which is
-- exactly the case the first draft missed.
do $$
begin
  if has_function_privilege('anon', 'public.complete_ended_shifts()', 'EXECUTE') then
    raise exception 'REVOKE FAILED: anon can still execute complete_ended_shifts()';
  end if;
  if not has_function_privilege('authenticated', 'public.complete_ended_shifts()', 'EXECUTE') then
    raise exception 'REVOKE WENT TOO FAR: authenticated can no longer execute complete_ended_shifts(), which both portals call on load';
  end if;
  raise notice 'complete_ended_shifts(): anon REVOKED, authenticated still granted.';
end $$;

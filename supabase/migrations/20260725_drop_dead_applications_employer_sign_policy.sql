-- Owner-approved cleanup (backlog 3a1d2ab0-50d9-819f, consolidated in the
-- 2026-07-24 Telegram reminder as item 11).
--
-- applications_employer_sign (20260630, re-declared 20260703b) is
-- structurally dead: its USING clause requires status = 'accepted' AND
-- employer_signed_at IS NULL, but employer_signed_at is only ever written
-- once, at makeOffer() (carigaji-app.jsx), during the status='offered'
-- transition -- BEFORE the worker accepts. It is never reset to null
-- afterward, so by the time status reaches 'accepted', employer_signed_at
-- is already non-null and the policy's condition can never be satisfied.
--
-- No client code path relies on this policy (confirmed via static analysis
-- of every write site touching employer_signed_at). Dropping it removes
-- dead surface area rather than leaving an RLS policy around that no longer
-- matches the app's real state machine -- exactly the kind of stale policy
-- that causes confusion in a future security review.

drop policy if exists applications_employer_sign on public.applications;

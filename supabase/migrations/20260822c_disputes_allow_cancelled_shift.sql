-- Let a dispute be filed on a CANCELLED shift, not only a completed one.
--
-- Why this is blocking: cancellation compensation pays a booked, signed worker
-- 50% (or 100% if they show up). If that payout is wrong, late, or never
-- arrives, the worker's only recourse in the product is the Dispute button --
-- and disputes_owner_insert requires `s.status = 'completed'`, so filing one on
-- a cancelled shift is refused by RLS. The compensation flow therefore has no
-- route to escalate the exact failure it is most likely to produce.
--
-- Regenerated 2026-08-22. A version of this was drafted and sent over Telegram
-- on Day 53 and never landed in the repo, so it could not be reviewed, diffed
-- or re-run. This one is patched from 20260725j's policy text programmatically
-- rather than retyped: hand-copying a policy in this project has already
-- silently dropped a guard once (see create_cancellation_payout, 20260817).
--
-- WHAT CHANGES, precisely:
--   before:  s.status = 'completed'
--   after:   s.status = 'completed'
--            OR (s.status = 'cancelled' AND the application was accepted
--                AND the worker had signed)
-- Nothing else in the policy moves. The read and admin policies are untouched.
--
-- The 'accepted AND signed' requirement on the cancelled branch is a deliberate
-- narrowing rather than a plain widening: without it, every pending or rejected
-- applicant on a cancelled shift could file a dispute about work they were
-- never booked for.
--
-- NOT VERIFIABLE FROM THE SQL EDITOR. auth.uid() is NULL in a direct database
-- session, so any in-migration self-test of an RLS policy would pass or fail for
-- the wrong reason. Verify through PostgREST with a real worker token instead --
-- ask Claude to run the live check after this is applied.

drop policy if exists disputes_owner_insert on public.disputes;

create policy disputes_owner_insert
  on public.disputes for insert to authenticated
  with check (
    auth.uid() = filed_by
    and exists (
      select 1 from public.applications a
      join public.shifts s on s.id = a.shift_id
      where a.id = application_id
        and (a.worker_id = auth.uid() or s.employer_id = auth.uid())
        and (
          -- unchanged: any party to a completed shift
          s.status = 'completed'
          -- new: a cancelled shift, but only for a worker who was actually
          -- booked AND had signed. That is exactly who create_cancellation_payout
          -- pays, so it is exactly who can be short-changed by one. A pending or
          -- rejected applicant was never owed anything by a cancellation and has
          -- nothing to dispute.
          or (
            s.status = 'cancelled'
            and a.status = 'accepted'
            and a.worker_signed_at is not null
          )
        )
    )
  );

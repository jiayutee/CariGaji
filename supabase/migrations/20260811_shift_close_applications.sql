-- Employers currently have no way to stop taking new applications early --
-- a shift stays status='open' (and keeps accepting bids) until either its
-- headcount fills automatically or the employer cancels it outright. There
-- is no time-based cutoff anywhere in this schema (confirmed: no pg_cron
-- job, no trigger on start_at) -- applications stay open indefinitely,
-- right up to shift start, unless one of those two things happens.
--
-- Adds a third, distinct option: 'closed' -- stop taking new applications
-- (new INSERTs into applications already require shift.status = 'open' per
-- the existing applications_worker_insert policy, so this alone blocks new
-- bids with no further RLS change needed) while leaving the shift itself
-- on, existing applicants unaffected, and the employer free to keep
-- reviewing/shortlisting/offering to whoever already applied. Distinct from
-- 'cancelled', which calls off the shift entirely and triggers the
-- late-cancellation payout flow for already-confirmed workers -- closing
-- applications has no payout side effects at all.

alter table public.shifts drop constraint if exists shifts_status_check;
alter table public.shifts add constraint shifts_status_check
  check (status in ('draft','open','filled','closed','completed','cancelled'));

-- Existing applicants (and anyone with a live application on the shift)
-- still need read access once it leaves 'open' -- same reasoning that
-- already put 'filled' and 'completed' in this policy.
drop policy if exists shifts_read_open on public.shifts;
create policy shifts_read_open
  on public.shifts for select to authenticated
  using (status in ('open','filled','closed','completed'));

-- ── application deadline (set at post time, optional) ───────────────────────
-- Companion to the manual close button above: an employer can pre-schedule
-- when applications stop, instead of having to remember to come back and
-- close them by hand. Nullable -- shifts without one behave exactly as
-- before (open until filled or manually closed/cancelled).
--
-- No pg_cron job flips shifts.status when this passes (none exists anywhere
-- in this schema yet -- see the note this migration's header references),
-- so this is enforced the same durable way shift.status='open' already is:
-- directly in the applications_worker_insert RLS check, not just a client
-- side hint. A shift can sit displayed as "open" past its deadline (a
-- purely cosmetic staleness the same as any other status here), but no new
-- bid can land after it regardless.
alter table public.shifts add column if not exists applications_close_at timestamptz;

drop policy if exists applications_worker_insert on public.applications;
create policy applications_worker_insert
  on public.applications for insert to authenticated
  with check (
    auth.uid() = worker_id
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id
        and s.status = 'open'
        and (s.applications_close_at is null or now() < s.applications_close_at)
    )
  );

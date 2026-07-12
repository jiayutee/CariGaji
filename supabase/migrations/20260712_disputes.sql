-- Disputes: file-a-dispute flow for completed shifts.
-- v1 scope: informational only. Disputes do NOT hold, block, or interact
-- with payouts in any way (no payout_item linkage). Evidence is text-only
-- (category + description) — no file/photo upload in this pass.
-- Run in Supabase SQL Editor after 20260629_shifts_and_applications.sql

-- ── disputes ─────────────────────────────────────────────────────────────────
create table if not exists public.disputes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  filed_by       uuid not null references auth.users(id) on delete cascade,
  filed_by_role  text not null check (filed_by_role in ('worker','employer')),
  category       text not null check (category in ('hours_disputed','no_show_claim','unsafe_conditions','payment_issue','other')),
  description    text not null,
  status         text not null default 'open' check (status in ('open','under_review','resolved','dismissed')),
  admin_notes    text,
  resolved_at    timestamptz,
  resolved_by    uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

-- ── RLS — disputes ───────────────────────────────────────────────────────────
alter table public.disputes enable row level security;

drop policy if exists disputes_owner_insert on public.disputes;
drop policy if exists disputes_owner_read   on public.disputes;
drop policy if exists disputes_admin_all    on public.disputes;

-- A dispute may only be filed by the worker or employer on an application
-- whose shift has already been marked 'completed'.
create policy disputes_owner_insert
  on public.disputes for insert to authenticated
  with check (
    auth.uid() = filed_by
    and exists (
      select 1 from public.applications a
      join public.shifts s on s.id = a.shift_id
      where a.id = application_id
        and s.status = 'completed'
        and (a.worker_id = auth.uid() or s.employer_id = auth.uid())
    )
  );

-- Both parties on the linked application can see all disputes tied to it,
-- not just the ones they personally filed — matches how both already see
-- the shared `applications` row.
create policy disputes_owner_read
  on public.disputes for select to authenticated
  using (
    exists (
      select 1 from public.applications a
      join public.shifts s on s.id = a.shift_id
      where a.id = application_id
        and (a.worker_id = auth.uid() or s.employer_id = auth.uid())
    )
  );

-- Disputes are immutable once filed by non-admins — no update policy for
-- the filer. Only admin can change status/admin_notes/resolved_*.
create policy disputes_admin_all
  on public.disputes for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

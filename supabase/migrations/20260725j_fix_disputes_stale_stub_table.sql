-- Same drift bug as 20260725i (ratings), found in the same live QA pass:
-- an even older stub `disputes` table already existed (id, raised_by,
-- reason, description, status, resolved_at, resolved_by — confirmed via
-- REST column probing, PostgREST's own error even suggested "did you mean
-- disputes.raised_by" when the app's actual column filed_by was queried;
-- 0 rows) predating 20260712_disputes.sql's real schema. That migration's
-- `create table if not exists` silently no-op'd against it, so
-- application_id/filed_by/filed_by_role/category/admin_notes/created_at
-- were never added and every dispute-filing attempt in the live app has
-- been failing since 2026-07-12 — this has been broken far longer than
-- the ratings feature was.
--
-- Fix: the stub has zero rows, safe to drop and recreate with
-- 20260712_disputes.sql's correct schema.

drop table if exists public.disputes cascade;

create table public.disputes (
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

alter table public.disputes enable row level security;

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

create policy disputes_admin_all
  on public.disputes for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

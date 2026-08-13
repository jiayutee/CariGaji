-- In-app issue reporting for the launch phase.
--
-- Purpose: during first-phase launch the owner needs problems to arrive
-- attached to WHO hit them and WHERE, not as a screenshot in a WhatsApp
-- message. Support chat already exists for conversations; this is for
-- "something is broken", captured with enough context to reproduce.
--
-- Deliberately minimal -- no threading, no assignment, no SLA. It is a
-- capture surface, not a helpdesk. Triage happens in the admin portal.

create table if not exists public.issue_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  -- Captured at submit time rather than joined later: a reporter's role can
  -- change, and what matters is which hat they were wearing when it broke.
  reporter_role text,
  category     text not null default 'other'
                 check (category in ('bug','confusing','missing','payment','account','other')),
  severity     text not null default 'normal'
                 check (severity in ('blocking','normal','minor')),
  description  text not null check (length(trim(description)) > 0),
  -- Context the reporter should not have to describe. Without these, a report
  -- reading "the button does nothing" is unactionable.
  page_context text,
  user_agent   text,
  app_version  text,
  status       text not null default 'new'
                 check (status in ('new','investigating','resolved','wont_fix','duplicate')),
  admin_note   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists issue_reports_status_created_idx
  on public.issue_reports (status, created_at desc);

alter table public.issue_reports enable row level security;

-- Anyone signed in may report. user_id is pinned to the caller so a report
-- cannot be filed in someone else's name.
drop policy if exists issue_reports_insert_own on public.issue_reports;
create policy issue_reports_insert_own
  on public.issue_reports for insert to authenticated
  with check (auth.uid() = user_id);

-- Reporters can see their own reports and the admin's reply -- otherwise
-- reporting feels like shouting into a void, and people stop doing it.
drop policy if exists issue_reports_read_own on public.issue_reports;
create policy issue_reports_read_own
  on public.issue_reports for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists issue_reports_admin_all on public.issue_reports;
create policy issue_reports_admin_all
  on public.issue_reports for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Reporters must NOT be able to edit status/admin_note on their own rows.
-- There is no UPDATE policy for them at all, so the read policy above is
-- read-only in practice -- but a guard makes that explicit and survives
-- anyone adding an update policy later.
create or replace function public.guard_issue_report_triage_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
begin
  if is_admin then
    return new;
  end if;
  new.status := old.status;
  new.admin_note := old.admin_note;
  return new;
end;
$$;

drop trigger if exists trg_guard_issue_report_triage on public.issue_reports;
create trigger trg_guard_issue_report_triage
before update on public.issue_reports
for each row execute function public.guard_issue_report_triage_columns();

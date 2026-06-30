-- Shifts and applications tables for the CariGaji core marketplace loop.
-- Run in Supabase SQL Editor after 20260629_profiles_admin_write.sql

-- ── shifts ───────────────────────────────────────────────────────────────────
create table if not exists public.shifts (
  id           uuid primary key default gen_random_uuid(),
  employer_id  uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  category     text not null default 'Other'
                 check (category in ('F&B','Retail','Event','Logistics','Other')),
  location     text not null,
  dress_code   text,
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  wage_min     numeric(8,2) not null check (wage_min >= 0),
  wage_max     numeric(8,2) not null check (wage_max >= wage_min),
  headcount    int not null default 1 check (headcount >= 1),
  filled_count int not null default 0 check (filled_count >= 0),
  status       text not null default 'open'
                 check (status in ('draft','open','filled','completed','cancelled')),
  requirements jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── applications ─────────────────────────────────────────────────────────────
create table if not exists public.applications (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid not null references public.shifts(id) on delete cascade,
  worker_id  uuid not null references auth.users(id) on delete cascade,
  wage_ask   numeric(8,2) not null check (wage_ask >= 0),
  status     text not null default 'pending'
               check (status in ('pending','shortlisted','accepted','rejected','withdrawn')),
  applied_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shift_id, worker_id)
);

-- ── filled_count trigger ──────────────────────────────────────────────────────
create or replace function public.sync_shift_filled_count()
returns trigger language plpgsql security definer as $$
begin
  update public.shifts
  set filled_count = (
    select count(*) from public.applications
    where shift_id = coalesce(new.shift_id, old.shift_id)
      and status = 'accepted'
  ),
  updated_at = now()
  where id = coalesce(new.shift_id, old.shift_id);
  return null;
end;
$$;

drop trigger if exists trg_sync_filled_count on public.applications;
create trigger trg_sync_filled_count
after insert or update of status or delete on public.applications
for each row execute function public.sync_shift_filled_count();

-- ── RLS — shifts ─────────────────────────────────────────────────────────────
alter table public.shifts enable row level security;

drop policy if exists shifts_read_open          on public.shifts;
drop policy if exists shifts_employer_own_read  on public.shifts;
drop policy if exists shifts_employer_insert    on public.shifts;
drop policy if exists shifts_employer_update    on public.shifts;
drop policy if exists shifts_employer_delete    on public.shifts;
drop policy if exists shifts_admin_all          on public.shifts;

create policy shifts_read_open
  on public.shifts for select to authenticated
  using (status in ('open','filled','completed'));

create policy shifts_employer_own_read
  on public.shifts for select to authenticated
  using (auth.uid() = employer_id);

create policy shifts_employer_insert
  on public.shifts for insert to authenticated
  with check (auth.uid() = employer_id);

create policy shifts_employer_update
  on public.shifts for update to authenticated
  using  (auth.uid() = employer_id)
  with check (auth.uid() = employer_id);

create policy shifts_employer_delete
  on public.shifts for delete to authenticated
  using (auth.uid() = employer_id);

create policy shifts_admin_all
  on public.shifts for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ── RLS — applications ────────────────────────────────────────────────────────
alter table public.applications enable row level security;

drop policy if exists applications_worker_read    on public.applications;
drop policy if exists applications_employer_read  on public.applications;
drop policy if exists applications_worker_insert  on public.applications;
drop policy if exists applications_worker_update  on public.applications;
drop policy if exists applications_employer_update on public.applications;
drop policy if exists applications_admin_all      on public.applications;

create policy applications_worker_read
  on public.applications for select to authenticated
  using (auth.uid() = worker_id);

create policy applications_employer_read
  on public.applications for select to authenticated
  using (exists (
    select 1 from public.shifts s
    where s.id = shift_id and s.employer_id = auth.uid()
  ));

create policy applications_worker_insert
  on public.applications for insert to authenticated
  with check (
    auth.uid() = worker_id
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id and s.status = 'open'
    )
  );

create policy applications_worker_update
  on public.applications for update to authenticated
  using  (auth.uid() = worker_id and status = 'pending')
  with check (auth.uid() = worker_id and status = 'withdrawn');

create policy applications_employer_update
  on public.applications for update to authenticated
  using (exists (
    select 1 from public.shifts s
    where s.id = shift_id and s.employer_id = auth.uid()
  ))
  with check (
    status in ('shortlisted','accepted','rejected')
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id and s.employer_id = auth.uid()
    )
  );

create policy applications_admin_all
  on public.applications for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

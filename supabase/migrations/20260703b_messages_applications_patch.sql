-- Patch: the live `messages` table pre-existed with a partial structure, so
-- `create table if not exists` in 20260630 skipped it and never added the
-- newer columns. Same for the contract-signing columns on `applications`.
-- This adds the missing columns explicitly (nullable, safe on existing rows)
-- and (re)applies the RLS policies. Fully idempotent.

-- ── messages: add missing columns ───────────────────────────────────────────
alter table public.messages
  add column if not exists shift_id     uuid references public.shifts(id) on delete cascade,
  add column if not exists recipient_id uuid references auth.users(id) on delete cascade,
  add column if not exists read_at      timestamptz,
  add column if not exists created_at   timestamptz not null default now();

create index if not exists messages_shift_id_idx   on public.messages(shift_id);
create index if not exists messages_created_at_idx on public.messages(created_at);

alter table public.messages enable row level security;

drop policy if exists messages_participant_read   on public.messages;
drop policy if exists messages_participant_insert on public.messages;
drop policy if exists messages_sender_update       on public.messages;
drop policy if exists messages_admin_all           on public.messages;

create policy messages_participant_read
  on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

create policy messages_participant_insert
  on public.messages for insert to authenticated
  with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.applications a
      join public.shifts s on s.id = a.shift_id
      where a.shift_id = shift_id
        and a.status   = 'accepted'
        and (
          (a.worker_id = auth.uid() and s.employer_id = recipient_id)
          or
          (s.employer_id = auth.uid() and a.worker_id = recipient_id)
        )
    )
  );

create policy messages_sender_update
  on public.messages for update to authenticated
  using  (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

create policy messages_admin_all
  on public.messages for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ── applications: contract-signing columns ──────────────────────────────────
alter table public.applications
  add column if not exists worker_signed_at   timestamptz,
  add column if not exists employer_signed_at timestamptz,
  add column if not exists contract_html      text;

drop policy if exists applications_worker_sign on public.applications;
create policy applications_worker_sign
  on public.applications for update to authenticated
  using  (auth.uid() = worker_id and status = 'accepted' and worker_signed_at is null)
  with check (auth.uid() = worker_id and worker_signed_at is not null);

drop policy if exists applications_employer_sign on public.applications;
create policy applications_employer_sign
  on public.applications for update to authenticated
  using (
    status = 'accepted'
    and employer_signed_at is null
    and exists (select 1 from public.shifts s where s.id = shift_id and s.employer_id = auth.uid())
  )
  with check (
    employer_signed_at is not null
    and exists (select 1 from public.shifts s where s.id = shift_id and s.employer_id = auth.uid())
  );

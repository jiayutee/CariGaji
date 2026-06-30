-- Chat messages between employer and accepted worker for a specific shift.
-- Contract signing timestamps on applications.

-- ── messages ─────────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references public.shifts(id) on delete cascade,
  sender_id    uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  content      text not null check (char_length(content) between 1 and 2000),
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists messages_shift_id_idx on public.messages(shift_id);
create index if not exists messages_created_at_idx on public.messages(created_at);

alter table public.messages enable row level security;

-- Only sender or recipient may read a message
drop policy if exists messages_participant_read  on public.messages;
drop policy if exists messages_participant_insert on public.messages;
drop policy if exists messages_sender_update      on public.messages;
drop policy if exists messages_admin_all          on public.messages;

create policy messages_participant_read
  on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- Sender may only insert messages where they are one of the two participants
-- AND an accepted application exists linking sender and recipient on that shift
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

-- Only recipient may mark a message as read (update read_at)
create policy messages_sender_update
  on public.messages for update to authenticated
  using  (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

create policy messages_admin_all
  on public.messages for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ── contract signing RLS fixes ───────────────────────────────────────────────
-- Worker can sign their own accepted application (set worker_signed_at once)
drop policy if exists applications_worker_sign on public.applications;
create policy applications_worker_sign
  on public.applications for update to authenticated
  using  (auth.uid() = worker_id and status = 'accepted' and worker_signed_at is null)
  with check (auth.uid() = worker_id and worker_signed_at is not null);

-- Employer can sign (set employer_signed_at) on accepted applications for their shifts
drop policy if exists applications_employer_sign on public.applications;
create policy applications_employer_sign
  on public.applications for update to authenticated
  using (
    status = 'accepted'
    and employer_signed_at is null
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id and s.employer_id = auth.uid()
    )
  )
  with check (
    employer_signed_at is not null
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id and s.employer_id = auth.uid()
    )
  );

-- ── address_visibility on shifts ─────────────────────────────────────────────
alter table public.shifts
  add column if not exists address_visibility text not null default 'public'
    check (address_visibility in ('public', 'accepted_only'));

-- ── contract signing on applications ─────────────────────────────────────────
alter table public.applications
  add column if not exists worker_signed_at    timestamptz,
  add column if not exists employer_signed_at  timestamptz,
  add column if not exists contract_html       text;

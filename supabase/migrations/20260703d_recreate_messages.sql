-- The live `messages` table had drifted badly from the intended schema
-- (extra NOT NULL application_id, missing shift_id/recipient_id/read_at/
-- created_at). It is empty (0 rows), so recreate it cleanly to match the
-- app and the 20260630 migration. Safe: no data to lose.

drop table if exists public.messages cascade;

create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references public.shifts(id) on delete cascade,
  sender_id    uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  content      text not null check (char_length(content) between 1 and 2000),
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

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

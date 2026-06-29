-- Telegram bot command queue.
-- Edge Function writes here on receipt; orchestrator reads + deletes processed rows.

create table if not exists public.bot_commands (
  id uuid primary key default gen_random_uuid(),
  command text not null,
  args text,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.bot_commands enable row level security;

-- Only service-role (Edge Function) and admins may read/write.
create policy bot_commands_admin_rw
on public.bot_commands for all
to authenticated
using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

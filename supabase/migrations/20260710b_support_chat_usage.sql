-- Per-user, per-day message counter for the support-chat Edge Function.
-- Groq's free tier is shared across every CariGaji user, so this caps how
-- much of it any single account can consume in a day (prevents abuse/cost
-- blowup from one account). Only the Edge Function (service role) ever
-- reads/writes this table — no client-facing RLS policies needed, so with
-- RLS enabled and zero policies it's fully locked to regular clients while
-- the service role (which bypasses RLS) still has full access.
create table if not exists public.support_chat_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  message_count int not null default 0,
  primary key (user_id, day)
);

alter table public.support_chat_usage enable row level security;

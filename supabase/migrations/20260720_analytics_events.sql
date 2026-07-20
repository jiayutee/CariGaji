-- Basic analytics: page views, sign-ups, bids placed.
-- Insert is open to anon + authenticated (page views happen pre-login), but a
-- caller can never forge another user's user_id. Read is admin-only via the
-- house app_metadata.role pattern (see 20260627_admin_rls_policies.sql).
--
-- IMPORTANT: the select policy below must never reference another table.
-- 20260717i/j showed that cross-table RLS policies on hot paths can recurse
-- ("infinite recursion detected in policy") and break all reads live. This
-- table stays single-table-only by design.

create table if not exists public.analytics_events (
  id         uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('page_view', 'sign_up', 'bid_placed')),
  user_id    uuid references auth.users(id) on delete set null,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_type_created_idx
  on public.analytics_events(event_type, created_at);

alter table public.analytics_events enable row level security;

drop policy if exists analytics_events_insert on public.analytics_events;
create policy analytics_events_insert
on public.analytics_events
for insert
to authenticated, anon
with check (user_id is null or user_id = auth.uid());

drop policy if exists analytics_events_admin_select on public.analytics_events;
create policy analytics_events_admin_select
on public.analytics_events
for select
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Server-side aggregation for the admin overview card. SECURITY INVOKER
-- (the default — no "security definer" here), so RLS is enforced exactly as
-- it would be for a direct select: a non-admin caller gets zero rows back,
-- no separate admin check needed inside the function. Aggregating here
-- avoids pulling raw rows to the client, which would silently under-count
-- once volume passes PostgREST's default row cap.
create or replace function public.analytics_event_counts(since timestamptz)
returns table(event_type text, count bigint)
language sql
stable
as $$
  select event_type, count(*) as count
  from public.analytics_events
  where created_at >= since
  group by event_type
  order by count desc;
$$;

grant execute on function public.analytics_event_counts(timestamptz) to authenticated;

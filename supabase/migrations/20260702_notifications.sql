-- In-app notifications for bid received / bid accepted / bid rejected events.
-- Run in Supabase SQL Editor after 20260629_shifts_and_applications.sql

-- ── notifications ────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null
               check (type in ('bid_received','bid_accepted','bid_rejected')),
  title      text not null,
  body       text,
  link       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_unread_recent
  on public.notifications (user_id, read, created_at desc);

-- ── bid received trigger ────────────────────────────────────────────────────
create or replace function public.notify_bid_received()
returns trigger language plpgsql security definer as $$
declare
  v_employer_id uuid;
  v_shift_title text;
begin
  select employer_id, title into v_employer_id, v_shift_title
  from public.shifts
  where id = new.shift_id;

  if v_employer_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_employer_id,
      'bid_received',
      'New bid received',
      'Someone applied for "' || coalesce(v_shift_title, 'your shift') || '".',
      '/employer/shifts/' || new.shift_id
    );
  end if;

  return null;
end;
$$;

drop trigger if exists trg_notify_bid_received on public.applications;
create trigger trg_notify_bid_received
after insert on public.applications
for each row execute function public.notify_bid_received();

-- ── bid accepted/rejected trigger ───────────────────────────────────────────
create or replace function public.notify_bid_status_change()
returns trigger language plpgsql security definer as $$
declare
  v_shift_title text;
begin
  select title into v_shift_title
  from public.shifts
  where id = new.shift_id;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    new.worker_id,
    case when new.status = 'accepted' then 'bid_accepted' else 'bid_rejected' end,
    case when new.status = 'accepted' then 'Bid accepted' else 'Bid rejected' end,
    case
      when new.status = 'accepted' then 'Your bid for "' || coalesce(v_shift_title, 'a shift') || '" was accepted.'
      else 'Your bid for "' || coalesce(v_shift_title, 'a shift') || '" was rejected.'
    end,
    '/worker/shifts/' || new.shift_id
  );

  return null;
end;
$$;

drop trigger if exists trg_notify_bid_status_change on public.applications;
create trigger trg_notify_bid_status_change
after update of status on public.applications
for each row
when (new.status is distinct from old.status and new.status in ('accepted','rejected'))
execute function public.notify_bid_status_change();

-- ── RLS — notifications ──────────────────────────────────────────────────────
alter table public.notifications enable row level security;

drop policy if exists notifications_owner_read   on public.notifications;
drop policy if exists notifications_owner_update on public.notifications;

create policy notifications_owner_read
  on public.notifications for select to authenticated
  using (auth.uid() = user_id);

create policy notifications_owner_update
  on public.notifications for update to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

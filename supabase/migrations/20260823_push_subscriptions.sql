-- Web Push: where a browser's push subscription lives.
--
-- One row per DEVICE, not per user: the same person on a phone and a laptop
-- has two endpoints and should get the notification on both. The endpoint URL
-- is the natural key -- the browser generates it, it is globally unique, and
-- re-subscribing on the same device returns the same endpoint, so upsert on it
-- rather than accumulating duplicates.
--
-- What is stored is what the Web Push protocol needs and nothing more:
--   endpoint  the push service URL the browser gave us (FCM, Mozilla, etc.)
--   p256dh    the client's public key, used to encrypt the payload
--   auth      the client's auth secret, same purpose
-- None of it identifies a person by itself, but the endpoint IS a stable
-- device identifier, so it is owner-scoped by RLS and deleted on sign-out.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- A user manages only their own device rows. The sender runs as service role,
-- which bypasses RLS, so no read policy is needed for it.
drop policy if exists push_subscriptions_owner_read on public.push_subscriptions;
create policy push_subscriptions_owner_read
  on public.push_subscriptions for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists push_subscriptions_owner_insert on public.push_subscriptions;
create policy push_subscriptions_owner_insert
  on public.push_subscriptions for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists push_subscriptions_owner_update on public.push_subscriptions;
create policy push_subscriptions_owner_update
  on public.push_subscriptions for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Deleting matters as much as creating: signing out on a shared or borrowed
-- phone must stop that device receiving the next person's notifications.
drop policy if exists push_subscriptions_owner_delete on public.push_subscriptions;
create policy push_subscriptions_owner_delete
  on public.push_subscriptions for delete to authenticated
  using (auth.uid() = user_id);

do $selftest$
declare
  v_user uuid;
  v_id uuid;
  v_out text;
  v_blocked boolean;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise notice 'self-test skipped: no auth users';
    return;
  end if;

  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (v_user, 'https://example.invalid/selftest', 'k', 'a')
    returning id into v_id;

    -- Re-subscribing on the same device must update, not duplicate.
    begin
      insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
      values (v_user, 'https://example.invalid/selftest', 'k2', 'a2');
      v_blocked := false;
    exception when unique_violation then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'ASSERT: a duplicate endpoint was accepted -- upsert cannot rely on the unique key';
    end if;

    raise exception using message = '__result__:passed';
  exception when others then
    v_out := case when sqlerrm like '__result__:%' then substr(sqlerrm, 12) else sqlerrm end;
  end;

  if v_out = 'passed' then
    if exists (select 1 from public.push_subscriptions where endpoint = 'https://example.invalid/selftest') then
      raise exception 'self-test row survived the rollback';
    end if;
    raise notice 'self-test passed: endpoint is unique, nothing left behind';
  elsif v_out like 'ASSERT: %' then
    raise exception 'push_subscriptions self-test FAILED -- %', substr(v_out, 9);
  else
    raise warning 'push_subscriptions self-test COULD NOT RUN: %', v_out;
    raise warning 'the table above is created but UNVERIFIED -- report this message';
  end if;
end
$selftest$;

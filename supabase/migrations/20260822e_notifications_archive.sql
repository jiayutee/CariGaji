-- Archive, not delete.
--
-- The backlog item is "users cannot clear their own notifications", and the
-- obvious reading is a DELETE policy. That is the wrong tool here. These rows
-- are a worker's record of what they were promised -- "RM108.00 is on its way",
-- "choose 50% or show up for 100%, reply before 14 Aug 03:49" -- and the product
-- has a disputes feature that such a record is evidence in. Handing the worker
-- a button that destroys their own evidence, silently and irreversibly, solves
-- clutter by creating a much worse failure: clear the cancellation notice, miss
-- the deadline, have nothing to point at.
--
-- It also contradicts a decision this codebase already made: notifications
-- deliberately OUTLIVE the shift they point at (see parseNotificationLink and
-- the tombstone rendering), because erasing a worker's copy quietly rewrites
-- their history.
--
-- So: dismissed_at hides a notification from the bell's inbox. The row stays,
-- the worker can still read it under Archived, and can put it back. Erasure at
-- the account level is unaffected and already handled -- user_id references
-- auth.users(id) on delete cascade.
--
-- No new RLS policy is needed: notifications_owner_update already permits a
-- user to update their own rows, and 20260822d's guard is what decides which
-- columns. That makes archive both safer AND smaller than the delete it
-- replaces.

alter table public.notifications
  add column if not exists dismissed_at timestamptz;

-- The bell's default query is "mine, not archived, newest first".
create index if not exists notifications_user_active_idx
  on public.notifications (user_id, created_at desc)
  where dismissed_at is null;

-- Widen the guard to let the new column move. Same whole-row diff as before, so
-- every other column stays frozen.
create or replace function public.guard_notification_columns()
returns trigger
language plpgsql
as $$
declare
  v_allowed text[] := array['read', 'dismissed_at'];
begin
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'notifications are read-only except for %: correct one by inserting a new notification, never by editing it',
      array_to_string(v_allowed, ', ');
  end if;
  return new;
end;
$$;

do $selftest$
declare
  v_user uuid;
  v_id uuid;
  v_blocked boolean;
  v_out text;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise notice 'self-test skipped: no auth users';
    return;
  end if;

  begin
    insert into public.notifications (user_id, type, title, body, link)
    values (v_user, 'bid_received', 'SELFTEST archive', 'body', '/x')
    returning id into v_id;

    update public.notifications set dismissed_at = now() where id = v_id;
    if not exists (select 1 from public.notifications where id = v_id and dismissed_at is not null) then
      raise exception 'ASSERT: archiving did not take';
    end if;

    -- restoring must work too, or archive is a one-way door with extra steps
    update public.notifications set dismissed_at = null where id = v_id;
    if exists (select 1 from public.notifications where id = v_id and dismissed_at is not null) then
      raise exception 'ASSERT: restore did not take';
    end if;

    -- and the guard must still hold
    begin
      update public.notifications set body = 'rewritten' where id = v_id;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'ASSERT: body rewrite was ALLOWED after widening the guard';
    end if;

    raise exception using message = '__result__:passed';
  exception when others then
    v_out := case when sqlerrm like '__result__:%' then substr(sqlerrm, 12) else sqlerrm end;
  end;

  if v_out = 'passed' then
    if exists (select 1 from public.notifications where title = 'SELFTEST archive') then
      raise exception 'self-test row survived the rollback';
    end if;
    raise notice 'self-test passed: archive + restore work, body still frozen, nothing left behind';
  elsif v_out like 'ASSERT: %' then
    raise exception 'notifications archive self-test FAILED -- %', substr(v_out, 9);
  else
    raise warning 'notifications archive self-test COULD NOT RUN: %', v_out;
    raise warning 'the change above is applied but UNVERIFIED -- report this message';
  end if;
end
$selftest$;

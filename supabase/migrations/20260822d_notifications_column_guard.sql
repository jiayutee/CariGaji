-- A user can currently rewrite their own notifications.
--
-- notifications_owner_update is scoped by ROW (auth.uid() = user_id) but not by
-- COLUMN, and Postgres RLS cannot restrict columns. So today any authenticated
-- worker can PATCH their own notification's title, body, link, type or
-- created_at through PostgREST:
--
--   PATCH /rest/v1/notifications?id=eq.<own row>
--   {"body": "RM800.00 is on its way."}
--
-- Nothing in the app does that -- the only two writes it makes are
-- {read: true} -- but the API is the surface, not the app. This matters here
-- more than it would elsewhere: notifications are the worker's record of what
-- they were promised ("RM108.00 is on its way", "reply before 14 Aug 03:49"),
-- the product has a disputes feature that such a record would be evidence in,
-- and an editable record is not evidence.
--
-- Fix: RLS decides WHICH ROWS, a trigger decides WHICH COLUMNS. Only `read`
-- may change. Everything else must arrive unchanged or the write is refused.
--
-- Deliberately NOT an admin exemption. Nothing server-side updates this table
-- (verified: no `update public.notifications` anywhere in the schema, and the
-- app makes exactly two calls, both {read: true}), so an exemption would only
-- widen what the guard is for. If a future flow needs to amend a notification,
-- it should insert a new one -- the same rule the wallet ledger follows.

-- Compares the whole row minus the columns a user is allowed to touch, rather
-- than listing the protected ones. A list would silently stop protecting any
-- column added later -- and this table has already grown `params` once since it
-- was created. Whatever the schema becomes, anything not named here is frozen.
create or replace function public.guard_notification_columns()
returns trigger
language plpgsql
as $$
declare
  v_allowed text[] := array['read'];
begin
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'notifications are read-only except for %: correct one by inserting a new notification, never by editing it',
      array_to_string(v_allowed, ', ');
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_column_guard on public.notifications;
create trigger notifications_column_guard
before update on public.notifications
for each row execute function public.guard_notification_columns();

-- Prove it, and prove the legitimate write still works. Rolled back at the end:
-- a stray self-test notification would sit in a real user's bell forever.
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
    values (v_user, 'bid_received', 'SELFTEST', 'original body', '/x')
    returning id into v_id;

    -- the write the app actually makes
    update public.notifications set read = true where id = v_id;

    -- the write this migration exists to stop
    begin
      update public.notifications set body = 'RM800.00 is on its way.' where id = v_id;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'ASSERT: body rewrite was ALLOWED';
    end if;

    begin
      update public.notifications set created_at = now() - interval '30 days' where id = v_id;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'ASSERT: created_at rewrite was ALLOWED';
    end if;

    raise exception using message = '__result__:passed';
  exception when others then
    v_out := case when sqlerrm like '__result__:%' then substr(sqlerrm, 12) else sqlerrm end;
  end;

  if v_out = 'passed' then
    if exists (select 1 from public.notifications where title = 'SELFTEST') then
      raise exception 'self-test row survived the rollback';
    end if;
    raise notice 'self-test passed: read flag still writable, every other column refused, nothing left behind';
  elsif v_out like 'ASSERT: %' then
    raise exception 'notification column guard self-test FAILED -- %', substr(v_out, 9);
  else
    raise warning 'notification column guard self-test COULD NOT RUN: %', v_out;
    raise warning 'the guard above is applied but UNVERIFIED -- report this message';
  end if;
end
$selftest$;

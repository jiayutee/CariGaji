-- Calls the send-notification-email Edge Function directly via pg_net on
-- every new row in public.notifications, instead of using the Dashboard's
-- Database Webhooks UI. The shared secret is read from Vault (set once via
-- SQL Editor — see the Edge Function's setup notes — never committed here).
--
-- Prerequisite (run in SQL Editor, NOT part of this file, before this migration):
--   select vault.create_secret('<your random secret>', 'webhook_secret');
-- Must match the WEBHOOK_SECRET you set with `supabase secrets set`.

create extension if not exists pg_net;

create or replace function public.notify_email_on_notification()
returns trigger language plpgsql security definer as $$
declare
  v_secret text;
  v_project_url text := 'https://eqxpskyymohghxgtykfr.supabase.co';
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'webhook_secret'
  limit 1;

  if v_secret is null then
    -- Vault secret not set up yet — skip silently rather than error every insert.
    return null;
  end if;

  perform net.http_post(
    url := v_project_url || '/functions/v1/send-notification-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    body := jsonb_build_object('record', to_jsonb(new))
  );

  return null;
end;
$$;

drop trigger if exists trg_notify_email_on_notification on public.notifications;
create trigger trg_notify_email_on_notification
after insert on public.notifications
for each row
execute function public.notify_email_on_notification();

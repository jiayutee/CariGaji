-- Superseded by the Dashboard Database Webhook (Database -> Webhooks),
-- which uses proper JWT auth and has built-in retry/observability —
-- the more robust option vs. the pg_net + shared-secret workaround.
-- Safe to run even if 20260705b_notification_email_trigger.sql was never
-- applied (all statements are IF EXISTS). Only removes the SQL-side
-- trigger/function; does not touch pg_net itself (harmless to leave enabled).

drop trigger if exists trg_notify_email_on_notification on public.notifications;
drop function if exists public.notify_email_on_notification();

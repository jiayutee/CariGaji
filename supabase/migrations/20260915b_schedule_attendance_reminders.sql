-- Run send_attendance_reminders() every 10 minutes (20260915). Until now the
-- project had no scheduler at all: complete_ended_shifts is called by the
-- client on load, which cannot deliver "remind them right after the shift, then
-- every 8 hours" to someone who is not looking at the app.
--
-- Bounded windows inside the function mean the first run cannot flood users
-- about old shifts; a dry run against production data on 2026-09-19 (rolled
-- back) would have sent 0 notifications.

create extension if not exists pg_cron;

do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'attendance-reminders') then
    perform cron.unschedule('attendance-reminders');
  end if;
  perform cron.schedule('attendance-reminders', '*/10 * * * *', 'select public.send_attendance_reminders()');
end $sched$;

-- The notifications table was never added to the supabase_realtime
-- publication (same missing-publication bug found and fixed for `messages`
-- in 20260705f). Confirmed via a live test: subscribed to postgres_changes
-- on notifications, triggered a real notify_shift_offer insert via an
-- accepted bid, and no event was delivered. This means NotificationBell's
-- "live" unread-count updates have never actually worked in real time --
-- new notifications only ever appeared after a manual refetch (page load
-- or switching tabs), never pushed live the way chat messages now are.
alter publication supabase_realtime add table public.notifications;

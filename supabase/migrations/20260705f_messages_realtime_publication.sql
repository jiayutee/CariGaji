-- The messages table was never added to the supabase_realtime publication,
-- so the app's postgres_changes subscription (used for live chat sync)
-- silently never fired for the receiving party — confirmed via a live test:
-- the channel subscribed successfully (status SUBSCRIBED) but no INSERT
-- event was ever delivered. This is why chat only ever "worked" for the
-- sender (via the client-side optimistic insert) and never synced live to
-- the other participant, who only saw new messages after a manual refresh.
alter publication supabase_realtime add table public.messages;

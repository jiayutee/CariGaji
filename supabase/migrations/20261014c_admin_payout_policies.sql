-- The admin payout tools could not see or touch payouts, and every signed-in
-- user could read the payout audit log. Found 2026-10-14 alongside
-- 20261014b (same class of bug: admin writes silently filtered to 0 rows).
--
-- payout_item: only worker-own and employer-own SELECT policies existed, so
-- the admin Payouts screen always read an empty queue, Release/Hold had
-- nothing to act on, the sidebar count was always 0, and the client-side
-- scheduler (src/lib/payouts/scheduler.js, run from the admin portal) could
-- not insert. Admins now get full access; worker/employer reads unchanged.
--
-- payout_audit: payout_audit_read_authenticated let ANY signed-in user read
-- every audit row (amount transitions, admin notes). Nothing outside admin
-- reads it, so it becomes admin-only.
--
-- Both tables were empty when this ran, so no data was exposed or lost.

drop policy if exists payout_item_admin_all on public.payout_item;
create policy payout_item_admin_all
  on public.payout_item for all
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

drop policy if exists payout_audit_read_authenticated on public.payout_audit;
drop policy if exists payout_audit_admin_all on public.payout_audit;
create policy payout_audit_admin_all
  on public.payout_audit for all
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

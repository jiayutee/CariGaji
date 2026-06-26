-- Admin write policies for payout_item and payout_audit.
-- Requires the user's app_metadata.role to be set to 'admin' in the Supabase Auth dashboard.
-- Example (Supabase dashboard > Authentication > Users > Edit user > app_metadata):
--   { "role": "admin" }

drop policy if exists payout_item_admin_rw on public.payout_item;
create policy payout_item_admin_rw
on public.payout_item
for all
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists payout_audit_admin_rw on public.payout_audit;
create policy payout_audit_admin_rw
on public.payout_audit
for all
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists payout_cycle_admin_rw on public.payout_cycle;
create policy payout_cycle_admin_rw
on public.payout_cycle
for all
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Tighten payout_cycle / payout_audit reads: previously any authenticated user
-- could read ALL cycles and the full audit log. Restrict to admins.

drop policy if exists payout_cycle_read_authenticated on public.payout_cycle;
drop policy if exists payout_cycle_read_admin on public.payout_cycle;
create policy payout_cycle_read_admin
on public.payout_cycle for select
to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists payout_audit_read_authenticated on public.payout_audit;
drop policy if exists payout_audit_read_admin on public.payout_audit;
create policy payout_audit_read_admin
on public.payout_audit for select
to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

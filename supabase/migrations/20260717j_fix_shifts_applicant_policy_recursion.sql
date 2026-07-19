-- HOTFIX for 20260717i: the shifts_read_by_applicant policy subqueried
-- public.applications directly, but several applications policies subquery
-- public.shifts back (employer-read, cancellation-expire, ...) — Postgres
-- detects the circular RLS evaluation and errors with "infinite recursion
-- detected in policy for relation applications", which broke ALL
-- authenticated shift + application reads (Discover empty, My Bids failing).
--
-- Fix: route the membership check through a SECURITY DEFINER function.
-- It runs as the table owner, which bypasses RLS on applications, so
-- evaluating the shifts policy no longer re-enters the applications
-- policies and the cycle is broken. The function exposes only a boolean
-- for (current user, one shift id) — no data leak.

create or replace function public.is_applicant_of_shift(p_shift_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.applications a
    where a.shift_id = p_shift_id
      and a.worker_id = auth.uid()
  );
$$;

revoke all on function public.is_applicant_of_shift(uuid) from public;
grant execute on function public.is_applicant_of_shift(uuid) to authenticated;

drop policy if exists shifts_read_by_applicant on public.shifts;
create policy shifts_read_by_applicant
  on public.shifts for select
  to authenticated
  using (public.is_applicant_of_shift(id));

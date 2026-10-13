-- Keep QA / test accounts' shifts out of the public Discover feed.
--
-- Before this, the only open shift a visitor saw on the live site was a QA
-- probe ("REAPPLY probe" by "Test Employer Two"). Test accounts are now
-- flagged, and the two "open shifts" read policies hide a flagged employer's
-- shifts from everyone who is not themselves a test account. Nothing else
-- changes for test accounts: the employer still reads its own shifts
-- (shifts_employer_own_read), applicants still read shifts they applied to
-- (shifts_read_by_applicant), admins still read everything
-- (shifts_admin_all), and test workers still see test shifts in Discover, so
-- QA flows keep working end to end.

alter table public.profiles
  add column if not exists is_test_account boolean not null default false;

-- Users can update their own profiles row, so stop them flipping the flag
-- either way. Separate trigger on purpose: the existing
-- guard_profile_reputation_and_role is left untouched (see lessons.md,
-- 2026-08-12, on hand-reproducing that function). Only end-user roles are
-- held back; the service role, migrations and admins can still set it.
create or replace function public.guard_profile_test_account_flag()
returns trigger
language plpgsql
as $$
begin
  if new.is_test_account is distinct from old.is_test_account
     and current_user in ('authenticated', 'anon')
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    new.is_test_account := old.is_test_account;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_test_account_flag on public.profiles;
create trigger trg_guard_profile_test_account_flag
  before update on public.profiles
  for each row execute function public.guard_profile_test_account_flag();

-- SECURITY DEFINER for the same reason as is_applicant_of_shift (20260717j):
-- a shifts policy must not read another RLS-protected table directly, or a
-- policy that reads back into shifts can recurse. Exposes one boolean only.
create or replace function public.is_test_account(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select p.is_test_account from public.profiles p where p.id = p_user_id),
    false
  );
$$;

revoke all on function public.is_test_account(uuid) from public;
grant execute on function public.is_test_account(uuid) to anon, authenticated;

drop policy if exists shifts_read_open_public on public.shifts;
create policy shifts_read_open_public
  on public.shifts for select
  to anon
  using (
    status = any (array['open', 'filled', 'completed']::shift_status[])
    and not public.is_test_account(employer_id)
  );

drop policy if exists shifts_read_open on public.shifts;
create policy shifts_read_open
  on public.shifts for select
  to authenticated
  using (
    status = any (array['open', 'filled', 'closed', 'completed']::shift_status[])
    and (
      not public.is_test_account(employer_id)
      or public.is_test_account(auth.uid())
    )
  );

-- QA fixtures: every +qa* address plus the mailinator self/sender tests.
-- Demo Staff / Demo Worker are deliberately NOT flagged: their shifts are the
-- intended public demo feed.
update public.profiles p
set is_test_account = true
from auth.users u
where u.id = p.id
  and (
    u.email like 'jiayutee97+qa%@gmail.com'
    or u.email like 'carigaji-selftest%@mailinator.com'
    or u.email like 'carigaji-sendertest%@mailinator.com'
  );

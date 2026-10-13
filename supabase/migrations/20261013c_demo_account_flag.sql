-- Mark the Demo Staff account so its shifts can stay visible to visitors but
-- are never offered to search engines (tasks/seo_plan.md, section on
-- JobPosting rules: markup for jobs that aren't real is a spam-policy
-- violation). Unlike is_test_account (20261013), this flag hides NOTHING:
-- Demo Staff's shifts are the intended public demo feed. It is read by the
-- future SEO edge Worker / sitemap through is_demo_account(), which emits
-- noindex and no JobPosting for these employers.

alter table public.profiles
  add column if not exists is_demo_account boolean not null default false;

-- One guard for both reputation-style flags users must not set on themselves.
-- Same function name and trigger as 20261013 so there is still exactly one
-- trigger; only end-user roles are held back, admins/service role/migrations
-- can set either flag.
create or replace function public.guard_profile_test_account_flag()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    if new.is_test_account is distinct from old.is_test_account then
      new.is_test_account := old.is_test_account;
    end if;
    if new.is_demo_account is distinct from old.is_demo_account then
      new.is_demo_account := old.is_demo_account;
    end if;
  end if;
  return new;
end;
$$;

-- profiles has no anon SELECT policy, so a signed-out reader (the edge Worker
-- on the anon key) can't see the column; expose one boolean per user instead.
-- SECURITY DEFINER for the same reason as is_test_account / is_applicant_of_shift.
create or replace function public.is_demo_account(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select p.is_demo_account from public.profiles p where p.id = p_user_id),
    false
  );
$$;

revoke all on function public.is_demo_account(uuid) from public;
grant execute on function public.is_demo_account(uuid) to anon, authenticated;

-- Demo Staff (memory: demo-accounts). By user id, not email: the account must
-- never be recreated, so its id is the stable handle.
update public.profiles
set is_demo_account = true
where id = '3446faa8-8601-4f22-8fec-5b9566a9601c';

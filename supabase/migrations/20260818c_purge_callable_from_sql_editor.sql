-- Make admin_purge_shift usable from the Supabase SQL editor, and clear the
-- last of the QA rows.
--
-- FOURTH instance of one root cause, and I had already written the lesson for
-- it in 20260818b: `auth.jwt()` is NULL in the SQL editor, so any check of the
-- form
--     coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
-- is FALSE there. I then wrote admin_purge_shift gated on exactly that and
-- told the owner to call it from the SQL editor, which raised 'Not authorized'.
--
-- The function was not wrong for its intended caller -- an admin using the app
-- goes through PostgREST with a real JWT and passes. It was wrong for the
-- caller who actually needed it.
--
-- Fix: also accept a direct privileged database session. PostgREST always
-- populates request.jwt.claims for API traffic, so an empty value means the
-- call did not arrive through the API at all -- it came from a psql/SQL-editor
-- connection, which is already privileged by definition. This widens nothing
-- for app users: an anon or authenticated request always carries claims, so
-- they still fall through to the admin check.

create or replace function public.admin_purge_shift(
  p_shift_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  -- No JWT claims at all => not an API request => a direct database session.
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  v_shift record;
  v_apps int;
  v_pending_payouts int;
begin
  if not (is_admin or is_direct_sql) then
    raise exception 'Not authorized';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to purge a shift';
  end if;

  select id, title, employer_id, status into v_shift
  from public.shifts where id = p_shift_id;

  if v_shift.id is null then
    raise exception 'Shift not found';
  end if;

  -- Money in flight is the hard stop. A payout that is queued or processing
  -- refers back to this application; deleting the row underneath it would
  -- leave a payment nobody can trace or reconcile.
  select count(*) into v_pending_payouts
  from public.payout_item p
  join public.applications a
    on a.id = (p.source_refs ->> 'application_id')::uuid
  where a.shift_id = p_shift_id
    and p.status not in ('paid', 'cancelled', 'failed');

  if v_pending_payouts > 0 then
    raise exception 'Cannot purge: % payout(s) for this shift are still outstanding. Settle or cancel them first.', v_pending_payouts;
  end if;

  select count(*) into v_apps from public.applications where shift_id = p_shift_id;

  raise warning 'admin_purge_shift: % ("%") by % (direct_sql=%) -- % application(s) -- reason: %',
    p_shift_id, coalesce(v_shift.title, '?'), coalesce(auth.uid()::text, 'sql-session'), is_direct_sql, v_apps, p_reason;

  -- Ratings reference the application and have no cascade of their own.
  delete from public.ratings
  where application_id in (select id from public.applications where shift_id = p_shift_id);

  -- Notifications have no FK to either table, so they never cascade.
  delete from public.notifications
  where link = '/worker/shifts/' || p_shift_id::text
     or link = '/employer/shifts/' || p_shift_id::text
     or link in (
       select '/worker/applications/' || a.id::text
       from public.applications a where a.shift_id = p_shift_id
     );

  -- Applications FIRST: guard_delete_of_booked_shift refuses while any of them
  -- is 'accepted', so removing them makes the shift delete below legitimate
  -- rather than exempt.
  delete from public.applications where shift_id = p_shift_id;

  delete from public.shifts where id = p_shift_id;

  return jsonb_build_object(
    'shift_id', p_shift_id,
    'title', v_shift.title,
    'applications_removed', v_apps,
    'reason', p_reason
  );
end;
$$;

revoke all on function public.admin_purge_shift(uuid, text) from public;
grant execute on function public.admin_purge_shift(uuid, text) to authenticated;

-- ── clear the last QA rows, and prove it worked ──────────────────────────────
do $cleanup$
declare
  v_ids uuid[] := array[
    '49caaa91-9fc8-460d-a63e-6e17180a7a9f',   -- "UI rate me"
    '59c1f395-bb78-4afe-94e3-fbe3bbee3ffc'    -- "UI no-show me"
  ]::uuid[];
  v_id uuid;
  v_left int;
begin
  foreach v_id in array v_ids loop
    if exists (select 1 from public.shifts where id = v_id) then
      perform public.admin_purge_shift(v_id, 'QA cleanup after UI verification');
    end if;
  end loop;

  select count(*) into v_left from public.shifts where id = any(v_ids);
  if v_left > 0 then
    raise exception 'Purge did not remove % shift(s)', v_left;
  end if;
  raise notice 'purge verified: both QA shifts removed';
end
$cleanup$;

-- Restore worker1, docked 25 by the no-show verification. Needs the
-- trusted-write flag: guard_profile_reputation_and_role pins this column and
-- its admin exemption does not apply here either, for the same reason.
do $reset$
declare
  v_bad int;
begin
  perform set_config('app.reliability_trusted_write', 'true', true);
  update public.profiles set reliability_score = 100
  where id in (
    '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',
    '1ad212f6-5f29-41cb-b60f-2c9159915ab6'
  );
  perform set_config('app.reliability_trusted_write', 'false', true);

  select count(*) into v_bad from public.profiles
  where id in ('13e3a2d8-40fa-472f-8ca4-18c8361dbbd0', '1ad212f6-5f29-41cb-b60f-2c9159915ab6')
    and reliability_score is distinct from 100;
  if v_bad > 0 then
    raise exception 'Reliability reset did not take effect on % row(s)', v_bad;
  end if;
  raise notice 'reliability reset verified';
end
$reset$;

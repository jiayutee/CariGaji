-- Clear the two shifts created to verify 20260822c (the disputes RLS widening).
--
-- They cannot go through the REST API: shift 1 has an accepted worker, which
-- guard_delete_of_booked_shift refuses, and admin_purge_shift needs a direct
-- SQL session. The dispute row cascades from applications, so it goes with them.
--
-- Verified before writing this: neither shift produced a payout. Both were
-- cancelled ~30 days before their start date, so no cancellation compensation
-- was owed and create_cancellation_payout never fired.

do $cleanup$
declare
  v_ids uuid[] := array[
    '0298894b-f307-4921-8a0d-9703c5eef0f3',   -- "DISPUTE RLS probe"   (accepted + signed worker, 1 dispute row)
    '25bc574d-433c-4d1c-90b2-9f33e614c706'    -- "DISPUTE RLS probe 2" (pending applicant, negative control)
  ]::uuid[];
  v_id uuid;
  v_left int;
  v_disputes int;
begin
  select count(*) into v_disputes
  from public.disputes d
  join public.applications a on a.id = d.application_id
  where a.shift_id = any(v_ids);
  raise notice 'removing % probe dispute(s) with their applications', v_disputes;

  foreach v_id in array v_ids loop
    if exists (select 1 from public.shifts where id = v_id) then
      perform public.admin_purge_shift(v_id, 'QA cleanup after disputes RLS verification');
    end if;
  end loop;

  select count(*) into v_left from public.shifts where id = any(v_ids);
  if v_left > 0 then
    raise exception 'purge left % shift(s)', v_left;
  end if;

  select count(*) into v_left
  from public.disputes d
  join public.applications a on a.id = d.application_id
  where a.shift_id = any(v_ids);
  if v_left > 0 then
    raise exception '% probe dispute(s) survived', v_left;
  end if;

  raise notice 'cleanup verified: probe shifts, applications and disputes all gone';
end
$cleanup$;

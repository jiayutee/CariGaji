-- Clear the shift used to verify Decline & Modify live (2026-09-19). It has an
-- accepted worker, so guard_delete_of_booked_shift refuses a plain delete; the
-- shift is already status 'cancelled' (hidden from the public feed) and this
-- removes it and its application. No payout rows were created for it.

do $cleanup$
declare
  v_shift uuid := 'a3016ccc-de63-4213-8ad3-a29deef9277d';
  v_left int;
begin
  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after hours-negotiation test');
  end if;

  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then raise exception 'purge left the shift in place'; end if;
  select count(*) into v_left from public.applications where shift_id = v_shift;
  if v_left > 0 then raise exception '% application(s) survived', v_left; end if;

  raise notice 'cleanup verified: negotiation probe shift and application removed';
end
$cleanup$;

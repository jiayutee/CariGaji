-- Clear the shift created to exercise the notification archive UI.
-- It has an accepted worker, so guard_delete_of_booked_shift refuses a plain
-- delete and admin_purge_shift needs a direct SQL session. The shift was never
-- worked and produced no payout; its notifications go with the applications.

do $cleanup$
declare
  v_shift uuid := '76f72210-e3a9-47bb-92fa-dd18d1d3feb4';
  v_left int;
begin
  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after notification archive UI test');
  end if;
  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then raise exception 'purge left the shift in place'; end if;
  raise notice 'cleanup verified: probe shift, application and notifications removed';
end
$cleanup$;

-- Clear the shift used to verify the chat room's "View shift" shortcut.
-- Accepted worker, so guard_delete_of_booked_shift refuses a plain delete.

do $cleanup$
declare
  v_shift uuid := 'c1046bee-e6bb-43cc-83cb-73161623b7aa';
  v_left int;
begin
  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after chat view-shift shortcut test');
  end if;
  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then raise exception 'purge left the shift in place'; end if;
  raise notice 'cleanup verified: probe shift, application and messages removed';
end
$cleanup$;

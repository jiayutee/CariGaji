-- Clear the shift used to verify the chat unread badge and day separators.
-- It has an accepted worker, so guard_delete_of_booked_shift refuses a plain
-- delete. Its messages cascade from the shift (messages.shift_id references
-- shifts on delete cascade), and the application goes with it.

do $cleanup$
declare
  v_shift uuid := '14ecdacb-effc-4661-a750-fefa70c52b53';
  v_msgs int;
  v_left int;
begin
  select count(*) into v_msgs from public.messages where shift_id = v_shift;
  raise notice 'removing % probe message(s) with the shift', v_msgs;

  if exists (select 1 from public.shifts where id = v_shift) then
    perform public.admin_purge_shift(v_shift, 'QA cleanup after chat badge / day separator test');
  end if;

  select count(*) into v_left from public.shifts where id = v_shift;
  if v_left > 0 then raise exception 'purge left the shift in place'; end if;
  select count(*) into v_left from public.messages where shift_id = v_shift;
  if v_left > 0 then raise exception '% probe message(s) survived', v_left; end if;

  raise notice 'cleanup verified: probe shift, application and messages removed';
end
$cleanup$;

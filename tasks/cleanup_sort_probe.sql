-- Clear the two shifts used to verify chat-list ordering (most recent first).
-- Both have an accepted worker, so guard_delete_of_booked_shift refuses a plain
-- delete. Messages cascade from the shift; the applications go with it.

do $cleanup$
declare
  v_ids uuid[] := array['51c6d1a4-1a80-4a79-99d6-05de654a333b','9ab89029-c9ab-479d-96f0-124e7cb27f26']::uuid[];
  v_id uuid;
  v_msgs int;
  v_left int;
begin
  select count(*) into v_msgs from public.messages where shift_id = any(v_ids);
  raise notice 'removing % probe message(s) with their shifts', v_msgs;

  foreach v_id in array v_ids loop
    if exists (select 1 from public.shifts where id = v_id) then
      perform public.admin_purge_shift(v_id, 'QA cleanup after chat sort-order test');
    end if;
  end loop;

  select count(*) into v_left from public.shifts where id = any(v_ids);
  if v_left > 0 then raise exception 'purge left % shift(s)', v_left; end if;
  select count(*) into v_left from public.messages where shift_id = any(v_ids);
  if v_left > 0 then raise exception '% probe message(s) survived', v_left; end if;

  raise notice 'cleanup verified: both probe shifts, applications and messages removed';
end
$cleanup$;

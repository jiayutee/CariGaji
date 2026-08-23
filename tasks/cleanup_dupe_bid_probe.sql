-- Remove one QA application left on a REAL shift.
--
-- Created while reproducing the "duplicate key" bug the owner reported: worker1
-- applied to "Event helper" (a genuine shift belonging to the owner's own
-- account), so the fix could be verified against the real condition. The row is
-- status 'withdrawn' and must not be left behind -- it inflates that shift's
-- applicant history and, more importantly, permanently blocks worker1 from ever
-- bidding on that shift, which is the exact bug just fixed.
--
-- It could not be removed through the API: applications has no DELETE policy,
-- so the request returns 204 having matched zero rows. A delete that reports
-- success without deleting is worse than one that fails.
--
-- The shift itself is NOT touched.

do $cleanup$
declare
  v_app uuid := 'c9876338-5f99-4bc5-95c1-1ead0d327a4d';
  v_shift uuid;
  v_status text;
  v_left int;
begin
  select shift_id, status into v_shift, v_status
  from public.applications where id = v_app;

  if v_shift is null then
    raise notice 'already gone, nothing to do';
    return;
  end if;

  -- Refuse if it is not the harmless row this script was written for.
  if v_status not in ('withdrawn', 'pending', 'rejected') then
    raise exception 'application % is % -- not the QA row this script expects; stopping', v_app, v_status;
  end if;

  delete from public.applications where id = v_app;

  select count(*) into v_left from public.applications where id = v_app;
  if v_left > 0 then raise exception 'the application survived'; end if;

  if not exists (select 1 from public.shifts where id = v_shift) then
    raise exception 'the shift was removed -- it should NOT have been';
  end if;

  raise notice 'cleanup verified: QA application removed, shift % untouched', v_shift;
end
$cleanup$;

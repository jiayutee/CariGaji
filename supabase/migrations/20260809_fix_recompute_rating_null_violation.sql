-- 20260804_recompute_rating_on_delete.sql was applied correctly, but broke
-- on first real use: profiles.rating is `numeric(2,1) not null default 0`
-- (20260628_profiles.sql) -- 0 has always been this project's convention for
-- "no ratings yet", not null. The 20260804 trigger's aggregate subquery
-- returns NULL when a ratee's last rating is deleted (avg() of zero rows),
-- which violates that not-null constraint -- and because this fires inside
-- the same transaction as the delete, the constraint violation rolled back
-- the ENTIRE delete (shift/application/rating all stayed put), not just the
-- rating recompute. Confirmed live: deleting the last rating for a test
-- worker 400'd with "null value in column rating... violates not-null
-- constraint" and the row never actually deleted.
--
-- Fix: coalesce the aggregate to 0, matching the column's own default and
-- the convention every other write to this column already follows.

create or replace function public.recompute_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ratee_id uuid := coalesce(new.ratee_id, old.ratee_id);
begin
  perform set_config('app.ratings_trusted_write', 'true', true);

  update public.profiles
  set rating = coalesce((
    select round(avg(overall)::numeric, 1)
    from public.ratings
    where ratee_id = v_ratee_id
  ), 0)
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

-- Trigger itself is unchanged from 20260804 (still AFTER INSERT OR DELETE) --
-- only the function body changes, so no need to drop/recreate the trigger.

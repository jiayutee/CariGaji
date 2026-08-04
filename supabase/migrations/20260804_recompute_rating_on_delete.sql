-- recompute_profile_rating (20260725i) only fires AFTER INSERT — a ratee's
-- profiles.rating never goes back down once a rating row is removed (e.g.
-- admin moderation, or QA test-data cleanup). Found live during a
-- multi-employer/multi-worker rating QA pass: after deleting test ratings,
-- the 3 affected profiles kept showing their old (now-orphaned) averages
-- indefinitely, since nothing ever re-ran the aggregate.
--
-- Add an AFTER DELETE trigger using the same recompute function — DELETE
-- triggers see the removed row via OLD, not NEW, so recompute_profile_rating
-- is extended to key off whichever is present. When a ratee's last rating is
-- deleted, the aggregate subquery returns NULL, which is correct (no ratings
-- = no average, not 0).

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
  set rating = (
    select round(avg(overall)::numeric, 1)
    from public.ratings
    where ratee_id = v_ratee_id
  )
  where id = v_ratee_id;

  perform set_config('app.ratings_trusted_write', 'false', true);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_recompute_profile_rating on public.ratings;
create trigger trg_recompute_profile_rating
after insert or delete on public.ratings
for each row execute function public.recompute_profile_rating();

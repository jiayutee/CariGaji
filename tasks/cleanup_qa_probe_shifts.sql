-- Remove QA probe shifts that are visible to SIGNED-OUT visitors on the public
-- Discover feed. Written 2026-09-13.
--
-- WHY THIS EXISTS. The live landing page lists "REAPPLY probe — Test Employer
-- Two" in the open-shifts feed, next to real listings, to every visitor. These
-- are QA scaffolding left behind by earlier sessions, not real work.
--
-- WHAT MUST NOT BE TOUCHED. Demo Staff owns the public Discover feed shifts on
-- purpose -- "Corporate Dinner Server" and its siblings are deliberate demo
-- content and MUST survive this script. Only rows whose title matches the probe
-- pattern are in scope. If you widen the pattern, re-read this paragraph first.
--
-- BLAST RADIUS FIRST, DELETE SECOND. This project has already learned this one
-- the hard way (commit 62c0805, "lesson on predicting a delete's blast radius in
-- the wrong unit"). A shift does not stand alone: applications, ratings, chat
-- rooms and messages hang off it, and some of those FKs may cascade while others
-- may block. So STEP 1 discovers, from the live catalogue, every table that
-- actually references public.shifts and counts what each holds for these rows.
-- Nothing is deleted until you have read those numbers.

-- ── STEP 1: what matches, and what hangs off it ────────────────────────────
-- Run this ALONE first. It writes nothing.

select id, title, status, employer_id, start_at, created_at
  from public.shifts
 where title ilike '%probe%'
 order by created_at;

-- Every FK pointing at public.shifts, so the blast radius is discovered rather
-- than assumed. Read the delete_rule column: 'CASCADE' rows vanish with the
-- shift, 'NO ACTION'/'RESTRICT' rows will BLOCK the delete until cleared.
select
  tc.table_name        as referencing_table,
  kcu.column_name      as referencing_column,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_name = 'shifts'
  and ccu.table_schema = 'public'
order by rc.delete_rule, tc.table_name;

-- Direct dependents, counted. Extend this if STEP 1 reveals a table not listed.
select
  (select count(*) from public.applications a
     join public.shifts s on s.id = a.shift_id
    where s.title ilike '%probe%')                      as applications,
  (select count(*) from public.ratings r
     join public.applications a on a.id = r.application_id
     join public.shifts s on s.id = a.shift_id
    where s.title ilike '%probe%')                      as ratings;

-- ── STEP 2: the delete ─────────────────────────────────────────────────────
-- ⚠️  COMMENTED OUT ON PURPOSE. Read STEP 1's output first, then strip the
--     leading "-- " from every line below. Pasting this section as-is executes
--     nothing but comments and Postgres reports SUCCESS -- exactly the failure
--     that left six demo payout rows live for three days on 2026-09-13.
--
--     It runs inside an explicit transaction and RAISES if the count is not what
--     STEP 1 showed you, so a surprise (someone naming a real shift "probe")
--     aborts instead of deleting. Set v_expected to the row count STEP 1 printed.
--
-- begin;
-- do $$
-- declare
--   v_expected int := 2;   -- <<< SET THIS from STEP 1's row count
--   v_found    int;
--   v_deleted  int;
-- begin
--   select count(*) into v_found from public.shifts where title ilike '%probe%';
--   if v_found <> v_expected then
--     raise exception 'ABORT: expected % probe shift(s), found %. Re-run STEP 1 -- do not guess.', v_expected, v_found;
--   end if;
--   -- Guard the deliberate demo content explicitly, belt and braces.
--   if exists (select 1 from public.shifts where title ilike '%probe%' and title ilike '%Corporate Dinner%') then
--     raise exception 'ABORT: the pattern matched a Demo Staff feed shift. Narrow it.';
--   end if;
--   delete from public.shifts where title ilike '%probe%';
--   get diagnostics v_deleted = row_count;
--   raise notice 'Deleted % probe shift(s).', v_deleted;
-- end $$;
-- commit;

-- ── STEP 3: verify ─────────────────────────────────────────────────────────
-- probe_left must be 0. demo_feed_left is the control: it must stay NON-zero,
-- proving the delete was narrow and the public feed still has its demo content.
-- If both are 0, too much was deleted -- restore from a backup.
--
-- select
--   (select count(*) from public.shifts where title ilike '%probe%')        as probe_left,
--   (select count(*) from public.shifts where status = 'open')              as open_shifts_left;

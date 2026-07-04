-- The live shifts.category column drifted to an enum (shift_category) with
-- lowercase values (fnb, retail, …), but the app and the original migration
-- use plain text with display values ('F&B','Retail','Event','Logistics',
-- 'Other'). Convert the column to text + check constraint so inserts match
-- what the app sends. Idempotent.

alter table public.shifts drop constraint if exists shifts_category_check;
alter table public.shifts alter column category drop default;

-- Convert enum → text (no-op if already text). Existing lowercase enum values
-- are normalised to the app's display labels.
alter table public.shifts
  alter column category type text
  using (
    case lower(category::text)
      when 'fnb'       then 'F&B'
      when 'f&b'       then 'F&B'
      when 'retail'    then 'Retail'
      when 'event'     then 'Event'
      when 'logistics' then 'Logistics'
      else 'Other'
    end
  );

alter table public.shifts alter column category set default 'Other';
alter table public.shifts
  add constraint shifts_category_check
  check (category in ('F&B','Retail','Event','Logistics','Other'));

-- Free-text job/shift description so employers can give workers context
-- beyond the structured fields (title, category, dress code, etc.).
alter table public.shifts
  add column if not exists description text;

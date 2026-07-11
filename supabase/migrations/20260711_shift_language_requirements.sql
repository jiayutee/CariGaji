-- Optional language requirement(s) for a shift, so employers can flag when a
-- role needs a worker fluent in specific language(s) (e.g. a Mandarin-speaking
-- customer service shift). Purely additive: new column defaults to an empty
-- array, so existing rows and existing app behaviour are unaffected while
-- this migration is pending. Mirrors the shifts_category_check pattern (see
-- 20260705g_widen_shift_categories.sql) for the allowed value list, kept in
-- sync with SHIFT_LANGUAGES in carigaji-app.jsx (added in a later commit).
alter table public.shifts
  add column if not exists language_requirements text[] not null default '{}'::text[];

alter table public.shifts drop constraint if exists shifts_language_requirements_check;
alter table public.shifts
  add constraint shifts_language_requirements_check
  check (language_requirements <@ array['Bahasa Melayu', 'English', 'Mandarin', 'Tamil', 'Other']::text[]);

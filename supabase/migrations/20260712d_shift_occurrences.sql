-- Multi-day shift postings: an employer can post one job that recurs across
-- specific, individually-chosen calendar days (e.g. Sat + Mon, or Tue/Wed/Fri),
-- each with its own start/end time. One application/offer/contract still
-- covers the whole set of days (no per-occurrence assignment) — the app has
-- no precedent for partial-occurrence acceptance, so this deliberately keeps
-- the existing "one applications row = one shift" model and just adds a
-- richer schedule to the shift itself.
--
-- `occurrences` is an array of {"date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM"}
-- objects, sorted by date. Every shift gets this populated — including
-- ordinary single-day shifts, which just get a one-element array — so there's
-- one uniform code path instead of an "old-style vs multi-day" branch.
--
-- start_at/end_at are kept as-is and always mirror the EARLIEST occurrence.
-- Every existing read site that uses them for sorting, offer-deadline math
-- (computeOfferDeadline/hoursUntilShift), or "time until shift begins" logic
-- keeps working unchanged, since that's exactly what they should mean.

alter table public.shifts
  add column if not exists occurrences jsonb not null default '[]'::jsonb;

-- Backfill existing rows from their single start_at/end_at pair, in Malaysia
-- time (same to_char(... at time zone 'Asia/Kuala_Lumpur', ...) pattern used
-- elsewhere in this project's timezone fixes).
update public.shifts
set occurrences = jsonb_build_array(
  jsonb_build_object(
    'date',  to_char(start_at at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM-DD'),
    'start', to_char(start_at at time zone 'Asia/Kuala_Lumpur', 'HH24:MI'),
    'end',   to_char(end_at   at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')
  )
)
where jsonb_array_length(occurrences) = 0;

alter table public.shifts drop constraint if exists shifts_occurrences_nonempty;
alter table public.shifts
  add constraint shifts_occurrences_nonempty check (jsonb_array_length(occurrences) >= 1);

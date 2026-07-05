-- Expand shift categories beyond F&B/Retail/Event/Logistics/Other, matching
-- the broader taxonomy seen on comparable staffing platforms (promotion,
-- warehouse, office, security, production, market research, student jobs).
alter table public.shifts drop constraint if exists shifts_category_check;
alter table public.shifts
  add constraint shifts_category_check
  check (category in (
    'F&B', 'Retail', 'Event', 'Promotion', 'Warehouse', 'Office',
    'Security', 'Production', 'Market Research', 'Student', 'Logistics', 'Other'
  ));

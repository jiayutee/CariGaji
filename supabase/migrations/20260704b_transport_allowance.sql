-- Optional transport allowance (RM flat amount) an employer may offer on
-- top of hourly wage. Nullable/0 by default — employers opt in per shift.
alter table public.shifts
  add column if not exists transport_allowance numeric(10,2) not null default 0
    check (transport_allowance >= 0);

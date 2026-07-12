-- Real applicant counts on the public Discover shift list. The "X applied"
-- badge on shift cards was hardcoded to 0 client-side (see carigaji-app.jsx
-- discover query) because anon/public browsers can't read the applications
-- table directly (RLS only exposes a worker's own rows / an employer's own
-- shift's rows). Mirrors the existing filled_count trigger pattern exactly.

alter table public.shifts
  add column if not exists applicant_count int not null default 0 check (applicant_count >= 0);

create or replace function public.sync_shift_applicant_count()
returns trigger language plpgsql security definer as $$
begin
  update public.shifts
  set applicant_count = (
    select count(*) from public.applications
    where shift_id = coalesce(new.shift_id, old.shift_id)
  )
  where id = coalesce(new.shift_id, old.shift_id);
  return null;
end;
$$;

drop trigger if exists trg_sync_applicant_count on public.applications;
create trigger trg_sync_applicant_count
after insert or delete on public.applications
for each row execute function public.sync_shift_applicant_count();

-- Allow employers to cancel a shift, notifying every worker who had an
-- active (pending/shortlisted/accepted) application on it. Idempotent.

-- Widen the notifications.type check to include the new event.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled'));

create or replace function public.notify_shift_cancelled()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_cancelled',
      'Shift cancelled',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled by the employer.',
      '/worker/shifts/' || new.id
    from public.applications a
    where a.shift_id = new.id
      and a.status in ('pending', 'shortlisted', 'accepted');
  end if;
  return null;
end;
$$;

drop trigger if exists trg_notify_shift_cancelled on public.shifts;
create trigger trg_notify_shift_cancelled
after update of status on public.shifts
for each row
when (new.status is distinct from old.status)
execute function public.notify_shift_cancelled();

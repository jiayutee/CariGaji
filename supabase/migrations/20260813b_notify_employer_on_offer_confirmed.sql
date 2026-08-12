-- Notify the employer when a worker accepts their offer.
--
-- 'offer_confirmed' has been in the notifications type constraint since
-- 20260705 but NOTHING has ever emitted it. The consequence: the employer is
-- told when an offer is declined or expires (notify_offer_response), but not
-- when one is accepted -- the outcome they are actually waiting on. They had
-- to open the shift and re-read the applicant pool to find out whether their
-- shift was staffed.
--
-- Deliberately narrow: fires only on the offered -> accepted transition, i.e.
-- the worker confirming. It does NOT fire when an employer accepts an
-- applicant directly (pending/shortlisted -> accepted), because there the
-- employer IS the actor and already knows.
--
-- No overlap with trg_notify_bid_status_change: that one fires on the same
-- transition but notifies the WORKER ('Bid accepted'). This notifies the
-- employer. Different recipient, different type.

create or replace function public.notify_offer_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift_title text;
  v_employer_id uuid;
  v_worker_name text;
begin
  if old.status = 'offered' and new.status = 'accepted' then
    select s.title, s.employer_id into v_shift_title, v_employer_id
    from public.shifts s where s.id = new.shift_id;

    select full_name into v_worker_name
    from public.profiles where id = new.worker_id;

    if v_employer_id is not null then
      insert into public.notifications (user_id, type, title, body, link, params)
      values (
        v_employer_id,
        'offer_confirmed',
        'Worker confirmed',
        coalesce(v_worker_name, 'A worker') || ' accepted your offer for "' ||
          coalesce(v_shift_title, 'your shift') || '".',
        '/employer/shifts/' || new.shift_id,
        jsonb_build_object(
          'shift_title', coalesce(v_shift_title, 'your shift'),
          'worker_name', coalesce(v_worker_name, 'A worker')
        )
      );
    end if;
  end if;
  return null;

exception when others then
  -- Pure notifier: must never abort the worker's acceptance. Losing the
  -- notification is recoverable; blocking a worker from confirming a booking
  -- is not.
  raise warning 'notify_offer_confirmed failed for application %: %', new.id, sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_notify_offer_confirmed on public.applications;
create trigger trg_notify_offer_confirmed
after update of status on public.applications
for each row
when (old.status = 'offered' and new.status = 'accepted')
execute function public.notify_offer_confirmed();

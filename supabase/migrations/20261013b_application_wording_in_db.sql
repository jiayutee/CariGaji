-- User-facing English text in three DB functions still said "bid" after the
-- app moved to one vocabulary (5786755: Apply / Applicants / Your rate).
-- Text only: each function is the live pg_get_functiondef output (2026-10-13)
-- with just the quoted strings swapped, asserted by anchor, nothing else
-- touched. Titles/bodies now match the app's notif.bid_* English strings,
-- which the app renders in preference to these; these are the fallback
-- (and what a push/email would show). Type codes ('bid_received' etc.) and
-- function names stay -- they are identifiers, not copy. Rows already in
-- notifications keep their old text.

CREATE OR REPLACE FUNCTION public.check_bid_cap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_wage_max numeric(8,2);
begin
  select wage_max into v_wage_max
  from public.shifts
  where id = new.shift_id;

  if new.wage_ask > v_wage_max * 1.5 then
    raise exception 'Your rate of RM% is above the maximum allowed (RM%)',
      new.wage_ask,
      round(v_wage_max * 1.5, 2);
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_bid_received()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_employer_id uuid;
  v_shift_title text;
begin
  select employer_id, title into v_employer_id, v_shift_title
  from public.shifts
  where id = new.shift_id;

  if v_employer_id is not null then
    insert into public.notifications (user_id, type, title, body, link, params)
    values (
      v_employer_id,
      'bid_received',
      'New application received',
      'Someone applied for "' || coalesce(v_shift_title, 'your shift') || '".',
      '/employer/shifts/' || new.shift_id,
      jsonb_build_object('shift_title', coalesce(v_shift_title, 'your shift'))
    );
  end if;

  return null;

exception when others then
  raise warning 'notify_bid_received failed: %', sqlerrm;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_bid_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_shift_title text;
begin
  select title into v_shift_title
  from public.shifts
  where id = new.shift_id;

  insert into public.notifications (user_id, type, title, body, link, params)
  values (
    new.worker_id,
    case when new.status = 'accepted' then 'bid_accepted' else 'bid_rejected' end,
    case when new.status = 'accepted' then 'Application accepted' else 'Application rejected' end,
    case
      when new.status = 'accepted' then 'Your application for "' || coalesce(v_shift_title, 'a shift') || '" was accepted.'
      else 'Your application for "' || coalesce(v_shift_title, 'a shift') || '" was rejected.'
    end,
    '/worker/shifts/' || new.shift_id,
    jsonb_build_object('shift_title', coalesce(v_shift_title, 'a shift'))
  );

  return null;

exception when others then
  raise warning 'notify_bid_status_change failed: %', sqlerrm;
  return null;
end;
$function$;

-- Closes a second exploit in the cancellation-choice payout flow, found by
-- an independent security review of 20260717e AFTER it was written (never
-- verified live before this migration).
--
-- THE BUG: 20260717e's `revoke update (wage_ask, cancellation_choice_deadline,
-- cancellation_choice_made_at) on public.applications from authenticated` is
-- a no-op for cancellation_choice_deadline/cancellation_choice_made_at.
-- Postgres column-level REVOKE cannot subtract from a broader table-level
-- GRANT, and Supabase's bootstrap grants table-level UPDATE on every public
-- table to `authenticated`. No migration in this repo ever narrows that
-- table-level grant (confirmed by grep), so `authenticated` still holds
-- full-row UPDATE — the REVOKE changes nothing.
--
-- guard_cancellation_choice_columns (20260717e) only reverts illegitimate
-- changes to cancellation_choice, cancellation_proof_path, and wage_ask —
-- cancellation_choice_deadline and cancellation_choice_made_at are left
-- completely unguarded. A worker can therefore still smuggle an
-- attacker-chosen cancellation_choice_deadline through the pre-existing
-- applications_worker_update policy (withdraw their own pending
-- application while also setting a past deadline), then legitimately walk
-- through applications_cancellation_choice_expire to set
-- cancellation_choice = 'contract_50' on an application that was never
-- accepted, for a shift that was never cancelled — firing a real
-- payout_item against the employer.
--
-- THE FIX has two independent layers:
--
-- 1. cancellation_choice_deadline / cancellation_choice_made_at are now
--    guarded the same way cancellation_choice/cancellation_proof_path
--    already are, using a transaction-local trust flag instead of trying
--    to re-derive business rules in the trigger. The only two legitimate
--    writers of these columns (notify_cancellation_choice_pending and
--    create_cancellation_payout, both existing SECURITY DEFINER triggers)
--    now set app.cancellation_trusted_write = true (via set_config(...,
--    is_local => true), scoped to the rest of their own transaction) right
--    before their internal UPDATE. The guard trigger reverts any change to
--    either column unless that flag is set. This doesn't depend on which
--    RLS policy authorized the outer UPDATE, and doesn't depend on table
--    grants at all — set_config for a custom (dotted) GUC name has no
--    special privilege requirement, but PostgREST/Supabase's REST API only
--    exposes table CRUD and explicitly-created public-schema RPC
--    functions, never raw SQL or pg_catalog builtins like set_config, so a
--    client can never set this flag itself.
--
-- 2. Defense-in-depth at the point money actually moves:
--    create_cancellation_payout now verifies, from the database's own
--    current row state (never trusting that reaching this trigger implies
--    legitimacy), that the shift is actually status = 'cancelled' and this
--    application is actually status = 'accepted' with worker_signed_at set
--    before inserting a payout_item. Even a future bug in the guard
--    trigger or a new unpinned-column path elsewhere could no longer turn
--    into a real payout without both of these being independently true.

create or replace function public.guard_cancellation_choice_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.cancellation_trusted_write', true), '') = 'true';
begin
  if is_admin then
    return new;
  end if;

  if new.cancellation_choice is distinct from old.cancellation_choice then
    if not (
      ( auth.uid() = old.worker_id
        and old.cancellation_choice_deadline is not null
        and old.cancellation_choice is null
        and new.cancellation_choice in ('contract_50', 'show_up_100') )
      or
      ( old.cancellation_choice_deadline is not null
        and old.cancellation_choice_deadline < now()
        and old.cancellation_choice is null
        and new.cancellation_choice = 'contract_50'
        and ( auth.uid() = old.worker_id
              or exists (select 1 from public.shifts s where s.id = old.shift_id and s.employer_id = auth.uid()) ) )
    ) then
      new.cancellation_choice := old.cancellation_choice;
    end if;
  end if;

  if new.cancellation_proof_path is distinct from old.cancellation_proof_path then
    if not (
      auth.uid() = old.worker_id
      and old.cancellation_choice = 'show_up_100'
      and old.cancellation_proof_path is null
      and new.cancellation_proof_path is not null
    ) then
      new.cancellation_proof_path := old.cancellation_proof_path;
    end if;
  end if;

  if new.wage_ask is distinct from old.wage_ask then
    new.wage_ask := old.wage_ask;
  end if;

  -- The REVOKE in 20260717e does not actually protect these two columns
  -- (see file header) — this trust-flag check is the real enforcement.
  if not is_trusted_write then
    if new.cancellation_choice_deadline is distinct from old.cancellation_choice_deadline then
      new.cancellation_choice_deadline := old.cancellation_choice_deadline;
    end if;
    if new.cancellation_choice_made_at is distinct from old.cancellation_choice_made_at then
      new.cancellation_choice_made_at := old.cancellation_choice_made_at;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.notify_cancellation_choice_pending()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and new.start_at is not null and new.start_at - now() <= interval '24 hours' then

    perform set_config('app.cancellation_trusted_write', 'true', true);

    update public.applications
    set cancellation_choice_deadline = new.start_at
    where shift_id = new.id
      and status = 'accepted'
      and worker_signed_at is not null
      and cancellation_choice_deadline is null;

    insert into public.notifications (user_id, type, title, body, link)
    select
      a.worker_id,
      'shift_cancellation_choice_pending',
      'Shift cancelled — choose your payout',
      'The shift "' || coalesce(new.title, 'a shift') || '" was cancelled less than 24 hours before it started. ' ||
        'Choose to sign a 50% cancellation payout, or show up in person for 100% of your agreed wage. ' ||
        'Respond by ' || to_char(new.start_at, 'DD Mon HH24:MI') || '.',
      '/worker/applications/' || a.id
    from public.applications a
    where a.shift_id = new.id
      and a.status = 'accepted'
      and a.worker_signed_at is not null
      and a.cancellation_choice_deadline = new.start_at;
  end if;
  return null;
end;
$$;

create or replace function public.create_cancellation_payout()
returns trigger language plpgsql security definer as $$
declare
  v_shift record;
  v_hours numeric;
  v_multiplier numeric;
  v_reason text;
begin
  if (new.cancellation_choice = 'contract_50' and old.cancellation_choice is distinct from 'contract_50')
     or (new.cancellation_choice = 'show_up_100' and new.cancellation_proof_path is not null and old.cancellation_proof_path is null) then

    select s.employer_id, s.start_at, s.end_at, s.title, s.status into v_shift
    from public.shifts s where s.id = new.shift_id;

    -- Defense-in-depth: never create a payout unless the shift is actually
    -- cancelled and this application was actually accepted + contract-signed,
    -- regardless of which RLS policy or trigger path authorized the write
    -- that landed us here.
    if v_shift.status is distinct from 'cancelled'
       or new.status is distinct from 'accepted'
       or new.worker_signed_at is null then
      return null;
    end if;

    v_hours := greatest(0.25, extract(epoch from (v_shift.end_at - v_shift.start_at)) / 3600.0);
    if new.cancellation_choice = 'contract_50' then
      v_multiplier := 0.5;
      v_reason := 'late_cancellation_50pct';
    else
      v_multiplier := 1.0;
      v_reason := 'late_cancellation_show_up_100pct';
    end if;

    if new.cancellation_choice_made_at is null then
      perform set_config('app.cancellation_trusted_write', 'true', true);
      update public.applications set cancellation_choice_made_at = now() where id = new.id;
    end if;

    insert into public.payout_item (
      payout_cycle_id, worker_id, employer_id, amount, currency, scheduled_date,
      status, source_refs, idempotency_key
    ) values (
      null, new.worker_id, v_shift.employer_id,
      round(new.wage_ask * v_hours * v_multiplier, 2), 'MYR', current_date,
      'queued',
      jsonb_build_object('application_id', new.id, 'shift_id', new.shift_id, 'reason', v_reason),
      'cancellation:' || new.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_shift.employer_id,
      'shift_cancellation_choice_made',
      'Worker responded to shift cancellation',
      case when new.cancellation_choice = 'contract_50'
        then 'A worker accepted the 50% cancellation payout for "' || coalesce(v_shift.title, 'your shift') || '".'
        else 'A worker is showing up for "' || coalesce(v_shift.title, 'your shift') || '" and has submitted proof for full pay.'
      end,
      '/employer/shifts/' || new.shift_id
    );
  end if;
  return null;
end;
$$;

-- Sanity check: confirm no application currently holds a deadline that
-- can't be traced to its own shift's start_at, which would indicate the
-- exploit was already exercised live before this migration ran.
do $$
declare
  v_suspect int;
begin
  select count(*) into v_suspect
  from public.applications a
  join public.shifts s on s.id = a.shift_id
  where a.cancellation_choice_deadline is not null
    and a.cancellation_choice_deadline is distinct from s.start_at;
  if v_suspect > 0 then
    raise warning 'cancellation_choice_deadline audit: % application(s) have a deadline that does not match their shift''s start_at — investigate before trusting this data', v_suspect;
  end if;
end $$;

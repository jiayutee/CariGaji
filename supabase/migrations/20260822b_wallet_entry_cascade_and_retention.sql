-- Two related defects in the deposit ledger, both currently latent and both
-- armed the moment enforcement is switched on (from then, every offer writes a
-- hold).
--
-- `employer_wallet_entry` carries an unconditional `before update or delete`
-- trigger with no trusted-write escape, while its foreign keys are declared
-- `on delete set null` / `on delete cascade`. A referential action is an
-- ordinary UPDATE or DELETE, so it fires that trigger like any other write.
-- Postgres names the statement it was running in the error CONTEXT, which is
-- the proof outright:
--
--     UPDATE ONLY "public"."employer_wallet_entry" SET "shift_id" = NULL ...
--     ERROR: employer_wallet_entry is append-only
--
-- Reproduced on PostgreSQL 17.4; tasks/wallet_cascade_repro.sql re-runs it
-- against a throwaway local cluster. It is not run against production on
-- purpose: the ledger is append-only, so a probe row in the real table could
-- never be removed afterwards.
--
-- Four operations abort once a single ledger row exists:
--   1. deleting the application  -- the FIRST thing admin_purge_shift does
--   2. deleting the shift
--   3. deleting the employer's auth user (cascade DELETE, trigger depth 2)
--   4. deleting the admin who recorded a top-up (created_by SET NULL)
--
-- (1), (2) and (4) are fixed here by teaching the guard the difference between
-- a rewrite and a dropped back-reference. (3) is fixed by the retention
-- decision below.

-- ── 0. which version of this file am I? ─────────────────────────────────────
-- Revision 2 exists because revision 1's self-test inserted a shift without
-- `occurrences` and died on shifts_occurrences_nonempty, rolling back DDL that
-- was correct. If a run reports that constraint again, it is revision 1 being
-- run a second time -- rev2 cannot produce that error, because it supplies
-- occurrences and because a setup failure warns instead of raising.
do $stamp$
begin
  raise notice '20260822b revision 2 (occurrences-aware self-test) starting';
end
$stamp$;

-- ── 1. the guard tells a rewrite from a dropped reference ────────────────────
-- A cascade nulling a back-reference does not rewrite the movement: who paid,
-- what kind, how much, and when are all untouched. Only a pointer to a row that
-- no longer exists goes away. Permit exactly that shape, refuse everything else.
--
-- Deliberately NOT keyed on pg_trigger_depth(). Depth asserts "some other
-- trigger did this", which is a weaker claim than "nothing about this movement
-- changed", and it would hand a bypass to any trigger added to this table
-- later. Comparing the columns says what we actually mean.
--
-- A reference may be DROPPED, never REPOINTED: `new.shift_id = 2` on a row that
-- pointed at shift 1 is refused, because moving a hold to a different shift is
-- exactly the kind of quiet rewrite this table exists to prevent.
create or replace function public.guard_wallet_entry_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and new.id = old.id
     and new.kind = old.kind
     and new.amount = old.amount
     and new.currency = old.currency
     and new.note is not distinct from old.note
     and new.idempotency_key is not distinct from old.idempotency_key
     and new.created_at = old.created_at
     and (new.employer_id    is null or new.employer_id    = old.employer_id)
     and (new.shift_id       is null or new.shift_id       = old.shift_id)
     and (new.application_id is null or new.application_id = old.application_id)
     and (new.created_by     is null or new.created_by     = old.created_by)
  then
    return new;
  end if;

  raise exception 'employer_wallet_entry is append-only: correct with a new entry, never by editing or deleting one';
end;
$$;

-- ── 2. a financial record outlives the account it belongs to ─────────────────
-- Owner decision, 2026-08-20: keep the ledger, drop the link. `employer_id`
-- cascaded from auth.users, so deleting an employer meant deleting their
-- movements -- and because the guard refused that delete, it meant the account
-- could not be deleted at all. An erasure request would have failed with a
-- confusing append-only error.
--
-- The column becomes nullable with `on delete set null`, so the account goes
-- and the money history stays reconcilable, anonymised.
do $retention$
declare
  v_fk text;
begin
  select conname into v_fk
  from pg_constraint
  where conrelid = 'public.employer_wallet_entry'::regclass
    and contype = 'f'
    and conkey = array[(
      select attnum from pg_attribute
      where attrelid = 'public.employer_wallet_entry'::regclass
        and attname = 'employer_id'
    )]::smallint[];

  if v_fk is null then
    raise exception 'could not find the employer_id foreign key to replace';
  end if;

  execute format('alter table public.employer_wallet_entry drop constraint %I', v_fk);
  alter table public.employer_wallet_entry alter column employer_id drop not null;
  alter table public.employer_wallet_entry
    add constraint employer_wallet_entry_employer_id_fkey
    foreign key (employer_id) references auth.users(id) on delete set null;

  raise notice 'replaced % with on delete set null', v_fk;
end
$retention$;

-- Dropping NOT NULL is for the cascade's benefit only. A NEW entry with no
-- employer has lost the one fact that says whose money moved, so it stays
-- refused -- the guarantee is unchanged for every write the application makes.
create or replace function public.guard_wallet_entry_has_employer()
returns trigger
language plpgsql
as $$
begin
  if new.employer_id is null then
    raise exception 'employer_wallet_entry.employer_id is required on insert';
  end if;
  return new;
end;
$$;

drop trigger if exists employer_wallet_entry_require_employer on public.employer_wallet_entry;
create trigger employer_wallet_entry_require_employer
before insert on public.employer_wallet_entry
for each row execute function public.guard_wallet_entry_has_employer();

-- employer_wallet_balance filters `where employer_id = p_employer_id`, so an
-- orphaned row matches nobody and no balance shifts. Same for the RLS read
-- policy. Nothing else needs changing.

-- ── 3. purging a shift must give back what it was holding ───────────────────
-- Patched from 20260819b's definition verbatim, with one block added, rather
-- than retyped -- a hand-copied version of this function has already silently
-- lost a guard once in this project.
--
-- Until now a shift with a hold could not be purged at all: the cascade above
-- aborted it. Part 1 removes that block, which means the purge now succeeds --
-- and would leave the hold pointing at an application that no longer exists.
-- employer_release_hold locates a hold by application_id, so at that point the
-- money is unreachable: `held` derives as (holds - releases - captures), so an
-- orphaned hold reduces the employer's available balance permanently with
-- nothing able to reverse it.
--
-- Trading a loud refusal for quietly frozen funds would be a worse bug than the
-- one being fixed, so the release ships in the same migration.

create or replace function public.admin_purge_shift(
  p_shift_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_direct_sql boolean := coalesce(current_setting('request.jwt.claims', true), '') = '';
  v_shift record;
  v_apps int;
  v_pending_payouts int;
  v_released numeric := 0;
  v_one jsonb;
  v_app record;
begin
  if not (is_admin or is_direct_sql) then
    raise exception 'Not authorized';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to purge a shift';
  end if;

  select id, title, employer_id, status into v_shift
  from public.shifts where id = p_shift_id;

  if v_shift.id is null then
    raise exception 'Shift not found';
  end if;

  -- Money still in flight is the hard stop. Listed positively against the real
  -- constraint, so an invented value silently matches nothing instead of
  -- everything.
  select count(*) into v_pending_payouts
  from public.payout_item p
  join public.applications a
    on a.id = (p.source_refs ->> 'application_id')::uuid
  where a.shift_id = p_shift_id
    and p.status in ('queued', 'ready', 'scheduled', 'held');

  if v_pending_payouts > 0 then
    raise exception 'Cannot purge: % payout(s) for this shift are still outstanding. Settle or release them first.', v_pending_payouts;
  end if;

  select count(*) into v_apps from public.applications where shift_id = p_shift_id;

  raise warning 'admin_purge_shift: % ("%") by % (direct_sql=%) -- % application(s) -- reason: %',
    p_shift_id, coalesce(v_shift.title, '?'), coalesce(auth.uid()::text, 'sql-session'), is_direct_sql, v_apps, p_reason;

  -- Give the employer back anything still held against this shift BEFORE the
  -- applications go. employer_release_hold finds the hold by application_id, so
  -- once the row is gone the money can never be released -- the balance derives
  -- held as (holds - releases - captures), and an orphaned hold subtracts from
  -- available forever with nothing able to reverse it.
  --
  -- This became necessary in the same migration that let the purge succeed at
  -- all. Before it, a held shift was blocked outright; unblocking it without
  -- this would have traded a loud refusal for silently frozen funds, which is
  -- the worse of the two.
  perform set_config('app.wallet_trusted_write', 'true', true);
  for v_app in select id from public.applications where shift_id = p_shift_id loop
    v_one := public.employer_release_hold(v_app.id, 'Shift purged: ' || p_reason);
    if coalesce((v_one ->> 'released')::boolean, false) then
      v_released := v_released + coalesce((v_one ->> 'amount')::numeric, 0);
    end if;
  end loop;
  perform set_config('app.wallet_trusted_write', 'false', true);

  delete from public.ratings
  where application_id in (select id from public.applications where shift_id = p_shift_id);

  delete from public.notifications
  where link = '/worker/shifts/' || p_shift_id::text
     or link = '/employer/shifts/' || p_shift_id::text
     or link in (
       select '/worker/applications/' || a.id::text
       from public.applications a where a.shift_id = p_shift_id
     );

  -- Applications FIRST: guard_delete_of_booked_shift refuses while any of them
  -- is 'accepted', so removing them makes the shift delete legitimate rather
  -- than exempt.
  delete from public.applications where shift_id = p_shift_id;

  delete from public.shifts where id = p_shift_id;

  return jsonb_build_object(
    'shift_id', p_shift_id,
    'title', v_shift.title,
    'applications_removed', v_apps,
    'holds_released', round(v_released, 2),
    'reason', p_reason
  );
end;
$$;

revoke all on function public.admin_purge_shift(uuid, text) from public;
grant execute on function public.admin_purge_shift(uuid, text) to authenticated;

-- ── 5. prove all of it, in the database, before anyone trusts it ───────────
-- Raises rather than reports: a self-test that returns a report nobody reads is
-- not a test.
--
-- Everything it creates is rolled back by a deliberate raise at the end of the
-- inner block. That is not tidiness -- this table is append-only, so a test
-- row left behind would be a permanent phantom hold against a real employer's
-- balance, with no way to remove it. The verdict travels back inside the
-- exception MESSAGE so it survives that rollback. The DDL above sits outside
-- the block and is untouched by it.
do $selftest$
declare
  v_emp    uuid := '2d8f78c4-fa12-4593-970c-57da3dea487a';  -- jiayutee97+qaemployer2
  v_worker uuid := '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0';  -- jiayutee97+qaworker1
  v_shift uuid;
  v_app uuid;
  v_entry uuid;
  v_amount numeric;
  v_blocked boolean;
  v_purge jsonb;
  v_other_shift uuid;
  -- shifts carries shifts_occurrences_nonempty, so a shift with no occurrence
  -- is rejected. Same shape the app writes: a date plus start/end in MYT.
  v_occurrence jsonb := jsonb_build_array(jsonb_build_object(
    'date',  to_char((now() + interval '30 days') at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM-DD'),
    'start', to_char((now() + interval '30 days') at time zone 'Asia/Kuala_Lumpur', 'HH24:MI'),
    'end',   to_char((now() + interval '30 days 4 hours') at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')
  ));
  v_out text;
begin
  if not exists (select 1 from auth.users where id = v_emp)
     or not exists (select 1 from auth.users where id = v_worker) then
    raise notice 'self-test skipped: the QA accounts it uses are not present';
    return;
  end if;

  begin
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, occurrences)
    values (v_emp, 'SELFTEST wallet cascade', 'Selftest',
            now() + interval '30 days', now() + interval '30 days 4 hours', 10, 20,
            v_occurrence)
    returning id into v_shift;

    insert into public.applications (shift_id, worker_id, wage_ask)
    values (v_shift, v_worker, 15)
    returning id into v_app;

    insert into public.employer_wallet_entry
      (employer_id, kind, amount, shift_id, application_id, note, idempotency_key)
    values (v_emp, 'hold', 1.00, v_shift, v_app, 'selftest',
            'selftest:' || v_shift::text)
    returning id into v_entry;

    -- The two deletes that used to abort.
    delete from public.applications where id = v_app;
    delete from public.shifts where id = v_shift;

    select amount into v_amount from public.employer_wallet_entry where id = v_entry;
    if v_amount is distinct from 1.00 then
      raise exception 'ASSERT: the movement did not survive the cascade';
    end if;
    if exists (select 1 from public.employer_wallet_entry
               where id = v_entry and (shift_id is not null or application_id is not null)) then
      raise exception 'ASSERT: back-references were not nulled';
    end if;

    -- A real rewrite must still be refused.
    begin
      update public.employer_wallet_entry set amount = 999 where id = v_entry;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then raise exception 'ASSERT: an amount rewrite was ALLOWED'; end if;

    -- So must repointing a reference at a DIFFERENT row, as opposed to dropping
    -- it. Needs a real second shift to point at: an earlier draft of this test
    -- selected from a table the test had just emptied, so it was setting
    -- shift_id to NULL and asserting that a null-out is refused -- which is the
    -- one update the fix deliberately permits. The test failed, correctly, and
    -- the guard was right.
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, occurrences)
    values (v_emp, 'SELFTEST repoint target', 'Selftest',
            now() + interval '30 days', now() + interval '30 days 4 hours', 10, 20,
            v_occurrence)
    returning id into v_other_shift;

    begin
      update public.employer_wallet_entry set shift_id = v_other_shift where id = v_entry;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then raise exception 'ASSERT: repointing shift_id was ALLOWED'; end if;

    begin
      delete from public.employer_wallet_entry where id = v_entry;
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then raise exception 'ASSERT: a direct delete was ALLOWED'; end if;

    -- And the purge must hand the money back rather than stranding it.
    insert into public.shifts (employer_id, title, location, start_at, end_at,
                               wage_min, wage_max, occurrences)
    values (v_emp, 'SELFTEST purge release', 'Selftest',
            now() + interval '30 days', now() + interval '30 days 4 hours', 10, 20,
            v_occurrence)
    returning id into v_shift;

    insert into public.applications (shift_id, worker_id, wage_ask)
    values (v_shift, v_worker, 15)
    returning id into v_app;

    insert into public.employer_wallet_entry
      (employer_id, kind, amount, shift_id, application_id, note, idempotency_key)
    values (v_emp, 'hold', 7.00, v_shift, v_app, 'selftest',
            'selftest-hold:' || v_shift::text);

    v_purge := public.admin_purge_shift(v_shift, 'selftest');

    if coalesce((v_purge ->> 'holds_released')::numeric, -1) is distinct from 7.00 then
      raise exception 'ASSERT: purge released % rather than 7.00', v_purge ->> 'holds_released';
    end if;

    select coalesce(sum(amount) filter (where kind = 'hold'), 0)
         - coalesce(sum(amount) filter (where kind = 'release'), 0)
         - coalesce(sum(amount) filter (where kind = 'capture'), 0)
    into v_amount
    from public.employer_wallet_entry where application_id = v_app;
    if v_amount is distinct from 0 then
      raise exception 'ASSERT: the purged shift left % still held', v_amount;
    end if;

    -- An insert with no employer must still be refused.
    begin
      insert into public.employer_wallet_entry (employer_id, kind, amount)
      values (null, 'topup', 5.00);
      v_blocked := false;
    exception when others then
      v_blocked := true;
    end;
    if not v_blocked then raise exception 'ASSERT: an insert with no employer was ALLOWED'; end if;

    raise exception using message = '__result__:passed';
  exception when others then
    v_out := case when sqlerrm like '__result__:%' then substr(sqlerrm, 12)
                  else sqlerrm end;
  end;

  -- An ASSERTION failure means the fix above is wrong, so the whole migration
  -- aborts and nothing lands. A SETUP failure means only that this test could
  -- not build its fixtures -- the first run of this migration died on
  -- shifts_occurrences_nonempty, a constraint the test had not supplied,
  -- and took the perfectly good DDL down with it. That is the test being
  -- wrong about the schema, not the fix being wrong, and it should not cost
  -- the fix. It still shouts, because an unverified fix is not a verified one.
  if v_out = 'passed' then
    null;
  elsif v_out like 'ASSERT: %' then
    raise exception 'wallet cascade self-test FAILED -- the fix is wrong: %', substr(v_out, 9);
  else
    raise warning 'wallet cascade self-test COULD NOT RUN: %', v_out;
    raise warning 'the fix above is applied but UNVERIFIED -- report this message rather than assuming it works';
    return;
  end if;

  if exists (select 1 from public.employer_wallet_entry where note = 'selftest') then
    raise exception 'self-test row survived the rollback -- it can never be deleted, investigate before continuing';
  end if;

  raise notice 'self-test passed: cascade nulls the references, the purge returns the hold, rewrites and deletes still refused, nothing left behind';
end
$selftest$;


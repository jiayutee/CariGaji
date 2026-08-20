-- Reproduction for the employer_wallet_entry cascade defect, and the proposed
-- guard. Runs against a THROWAWAY local Postgres, never against production --
-- it only needs the shape of the DDL, not the data. That matters here because
-- the ledger is append-only: a probe row inserted into the real table could
-- never be removed.
--
--   initdb -D /tmp/cgprobe/data -U probe --auth=trust
--   pg_ctl -D /tmp/cgprobe/data -o "-p 54329 -k /tmp/cgprobe -c listen_addresses=" start
--   psql -h /tmp/cgprobe -p 54329 -U probe -d postgres -f tasks/wallet_cascade_repro.sql
--
-- Verified on PostgreSQL 17.4, 2026-08-20.

-- ── the shape, straight from 20260820_employer_wallet_ledger.sql ─────────────
drop table if exists employer_wallet_entry, applications, shifts, users cascade;
create table users (id int primary key);                                    -- stands in for auth.users
create table shifts (id int primary key, employer_id int references users(id) on delete cascade);
create table applications (id int primary key, shift_id int not null references shifts(id) on delete cascade);
create table employer_wallet_entry (
  id int primary key,
  employer_id int not null references users(id) on delete cascade,
  kind text not null,
  amount numeric(10,2) not null,
  currency text not null default 'MYR',
  shift_id int references shifts(id) on delete set null,
  application_id int references applications(id) on delete set null,
  note text,
  idempotency_key text unique,
  created_by int references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── PART 1: the guard as it ships today ─────────────────────────────────────
create or replace function guard() returns trigger language plpgsql as $$
begin
  raise notice 'trigger fired: op=% depth=%', tg_op, pg_trigger_depth();
  raise exception 'employer_wallet_entry is append-only: correct with a new entry, never by editing or deleting one';
end; $$;
create trigger t before update or delete on employer_wallet_entry
for each row execute function guard();

insert into users values (1),(2);
insert into shifts values (1,1);
insert into applications values (10,1);
insert into employer_wallet_entry (id,employer_id,kind,amount,shift_id,application_id,created_by)
values (100,1,'hold',160.00,1,10,2);

-- Each of these fails. Read the CONTEXT line: Postgres names the internal
-- statement it was running, e.g.
--   UPDATE ONLY "public"."employer_wallet_entry" SET "shift_id" = NULL ...
-- which is the proof -- a referential SET NULL is an ordinary UPDATE, so it
-- fires the row trigger like any other.
\echo '>>> expect BLOCKED: delete the application (admin_purge_shift does this first)'
delete from applications where id = 10;
\echo '>>> expect BLOCKED: delete the shift'
delete from shifts where id = 1;
\echo '>>> expect BLOCKED: delete the employer account (cascade DELETE, depth=2)'
delete from users where id = 1;
\echo '>>> expect BLOCKED: delete the admin who recorded the top-up (created_by SET NULL)'
delete from users where id = 2;

-- ── PART 2: the proposed guard ──────────────────────────────────────────────
-- A cascade nulling a back-reference is not a rewrite of the movement: who paid,
-- what kind, how much and when are all untouched. Only the pointer to a row that
-- no longer exists goes away. So permit exactly that shape and nothing else.
--
-- Deliberately NOT keyed on pg_trigger_depth(). Depth would say "some other
-- trigger did it", which is not the same claim as "nothing about this movement
-- changed" -- and any future trigger that touched the table would inherit a
-- bypass it was never granted.
create or replace function guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.id = old.id
     and new.employer_id = old.employer_id
     and new.kind = old.kind
     and new.amount = old.amount
     and new.currency = old.currency
     and new.note is not distinct from old.note
     and new.idempotency_key is not distinct from old.idempotency_key
     and new.created_at = old.created_at
     -- a reference may be dropped, never repointed
     and (new.shift_id       is null or new.shift_id       = old.shift_id)
     and (new.application_id is null or new.application_id = old.application_id)
     and (new.created_by     is null or new.created_by     = old.created_by)
  then
    return new;
  end if;
  raise exception 'employer_wallet_entry is append-only: correct with a new entry, never by editing or deleting one';
end; $$;

\echo '>>> expect ALLOWED: delete the application, then the shift'
delete from applications where id = 10;
delete from shifts where id = 1;
\echo '>>> the movement must be intact, with only its back-references nulled:'
select amount, kind, shift_id, application_id from employer_wallet_entry;

\echo '>>> expect BLOCKED, all five:'
insert into shifts values (2,1);
update employer_wallet_entry set amount = 1 where id = 100;
update employer_wallet_entry set kind = 'topup' where id = 100;
update employer_wallet_entry set employer_id = 2 where id = 100;
update employer_wallet_entry set shift_id = 2 where id = 100;
delete from employer_wallet_entry where id = 100;

\echo '>>> STILL BLOCKED after the fix -- deleting the employer account:'
delete from users where id = 1;

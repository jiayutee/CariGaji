-- Revision 3 -- read-only. Reports the FACTS rather than a verdict, because
-- revision 1's verdict was wrong (a LIKE pattern that could never match) and
-- revision 2 could not tell "the fix is absent" from "the file being run is
-- stale". This one prints the guard's own source, so there is nothing left to
-- infer.
--
-- The expected fingerprint, measured against a sandbox with 20260822b applied:
--   md5 = bbf01db05c2cf45de3cfae35c8e6d92b, length = 780
select 'VERIFIER REVISION 3' as marker;

select
  n.nspname                                as schema,
  md5(p.prosrc)                            as source_md5,
  length(p.prosrc)                         as source_len,
  case when md5(p.prosrc) = 'bbf01db05c2cf45de3cfae35c8e6d92b'
       then 'MATCHES the shipped version'
       else 'DIFFERENT from the shipped version' end as verdict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'guard_wallet_entry_immutable';

-- The actual text. Read the first lines: the shipped version begins
--   begin
--     if tg_op = 'UPDATE'
-- and the version it replaces goes straight to `raise exception`.
select prosrc as guard_source
from pg_proc where proname = 'guard_wallet_entry_immutable';

-- Which trigger is actually attached, and to what function.
select t.tgname, p.proname as calls, t.tgenabled
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = 'public.employer_wallet_entry'::regclass
  and not t.tgisinternal;

-- The three catalog facts, which were right all along.
select
  (select case when attnotnull then 'NOT NULL' else 'nullable' end
     from pg_attribute where attrelid='public.employer_wallet_entry'::regclass
      and attname='employer_id')                                     as employer_id,
  (select case confdeltype when 'n' then 'SET NULL' when 'c' then 'CASCADE' else confdeltype::text end
     from pg_constraint where conrelid='public.employer_wallet_entry'::regclass and contype='f'
      and conkey = array[(select attnum from pg_attribute
            where attrelid='public.employer_wallet_entry'::regclass and attname='employer_id')]::smallint[]) as employer_fk,
  (select count(*) from pg_trigger where tgrelid='public.employer_wallet_entry'::regclass
      and tgname='employer_wallet_entry_require_employer')           as insert_guard,
  (select case when prosrc ~ 'employer_release_hold' then 'releases holds' else 'OLD' end
     from pg_proc where proname='admin_purge_shift')                 as purge;

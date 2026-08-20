-- Read-only confirmation that 20260822b landed. Selects only; changes nothing.
--
-- Revision 2. Revision 1 reported "part 1 did not land" against a database
-- where it HAD landed: it matched the guard's source with a LIKE pattern
-- written from memory, `%new.shift_id is null%`, while the function's actual
-- text aligns the operands -- `new.shift_id       is null`. The pattern could
-- never have matched. The checks below use whitespace-tolerant regexes and
-- anchor on tokens that alignment cannot break.
select
  (select case when attnotnull then 'STILL NOT NULL (part 2 did not land)' else 'nullable' end
     from pg_attribute
    where attrelid = 'public.employer_wallet_entry'::regclass
      and attname = 'employer_id')                                   as employer_id,

  (select case confdeltype when 'n' then 'SET NULL' when 'c' then 'CASCADE (part 2 did not land)'
                           else confdeltype::text end
     from pg_constraint
    where conrelid = 'public.employer_wallet_entry'::regclass and contype = 'f'
      and conkey = array[(select attnum from pg_attribute
                           where attrelid = 'public.employer_wallet_entry'::regclass
                             and attname = 'employer_id')]::smallint[])  as employer_fk,

  (select case when count(*) = 1 then 'present' else 'MISSING (part 2 did not land)' end
     from pg_trigger
    where tgrelid = 'public.employer_wallet_entry'::regclass
      and tgname = 'employer_wallet_entry_require_employer')          as insert_guard,

  (select case when prosrc ~ 'tg_op\s*=\s*''UPDATE'''
                and prosrc ~ 'new\.shift_id\s+is null'
                and prosrc ~ 'new\.employer_id\s+is null'
               then 'cascade-aware' else 'OLD (part 1 did not land)' end
     from pg_proc where proname = 'guard_wallet_entry_immutable')     as immutability_guard,

  (select case when prosrc ~ 'employer_release_hold'
                and prosrc ~ 'holds_released'
               then 'releases holds' else 'OLD (part 3 did not land)' end
     from pg_proc where proname = 'admin_purge_shift')                as purge;

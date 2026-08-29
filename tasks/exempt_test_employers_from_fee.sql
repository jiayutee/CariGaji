-- Keep the existing (test) employers fee-free indefinitely.
--
-- Owner's call, 2026-08-29: everyone who exists today is a test account, and
-- billing them would get in the way of internal testing. This is NOT the
-- 2-month trial -- it is an open-ended exemption, which is exactly what
-- profiles.fee_free_until was made a STORED column for.
--
-- Reversible in one statement (see the bottom). Nothing about the trial
-- mechanism changes; these accounts simply sit inside a very long window.
--
-- Run in the Supabase SQL editor. A SQL-editor session has no
-- request.jwt.claims, so guard_fee_trial_columns treats it as direct SQL and
-- lets the write through -- the same hatch support would use.

-- ── 1. Who is about to be exempted? Read this before running section 2 ──────
select
  p.id,
  p.full_name,
  p.role,
  p.created_at::date                              as registered,
  p.fee_free_until,
  (select count(*) from public.shifts s where s.employer_id = p.id) as shifts_posted
from public.profiles p
where p.role = 'employer'
order by p.created_at;

-- ── 2. Exempt every employer that exists RIGHT NOW ──────────────────────────
-- Far-future rather than NULL: NULL means "trial not started", so the next
-- shift they post would START a 2-month clock and then begin billing. A date
-- means "free until then", which is what is actually wanted.
update public.profiles
set fee_trial_started_at = coalesce(fee_trial_started_at, now()),
    fee_free_until       = timestamptz '2099-01-01 00:00:00+00',
    updated_at           = now()
where role = 'employer';

-- ── 3. Confirm, and show what a NEW employer would get ──────────────────────
select
  full_name,
  fee_free_until,
  case when fee_free_until > now() + interval '50 years'
       then 'exempt (test account)' else 'normal' end as status
from public.profiles
where role = 'employer'
order by created_at;

do $$
begin
  raise notice 'Existing employers exempted. A NEW employer signing up from now still gets % from their first posted shift.',
    public.fee_trial_length();
  raise notice 'Global rate for anyone outside a free window: % percent',
    round(public.platform_fee_pct() * 100, 2);
end $$;

-- ── TO UNDO, per employer, when they become a real customer ─────────────────
--   update public.profiles
--   set fee_trial_started_at = null, fee_free_until = null
--   where id = '<employer uuid>';
-- That returns them to "trial not started": their next posted shift starts a
-- fresh 2 months, after which the global rate applies.

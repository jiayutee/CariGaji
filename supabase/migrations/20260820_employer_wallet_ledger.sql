-- Employer deposit ledger: the thing that makes "the employer funds
-- compensation" true rather than aspirational.
--
-- Today payout_item records what a worker is OWED, with nothing charging the
-- employer. Every ringgit figure the app shows an employer -- the cancellation
-- quote, the compensation tiers -- is a promise the platform cannot collect
-- on. This is the collection side.
--
-- DESIGN: an append-only ledger, with balances DERIVED, never stored.
-- A stored balance column is the classic place money quietly goes wrong: two
-- concurrent writes, one lost update, and the number no longer matches
-- reality with nothing to reconstruct it from. Entries here are immutable
-- (enforced below), so the balance is always recomputable and every movement
-- has a row explaining it.
--
-- OWNER DECISIONS (2026-08-20):
--   * hold the FULL contracted wage, taken at OFFER time -- the moment the
--     amount is known and the employer acts, so an unfunded employer is
--     stopped before any worker is involved rather than a booking bouncing
--     after a worker accepted;
--   * WARN-ONLY at first: holds are computed and shown, but offers are not
--     blocked until real top-ups exist (see employer_wallet_enforced()).
--
-- SCOPE: no payment gateway exists (FPX/DuitNow is not integrated), so the
-- only source of funds here is an admin-recorded top-up, which lets a pilot
-- run on manually reconciled bank transfers. A gateway later becomes one more
-- `topup` source rather than a rewrite.

-- ── the ledger ───────────────────────────────────────────────────────────────
create table if not exists public.employer_wallet_entry (
  id           uuid primary key default gen_random_uuid(),
  employer_id  uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('topup', 'hold', 'release', 'capture', 'refund')),
  -- Always POSITIVE. Direction is carried by `kind`, so a sign error cannot
  -- silently invert a movement.
  amount       numeric(10,2) not null check (amount > 0),
  currency     text not null default 'MYR',
  shift_id     uuid references public.shifts(id) on delete set null,
  application_id uuid references public.applications(id) on delete set null,
  note         text,
  -- Makes every movement replay-safe: the same offer retried cannot hold
  -- twice. Same idiom as payout_item's idempotency_key.
  idempotency_key text unique,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists employer_wallet_entry_employer_idx
  on public.employer_wallet_entry (employer_id, created_at desc);
create index if not exists employer_wallet_entry_shift_idx
  on public.employer_wallet_entry (shift_id);

-- Immutable. A ledger you can edit is not a ledger -- corrections are new
-- entries, never rewrites, so history always reconstructs the balance.
create or replace function public.guard_wallet_entry_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'employer_wallet_entry is append-only: correct with a new entry, never by editing or deleting one';
end;
$$;

drop trigger if exists employer_wallet_entry_no_update on public.employer_wallet_entry;
create trigger employer_wallet_entry_no_update
before update or delete on public.employer_wallet_entry
for each row execute function public.guard_wallet_entry_immutable();

alter table public.employer_wallet_entry enable row level security;

-- An employer may READ their own ledger. Nobody writes through the API at all
-- -- every movement goes through the security-definer RPCs below, so the
-- balance can never be moved by a crafted PATCH.
drop policy if exists employer_wallet_entry_read_own on public.employer_wallet_entry;
create policy employer_wallet_entry_read_own
  on public.employer_wallet_entry for select to authenticated
  using (auth.uid() = employer_id);

drop policy if exists employer_wallet_entry_admin on public.employer_wallet_entry;
create policy employer_wallet_entry_admin
  on public.employer_wallet_entry for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ── derived balance ──────────────────────────────────────────────────────────
--   held      = holds - releases - captures   (money committed to open offers)
--   available = topups + refunds - captures - held
-- A capture converts a hold into money actually paid out, so it reduces BOTH
-- the hold and the funds -- that is why it appears in each line.
create or replace function public.employer_wallet_balance(p_employer_id uuid)
returns table (available numeric, held numeric, topped_up numeric, captured numeric)
language sql
security definer
set search_path = public
stable
as $$
  with t as (
    select
      coalesce(sum(amount) filter (where kind = 'topup'), 0)   as topups,
      coalesce(sum(amount) filter (where kind = 'refund'), 0)  as refunds,
      coalesce(sum(amount) filter (where kind = 'hold'), 0)    as holds,
      coalesce(sum(amount) filter (where kind = 'release'), 0) as releases,
      coalesce(sum(amount) filter (where kind = 'capture'), 0) as captures
    from public.employer_wallet_entry
    where employer_id = p_employer_id
  )
  select
    round(t.topups + t.refunds - t.captures - greatest(t.holds - t.releases - t.captures, 0), 2),
    round(greatest(t.holds - t.releases - t.captures, 0), 2),
    round(t.topups, 2),
    round(t.captures, 2)
  from t;
$$;

revoke all on function public.employer_wallet_balance(uuid) from public;
grant execute on function public.employer_wallet_balance(uuid) to authenticated;

-- ── enforcement switch ───────────────────────────────────────────────────────
-- Warn-only until real top-ups exist. Every existing employer has a zero
-- balance, so enforcing on day one would block all hiring at once. Kept as a
-- function rather than a constant so it flips without a code deploy.
create table if not exists public.platform_settings (
  key   text primary key,
  value jsonb not null,
  note  text
);

insert into public.platform_settings (key, value, note) values
  ('employer_wallet_enforced', 'false'::jsonb,
   'When true, an offer is REFUSED if the employer cannot cover the full contracted wage. Warn-only until real top-ups exist.')
on conflict (key) do nothing;

alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read
  on public.platform_settings for select to authenticated using (true);

drop policy if exists platform_settings_admin on public.platform_settings;
create policy platform_settings_admin
  on public.platform_settings for all to authenticated
  using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create or replace function public.employer_wallet_enforced()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select value::text = 'true' from public.platform_settings
                   where key = 'employer_wallet_enforced'), false);
$$;

revoke all on function public.employer_wallet_enforced() from public;
grant execute on function public.employer_wallet_enforced() to authenticated;

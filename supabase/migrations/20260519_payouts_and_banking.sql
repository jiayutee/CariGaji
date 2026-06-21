create extension if not exists pgcrypto;

create table if not exists public.banking_details (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role text not null check (role in ('worker', 'employer')),
  bank_code text not null,
  bank_name text not null,
  account_holder_name text not null,
  account_number_encrypted text not null,
  account_number_last4 text not null,
  is_primary boolean not null default true,
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verification_provider text,
  verification_reference text,
  verified_at timestamptz,
  rejection_reason text,
  funding_ready boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

create table if not exists public.payout_cycle (
  id uuid primary key default gen_random_uuid(),
  cycle_month text not null unique,
  nominal_pay_date date not null,
  adjusted_pay_date date not null,
  adjustment_reason text not null default 'none' check (adjustment_reason in ('none', 'weekend', 'federal_holiday')),
  holiday_source_version text not null,
  status text not null default 'draft' check (status in ('draft', 'generated', 'locked', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payout_item (
  id uuid primary key default gen_random_uuid(),
  payout_cycle_id uuid not null references public.payout_cycle(id) on delete cascade,
  worker_id uuid not null,
  employer_id uuid,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'MYR',
  scheduled_date date not null,
  status text not null default 'queued' check (status in ('queued', 'ready', 'scheduled', 'processed_internal', 'failed_internal', 'held')),
  source_refs jsonb,
  idempotency_key text not null unique,
  error_code text,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payout_audit (
  id uuid primary key default gen_random_uuid(),
  payout_item_id uuid not null references public.payout_item(id) on delete cascade,
  actor_type text not null check (actor_type in ('system', 'admin')),
  actor_id uuid,
  action text not null,
  from_status text,
  to_status text,
  notes text,
  metadata_json jsonb,
  created_at timestamptz not null default now()
);

alter table public.banking_details enable row level security;
alter table public.payout_cycle enable row level security;
alter table public.payout_item enable row level security;
alter table public.payout_audit enable row level security;

drop policy if exists banking_details_own_rw on public.banking_details;
create policy banking_details_own_rw
on public.banking_details
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists payout_item_worker_read on public.payout_item;
create policy payout_item_worker_read
on public.payout_item
for select
using (auth.uid() = worker_id);

drop policy if exists payout_item_employer_read on public.payout_item;
create policy payout_item_employer_read
on public.payout_item
for select
using (auth.uid() = employer_id);

drop policy if exists payout_cycle_read_authenticated on public.payout_cycle;
create policy payout_cycle_read_authenticated
on public.payout_cycle
for select
using (auth.role() = 'authenticated');

drop policy if exists payout_audit_read_authenticated on public.payout_audit;
create policy payout_audit_read_authenticated
on public.payout_audit
for select
using (auth.role() = 'authenticated');

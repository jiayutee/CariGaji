-- Public-safe profile (what employers may see when browsing applicants)
-- and a separate owner-only table for sensitive PII (IC number, DOB, address).

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  role text not null default 'worker' check (role in ('worker', 'employer', 'admin')),
  kyc_level text not null default 'Basic',
  reliability_score int not null default 0,
  rating numeric(2,1) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sensitive identity data — never exposed to other users.
create table if not exists public.user_private (
  id uuid primary key references auth.users(id) on delete cascade,
  identity_type text,
  id_number text,
  date_of_birth date,
  address text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.user_private enable row level security;

-- profiles: any signed-in user may READ (so employers can see applicants),
-- but only the owner may write their own row.
drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated
on public.profiles for select
to authenticated
using (true);

drop policy if exists profiles_owner_write on public.profiles;
create policy profiles_owner_write
on public.profiles for all
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- user_private: ONLY the owner (and admins) may read/write.
drop policy if exists user_private_owner_rw on public.user_private;
create policy user_private_owner_rw
on public.user_private for all
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists user_private_admin_read on public.user_private;
create policy user_private_admin_read
on public.user_private for select
to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

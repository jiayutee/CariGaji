-- SECURITY FIX for 20260725d: shifts.checkin_secret was fully readable by
-- anyone via the existing public shift-browsing policies (shifts_read_open
-- exposes every column of every open/filled/completed shift to any
-- authenticated user, and 20260704_public_shift_browsing.sql extends that
-- to anon). Confirmed live: an anonymous REST request could read the raw
-- secret for an open shift. RLS is row-level, not column-level, so putting
-- a secret in a publicly-readable table exposes it outright — anyone could
-- have derived valid check-in codes themselves, defeating the entire
-- anti-fraud point of this feature. Same bug class as the
-- cancellation_choice_deadline column-grant lesson (20260717f): a plain
-- column on a broadly-read/written table cannot be made secret via RLS or
-- column REVOKE (REVOKE cannot subtract from Supabase's table-level grant).
--
-- Fix: move the secret to its own table with NO select policy for anyone —
-- not even the owning employer. Only the two SECURITY DEFINER functions
-- touch it, since those run as the table owner and bypass RLS entirely.

create table if not exists public.shift_checkin_secrets (
  shift_id uuid primary key references public.shifts(id) on delete cascade,
  secret text not null default encode(gen_random_bytes(16), 'hex')
);

alter table public.shift_checkin_secrets enable row level security;
-- Deliberately no policies at all: RLS enabled + zero policies means even
-- the table owner's own client-side queries are denied by default; only
-- SECURITY DEFINER functions (which run as the table owner and bypass RLS)
-- can read or write this table.

insert into public.shift_checkin_secrets (shift_id, secret)
select id, checkin_secret from public.shifts
on conflict (shift_id) do nothing;

alter table public.shifts drop column if exists checkin_secret;

create or replace function public.get_shift_checkin_code(p_shift_id uuid)
returns table(code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_bucket bigint;
  v_is_employer boolean;
begin
  select exists (
    select 1 from public.shifts s where s.id = p_shift_id and s.employer_id = auth.uid()
  ) into v_is_employer;

  if not v_is_employer then
    raise exception 'not authorized or shift not found';
  end if;

  select secret into v_secret from public.shift_checkin_secrets where shift_id = p_shift_id;
  if v_secret is null then
    insert into public.shift_checkin_secrets (shift_id) values (p_shift_id)
    returning secret into v_secret;
  end if;

  v_bucket := floor(extract(epoch from now()) / 30);

  return query select
    lpad((abs((('x' || substr(encode(hmac(v_bucket::text, v_secret, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0'),
    to_timestamp((v_bucket + 1) * 30);
end;
$$;

revoke all on function public.get_shift_checkin_code(uuid) from public;
grant execute on function public.get_shift_checkin_code(uuid) to authenticated;

create or replace function public.worker_check_in(p_application_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app record;
  v_secret text;
  v_bucket bigint;
  v_expected text;
  v_matched boolean := false;
  v_offset int;
begin
  select a.id, a.worker_id, a.shift_id, a.status, a.worker_signed_at, a.checked_in_at,
         s.start_at, s.end_at
  into v_app
  from public.applications a
  join public.shifts s on s.id = a.shift_id
  where a.id = p_application_id
  for update of a;

  if v_app.id is null or v_app.worker_id is distinct from auth.uid() then
    raise exception 'application not found';
  end if;
  if v_app.status is distinct from 'accepted' or v_app.worker_signed_at is null then
    raise exception 'contract not signed';
  end if;
  if v_app.checked_in_at is not null then
    raise exception 'already checked in';
  end if;
  if now() < v_app.start_at - interval '2 hours' or now() > v_app.end_at + interval '2 hours' then
    raise exception 'outside the shift check-in window';
  end if;

  select secret into v_secret from public.shift_checkin_secrets where shift_id = v_app.shift_id;
  if v_secret is null then
    raise exception 'invalid or expired code';
  end if;

  v_bucket := floor(extract(epoch from now()) / 30);
  for v_offset in 0..1 loop
    v_expected := lpad((abs((('x' || substr(encode(hmac((v_bucket - v_offset)::text, v_secret, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0');
    if v_expected = p_code then
      v_matched := true;
      exit;
    end if;
  end loop;

  if not v_matched then
    raise exception 'invalid or expired code';
  end if;

  update public.applications set checked_in_at = now() where id = p_application_id;
  return true;
end;
$$;

revoke all on function public.worker_check_in(uuid, text) from public;
grant execute on function public.worker_check_in(uuid, text) to authenticated;

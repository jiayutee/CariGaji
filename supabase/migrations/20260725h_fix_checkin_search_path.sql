-- Third fix for check-in code derivation. Root cause finally identified:
-- both prior "function does not exist" errors (hmac, then digest) were
-- never about which pgcrypto functions are compiled in -- pgcrypto was
-- installed correctly the whole time. The real cause is `set search_path
-- = public` inside these SECURITY DEFINER functions, which excludes
-- whatever schema Supabase actually installed pgcrypto into (commonly
-- `extensions`, not `public`, on Supabase projects). Table column
-- DEFAULT expressions (like shift_checkin_secrets.secret using
-- gen_random_bytes()) evaluate under the session's normal search_path,
-- not the function-body-local one, which is why that default worked
-- fine while these functions' internal calls did not.
--
-- Fix: widen the function-local search_path to include both `public` and
-- `extensions`, covering whichever schema actually holds pgcrypto without
-- needing to guess and hardcode one.

create or replace function public.get_shift_checkin_code(p_shift_id uuid)
returns table(code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
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
    lpad((abs((('x' || substr(encode(digest(v_secret || ':' || v_bucket::text, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0'),
    to_timestamp((v_bucket + 1) * 30);
end;
$$;

create or replace function public.worker_check_in(p_application_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
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
    v_expected := lpad((abs((('x' || substr(encode(digest(v_secret || ':' || (v_bucket - v_offset)::text, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0');
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

-- Second fix for the check-in code derivation: hmac() itself is absent on
-- this Supabase project's pgcrypto build (confirmed live — neither the
-- text nor the bytea overload resolves, "function hmac(...) does not
-- exist" for both). digest() is the pgcrypto function that's universally
-- present (gen_random_bytes, already relied on elsewhere in this project,
-- confirms pgcrypto itself IS installed — just not this one function).
--
-- Switching to a salted SHA-256 digest of secret || ':' || time_bucket.
-- This isn't a textbook HMAC, but the threat model here doesn't need one:
-- the goal is "can't predict the code without knowing the secret", which a
-- keyed/salted digest satisfies for a 30-second rotating shift check-in
-- code — this is not a use case where HMAC's length-extension resistance
-- actually matters (the secret and bucket are hashed together as one
-- message with a fixed separator, not used as a MAC over attacker-supplied
-- data of variable length).

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
    lpad((abs((('x' || substr(encode(digest(v_secret || ':' || v_bucket::text, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0'),
    to_timestamp((v_bucket + 1) * 30);
end;
$$;

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

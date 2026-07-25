-- QR/code check-in (owner decision 2026-07-25, backlog item #7 of the
-- 07-24 consolidated reminder): rotating token, not a static reusable QR,
-- and payout is gated on a successful check-in.
--
-- Design: each shift gets a server-only random secret at creation. The
-- displayed code is derived deterministically from that secret + a 30-second
-- time bucket (HMAC-SHA256, truncated to 6 digits) -- classic TOTP-style
-- rotation, so nothing needs to be persisted per-tick and a photographed/
-- shared code goes stale within 30-60 seconds. Both the "generate for
-- display" and "verify on scan" paths run server-side via SECURITY DEFINER
-- RPCs so the secret itself is never sent to any client, including the
-- employer's.

alter table public.shifts
  add column if not exists checkin_secret text not null default encode(gen_random_bytes(16), 'hex');

alter table public.applications
  add column if not exists checked_in_at timestamptz;

-- Employer-only: current + previous-window codes (so a code shown right
-- before rotation is still valid for a few extra seconds instead of
-- flickering dead the instant a worker's camera focuses).
create or replace function public.get_shift_checkin_code(p_shift_id uuid)
returns table(code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_bucket bigint;
begin
  select checkin_secret into v_secret
  from public.shifts
  where id = p_shift_id and employer_id = auth.uid();

  if v_secret is null then
    raise exception 'not authorized or shift not found';
  end if;

  v_bucket := floor(extract(epoch from now()) / 30);

  return query select
    lpad((abs((('x' || substr(encode(hmac(v_bucket::text, v_secret, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0'),
    to_timestamp((v_bucket + 1) * 30);
end;
$$;

revoke all on function public.get_shift_checkin_code(uuid) from public;
grant execute on function public.get_shift_checkin_code(uuid) to authenticated;

-- Worker-only: verifies the submitted code against the current AND
-- previous 30s bucket (clock-skew / just-rotated tolerance), confirms the
-- application belongs to the caller, is accepted + contract-signed, and
-- the shift is actually happening (within a 2h window either side of
-- start_at, generous enough for early arrivals / late finishes without
-- accepting a check-in on an unrelated day).
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
         s.checkin_secret, s.start_at, s.end_at
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

  v_bucket := floor(extract(epoch from now()) / 30);
  for v_offset in 0..1 loop
    v_expected := lpad((abs((('x' || substr(encode(hmac((v_bucket - v_offset)::text, v_app.checkin_secret, 'sha256'), 'hex'), 1, 8))::bit(32)::int)::bigint) % 1000000)::text, 6, '0');
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

-- Security audit finding (2026-07-18, whole-app audit): the same
-- unrestricted-owner-write bug class already fixed for kyc_level
-- (20260714) and employer_verification_status (20260712b) was still open
-- on two more profiles columns, plus a sibling gap on applications and
-- messages found in the same pass.
--
-- 1. profiles.rating / profiles.reliability_score are shown to the other
--    party as the platform's core trust signal (carigaji-app.jsx:4047,
--    5143, 5952 etc.) but profiles_owner_write (20260704e) has no column
--    restriction and nothing computes these server-side yet (the Ratings
--    table feature is not built). A worker can PATCH their own profile
--    via REST and set rating=5.0, reliability_score=100 with zero real
--    history, defeating the trust mechanic employers hire on. Locking
--    both to admin-only until a real ratings-computation trigger ships.
--
-- 2. profiles.role has the same unrestricted-write gap. Server-side
--    impact is limited (admin gating uses the JWT claim, not this
--    column, and shift-posting is independently gated on
--    employer_verification_status) but it's the same bug class, and the
--    client only ever legitimately writes 'worker' or 'employer' at
--    sign-up (handleRegister, carigaji-app.jsx:8993). Mirrors the
--    guard_kyc_level allow-list pattern.
--
-- 3. applications.employer_signed_at was never added to
--    guard_application_status_transitions' (20260717g) column pins --
--    only status and worker_signed_at were covered. A worker responding
--    to their own offer could smuggle employer_signed_at into the same
--    UPDATE. Low impact (nothing financial keys off this column, per
--    20260717f/h) but same unpinned-column class; closing it while the
--    trigger is fresh.
--
-- 4. messages_sender_update (20260703d) lets the recipient update a
--    message row to set read_at, but has no column restriction, so a
--    recipient can also rewrite content/sender_id/created_at of a
--    message they received. Guarding to read_at-only.

create or replace function public.guard_profile_reputation_and_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  prior_rating numeric(2,1) := case when tg_op = 'INSERT' then 0 else old.rating end;
  prior_reliability int := case when tg_op = 'INSERT' then 0 else old.reliability_score end;
  prior_role text := case when tg_op = 'INSERT' then 'worker' else old.role end;
begin
  if is_admin then
    return new;
  end if;

  -- No client or scheduled-job write path exists yet for these two
  -- (Ratings table feature not built) -- pin to the prior/default value
  -- until a real server-side computation lands.
  if new.rating is distinct from prior_rating then
    new.rating := prior_rating;
  end if;
  if new.reliability_score is distinct from prior_reliability then
    new.reliability_score := prior_reliability;
  end if;

  -- Sign-up (handleRegister) only ever upserts 'worker' or 'employer' on
  -- the initial INSERT; anything else collapses to 'worker'. Once a row
  -- exists, role is permanently pinned for non-admins -- no worker<->
  -- employer flip after account creation, closing the gap the security
  -- reviewer found in an earlier draft of this guard (a not-in-allow-list
  -- check alone would still have permitted that flip).
  if tg_op = 'INSERT' then
    if new.role not in ('worker', 'employer') then
      new.role := 'worker';
    end if;
  else
    new.role := prior_role;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_reputation_and_role on public.profiles;
create trigger profiles_guard_reputation_and_role
before insert or update on public.profiles
for each row execute function public.guard_profile_reputation_and_role();

-- Extend the existing application-status guard to also pin
-- employer_signed_at, mirroring how it already pins worker_signed_at.
-- The trigger (trg_guard_application_status_transitions, 20260717g)
-- already points at this function name, so re-declaring the body here
-- is sufficient -- no trigger re-creation needed.
create or replace function public.guard_application_status_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
  is_trusted_write boolean := coalesce(current_setting('app.application_status_trusted_write', true), '') = 'true';
  is_worker boolean := auth.uid() = old.worker_id;
  is_employer boolean := exists (
    select 1 from public.shifts s where s.id = old.shift_id and s.employer_id = auth.uid()
  );
  legitimate boolean;
begin
  if is_admin or is_trusted_write then
    return new;
  end if;

  if new.status is distinct from old.status then
    legitimate := false;

    if is_worker then
      legitimate := (
        (old.status = 'pending' and new.status = 'withdrawn')
        or (old.status = 'offered' and new.status in ('accepted', 'rejected'))
        or (old.status = 'offered' and new.status = 'expired'
            and old.offer_expires_at is not null and old.offer_expires_at < now())
      );
    end if;

    if not legitimate and is_employer then
      legitimate := (
        (old.status in ('pending', 'shortlisted')
         and new.status in ('shortlisted', 'offered', 'accepted', 'rejected'))
        or (old.status = 'offered' and new.status = 'expired'
            and old.offer_expires_at is not null and old.offer_expires_at < now())
      );
    end if;

    if not legitimate then
      new.status := old.status;
    end if;
  end if;

  if new.worker_signed_at is distinct from old.worker_signed_at then
    if not (
      is_worker
      and old.worker_signed_at is null
      and new.worker_signed_at is not null
      and new.status = 'accepted'
    ) then
      new.worker_signed_at := old.worker_signed_at;
    end if;
  end if;

  -- New: only the shift's own employer may stamp employer_signed_at, only
  -- null -> now(), and only in the same statement that moves status to
  -- 'offered' (the real makeOffer flow, carigaji-app.jsx:6296-6299).
  if new.employer_signed_at is distinct from old.employer_signed_at then
    if not (
      is_employer
      and old.employer_signed_at is null
      and new.employer_signed_at is not null
      and new.status = 'offered'
    ) then
      new.employer_signed_at := old.employer_signed_at;
    end if;
  end if;

  return new;
end;
$$;

-- Restrict the recipient's message-update policy (messages_sender_update,
-- 20260703d) to read_at only -- everything else reverts to its prior
-- value for a non-admin, non-sender caller.
create or replace function public.guard_message_recipient_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
begin
  if is_admin or auth.uid() = old.sender_id then
    return new;
  end if;

  -- Recipient path: only read_at may change.
  new.id           := old.id;
  new.shift_id     := old.shift_id;
  new.sender_id    := old.sender_id;
  new.recipient_id := old.recipient_id;
  new.content      := old.content;
  new.created_at   := old.created_at;

  return new;
end;
$$;

drop trigger if exists trg_guard_message_recipient_update on public.messages;
create trigger trg_guard_message_recipient_update
before update on public.messages
for each row execute function public.guard_message_recipient_update();

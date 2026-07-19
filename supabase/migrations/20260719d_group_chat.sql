-- Per-shift group chat (owner decision 2026-07-19): the in-app chat becomes
-- ONE room per shift shared by the employer and every accepted worker,
-- replacing the per-pair 1:1 threads (workers who want a private word can
-- call/WhatsApp the employer off-platform). Group messages are rows with
-- recipient_id NULL; the old 1:1 policies stay so historic messages remain
-- readable, but the app no longer writes pair messages.
--
-- All membership checks live in SECURITY DEFINER helpers — the RLS-recursion
-- lesson from 20260717i/j: messages policies must not subquery
-- applications/shifts under the caller's RLS, and a worker could never see
-- a co-worker's application row anyway.

alter table public.messages alter column recipient_id drop not null;

-- Member of a shift's chat room: its employer, or an accepted worker.
create or replace function public.is_shift_chat_member(p_shift uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift and s.employer_id = auth.uid()
  )
  or exists (
    select 1 from public.applications a
    where a.shift_id = p_shift
      and a.worker_id = auth.uid()
      and a.status = 'accepted'
  );
$$;

-- Chat peer: someone who shares at least one shift room with the caller
-- (the employer of a shift I'm accepted on, a worker accepted on my shift,
-- or a co-worker accepted on the same shift). Used so chat can show real
-- sender names without widening general profile visibility.
create or replace function public.is_shift_chat_peer(p_other uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  -- caller is a worker; p_other employs a shift the caller is accepted on
  select exists (
    select 1 from public.applications a
    join public.shifts s on s.id = a.shift_id
    where a.worker_id = auth.uid() and a.status = 'accepted'
      and s.employer_id = p_other
  )
  -- caller is an employer; p_other is accepted on one of the caller's shifts
  or exists (
    select 1 from public.applications a
    join public.shifts s on s.id = a.shift_id
    where s.employer_id = auth.uid()
      and a.worker_id = p_other and a.status = 'accepted'
  )
  -- co-workers accepted on the same shift
  or exists (
    select 1 from public.applications a1
    join public.applications a2 on a2.shift_id = a1.shift_id
    where a1.worker_id = auth.uid() and a1.status = 'accepted'
      and a2.worker_id = p_other and a2.status = 'accepted'
  );
$$;

revoke all on function public.is_shift_chat_member(uuid) from public;
revoke all on function public.is_shift_chat_peer(uuid) from public;
grant execute on function public.is_shift_chat_member(uuid) to authenticated;
grant execute on function public.is_shift_chat_peer(uuid) to authenticated;

drop policy if exists messages_group_read on public.messages;
create policy messages_group_read
  on public.messages for select to authenticated
  using (
    recipient_id is null
    and public.is_shift_chat_member(shift_id)
  );

drop policy if exists messages_group_insert on public.messages;
create policy messages_group_insert
  on public.messages for insert to authenticated
  with check (
    auth.uid() = sender_id
    and recipient_id is null
    and public.is_shift_chat_member(shift_id)
  );

-- Chat needs to show who said what: let room members read each other's
-- profile row (name + public reputation fields, same exposure the
-- employer-of-applicant policy already grants).
drop policy if exists profiles_read_by_shift_chat_peer on public.profiles;
create policy profiles_read_by_shift_chat_peer
  on public.profiles for select to authenticated
  using (public.is_shift_chat_peer(id));

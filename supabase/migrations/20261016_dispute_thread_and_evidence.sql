-- Disputes: a conversation both sides can see, with evidence.
--
-- Until now a dispute was one text box. Both parties could already READ it
-- (disputes_owner_read), but nothing told the other side it existed, neither could
-- answer, no file could be attached, and the admin's reasoning lived in an
-- `admin_notes` column that the same read policy exposes to both parties.
--
-- This adds:
--   * dispute_messages      - the thread. is_internal rows are admin-only notes.
--   * dispute_attachments   - photos / PDFs, private bucket `dispute-evidence`.
--   * disputes.resolution_note  - the outcome, written FOR both parties to read.
--   * status 'awaiting_info' (+ awaiting_role): admin asked one side for more.
--   * category 'review_report' (+ rating_id): a rated person challenging a review.
--   * notifications: counterparty on filing, both on new messages / status changes.
--
-- Evidence retention: keep for 12 months after resolution. There is deliberately no
-- automatic purge yet (deleting storage objects from SQL orphans the files); the
-- owner decides when to add one.

-- 1. helpers --------------------------------------------------------------------
create or replace function public.is_app_admin()
returns boolean
language sql
stable
as $$ select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin' $$;

-- Participation is a security-definer function, not an inline subquery, so the
-- new tables' policies cannot recurse through applications/shifts policies.
create or replace function public.is_dispute_party(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.disputes d
    join public.applications a on a.id = d.application_id
    join public.shifts s on s.id = a.shift_id
    where d.id = p_dispute_id
      and (a.worker_id = auth.uid() or s.employer_id = auth.uid())
  )
$$;

create or replace function public.dispute_is_open(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.disputes d
    where d.id = p_dispute_id and d.status in ('open', 'under_review', 'awaiting_info')
  )
$$;

-- 2. disputes: new columns and widened checks ------------------------------------
alter table public.disputes
  add column if not exists awaiting_role text,
  add column if not exists resolution_note text,
  add column if not exists rating_id uuid references public.ratings(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.disputes drop constraint if exists disputes_status_check;
alter table public.disputes add constraint disputes_status_check
  check (status in ('open', 'under_review', 'awaiting_info', 'resolved', 'dismissed'));

alter table public.disputes drop constraint if exists disputes_category_check;
alter table public.disputes add constraint disputes_category_check
  check (category in ('hours_disputed', 'no_show_claim', 'unsafe_conditions', 'payment_issue', 'other', 'review_report'));

alter table public.disputes drop constraint if exists disputes_awaiting_role_check;
alter table public.disputes add constraint disputes_awaiting_role_check
  check (awaiting_role is null or awaiting_role in ('worker', 'employer'));

-- 3. thread ------------------------------------------------------------------------
create table if not exists public.dispute_messages (
  id          uuid primary key default gen_random_uuid(),
  dispute_id  uuid not null references public.disputes(id) on delete cascade,
  author_id   uuid not null references auth.users(id),
  author_role text not null check (author_role in ('worker', 'employer', 'admin')),
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  is_internal boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists dispute_messages_dispute_idx on public.dispute_messages (dispute_id, created_at);

create table if not exists public.dispute_attachments (
  id           uuid primary key default gen_random_uuid(),
  dispute_id   uuid not null references public.disputes(id) on delete cascade,
  message_id   uuid references public.dispute_messages(id) on delete cascade,  -- null = attached to the original filing
  uploader_id  uuid not null references auth.users(id),
  storage_path text not null unique,
  file_name    text not null check (char_length(file_name) between 1 and 200),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  created_at   timestamptz not null default now(),
  constraint dispute_attachments_path_in_dispute check (storage_path like dispute_id::text || '/%')
);
create index if not exists dispute_attachments_dispute_idx on public.dispute_attachments (dispute_id, created_at);

-- Carry the old admin notes over as internal messages BEFORE the triggers below
-- exist (they would overwrite the author role), then clear the column that both
-- parties could read.
insert into public.dispute_messages (dispute_id, author_id, author_role, body, is_internal, created_at)
select d.id, coalesce(d.resolved_by, d.filed_by), 'admin', left(d.admin_notes, 2000), true, coalesce(d.resolved_at, d.created_at)
from public.disputes d
where nullif(btrim(coalesce(d.admin_notes, '')), '') is not null;

update public.disputes set admin_notes = null where admin_notes is not null;

-- 4. RLS -----------------------------------------------------------------------------
alter table public.dispute_messages enable row level security;
alter table public.dispute_attachments enable row level security;

drop policy if exists dispute_messages_read on public.dispute_messages;
create policy dispute_messages_read on public.dispute_messages for select to authenticated
  using ((public.is_dispute_party(dispute_id) and not is_internal) or public.is_app_admin());

drop policy if exists dispute_messages_insert on public.dispute_messages;
create policy dispute_messages_insert on public.dispute_messages for insert to authenticated
  with check (
    author_id = auth.uid()
    and (
      (public.is_dispute_party(dispute_id) and not is_internal and public.dispute_is_open(dispute_id))
      or public.is_app_admin()
    )
  );

drop policy if exists dispute_attachments_read on public.dispute_attachments;
create policy dispute_attachments_read on public.dispute_attachments for select to authenticated
  using (public.is_dispute_party(dispute_id) or public.is_app_admin());

drop policy if exists dispute_attachments_insert on public.dispute_attachments;
create policy dispute_attachments_insert on public.dispute_attachments for insert to authenticated
  with check (
    uploader_id = auth.uid()
    and ((public.is_dispute_party(dispute_id) and public.dispute_is_open(dispute_id)) or public.is_app_admin())
  );
-- No UPDATE or DELETE policies: what was said and shown stays on the record.

-- 5. private bucket ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dispute-evidence', 'dispute-evidence', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

-- The first path segment is the dispute id; everything else follows from it.
create or replace function public.dispute_file_access(p_path text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  begin
    v_id := (split_part(p_path, '/', 1))::uuid;
  exception when others then
    return false;
  end;
  if public.is_app_admin() then return true; end if;
  if not public.is_dispute_party(v_id) then return false; end if;
  if p_write and not public.dispute_is_open(v_id) then return false; end if;
  return true;
end;
$$;

drop policy if exists dispute_evidence_read on storage.objects;
create policy dispute_evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'dispute-evidence' and public.dispute_file_access(name, false));

drop policy if exists dispute_evidence_write on storage.objects;
create policy dispute_evidence_write on storage.objects for insert to authenticated
  with check (bucket_id = 'dispute-evidence' and public.dispute_file_access(name, true));

-- 6. notification types -------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array[
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled', 'shift_offer', 'offer_confirmed',
    'offer_declined_or_expired', 'not_selected', 'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed', 'shift_updated', 'shift_terms_changed', 'worker_withdrew',
    'slot_reopened', 'marked_no_show', 'payout_created', 'shift_hours_modification_proposed',
    'shift_hours_modification_rejected', 'attendance_missed_checkin', 'attendance_employer_missed_checkin',
    'attendance_request', 'attendance_request_reminder', 'attendance_request_approved', 'attendance_request_declined',
    'attendance_checkout_reminder', 'attendance_checkout_window_closed', 'attendance_employer_not_checked_out',
    'shift_hours_submitted_on_behalf', 'hours_confirmation_reminder', 'hours_awaiting_employer', 'no_show_reversed',
    'attendance_admin_ruling',
    'dispute_filed', 'dispute_message', 'dispute_status', 'review_visibility'
  ]::text[]));

-- 7. triggers (side effects never abort the user's write) --------------------------------------
create or replace function public.dispute_message_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker uuid;
  v_employer uuid;
begin
  if public.is_app_admin() then
    new.author_role := 'admin';
  else
    select a.worker_id, s.employer_id into v_worker, v_employer
    from public.disputes d
    join public.applications a on a.id = d.application_id
    join public.shifts s on s.id = a.shift_id
    where d.id = new.dispute_id;
    new.author_role := case
      when auth.uid() = v_worker then 'worker'
      when auth.uid() = v_employer then 'employer'
      else null end;
    new.is_internal := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dispute_message_before_insert on public.dispute_messages;
create trigger trg_dispute_message_before_insert before insert on public.dispute_messages
  for each row execute function public.dispute_message_before_insert();

create or replace function public.dispute_message_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  if new.is_internal then return null; end if;

  select d.status, d.awaiting_role, a.worker_id, s.employer_id, s.title
  into v
  from public.disputes d
  join public.applications a on a.id = d.application_id
  join public.shifts s on s.id = a.shift_id
  where d.id = new.dispute_id;

  -- The side that was asked for more has now answered: back to the team.
  if v.status = 'awaiting_info' and v.awaiting_role = new.author_role then
    update public.disputes set status = 'under_review', awaiting_role = null where id = new.dispute_id;
  end if;

  if new.author_role <> 'worker' then
    perform public.notify_safe(v.worker_id, 'dispute_message', 'New message on your dispute',
      'There is a new message on your dispute about "' || coalesce(v.title, 'a shift') || '".',
      '/worker/disputes/' || new.dispute_id,
      jsonb_build_object('shift_title', coalesce(v.title, 'a shift'),
                         'variant', case when new.author_role = 'admin' then 'admin' else 'party' end));
  end if;
  if new.author_role <> 'employer' then
    perform public.notify_safe(v.employer_id, 'dispute_message', 'New message on your dispute',
      'There is a new message on your dispute about "' || coalesce(v.title, 'a shift') || '".',
      '/employer/disputes/' || new.dispute_id,
      jsonb_build_object('shift_title', coalesce(v.title, 'a shift'),
                         'variant', case when new.author_role = 'admin' then 'admin' else 'party' end));
  end if;
  return null;
exception when others then
  raise warning 'dispute_message_after_insert failed: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_dispute_message_after_insert on public.dispute_messages;
create trigger trg_dispute_message_after_insert after insert on public.dispute_messages
  for each row execute function public.dispute_message_after_insert();

create or replace function public.dispute_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  v_target uuid;
  v_portal text;
begin
  select a.worker_id, s.employer_id, s.title into v
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = new.application_id;

  if new.filed_by_role = 'worker' then
    v_target := v.employer_id; v_portal := 'employer';
  else
    v_target := v.worker_id; v_portal := 'worker';
  end if;

  perform public.notify_safe(v_target, 'dispute_filed',
    case when new.category = 'review_report' then 'A review you wrote was reported' else 'A dispute was filed about your shift' end,
    case when new.category = 'review_report'
         then 'Your review for "' || coalesce(v.title, 'a shift') || '" was reported. You can add your side and any evidence.'
         else 'A dispute was filed about "' || coalesce(v.title, 'a shift') || '". You can add your side and any evidence.' end,
    '/' || v_portal || '/disputes/' || new.id,
    jsonb_build_object('shift_title', coalesce(v.title, 'a shift'),
                       'variant', case when new.category = 'review_report' then 'review' else 'standard' end));
  return null;
exception when others then
  raise warning 'dispute_after_insert failed: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_dispute_after_insert on public.disputes;
create trigger trg_dispute_after_insert after insert on public.disputes
  for each row execute function public.dispute_after_insert();

create or replace function public.dispute_before_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.status is distinct from 'awaiting_info' then
    new.awaiting_role := null;
  end if;
  if new.status in ('resolved', 'dismissed') and new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dispute_before_update on public.disputes;
create trigger trg_dispute_before_update before update on public.disputes
  for each row execute function public.dispute_before_update();

create or replace function public.dispute_after_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  v_variant text;
  v_params jsonb;
begin
  -- The automatic "they answered" step is not news to anyone.
  if old.status = 'awaiting_info' and new.status = 'under_review' then return null; end if;

  select a.worker_id, s.employer_id, s.title into v
  from public.applications a join public.shifts s on s.id = a.shift_id
  where a.id = new.application_id;

  v_variant := new.status;
  v_params := jsonb_build_object('shift_title', coalesce(v.title, 'a shift'), 'variant', v_variant,
                                 'note', coalesce(new.resolution_note, ''));

  if new.status = 'awaiting_info' then
    if new.awaiting_role = 'worker' then
      perform public.notify_safe(v.worker_id, 'dispute_status', 'We need more information',
        'The team needs more information from you about the dispute for "' || coalesce(v.title, 'a shift') || '".',
        '/worker/disputes/' || new.id, v_params);
    elsif new.awaiting_role = 'employer' then
      perform public.notify_safe(v.employer_id, 'dispute_status', 'We need more information',
        'The team needs more information from you about the dispute for "' || coalesce(v.title, 'a shift') || '".',
        '/employer/disputes/' || new.id, v_params);
    end if;
  elsif new.status in ('under_review', 'resolved', 'dismissed') then
    perform public.notify_safe(v.worker_id, 'dispute_status', 'Your dispute was updated',
      'The dispute about "' || coalesce(v.title, 'a shift') || '" is now ' || replace(new.status, '_', ' ') || '.',
      '/worker/disputes/' || new.id, v_params);
    perform public.notify_safe(v.employer_id, 'dispute_status', 'Your dispute was updated',
      'The dispute about "' || coalesce(v.title, 'a shift') || '" is now ' || replace(new.status, '_', ' ') || '.',
      '/employer/disputes/' || new.id, v_params);
  end if;
  return null;
exception when others then
  raise warning 'dispute_after_status_change failed: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_dispute_after_status_change on public.disputes;
create trigger trg_dispute_after_status_change after update of status on public.disputes
  for each row when (old.status is distinct from new.status)
  execute function public.dispute_after_status_change();

-- A runaway upload loop cannot fill the bucket: 30 files per dispute.
create or replace function public.dispute_attachment_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.dispute_attachments where dispute_id = new.dispute_id) >= 30 then
    raise exception 'A dispute can hold at most 30 files';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dispute_attachment_cap on public.dispute_attachments;
create trigger trg_dispute_attachment_cap before insert on public.dispute_attachments
  for each row execute function public.dispute_attachment_cap();

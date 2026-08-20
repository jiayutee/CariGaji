-- Clear notifications belonging to the four QA accounts whose shift or
-- application no longer exists.
--
-- These are the residue of months of purged test shifts: notifications carry no
-- FK to shifts or applications, so nothing ever cascaded them away. 135 of the
-- 194 notifications on these accounts now point at rows that are gone, which
-- makes the notification bell almost entirely tombstones and the Friday
-- dogfood pass hard to read.
--
-- This is deliberately NOT a general cleanup, and must not become one. Tombstone
-- rendering exists because "you were selected for this shift" is true and
-- happened; erasing a real worker's copy when an employer deletes a posting
-- quietly rewrites their history. That reasoning holds for every real account.
-- It does not hold for four QA accounts whose "history" is test runs.
--
-- Hence the account allowlist below is the safety boundary. Rows are matched
-- only when the account is one of the four, the link is a well-formed
-- shift/application link, and the target genuinely does not exist. A
-- notification with no link, an unrecognised link, or a live target is left
-- alone.

do $cleanup$
declare
  v_users uuid[] := array[
    '13e3a2d8-40fa-472f-8ca4-18c8361dbbd0',   -- worker  jiayutee97+qaworker1
    '1ad212f6-5f29-41cb-b60f-2c9159915ab6',   -- worker  jiayutee97+qaworker2
    '2d8f78c4-fa12-4593-970c-57da3dea487a',   -- employer jiayutee97+qaemployer2
    '5262571e-c068-4f43-acae-9c8bd9a3a4cf'    -- employer jiayutee97+qaemployer1b
  ]::uuid[];
  v_before int;
  v_deleted int;
  v_left int;
  v_kept int;
begin
  select count(*) into v_before
  from public.notifications where user_id = any(v_users);

  with dead as (
    select n.id
    from public.notifications n
    where n.user_id = any(v_users)
      and n.link ~ '^/(worker|employer)/(shifts|applications)/[0-9a-f-]{36}$'
      and case split_part(n.link, '/', 3)
            when 'shifts' then
              not exists (select 1 from public.shifts s
                          where s.id = split_part(n.link, '/', 4)::uuid)
            else
              not exists (select 1 from public.applications a
                          where a.id = split_part(n.link, '/', 4)::uuid)
          end
  )
  delete from public.notifications n using dead d where n.id = d.id;
  get diagnostics v_deleted = row_count;

  -- Nothing should remain that matches the same predicate.
  select count(*) into v_left
  from public.notifications n
  where n.user_id = any(v_users)
    and n.link ~ '^/(worker|employer)/(shifts|applications)/[0-9a-f-]{36}$'
    and case split_part(n.link, '/', 3)
          when 'shifts' then
            not exists (select 1 from public.shifts s
                        where s.id = split_part(n.link, '/', 4)::uuid)
          else
            not exists (select 1 from public.applications a
                        where a.id = split_part(n.link, '/', 4)::uuid)
        end;
  if v_left > 0 then
    raise exception '% dead-link notification(s) survived', v_left;
  end if;

  select count(*) into v_kept
  from public.notifications where user_id = any(v_users);

  raise notice 'QA notifications: % before, % deleted, % kept (all still resolving)',
    v_before, v_deleted, v_kept;
end
$cleanup$;

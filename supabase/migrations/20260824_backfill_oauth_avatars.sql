-- "I can't see anyone's profile picture" (2026-08-24). Same root cause as the
-- full_name backfill in 20260719c, one column over: OAuth sign-up never writes
-- to `profiles` at all. Google and Facebook hand us a picture URL at sign-in
-- and GoTrue stores it in auth.users.raw_user_meta_data -- which no other user
-- can read. `profiles.avatar_url` is the only avatar source anyone else can
-- see, so an OAuth account shows its photo to itself and initials to everyone
-- else, forever.
--
-- The client now mirrors this at sign-in, but that only heals an account once
-- THAT user next signs in on a build containing the fix (exactly the gap
-- 20260719c called out for names). Backfill everyone server-side, once.
--
-- Google puts the URL in `avatar_url`, Facebook in `picture`. Both are
-- absolute https URLs; getAvatarUrl() passes those through untouched instead
-- of resolving them against the storage bucket, so no file is needed.
--
-- avatar_url is not pinned by guard_profile_* (the guards protect
-- rating/reliability_score/role/verification state), so no bypass is needed.

update public.profiles p
set avatar_url = btrim(coalesce(
      u.raw_user_meta_data ->> 'avatar_url',
      u.raw_user_meta_data ->> 'picture'
    )),
    updated_at = now()
from auth.users u
where u.id = p.id
  and p.avatar_url is null
  and btrim(coalesce(
      u.raw_user_meta_data ->> 'avatar_url',
      u.raw_user_meta_data ->> 'picture',
      '')) <> ''
  -- Only absolute URLs. A bare storage path in metadata means the file was
  -- uploaded through the app, and the upload already wrote profiles; copying
  -- a stale path here would point at an object that may not exist.
  and btrim(coalesce(
      u.raw_user_meta_data ->> 'avatar_url',
      u.raw_user_meta_data ->> 'picture'
    )) like 'http%';

-- Report what happened so the result is visible in the SQL editor.
do $$
declare
  v_filled  int;
  v_still   int;
  v_storage int;
begin
  select count(*) into v_filled  from public.profiles where avatar_url is not null;
  select count(*) into v_still   from public.profiles where avatar_url is null;
  select count(*) into v_storage from storage.objects where bucket_id = 'avatars';
  raise notice 'profiles WITH an avatar now: %', v_filled;
  raise notice 'profiles still without one:  % (these accounts have no photo anywhere -- email signup, no upload)', v_still;
  raise notice 'files in the avatars bucket: %', v_storage;
end $$;

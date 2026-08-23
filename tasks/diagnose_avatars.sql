-- Read-only. Answers, per account: is there a photo file in storage, is the
-- path recorded on profiles, and is it recorded in auth metadata -- which is
-- the ONLY one the app reads when drawing your own avatar.
select
  p.id,
  p.full_name,
  p.role,
  p.avatar_url                                   as profiles_avatar_url,
  u.raw_user_meta_data ->> 'avatar_url'          as auth_metadata_avatar_url,
  o.name                                         as storage_object,
  o.created_at                                   as uploaded_at,
  case
    when o.name is null                                          then 'no file uploaded'
    when p.avatar_url is null                                    then 'file exists, profiles NOT set'
    when u.raw_user_meta_data ->> 'avatar_url' is null           then 'file exists, auth metadata NOT set  <-- own avatar shows initials'
    else 'ok'
  end as verdict
from public.profiles p
join auth.users u on u.id = p.id
left join storage.objects o
  on o.bucket_id = 'avatars' and o.name = p.id::text || '/avatar.jpg'
order by (o.name is not null) desc, p.full_name;

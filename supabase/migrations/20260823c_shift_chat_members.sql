-- Who is in this shift's chat room.
--
-- The room is the employer plus every accepted worker (20260719d), but no
-- client can work that out for itself: a worker sees only their OWN
-- application row, so co-workers are invisible to them by design -- and rightly
-- so, since applications carries wage_ask and status, which competing bidders
-- have no business reading.
--
-- So membership is answered by a SECURITY DEFINER function that returns names
-- and roles only, never bids. Same pattern and same reasoning as
-- is_shift_chat_member / is_shift_chat_peer in 20260719d, which exist because
-- policies that subquery applications under the caller's own RLS recurse
-- (20260717i/j).
--
-- Authorisation is the room's own membership rule: if you cannot read the
-- room's messages, you cannot list its people. Reusing is_shift_chat_member
-- rather than restating the condition means the two can never drift apart.

create or replace function public.shift_chat_members(p_shift uuid)
returns table (
  user_id     uuid,
  full_name   text,
  role        text,      -- 'employer' | 'worker'
  avatar_url  text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, coalesce(p.full_name, 'Member')::text, 'employer'::text, p.avatar_url
  from public.shifts s
  join public.profiles p on p.id = s.employer_id
  where s.id = p_shift
    and public.is_shift_chat_member(p_shift)

  union all

  select p.id, coalesce(p.full_name, 'Member')::text, 'worker'::text, p.avatar_url
  from public.applications a
  join public.profiles p on p.id = a.worker_id
  where a.shift_id = p_shift
    and a.status = 'accepted'
    and public.is_shift_chat_member(p_shift)
  order by 3 desc, 2;      -- employer first, then workers by name
$$;

revoke all on function public.shift_chat_members(uuid) from public;
grant execute on function public.shift_chat_members(uuid) to authenticated;

-- A non-member gets an empty list rather than an error: the function is a
-- lookup, and "you are not in this room" and "this room has nobody" are the
-- same answer from outside. It leaks nothing either way.

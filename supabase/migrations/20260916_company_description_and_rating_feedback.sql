-- 1. Employers can describe their company (shown to workers on the shift page
--    and the employer's profile). 2. Ratings can carry an optional comment.
-- Applied to production 2026-09-19 via the Supabase MCP.

alter table public.profiles
  add column if not exists company_description text
  check (company_description is null or char_length(company_description) <= 500);

-- Written ratings were put ON HOLD as public REVIEWS (tasks/todo.md, 2026-09-12:
-- needs moderation, a content policy and a legal read). This is FEEDBACK
-- instead: ratings rows are readable only by the rater and the rated person
-- (ratings_participant_read), and get_ratee_ratings -- the only public read --
-- does not return this column. Do not add it to that function without
-- revisiting that decision.
alter table public.ratings
  add column if not exists comment text
  check (comment is null or char_length(comment) <= 500);

-- Public read of an employer's own "about us" text (shift page for signed-out
-- visitors too). Returns ONLY that field: profiles is not readable by anon and
-- this must not become a back door to other columns.
create or replace function public.get_employer_about(p_employer_ids uuid[])
returns table(id uuid, company_description text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, nullif(trim(p.company_description), '')
  from public.profiles p
  where p.id = any (p_employer_ids) and p.role = 'employer';
$$;

revoke all on function public.get_employer_about(uuid[]) from public;
grant execute on function public.get_employer_about(uuid[]) to anon, authenticated;

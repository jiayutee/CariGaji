-- The pre-existing applications_employer_update policy's WITH CHECK only
-- allowed employers to set status to 'shortlisted'/'accepted'/'rejected' —
-- 'offered' (the new hiring-workflow step where the employer selects a
-- candidate) was never added, so every employer "Select" action was
-- silently blocked by RLS. Idempotent.

drop policy if exists applications_employer_update on public.applications;
create policy applications_employer_update
  on public.applications for update to authenticated
  using (exists (
    select 1 from public.shifts s
    where s.id = shift_id and s.employer_id = auth.uid()
  ))
  with check (
    status in ('shortlisted', 'offered', 'accepted', 'rejected')
    and exists (
      select 1 from public.shifts s
      where s.id = shift_id and s.employer_id = auth.uid()
    )
  );

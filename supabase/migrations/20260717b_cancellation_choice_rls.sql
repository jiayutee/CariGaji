-- RLS for the late-cancellation choice flow, following the exact narrow
-- single-purpose style already used for applications_worker_respond_offer /
-- applications_expire_offer.

-- Worker sets their choice exactly once, only while a deadline has been
-- stamped (i.e. this application was actually flagged for the choice) and
-- no choice has been made yet.
drop policy if exists applications_worker_cancellation_choice on public.applications;
create policy applications_worker_cancellation_choice
  on public.applications for update to authenticated
  using (
    auth.uid() = worker_id
    and cancellation_choice_deadline is not null
    and cancellation_choice is null
  )
  with check (
    auth.uid() = worker_id
    and cancellation_choice in ('contract_50', 'show_up_100')
  );

-- Worker attaches proof exactly once, only after choosing the show-up path
-- and before proof has already been recorded.
drop policy if exists applications_worker_cancellation_proof on public.applications;
create policy applications_worker_cancellation_proof
  on public.applications for update to authenticated
  using (
    auth.uid() = worker_id
    and cancellation_choice = 'show_up_100'
    and cancellation_proof_path is null
  )
  with check (
    auth.uid() = worker_id
    and cancellation_proof_path is not null
  );

-- Lazy-expiry sweep (mirrors applications_expire_offer): either party may
-- default an unanswered row to the 50% contract path once the deadline has
-- passed. Worker-favorable default since the employer caused the
-- cancellation, not the worker.
drop policy if exists applications_cancellation_choice_expire on public.applications;
create policy applications_cancellation_choice_expire
  on public.applications for update to authenticated
  using (
    cancellation_choice_deadline is not null
    and cancellation_choice_deadline < now()
    and cancellation_choice is null
    and (
      auth.uid() = worker_id
      or exists (select 1 from public.shifts s where s.id = shift_id and s.employer_id = auth.uid())
    )
  )
  with check (cancellation_choice = 'contract_50');

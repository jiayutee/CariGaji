-- Close the UI-only gate on shift posting: the client's guardPosting() check
-- (added alongside 20260712b_employer_verification.sql) only stops the button
-- click. shifts_employer_insert's with-check never referenced
-- employer_verification_status, so an unverified employer could still
-- INSERT a shift directly via REST (auth.uid() = employer_id was the only
-- condition) and have it appear in the public shifts_read_open listing.
-- This ties the actual write to the same 'verified' status the UI gate
-- displays, same bug class as the kyc_level / employer_verification_status
-- self-forge fixes in 20260712b and 20260714.
--
-- Depends on 20260712b_employer_verification.sql (profiles.employer_verification_status).
-- Requires that migration to already be applied.

drop policy if exists shifts_employer_insert on public.shifts;

create policy shifts_employer_insert
  on public.shifts for insert to authenticated
  with check (
    auth.uid() = employer_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.employer_verification_status = 'verified'
    )
  );

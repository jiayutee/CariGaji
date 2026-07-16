-- Late shift-cancellation compensation flow: when an employer cancels a
-- shift within 24h of start, each confirmed (accepted + signed) worker gets
-- a choice between a 50% cancellation payout (no show-up needed) or a 100%
-- payout if they show up and submit proof. Deliberately kept as new
-- nullable columns rather than new `application_status` enum values, to
-- avoid the "can't use a new enum value in the same transaction it was
-- added in" issue this project hit before (see 20260705d).
alter table public.applications
  add column if not exists cancellation_choice text check (cancellation_choice in ('contract_50', 'show_up_100')),
  add column if not exists cancellation_choice_deadline timestamptz,
  add column if not exists cancellation_choice_made_at timestamptz,
  add column if not exists cancellation_proof_path text;

-- Cancellation payouts aren't part of a monthly payout_cycle — confirmed via
-- codebase search that no query anywhere joins or aggregates on
-- payout_cycle_id, so relaxing this is safe.
alter table public.payout_item
  alter column payout_cycle_id drop not null;

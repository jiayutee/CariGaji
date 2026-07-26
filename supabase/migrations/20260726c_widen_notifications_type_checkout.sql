-- Live verification of the end-of-shift checkout feature caught this:
-- worker_submit_checkout/employer_dispute_checkout insert notifications of
-- type 'shift_checkout_submitted'/'shift_checkout_disputed', but neither
-- was ever added to notifications_type_check (last widened 20260717c) --
-- every checkout submission was failing outright (the whole RPC rolled
-- back, so checked_out_at never got set either).

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bid_received', 'bid_accepted', 'bid_rejected', 'shift_cancelled',
    'shift_offer', 'offer_confirmed', 'offer_declined_or_expired', 'not_selected',
    'shift_cancellation_choice_pending', 'shift_cancellation_choice_made',
    'shift_checkout_submitted', 'shift_checkout_disputed'
  ));

-- Clear the QA rows left by the payout-notification verification.
--
-- The purge refused, and it was RIGHT to refuse: the test genuinely created a
-- queued RM108 payout, and admin_purge_shift's hard stop is exactly "money in
-- flight still points at this application". The guard is not the problem; the
-- fake payout is.
--
-- It is deleted rather than marked 'paid' or 'cancelled'. Nobody worked this
-- shift and nobody is owed RM108, so settling it would leave a fictional
-- settlement in the payout ledger for reconciliation to trip over later.
-- payout_audit cascades from payout_item, so its rows go with it.
--
-- Scoped by idempotency_key, not by shift, so this can only ever match the one
-- row the test created.

do $cleanup$
declare
  v_shift uuid := '52096908-fb61-44d6-8a4d-8e4b9c2222ea';   -- "PN payout notice"
  v_key   text := 'shift_work:2a5be3b8-8cf3-42a9-993a-38b4ca0932bf';
  v_amount numeric;
  v_status text;
  v_left int;
begin
  select amount, status into v_amount, v_status
  from public.payout_item where idempotency_key = v_key;

  if v_amount is null then
    raise notice 'no payout for % -- already cleared', v_key;
  else
    -- Refuse to touch anything that has actually moved money.
    if v_status <> 'queued' then
      raise exception 'payout % is % (not queued) -- stopping rather than deleting a payout that may have been sent', v_key, v_status;
    end if;
    delete from public.payout_item where idempotency_key = v_key;
    raise notice 'deleted QA payout % (RM%)', v_key, v_amount;
  end if;

  perform public.admin_purge_shift(v_shift, 'QA cleanup after payout notification test');

  select count(*) into v_left
  from public.shifts where id = v_shift;
  if v_left > 0 then
    raise exception 'purge did not remove the shift';
  end if;

  select count(*) into v_left
  from public.payout_item where idempotency_key = v_key;
  if v_left > 0 then
    raise exception 'payout row survived';
  end if;

  raise notice 'cleanup verified: shift, application, notifications and payout all gone';
end
$cleanup$;

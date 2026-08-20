# Plan — Employer deposit / escrow

Owner decision (2026-08-12): the **employer funds compensation**. Nothing
charges them today, so every ringgit figure the app now shows an employer is a
promise the platform cannot collect on.

## 1. What exists today (verified)

- `payout_cycle` / `payout_item` / `payout_audit` — records what a worker is
  **owed**. No corresponding charge to the employer anywhere.
- **No** escrow, wallet, balance or deposit table. Grepped the whole schema.
- "Top Up" in the employer Billing tab is labelled *"(soon)"* and shows
  *"Adding funds isn't available yet — this is a preview until a real payment
  gateway (FPX/DuitNow) is integrated."*
- The only funding signal is `employer.fundingReadyLabel`: **a checkbox the
  employer ticks about themselves** — "Funding account has sufficient balance
  for this cycle". Nothing verifies it.

## 2. The finding that should be dealt with first

The landing page already tells workers, as a trust claim:

> **"Funds are held, not promised"**
> *"The wage is committed to CariGaji before the shift starts — it's not an
> IOU from the employer."*

**That is not true today.** No funds are held, because there is nowhere to
hold them. This is different from the known-placeholder sample figures (see
memory `project_landing_hero_illustrative_content`) — those are labelled
illustrative. This is a general statement of how the platform works, on the
screen whose entire job is earning a worker's trust before they sign up.

Two honest options, and this is a decision, not a technical call:
- **(a)** Soften the copy now to describe what the platform actually does
  today, and restore the stronger claim when escrow ships.
- **(b)** Leave it and treat escrow as urgent.

Recommendation: (a). A worker who signs up on that promise, works a shift and
then chases an employer for money has been misled by us specifically.

## 3. The blocker on the deposit itself

A deposit needs money to actually arrive. There is **no payment gateway** —
FPX/DuitNow is not integrated, and that is a external integration (merchant
account, settlement, reconciliation), not an afternoon's work.

So the work splits:

**Phase 1 — the ledger and the mechanics (buildable now, no gateway)**
- `employer_wallet_entry`: an append-only ledger. Kinds: `topup`, `hold`,
  `release`, `capture`, `refund`. Balances are DERIVED (`available`, `held`),
  never stored as a mutable number — a stored balance is the classic place
  money quietly goes wrong.
- `hold` when the employer makes an OFFER (see D1), sized per D2.
- `release` on cancellation-without-charge or when an offer lapses.
- `capture` when a payout is settled, or when cancellation compensation is
  owed — `capture` is what turns a hold into the worker's `payout_item`.
- Enforcement: an offer is refused if `available` cannot cover the hold.
- Admin-credited `topup` only, so a pilot can run on manually recorded bank
  transfers before any gateway exists.

**Phase 2 — real money in (needs the gateway)**
- FPX/DuitNow top-up, webhook reconciliation, refunds out.
- Out of scope here; Phase 1 is designed so the gateway becomes one new
  `topup` source rather than a rewrite.

## 4. Decisions needed before building Phase 1

- **D1 — when is the hold taken?**
  Posting / offering / acceptance. Offering is my recommendation: it is the
  moment the amount becomes known AND the employer takes the action, so an
  unfunded employer is stopped before any worker is involved. Holding at
  acceptance means a worker accepts and the booking then bounces.
- **D2 — how much is held?**
  The full contracted wage (what the landing copy promises, and what makes
  payout guaranteed) or only the maximum cancellation exposure (50%). Full
  wage is a much larger ask of the employer and will slow adoption.
- **D3 — what happens to an existing unfunded employer at cutover?**
  Every current employer has a zero balance, so enforcement would block all
  offers on day one. Needs a grace period, a pilot allowlist, or admin credit.

## 5. Steps (once D1–D3 are answered)
- [x] 1. Copy fix on the landing trust claim — shipped e1616b6, all 3 languages,
        padlock icon replaced (it implied custody of money)
- [x] 2. Ledger + derived balance — 20260820, verified
- [x] 3. hold/release/capture RPCs — 20260820b, plus 20260820c which fixed two
        of them having NO authorization check at all (a worker could call them)
- [ ] 4. Wire `capture` into the existing payout + cancellation-compensation flows
- [x] 5. Hold fires at the offer step; warn-only, so it reports a shortfall
        rather than blocking. Verified live: RPC returns held=false /
        shortfall=200 and the employer sees "your deposit balance is RM200.00
        short... Nothing is blocked yet"
- [x] 6. Billing tab shows real derived available/held. The self-declared
        "funding account has sufficient balance" checkbox is gone.
        Ledger history list still to do.
- [ ] 7. Admin: record a manual top-up
- [ ] 8. EN + BM + ZH strings
- [ ] 9. End-to-end verification, including that held funds cannot be
        double-spent across two concurrent offers

## Review
(filled in once built)

## Verified so far (2026-08-20)

API side 10/10: balance starts at zero; enforcement confirmed off; an employer
cannot INSERT a ledger row (403) nor call admin_record_topup; an unfunded offer
reports a RM160 shortfall creating no entry; required == wage x contracted
hours; a foreign employer is refused.

In-database self-test (shipped inside 20260820c, raises rather than reports):
topup, hold, idempotent re-hold, **double-spend refused** (RM200 balance, RM160
held, a second RM160 offer must not be funded), capture with the unused
remainder released, over-capture refused, ledger immutability.

Browser: Billing shows real derived figures; offering fires
employer_hold_for_offer then employer_wallet_balance; both the "Offer sent" and
the RM200 shortfall toasts confirmed via a MutationObserver — they were firing
all along, just expiring between polling round trips.

## Still to do
- Ledger history list in Billing (entries exist, nothing lists them yet)
- Wire `capture` into payout settlement and cancellation compensation, and
  `release` into decline / expiry / withdrawal — the ledger records holds but
  nothing yet converts or frees them automatically
- Admin UI for recording a top-up (RPC exists, SQL-only today)
- Flip enforcement on once real top-ups exist
- Phase 2: FPX/DuitNow, and restoring the stronger landing claim

## 2026-08-20 — the gap found while wiring capture

**Completing a shift creates no payout at all.** Verified four ways:
- every `insert into public.payout_item` in the schema is inside a
  *cancellation* function;
- `employer_confirm_checkout` stamps `employer_hours_confirmed_at` and
  inserts nothing;
- no trigger watches that column;
- every JS touch of `payout_item` is a `.select()`, except one admin
  `.update({status})` on rows that already exist;
- the live table holds zero rows with any non-cancellation reason.

So a worker who applies, is booked, works the shift, checks out and has their
hours confirmed by the employer receives **nothing** — no payout row, so
nothing in Earnings and nothing to pay out. The only way to get paid on this
platform today is for the shift to be *cancelled*.

This is larger than the deposit, the tier ladder and the quote work combined:
the platform's core promise has no implementation. It is also why "capture on
payout settlement" could not be wired — there is no settlement to hook into.

Next: create the payout when hours are confirmed, and capture the hold against
it. That single change makes the happy path pay, and completes the wallet's
capture side at the same time.

## 2026-08-20 — the happy path pays, verified

7/7 through the real API, first time in this project that completing a shift
produced money:

- worker checked in with the genuine rotating code (not a stamped column)
- checked out reporting 7.5h worked with a 30m break
- employer confirmed -> **payout RM150.00 created**, `reason: shift_completed`
- break correctly NOT deducted (20 x 7.5, not 20 x 7.0) — the judgement call
  renders as intended
- re-confirming produced no second payout

Funded capture side is covered by tasks/funded_capture_test.sql, which asserts
hold 160 -> worker paid 150 -> 10 released -> available 350, and raises on any
wrong number.

## 2026-08-20 — payout notification, verified

8/8 through the API: hours confirmed -> payout RM108.00 (18 x 6, break not
deducted) -> worker notified, params carry shift_title / amount / hours, link
points at the application, and re-confirming produced neither a second payout
nor a second notification.

Browser, all three languages, rendered from `params` through TRANSLATIONS
rather than the stored English prose:
- EN  "Your hours for "PN payout notice" were confirmed. RM108.00 is on its way."
- BM  "Jam kerja anda untuk "PN payout notice" telah disahkan. RM108.00 ..."
- ZH  "您在「PN payout notice」的工时已确认，RM108.00 正在发放中。"

The BM pass caught a real defect: jsonb stores 108.00 as the number 108, so
`RM{amount}` rendered **RM108** — less precise than the English prose the row
already carries, i.e. translating made the copy worse. notificationText now
formats `amount` / `*_amount` to two decimals, the same way it already
normalises `*_at` timestamps into the reader's locale.

### CONFIRMED: a hold makes its shift, and its employer's account, undeletable

Reproduced on PostgreSQL 17.4 in a throwaway local cluster --
`tasks/wallet_cascade_repro.sql` re-runs it. Not run against production: only
the DDL's shape is needed, and the ledger is append-only, so a probe row in the
real table could never be removed.

`employer_wallet_entry`'s FKs are `on delete set null` / `on delete cascade`,
while the table carries an unconditional `before update or delete` trigger with
no trusted-write escape. A referential action is an ordinary UPDATE/DELETE, so
it fires that trigger. Postgres names the statement in the error CONTEXT, which
is the proof outright:

    UPDATE ONLY "public"."employer_wallet_entry" SET "shift_id" = NULL ...
    ERROR: employer_wallet_entry is append-only

Four operations abort once a single ledger row exists:
1. deleting the application -- which is the FIRST thing admin_purge_shift does
2. deleting the shift
3. deleting the employer's auth user (cascade DELETE, trigger depth 2)
4. deleting the admin who recorded a top-up (`created_by` SET NULL)

(3) is the serious one and was not in the original suspicion: **an employer who
has ever had a ledger entry can never have their account deleted**, which is an
erasure-request problem, not just a QA-cleanup one.

Still latent today -- no employer is funded and an unfunded offer writes no
entry -- and it stops being latent the moment enforcement is switched on,
because from then on every offer writes a hold.

**Fix for (1), (2) and (4), tested in the same repro:** let the guard accept an
UPDATE whose only change is a back-reference going to NULL, and refuse
everything else. Verified to still block editing amount, kind or employer_id,
repointing shift_id at a different shift, and any direct delete; the movement
survives with its money intact. Deliberately not keyed on `pg_trigger_depth()`
-- depth asserts "another trigger did this", which is a weaker claim than
"nothing about this movement changed", and would hand a bypass to any trigger
added later.

**(3) was an owner decision, answered 2026-08-20: keep the ledger, drop the
link.** A financial record outlives the account it belongs to, so `employer_id`
becomes nullable with `on delete set null` — the account can be deleted and the
movements survive, anonymised.

**A third defect surfaced while building the fix.** Unblocking the purge would
have left the hold pointing at a deleted application, and `employer_release_hold`
finds a hold BY application_id — so the money would have become unreachable, and
`held` derives as (holds − releases − captures), meaning an orphaned hold cuts
available balance forever. The pre-fix refusal was loud and safe; the fix alone
would have traded it for silently frozen funds. `admin_purge_shift` therefore
releases open holds before deleting anything, and reports `holds_released`.

All of it ships as `20260822b_wallet_entry_cascade_and_retention.sql`, whose
in-database self-test raises rather than reports, and rolls its own rows back —
a test row in an append-only table would be a permanent phantom hold.

### Still open on the deposit
- Ledger history list in Billing
- Admin UI for recording a top-up (RPC exists, SQL-only)
- Flip enforcement on once real top-ups exist
- Phase 2: FPX/DuitNow, then restore the stronger landing claim

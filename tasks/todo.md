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
- [ ] 1. Copy fix on the landing trust claim (independent of everything else)
- [ ] 2. Migration: `employer_wallet_entry` ledger + derived-balance function
- [ ] 3. Migration: hold/release/capture RPCs, guarded like every other money path
- [ ] 4. Wire `capture` into the existing payout + cancellation-compensation flows
- [ ] 5. Enforcement at the offer step, with a clear "top up to continue" state
- [ ] 6. Employer Billing tab: real balance, held vs available, ledger history
- [ ] 7. Admin: record a manual top-up
- [ ] 8. EN + BM + ZH strings
- [ ] 9. End-to-end verification, including that held funds cannot be
        double-spent across two concurrent offers

## Review
(filled in once built)

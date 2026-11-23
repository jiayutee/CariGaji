# Stage 0 manual payment protocol: DRAFT for owner decision

Drafted 2026-11-23 by the orchestrator, closing the gap the Monday marketing
check found: `tasks/go_to_market.md` §2 (Stage 0) says to "decide and write the
manual payment protocol (below) and put it in the T&C", but nothing was ever
written there.

**Nothing here is in force yet.** This is a draft of terms that **only the owner
can decide**. Every `[DECIDE]` marker is an open choice, and each one has a
suggested default. Nothing goes into the T&C or the app until the owner has
settled every marker. An agent must not copy any of this into user-facing copy
on its own.

---

## What the system does today (verified 2026-11-23)

These facts limit what the protocol can promise:

- **No money moves through CariGaji.** There is no payment gateway and no
  disbursement rail. `payout_item` only records that money is owed.
  `employer_wallet_enforced()` returns false, because its `platform_settings`
  row does not exist.
- **Hours have evidence.** Check-in and check-out are QR-timestamped. The worker
  submits checkout hours, and the employer either confirms or disputes them
  (`shift_checkout_submitted` / `shift_checkout_disputed`). Submitted hours are
  capped at the contracted hours.
- **Cancellation compensation is calculated, but nobody pays it.** The live
  `cancellation_tiers` table (read 2026-11-23) holds these rates for an
  employer who cancels:

  | Notice given | Worker is owed |
  |---|---|
  | More than 7 days | 0% |
  | 48 hours to 7 days | **25%** of contracted wage |
  | 24 to 48 hours | **50%** |
  | Under 24 hours | **50%**, or **100% if the worker turns up** (show-up choice) |

  > ⚠️ `go_to_market.md` §1/§5 and this week's outreach draft only mention the
  > under-24h tier. The 25% and 50% tiers from 7 days down to 24 hours are live
  > and will appear in the app. The T&C wording must state all of the tiers,
  > not only the headline one.

- **The fee is not charged anywhere.** The 15% fee exists only as a constant in
  the browser (see `tasks/funding_architecture.md`), and pilot employers are
  told they pay nothing for two months. In Stage 0 the owner collects wages
  only.

---

## Draft protocol

### 1. Who pays whom
- [DECIDE] **Route A: employer pays the worker directly** (suggested for
  Stage 0). The owner witnesses the payment and keeps the record, but money
  never goes through the owner's account. Without a business bank account (SSM
  is still pending, per §2 Stage 1) this keeps the owner from holding other
  people's money.
- Route B: employer pays the owner, and the owner pays the worker. Only choose
  this with a separate account and written records. It makes the owner a de
  facto payment intermediary.

### 2. When
- Worker submits checkout hours → employer confirms or disputes within
  **[DECIDE: 24h suggested]**. If the employer does neither, the hours count as
  confirmed for this protocol. (The app does **not** do this automatically. The
  owner applies it by hand.)
- Payment due **[DECIDE: within 48h of hours confirmed suggested]**, to match the
  "within 48–72h" line the pitch wants to make one day.
- Amount = signed hourly wage × confirmed hours. The worker receives the full
  agreed rate, with nothing deducted.

### 3. How
- [DECIDE] Method: DuitNow / instant bank transfer (suggested). No cash, so
  there is always a record.
- Proof: the payer sends a screenshot of the transfer to the owner, who notes
  it against the shift in a simple log (suggested: a "Pilot payments" Notion
  table with shift, worker, amount, date paid and proof). The app has nowhere
  to record a real payment yet. `payout_item` rows must **not** be marked as
  paid by hand, because a future disbursement rail will read that table.

### 4. Cancellation compensation
- When an employer cancels, the app shows the tier and amount owed. The
  employer pays that amount to the worker by the same method, by the same
  **[DECIDE: 48h]** deadline.
- [DECIDE] What happens if the employer refuses. Suggested: the owner pays it
  personally, up to **RM[cap]** per shift, so the pilot never breaks its word to
  a worker, and that employer leaves the pilot. This is the only real
  protection that can honestly be offered in Stage 0, so the cap has to be
  something the owner can actually afford.

### 5. Disputes (hours or payment)
- Either side raises it in the app's dispute thread. The owner reviews the QR
  timestamps, the signed contract and the dispute evidence, and **decides
  within 48h** (this is already promised in the outreach FAQ).
- The owner's decision is final for the pilot. [DECIDE] whether an unpaid
  award is also covered by the §4 owner-backstop.

### 6. What we will NOT say
"Guaranteed pay", "escrow", "funds held", "secured payment". All of these are
false until Stage 1. This protocol is a promise that the owner will act
personally. It is not a guarantee from the platform.

---

## Before this goes into the T&C (owner checklist)
- [ ] Settle every `[DECIDE]` above.
- [ ] Have the T&C wording reviewed. It ties to the open backlog row "revise
      privacy policy, terms of service and cookie policy".
- [ ] Fix `go_to_market.md` §1/§5 and the outreach FAQ so they state all the
      cancellation tiers, not only the under-24h one.
- [ ] Create the "Pilot payments" log before the first pilot shift.

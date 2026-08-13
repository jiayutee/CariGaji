# Plan — Cancelling a shift that already has accepted workers

Owner's ask: an employer must not be able to cancel single-endedly once workers
are booked. They should see what compensation they owe, workers should be told,
and workers should accept. Plus: confirm the two worker options already exist.

## 1. What exists today (verified against the live database)

**The two worker options are real and working.** On `applications`:
`cancellation_choice` is `'contract_50'` or `'show_up_100'`.
- `contract_50` — sign for 50% of the agreed wage, don't show up.
- `show_up_100` — turn up at the venue, upload proof, get 100%.
`create_cancellation_payout` (20260717h) writes the payout row. It computes
hours across every occurrence (multi-day aware, overnight wrapping), floors at
0.25h, and refuses to pay unless the shift really is cancelled and the
application really was accepted + signed.

**Compensation is gated on a 24-hour window.**
`notify_cancellation_choice_pending` only fires when
`start_at - now() <= interval '24 hours'`. Outside that window, nothing is
stamped and no choice is offered.

**The employer already sees a warning** — but only inside 24h, and it names no
amount: *"…has {count} confirmed worker(s). Cancelling now will offer each of
them a choice…"*

## 2. Gaps found

**G1 — DELETE bypasses the entire system. (verified, most serious)**
`shifts_employer_delete` (20260629) allows an employer to delete any shift they
own, unconditionally, and `applications.shift_id` is `on delete cascade`.
Proven live: created a shift, took a worker to accepted + contract-signed, then
`DELETE /shifts?id=eq.<id>` as the employer → **HTTP 204**, shift gone,
application gone, signed contract gone, no notification, no payout. The worker
keeps two notifications pointing at a shift that no longer exists.
**So the whole 50%/100% system is currently optional** — an employer facing a
late-cancellation bill can simply delete instead of cancel and owe nothing.
The UI exposes no delete button, but the REST API is public and authenticated.

**G2 — Cancel at 25 hours' notice costs nothing.** A worker who signed a
contract, turned down other shifts and arranged transport gets "Shift
cancelled" and RM 0. The 24h cliff is absolute.

**G3 — The employer is never shown a number.** The warning describes
percentages; it never says "this will cost you RM 312.00". Nobody can weigh a
decision they can't see the price of.

**G4 — There is no worker acknowledgement.** Cancellation is unilateral. The
worker picks a *payout mode* afterwards, but never accepts (or disputes) the
cancellation itself.

**G5 — The choice deadline is enforced client-side.** carigaji-app.jsx ~5634
defaults a lapsed choice to `contract_50` in the browser, so it only runs if
the worker happens to open the app. A worker who never opens it keeps an
unresolved entitlement indefinitely.

**G6 — Employers can't be billed.** `payout_items` records what the worker is
owed; there is no corresponding charge to the employer. Compensation is
currently a promise the platform makes with no funding mechanism behind it.

## 3. Proposed design

### 3a. Close the hole first (independent of everything else)
Replace `shifts_employer_delete` with a policy that refuses when any
application on the shift is `accepted`, plus a `before delete` trigger as
defence in depth. Deleting a shift nobody has been booked onto stays fine.
Cancellation must go through `status = 'cancelled'`, which is what every
compensation trigger already hangs off.
*This is a bug fix and should ship on its own, before the rest.*

### 3b. One source of truth for the amount
New RPC `quote_shift_cancellation(p_shift_id uuid)` returning one row per
affected worker: `application_id`, `worker_name`, `wage_ask`,
`contracted_hours`, `multiplier`, `amount`, plus a total.

It must reuse `create_cancellation_payout`'s own hours calculation — the
multi-day occurrence sum with the 0.25h floor — rather than reimplementing it
in JS. If the quote and the payout disagree, the employer was misled about a
figure they explicitly agreed to, which is the one thing this feature cannot
get wrong. Extract that calculation into a shared
`shift_contracted_hours(shift_id)` function and have both call it.

### 3c. Employer flow
1. **Cancel** on a shift with ≥1 accepted worker opens a quote screen, not a
   confirm dialog.
2. Itemised table: each worker, their agreed rate, contracted hours, the
   multiplier that applies, the amount — and the total in bold.
3. Explicit acceptance: a checkbox reading *"I understand I will be charged
   RM X to cancel this shift"*. Not a generic "Cancel anyway".
4. On confirm: shift → `cancelled`, per-worker compensation offers created,
   workers notified.
5. The shift detail then shows a live ledger: who has responded, who hasn't,
   what's owed, what's settled.

### 3d. Worker flow
1. Notification: *"{employer} cancelled {shift}. You're entitled to
   RM X."* — the amount, not a percentage.
2. The bid detail shows a decision card with both existing options, each
   showing its actual ringgit value:
   - Accept RM X (50%), don't show up
   - Show up and claim RM Y (100%) — with the existing proof upload
3. **New third action: Dispute** — for "I already spent money on transport"
   or "this is the third time". Routes into the existing `disputes` table,
   which already has admin resolution built.
4. Deadline handling moves server-side (fixes G5).

### 3e. Notice-period tiers
Replace the single 24h cliff with a ladder, so G2 stops being a cliff edge.
Suggested starting point — **the owner sets the real numbers**:

| Notice given | Compensation |
|---|---|
| more than 7 days | none |
| 48h – 7 days | 25% |
| 24 – 48h | 50% |
| under 24h | 50%, or 100% if the worker shows up |

Store this as a config table, not constants, so it can change without a
migration and historical payouts keep the rate they were quoted at.

## 4. Decisions needed before building

- **D1 — the tier table.** Business/pricing policy, not a technical call.
  Section 3e is a straw man.
- **D2 — who funds it (G6).** Compensation is currently owed to workers with
  nothing charging the employer. Options: charge the card on file, deduct from
  a deposit, or invoice. Until this is answered the feature promises money the
  platform can't collect. **This is the biggest open question.**
- **D3 — is cancellation ever refusable?** "Single-end cancellation is not
  possible" could mean (a) always allowed but always compensated, or (b) the
  worker can refuse and the booking stands. (a) is what section 3 assumes; (b)
  is much larger and raises "what if they refuse and nobody turns up".
- **D4 — does the ladder apply to worker-side cancellation too?** A worker
  dropping out 2h before a shift also hurts the employer. Out of scope here.

## 5. Steps (once D1–D3 are answered)

- [x] 1. Migration: block DELETE on shifts with accepted applications (3a)
        DONE + verified in production: exploit refused, shift and signed
        application both survive, no RLS recursion. Follow-up 20260814b
        makes the refusal report an error instead of a misleading 204.
- [x] 2. Migration: extract `shift_contracted_hours`, reuse in the payout
        trigger, verify existing payouts are unchanged
        DONE + verified: returns 8.0h for a contracted 8h shift; diff against
        the real create_cancellation_payout confirmed only the inline block
        was swapped.
- [ ] 3. Migration: compensation-tier config table + `quote_shift_cancellation`
- [ ] 4. Employer quote screen with itemised amounts + explicit acceptance
- [ ] 5. Worker decision card showing ringgit values; wire the Dispute route
- [ ] 6. Move the choice deadline server-side (G5)
- [ ] 7. Employer-side settlement ledger on the cancelled shift
- [ ] 8. EN + BM strings throughout
- [ ] 9. End-to-end verification per tier, both worker options, dispute path,
        and a re-check that DELETE is now refused

## Review
(filled in once built)


## Dogfood sweep — 2026-08-13

25 scenarios across altering / deadline / cancellation, both roles. **25/25
passed.** Script: scratchpad/dogfood.py.

Covered: no-op save is silent; non-material edit notifies without demanding
re-confirmation; material edit holds only the SIGNED booking (not pending
applicants) and stores change CODES not prose; the re-confirm RPC clears it;
a withdrawn applicant stops being notified. Deadline in the past and status
`closed` both block new applications (403) while keeping the shift visible.
Cancellation >24h notifies without offering a payout choice; <24h stamps the
choice deadline and notifies; choosing contract_50 writes a real payout row
(RM 72.00 verified); an `offered` worker IS notified of cancellation (the
July bug, confirmed fixed); deleting a booked shift raises the named error.

### Found during the sweep

**F1 — a cancelled shift with accepted workers can never be deleted, by
anyone.** `worker_withdraw_from_shift` refuses once the shift is cancelled
("This shift was already cancelled"), so those applications stay `accepted`
forever and the delete guard blocks the shift permanently. Record-preservation
is right, but there is no admin purge path at all, so test and abandoned data
accumulates with no way to clear it. Needs an admin-only hard-delete RPC.

**F2 — applying past the deadline shows a raw Postgres error.** The RLS
policy correctly returns 403, but the UI does
`toast(t("toast.applicationFailed") + error.message)`, so the worker sees
"new row violates row-level security policy for table applications" instead
of "Applications for this shift have closed." The JS never pre-checks
`applications_close_at`.

**F3 — `issue_reports` has no DELETE policy for anyone**, including admin
(admin has `for all`, so admin is fine; reporters cannot remove their own).
Consistent with triage-by-admin, but worth a deliberate decision.

### Still open from the earlier review
- No post-shift rating PROMPT — ratings work but are opt-in via a button
  nobody is pointed at, so `profiles.rating` will not accumulate.
- No-show costs a worker NOTHING automatically, while a responsible
  withdrawal costs reliability points. The incentive is backwards until a
  no-show penalty exists.

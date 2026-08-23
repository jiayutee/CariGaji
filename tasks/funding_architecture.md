# How employers fund shifts, and how we get paid

Written 2026-08-24, in answer to: should we hold the money or wire it straight
through, and where does our fee come from?

## The uncomfortable finding first

**The 15% fee is displayed to employers and charged to nobody.**

`PLATFORM_FEE_PCT = 0.15` lives at carigaji-app.jsx:175 and is a *client-side
constant*. The database has never heard of it. Grep the migrations: there is no
fee column, no fee ledger kind, no fee calculation anywhere in Postgres.

It is used in exactly three places, all of them cosmetic:

| Where | What it does |
|---|---|
| Shift list card, `estBudget` | `wage_max × hours × headcount × 1.15` |
| Shift detail "Est. budget" tile | same figure, and the tooltip says "plus 15% platform fee" |
| Post-shift wizard, `reserve` | same figure, shown as what to set aside |

And what actually happens with money:

| Step | Amount | Fee? |
|---|---|---|
| Hold at offer time (`employer_wallet_hold_for_offer`) | `wage_ask × contracted_hours` | **no** |
| Payout at hours-confirmed (`create_payout_on_hours_confirmed`) | `wage_ask × reported_hours`, worker paid in full | **no** |
| Ledger kinds available | `topup, hold, release, capture, refund` | **no `fee`** |

20260821b says it out loud in its own header: *"Fee collection is separate and
does not exist yet."* So yes -- **Est. budget already includes the fee**, and it
is the only number in the system that does. An employer who reads "RM138" and
transfers RM138 has over-funded by ~15% against a hold that only ever asks for
the wage.

## Fee on top, not deducted from the worker

Keep this. The employer-facing copy already promises "plus 15% platform fee",
and 20260821b deliberately pays the worker the full agreed rate. Deducting the
fee from the wage instead would mean a worker who bids RM16/hr receives RM13.60
-- which breaks the bid (the number they agreed to is the number they get), and
walks toward a minimum-wage problem on low-rate shifts. Charge the employer
RM16 + RM2.40 and pay the worker RM16.

## Hold vs. pass-through: the actual question

**Option A -- we hold the money (what is half-built).** Employer tops up into a
CariGaji-controlled account; we hold, we disburse. This is the strongest version
of the product promise and the one the app already tells workers: *"the
employer's funds are committed before the shift starts."*

The problem is not technical. Holding other people's money in Malaysia is a
regulated activity -- BNM territory under the Financial Services Act, and
e-money issuance needs approval. **Get this checked by someone qualified before
the pilot takes a single real transfer.** I am not a lawyer and this note is not
legal advice.

**Option B -- a licensed PSP holds it, we never touch it.** Employer pays per
shift by FPX/DuitNow into a collection/escrow account operated by a licensed
payment provider. The provider disburses to workers and splits our fee out at
settlement. We keep the trust proposition (funds ARE committed before the shift)
without custody, and the fee is collected automatically instead of invoiced.

**Option C -- employer wires workers directly, we invoice our fee.** No custody,
no licensing question, and no product. The guarantee disappears, and we are left
chasing fees from the party with the least incentive to pay them.

### Recommendation: B, and the ledger already anticipates it

20260820 wrote this down at the time: *"A gateway later becomes one more `topup`
source rather than a rewrite."* That holds. Under B the ledger stops being the
custodian of truth and becomes the **mirror** of the PSP's state -- same rows,
same derived balance, different thing on the other end of a `topup`.

Nothing built so far is wasted, and nothing about A-vs-B changes the schema. It
changes who is holding the account.

For the pilot, A-by-hand is what exists (manual transfer + admin records it).
That is genuinely holding money, so: keep it small, keep it short, keep the
funds in a separate account rather than commingled with operating cash, and say
plainly in the T&C what is happening. It is a bridge, not a destination.

## What to build, in order

1. **Move the fee rate into the database, snapshotted per shift.**
   `alter table shifts add column platform_fee_pct numeric(5,4) not null default 0.15;`
   stamped at post time. This is the highest-priority item and it is
   independent of A-vs-B: today a change to `PLATFORM_FEE_PCT` would silently
   re-price every shift already live, including ones already agreed.

2. **Hold the fee, not just the wage.** `employer_wallet_hold_for_offer` becomes
   `wage_ask × hours × (1 + shift.platform_fee_pct)`. Until this lands, an
   enforced wallet would let an employer book a shift they cannot afford the
   fee on.

3. **Add a `fee` ledger kind and split the capture.** At
   `employer_hours_confirmed_at`, alongside the existing `payout_item`: release
   the hold, insert `capture` for the wage, insert `fee` for our cut. Widen the
   `kind` check constraint and add `fee` to the subtraction in
   `employer_wallet_balance` -- **both**, or the balance silently ignores it.

4. **Reconcile.** A revenue view over `kind = 'fee'`, and a check that every
   captured shift has exactly one wage capture and one fee row.

5. **Then swap the funding source.** PSP webhook writes `topup` rows instead of
   the admin screen. The admin screen stays as the manual fallback.

Steps 1-4 are ours and can ship now. Step 5 waits on a PSP contract, and on the
SSM registration and business bank account -- both still open.

## Related open items

- `employer_wallet_enforced()` is still warn-only. Do not flip it before step 2,
  or the enforcement will check the wrong number.
- The "Add funds" button routes to support by design (5299492). Its copy
  promises we will arrange a transfer, which needs the bank account to exist.

# CariGaji — go to market

Written 2026-08-29. Owner-facing. The marketing agent reads this before doing
anything, and must not run Stage 2 tactics while Stage 1 gates are open.

---

## 0. The thing that decides everything else

**The promise we most want to make is the one we cannot yet keep.**

The pitch is "both sides are secured — workers get paid as agreed, employers
get people who show up." The second half is real today. The first half is not:

| claim | status | evidence |
|---|---|---|
| Employer funds are committed before the shift | **NOT TRUE** | `employer_wallet_enforced()` reads a `platform_settings` row that does not exist → returns false. Offers are never blocked on funding. Live check returns `[]`. |
| Worker is paid within 48–72h | **NOT TRUE** | No payment gateway. Money enters only via an admin manually recording a bank transfer (`admin_record_topup`). |
| A payout actually moves money | **NOT TRUE** | `payout_item` records an obligation. There is no disbursement rail. |
| Workers are MyKad-verified | **NOT TRUE** | KYC provider is `secure_sign_sim`, a simulator. |

Marketing "guaranteed pay" now would be the single most damaging thing we
could do. One worker who was promised protection and did not get it, posting
in the same WhatsApp and XHS groups we recruited them from, ends the product.
Every other risk in this document is recoverable; that one is not.

**So the sequence is: earn the claim, then make it.** Until then we sell what
is actually true, which is still a genuinely better deal than a WhatsApp group.

---

## 1. What we can honestly say today

Each of these is enforced in the database, not just drawn in the UI:

- **The pay is on the ad before you apply.** Hourly range, total hours,
  estimated total. No "salary negotiable", no DM-for-details.
- **The worker names their own rate** inside the employer's range, capped at
  150%. The bid is the wage.
- **Both sides sign a digital contract before the shift**, carrying the agreed
  wage and hours.
- **QR check-in/out** timestamps what actually happened, so a timesheet
  argument has evidence behind it.
- **Late cancellation has a price.** An employer who cancels inside 24h owes
  each confirmed worker 50% by contract, or 100% if the worker shows up.
  Computed server-side from the signed wage — not goodwill, not a negotiation.
- **Employers are SSM-gated.** They cannot post until an admin verifies the
  company registration number.
- **Two-sided ratings and a reliability score**, so no-shows carry forward.

That is the honest wedge: *nobody has to argue about what was agreed.*

---

## 2. Launch gates — what must exist before each stage

### Stage 0 — Concierge pilot (can start now)
No new engineering required. Gates:
- [ ] Decide and write the **manual payment protocol** (below) and put it in
      the T&C, so the promise made is the promise kept.
- [ ] One category, one area. Recommend **F&B + events in Klang Valley**.
- [ ] 3–5 employers, hand-held. Owner is personally the payment rail.

### Stage 1 — Real money rails (before any "secured payment" claim)
- [ ] **SSM registration** — blocks the business bank account and `.com.my`.
- [ ] **Business bank account** — blocks taking any employer deposit.
- [ ] **Payment gateway / PSP** — see `tasks/funding_architecture.md`. Until
      this exists, every ringgit is a manual transfer.
- [ ] **Create the `platform_settings` row and flip `employer_wallet_enforced`
      to true** — today the switch reads a row that does not exist, so escrow
      is silently off. **Filed as a backlog item.**
- [ ] **Verify the admin top-up success path** — still unverified; the failure
      path works, the write itself has never run.

### Stage 2 — Scale marketing (only after Stage 1)
- [ ] KYC vendor integrated (MyKad + SMS OTP), replacing `secure_sign_sim`.
- [ ] Notification i18n migrations run, so BM/中文 users get their own language.
- [ ] `JobPosting` structured data + per-shift OG tags — see step 3 in the
      per-shift URL work. Without it every shared link previews as a generic
      card and Google Jobs cannot index a single shift.

---

## 3. Supply and demand: who, specifically

A marketplace dies of the wrong ratio, not of too few users overall. **Start
demand-first**: a worker who opens an empty app never returns, but an employer
with an unfilled shift will wait a day.

### Demand — employers, in the order to approach them

1. **Small F&B outlets with weekend gaps** — cafés, bubble tea, casual dining
   in Bangsar / Mont Kiara / SS15 / Damansara. Owner-operated, decides on the
   spot, feels the pain weekly. Easiest first yes.
2. **Event and activation agencies** — mall roadshows, product launches,
   exhibitions. Bursty demand for 5–20 people at once; agencies already keep
   WhatsApp lists and hate the admin.
3. **Booth companies at fairs and expo halls** — MITEC, KLCC, MVEC. Approach
   the *organiser* for the exhibitor list, then the exhibitors. Their need is
   dated and urgent, which makes the pitch concrete.
4. **Retail promoters and supermarket activations** — recurring, predictable,
   good for retention once the first shift works.
5. **Warehouse and logistics peak cover** — larger volumes, slower sales cycle,
   leave until there is a fill-rate record to show.

**Approach:** in person or a warm DM, never a mass email. The ask is small —
*"post one shift, free, and I will personally make sure it fills."* At Stage 0
that is a service, not a product pitch, and it should be.

### Supply — workers, and where they actually are

Only recruit workers **against real posted shifts**. Recruiting supply into an
empty app burns the channel.

1. **University students** — UM, UKM, Taylor's, Sunway, APU, UCSI. Reach via
   course/faculty Telegram and WhatsApp groups, student societies, and
   part-time-job Facebook groups. Student ambassadors paid per verified
   signup that completes a shift (not per download — pay for the outcome).
2. **Existing part-time WhatsApp/Telegram groups** — the incumbent. Do not
   spam them; join, and post real shifts with the pay visible. The contrast
   with "PM for details" is the entire pitch.
3. **XHS (小红书) and Threads** — where Malaysian part-timers already discuss
   jobs. Format that works: a screenshot of a real shift card showing the
   range and estimated pay, captioned in Malay/English/中文.
4. **TikTok** — short vertical video of the actual flow: bid → accept → sign →
   check in → paid. The product demo *is* the ad, because the transparency is
   visual.

---

## 4. Channel plan, with the message per audience

| audience | channel | the one line |
|---|---|---|
| F&B owner | in person, weekday afternoon lull | "Post your Saturday gap free. You see everyone's rate before you pick." |
| Event agency | WhatsApp/LinkedIn intro | "Twenty ushers, each one signed a contract with the rate in it, before the day." |
| Student | campus group + XHS | "The pay is on the ad. You say your rate. Nobody asks you to PM." |
| Existing gig worker | WhatsApp group, real posting | *(no pitch — just post a shift with the pay on it)* |

**Content that does the work, in priority order:**
1. A real filled shift, screenshotted end-to-end, with the worker's permission.
2. The contract + check-in flow as a 30-second video.
3. "How much do part-timers actually earn in KL" — the wage data we will have
   is genuinely interesting and nobody else publishes it.

---

## 5. Questions we will be asked, and the honest answer

**Worker: "How do I know I'll get paid?"**
Today: the wage and hours are in a contract both sides signed, check-in/out is
timestamped, and a late cancellation owes you 50–100% automatically. In the
pilot, the owner personally settles any dispute within 48h. **Do not say
"guaranteed" or "escrow" until Stage 1 is done.**

**Worker: "Is this another scam group?"**
Employers cannot post until their SSM company number is verified by a human.
You can see the company, its rating and its cancellation history before you
bid.

**Worker: "Do I pay anything?"**
No. Workers pay nothing, ever. The fee is charged to the employer on top of
your wage — you receive the full rate you agreed.

**Worker: "What if the employer cancels last minute?"**
Inside 24 hours you are owed 50% by contract, or 100% if you turn up. The
amount is computed from your signed wage, not negotiated.

**Employer: "Why not just use my WhatsApp group?"**
You already do, and it works until it doesn't: no-shows with no record, pay
arguments with no timesheet, and re-asking the same twenty people. Here the
rate is agreed in writing and check-in is timestamped.

**Employer: "What does it cost?"**
Free for your first two months from your first posted shift. After that 15% on
top of the wage. The worker still receives their full agreed rate.

**Employer: "Why are you cheaper than an agency?"**
Agencies charge 20–40% and bundle sourcing, payroll and admin. We do sourcing
and the paperwork; we do not employ the worker. If you need an employer of
record, an agency is genuinely the right answer today.

**Employer: "What if the worker doesn't show up?"**
Reliability score and strikes follow the worker across the platform, so the
incentive is real. We do not yet indemnify you for a no-show — anyone claiming
otherwise is overselling.

**Both: "Who employs the worker — you?"**
No. The employer engages the worker directly; CariGaji is the marketplace and
provides the contract, verification and records. See the T&C and the labour
law page in Notion. **Do not improvise beyond this line.**

**Both: "Is my data safe?" (PDPA)**
Identity documents are stored in a private bucket, readable only by the owner
and admins; profile data is scoped per user at the database level. IC numbers
and addresses are never shown to the other party.

---

## 6. What we measure, and the number that matters

Vanity: downloads, signups, impressions.
Real, in order:

1. **Fill rate** — shifts filled / shifts posted. Below ~70% the product does
   not work and no amount of marketing fixes it.
2. **Time to first bid** — how long an employer waits. Under 2 hours feels
   magical; over a day and they go back to WhatsApp.
3. **Repeat employer rate at 30 days** — the only real proof of value.
4. **No-show rate** — the promise to employers.
5. **Completed shifts per worker** — supply retention.

At Stage 0 the target is not growth. It is **five completed shifts with zero
disputes**, which is what earns the right to the Stage 1 claims.

---

## 7. Weekly cadence (the routine)

The orchestrator runs a marketing step once per week (Mondays), which:
- re-checks the gate list above against the code and database, and reports any
  claim that has become true or false;
- reports fill rate, time-to-first-bid and open-shift count from live data;
- drafts that week's outreach list and copy for the owner to send — it never
  contacts anyone itself;
- files any new gap it finds as a backlog row rather than mentioning it once.

Outreach is always sent by a human. Nothing in this plan authorises an agent to
message a real employer or worker.

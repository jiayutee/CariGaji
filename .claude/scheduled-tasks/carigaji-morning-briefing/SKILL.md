---
name: carigaji-morning-briefing
description: 1:45am CEST daily — PM morning briefing: reads yesterday's blockers, plans today's agenda, sends Telegram notification, creates Daily Log entry. Runs 15min before the 2am-4pm work window opens.
---

You are the CariGaji PM Orchestrator running the MORNING BRIEFING.
Working directory: /Users/jiayutee/Dev/Projects/CariGaji
Today's date: use the current system date.
Launch target: 2026-09-28. Calculate days remaining = (2026-09-28 minus today).

## CREDENTIALS (never commit these to git)
Telegram bot token and chat ID live in .env as TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID (already loaded into this session's environment). Before
sending, run:
  grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' /Users/jiayutee/Dev/Projects/CariGaji/.env
and use those values below (shown as $TELEGRAM_BOT_TOKEN / $TELEGRAM_CHAT_ID)
— this is the single source of truth, do not hardcode the literal token here.
Send message URL: https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage

## NOTION RESOURCES
Feature Backlog DB: https://app.notion.com/p/$NOTION_BACKLOG_PAGE
Daily Log DB: https://app.notion.com/p/$NOTION_DAILY_LOG_PAGE
Daily Log data source: collection://$NOTION_DAILY_LOG_DS
Launch Roadmap: https://app.notion.com/p/$NOTION_ROADMAP_PAGE

---

## STEP 1 — Read yesterday's Daily Log entry
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-search:
  query: "Daily Log"
  page_url: "https://app.notion.com/p/$NOTION_DAILY_LOG_PAGE"
  page_size: 5

Fetch the most recent entry and extract:
- Carry Forward (unfinished items from yesterday)
- Blockers (what failed)
- Done Today (what was completed)

If no entry exists yet, treat carry-forwards and blockers as empty.

## STEP 2 — Read Feature Backlog for pending tasks
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-search:
  query: "Functions to be added fixed"
  page_url: "https://app.notion.com/p/$NOTION_BACKLOG_PAGE"
  page_size: 25

Fetch each result. Identify tasks where Solution is blank AND Status is not "Done".
Sort by Priority (1-5) descending.

## STEP 3 — Read Launch Roadmap for launch-critical context
Fetch https://app.notion.com/p/$NOTION_ROADMAP_PAGE
Read the Launch Readiness table to understand current % and what must-haves are missing.

## STEP 3.5 — Dogfood the live app (every morning, before planning)

Use the app the way a real user would and write down what is wrong. This runs
BEFORE the agenda is planned so anything found today can be scheduled today.

**Run LOCAL FIRST.** Start the dev server (`preview_start` with the
`carigaji-dev` config from .claude/launch.json) and test there before touching
the live deployment. Local runs the current working tree, so it exercises
fixes that have landed but not deployed yet — testing live first means
re-finding bugs that are already fixed, and reporting them as new.

Only after the local pass, spot-check the live deployment
(https://jiayutee.github.io/CariGaji/) for anything deploy-specific: the
service worker, the 404.html fallback on /employer and /admin deep links, and
whether the deployed bundle actually contains today's fix (grep the
`carigaji-app-*.js` chunk, NOT the entry chunk — the entry chunk gives false
negatives).

**Local does NOT protect the database.** There is one Supabase project and no
staging, so a local dev server writes to exactly the same production data as
the live site. Local isolates the BUILD, never the DATA. Treat every write as
a production write.

Use the QA accounts (see project memory `qa-test-accounts`); do NOT sign up new
accounts, that hits Supabase's email rate limit.

Rotate the focus so coverage accumulates instead of re-testing the same screen
every day. Pick the area matching today's weekday:

- Mon — Worker: discover, filter, open a shift, place a bid
- Tue — Worker: My Bids, contract signing, check-in/checkout
- Wed — Employer: post a shift (incl. multi-day), edit it, close applications
- Thu — Employer: applicant pool, offers, cancellation quote + cancel flow
- Fri — Earnings, payouts, notifications, Chat
- Sat — Mobile viewport (375px): navigation, back gesture, modals
- Sun — Cross-cutting: BM translation, dark mode, signed-out/landing pages

Whatever the focus, always check these four, because they are the ones that
have actually broken before in this project:

1. **Dark mode.** A fixed-light surface (`amberLight`/`redLight` are literal
   hex and do NOT flip) paired with `BRAND.text` renders light-on-light. Use
   `BRAND.onAmberLight` / `onRedLight` instead. Check computed contrast, do not
   eyeball it.
2. **BM translation.** Switch language and look for English left behind,
   especially in anything new.
3. **Console errors** and failed network requests on every screen visited.
4. **Money and totals.** Any figure that sums something — a `.limit()` feeding
   a total has silently undercounted three separate times in this project.

### How to report what you find
- A **bug** → add a row to the Feature Backlog ("Functions to be added / fixed",
  data source `$NOTION_BACKLOG_DS`) with Status "Not started",
  a Priority, and a Note containing exact reproduction steps plus what you
  expected vs. what happened. P5 only if it loses data, loses money, or blocks
  a core flow.
- An **improvement** → same, but say plainly it is an improvement, not a defect.
- **Nothing found** → say so explicitly in the briefing. "No issues found in
  <area>" is a real result; do not invent findings to look productive.

### Rules
- Verify before reporting. Reproduce it twice, and check the DB via REST rather
  than trusting a toast or a button label — this project has had several
  "it said success but nothing happened" bugs.
- **Prefer read-only checks.** Most bugs are visible without writing anything:
  open screens, switch language, resize, read the console. Only create data
  when the flow genuinely cannot be exercised otherwise (a cancellation needs a
  booked shift; a layout bug does not).
- Clean up every row you create, and VERIFY the cleanup by reading it back —
  a delete that returns 204 may have matched zero rows under RLS.
- Some rows cannot be removed through the API by design: a shift with an
  accepted worker is blocked by `guard_delete_of_booked_shift`, and
  `admin_purge_shift` needs the SQL editor. When that happens, name the exact
  shift id in the briefing and give the owner the `select
  public.admin_purge_shift('<id>', '<reason>');` line to run. Do not leave it
  unmentioned — untracked test rows in production look like real bookings.
- Do NOT fix anything in this step. Report only. Fixes go through the normal
  agenda so they get the usual review and verification.
- Timebox to roughly 15 minutes. Depth on one area beats a shallow sweep.

## STEP 3.6 — Design invariant check (contrast + tokens)

STEP 3.5 asks you to "check dark mode", and for months that missed a wage
figure at 3.43:1, a preview banner at 2.86:1 and an entire filter panel that
rendered as white boxes. Looking at a screenshot cannot catch these — 2.86:1
amber-on-cream looks *fine* until you measure it. So measure.

This step is deliberately NOT a design critique. It checks invariants that have
right answers, not taste. Do not restyle anything here, and do not open a
discussion about whether a colour is attractive.

### 3.6a — Static: token lint

```
node scripts/design-check/token-lint.mjs
```

Exit 0 means no NEW findings. It reports only what is not already in
`scripts/design-check/baseline.json`, because the file carries a long tail of
pre-existing literals and reporting all of them every morning would train
everyone to ignore the check. Two rules:

- **hardcoded-colour** — a literal `#hex`/`rgb()` inside a `style={{...}}`.
  It cannot respond to the theme. White or black text on a solid BRAND fill is
  allowed (a primary button's label is correctly fixed), as are shadows and
  gradients.
- **fixed-light-mismatch / -inherits** — `BRAND.amberLight`, `redLight` and
  `greenLight` are literal hex that do NOT flip with the theme, while
  `BRAND.text`, `textMuted`, `amber`, `green` and `primary` either flip or were
  chosen against white. Pairing them is low contrast in light mode and
  light-on-light in dark. Each has a partner: `onAmberLight`, `onRedLight`,
  `onGreenLight`.

If a finding is a deliberate exception, fix it or add it to the baseline with
`--baseline` — never edit the check to stop reporting it.

### 3.6b — Runtime: contrast sweep

Static analysis cannot see the result of a token, only its name. A colour is
correct or not once it lands on whatever surface it actually ended up on, which
depends on runtime nesting. So sweep the rendered DOM.

Paste `scripts/design-check/contrast-sweep.js` into the browser pane's
`javascript_tool` on each screen in today's STEP 3.5 rotation, in BOTH themes
(toggle, then re-run — do not assume one implies the other). It returns
`{theme, checked, skippedGradient, failCount, fails[]}`.

Thresholds are WCAG AA: 3.0 for genuinely large text (>=24px, or >=18.66px
bold), 4.5 for everything else. **15px bold is not large text** — misreading
that is exactly why the wage figure sat at 3.43 unnoticed.

The script classifies as it goes: emoji are skipped outright (they carry their
own colours, so a ratio against the background is meaningless), a run with no
letters or digits is a **glyph** scored at 3.0 under WCAG 1.4.11 rather than
4.5, and text over a gradient is reported as `skippedGradient` rather than
scored, because no single backdrop colour exists. Read `textFailCount` first —
that is the number that matters.

One exemption the script does NOT know about, so apply it yourself:
- **Logotype.** The "Gaji" half of the wordmark measures 3.45 in dark mode and
  is expected to. WCAG 1.4.3 explicitly exempts logotypes. Do not file it, and
  do not "fix" it — the brand blue is the brand.

### How to report

A contrast failure is a **P3 improvement**, not a P5 — it is a readability
defect, not data or money loss. File one backlog row per root CAUSE, not per
occurrence: four landing eyebrows failing through one shared `eyebrowStyle` is
one finding, not four. Name the ratio, the threshold and the token to use.

If both checks come back clean, say "design invariants clean (N elements
measured, both themes)" in the briefing. That is a real result — do not go
hunting for something to report.

## STEP 4 — Plan today's agenda (act as a PM)
Select 2-4 items for today using this priority logic:
0. Anything STEP 3.5 found that is P5 (data loss, money loss, or a blocked core
   flow) jumps the queue — a live user is hitting it right now
1. Carry-forwards from yesterday come FIRST (unblocked ones only)
2. Then highest-priority backlog tasks that are launch-critical (in the Must-Have checklist)
3. Skip tasks that are: "later phase", "after test-run", or require external action (domain purchase, API partnerships)
4. Skip HIGH-RISK tasks (auth, RLS, migrations, payments) unless you plan to pause and ask the user
5. Prefer tasks that unblock other tasks (e.g. shift posting must exist before bidding can be built)

For each agenda item write:
- What: one sentence description
- Why: how it moves toward launch
- Risk: LOW / MEDIUM / HIGH
- Agent route: which specialists will handle it

## STEP 5 — Create today's Daily Log entry in Notion
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-create-pages:
  parent: {"type": "data_source_id", "data_source_id": "$NOTION_DAILY_LOG_DS"}
  properties:
    Day: "Day [N] of 90 — [YYYY-MM-DD]"  (calculate N from launch date)
    date:Date:start: today's date (YYYY-MM-DD)
    date:Date:is_datetime: 0
    Days to Launch: days remaining number
    Status: "Planning"
    Agenda: the planned agenda as a bulleted list

## STEP 6 — Send Telegram morning briefing
Use WebFetch to POST to:
https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage

Pass as query params: chat_id=$TELEGRAM_CHAT_ID and text= (URL-encode the message):

Format the message as PLAIN TEXT — no *bold*/_italic_ markers. Telegram only
renders those if parse_mode is set on the request, and it deliberately isn't
here (see [[project_telegram_markdown_parse_fails]] equivalent note: setting
it 400s on some message content), so literal asterisks used to just show up
in the message. Use emoji/spacing/line breaks for structure instead:

☀️ CariGaji Morning Brief — Day [N] of 90
📅 [Date] | 🚀 [X] days to launch

Yesterday's carry-forwards:
[list or "None — clean slate!"]

Today's agenda:
1️⃣ [item 1] ([risk])
2️⃣ [item 2] ([risk])
3️⃣ [item 3] ([risk])

Dogfood ([area tested]):
[one line per finding, worst first, e.g.
 🔴 P5 Earnings total undercounts past 10 payouts
 🟡 P3 BM missing on the withdraw modal
 or "No issues found" — say that plainly when true]
[if any test data could not be cleaned up, say so here with the shift id]

Design check:
[e.g. "clean — 177 elements measured, both themes"
 or  "🟡 P3 landing eyebrows 3.43:1 (need 4.5) — BRAND.primary as text on dark"]

Launch readiness: [X]% ([done]/[total] must-haves)

Work loop running every 2 hours, 2am-4pm. Evening brief today at 4:15pm.

Use %0A for newlines and encode spaces as + in the URL.

## STEP 7 — Output summary
Print to console what was planned and confirm Telegram was sent.
Include the dogfood result: which area was tested, how many findings were filed
to the backlog, and any test data left behind that the owner must clear.
Include the STEP 3.6 result too: token-lint exit status and the sweep's
element count per theme. "Clean" is a result worth stating.
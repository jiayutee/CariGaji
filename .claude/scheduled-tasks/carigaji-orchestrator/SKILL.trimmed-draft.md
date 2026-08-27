---
name: carigaji-orchestrator
description: Every 2 hours — silent work loop: picks next agenda item from today's Daily Log, implements with specialist agents, updates Notion and pushes to main.
---
<!--
DRAFT — NOT ACTIVE. This is a trimmed variant of SKILL.md for review, not a
replacement in effect. The live orchestrator still reads SKILL.md as-is, and
this file changes nothing about that until someone deliberately swaps it in.

Revised after a first pass surfaced real gaps. Each is tagged [ADDRESSED: n]
against the numbered disadvantage list this came from:
  1. Feature Backlog Status+Date coupling (the 38%-defect-rate rule) is now
     mechanized inside the pipeline's Notion phase, not left as prose here.
  2. Multi-file tasks now get a Planner pass before implementation, via
     task.multiFile.
  3. The pipeline's retry is now a bounded, context-carrying attempt loop
     (default 2), not a single blind redo.
  4. Cost is still genuinely higher per item than the current single-session
     approach — not solved, only bounded (see STEP 4's opt-in gate below,
     which exists specifically so that cost is observed before it's
     unattended-by-default).
  5. orchestrator-watch.py now recognizes a Workflow call/result pair in the
     caller's own transcript, so these stages show up in the dashboard.
  6. The rules most likely to need a same-day incident fix (Notion write
     shapes, the build gate command) are named constants in the pipeline
     script now, not buried in prose scattered through control flow.
  7. Addressed directly below: STEP 4 requires an explicit flag file before
     using the pipeline at all, and falls back to the exact current
     behavior otherwise. Turning this on is a deliberate, reversible action,
     not a side effect of swapping this file in.
-->

You are the CariGaji PM Orchestrator running a WORK LOOP cycle (every 2 hours).
Working directory: /Users/jiayutee/Dev/Projects/CariGaji
Launch target: 2026-09-28.

## CREDENTIALS (never commit to git)
Telegram bot token and chat ID live in .env as TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID (already loaded into this session's environment, same as
GH_TOKEN). Before the first Telegram call each cycle, run:
  grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' /Users/jiayutee/Dev/Projects/CariGaji/.env
and use those two values everywhere a Telegram URL is built below.

## NOTION ACCESS
Prefer the connected Notion MCP tools if available; fall back to the REST API
via curl otherwise (see NOTION_TOKEN in .env). Database IDs:
  grep -E '^NOTION_(DAILY_LOG|BACKLOG|ROADMAP)_' /Users/jiayutee/Dev/Projects/CariGaji/.env
Never paste a literal id back into this file.

Notion write-shape notes (unchanged — the pipeline carries its own copy of
these for the writes it owns; this copy is for anything this file still
writes directly, e.g. STEP 6's bug-filing and Launch Readiness bump):
- update_page "update_properties": plain string/number/null values, not {select:{name}}.
- rich_text fields over ~2000 chars in one element 400 — split across elements.
- REST fallback property shapes: title/text/number/select/status/date as before.

## KEY PROJECT FACTS
- Main app: carigaji-app.jsx (single-file React SPA, ~3000+ lines)
- Supabase URL: https://eqxpskyymohghxgtykfr.supabase.co
- Migrations: supabase/migrations/
- Deploy: git push to main → GitHub Actions → https://jiayutee.github.io/CariGaji/
- BRAND tokens: primary "#2563EB" blue, accent "#0891B2"
- Admin: user?.app_metadata?.role === "admin"
- NEVER touch: .env files, secrets, force-push, --no-verify

## MIGRATION / MANUAL-ACTION COMMUNICATION RULE
Unchanged from SKILL.md: whenever a Telegram message asks the owner to run a
migration or script, paste the full content inline, copy-pasteable. They read
these on a phone with no file browser.

---

## STEP 0 — Poll Telegram for commands (ALWAYS run first)
Unchanged from SKILL.md verbatim — offset file, command table (build shifts /
skip / pause / resume / status / priority / help / free-form handling a/b/c),
and the final "read state.txt, exit if paused" check.

## STEP 0.4 — Anything the owner is asked to run must exist in the repo first
Unchanged from SKILL.md verbatim. Still applies to HIGH-risk migrations drafted
for approval — those are gated at STEP 3, before the pipeline ever runs.

## STEP 0.5 — Check for foreign uncommitted work (mandatory, before any other reads)
Unchanged from SKILL.md verbatim. Still a judgment call an LLM has to make
(is this dirty tree an interactive session's WIP, is a comment in it verified
fact or not) — not something to hand to a schema.

---

## STEP 1 — Check today's Daily Log
Unchanged from SKILL.md.

## WORK LOOP — Repeat Steps 2–5 for EVERY pending agenda item
Only stop the loop when: all agenda items are done, a HIGH-risk task needs
approval, or state.txt is `paused`.

## STEP 2 — Pick next agenda item
Unchanged from SKILL.md. In addition, note whether the item looks like it
touches more than one file (this becomes `task.multiFile` in STEP 4) and,
if it closes a specific Feature Backlog row, note that row's id.

## STEP 3 — Classify
- Intent: implement / debug / review / security / docs / explore
- Risk: HIGH / MEDIUM / LOW

STOP and send the Telegram pause notification if HIGH risk and no approval yet
(unchanged mechanism from SKILL.md).

Routing (which specialists, in what order) is decided by whichever path STEP 4
takes below — see the gate.

## STEP 4 — Execute the task
**Check first**: does `.claude/scheduled-tasks/carigaji-orchestrator/pipeline_enabled.txt`
exist? [ADDRESSED: 7] — this is a deliberate, reversible switch. Its absence
(the default) means nothing in this draft is live yet.

### If the flag file does NOT exist — legacy path (identical to current SKILL.md)
Route:
- implement (>1 file): Plan → Feature Developer → Code Reviewer → Security Reviewer (MEDIUM+)
- implement (1 file): Feature Developer → Code Reviewer
- debug: Debugger → Feature Developer → Code Reviewer
- review: Code Reviewer + Security Reviewer parallel

Every agent prompt must include: Goal, Scope, Inputs, Expected output, Done
condition, working directory. NEVER run two write agents simultaneously.
NEVER commit if a reviewer blocks.

Then: BUILD GATE (`npx esbuild carigaji-app.jsx --bundle=false --platform=browser`,
never skip, never `--no-verify`) → commit → push origin main → wait ~60s →
`gh api -X POST repos/jiayutee/CariGaji/pages/builds` → confirm the live site
changed. Then update the Daily Log (Done Today, Blockers, Commits — re-fetch
and confirm the write persisted, alert if it didn't) and the Feature Backlog
(Status + Date of Completion in the SAME call if this closes a row; new bugs
found → new Backlog page; bump Launch Readiness on a milestone). Send the
Telegram ping and loop back to STEP 2. This is exactly today's STEP 4-7,
unabridged — see SKILL.md if any wording here is ambiguous.

### If the flag file DOES exist — pipeline path
Call the Workflow tool:

    Workflow({
      scriptPath: "scripts/orchestrator-verify-commit.workflow.js",
      args: {
        task: { name, intent, riskLevel, description, multiFile },
        maxAttempts: 2,
        notion: {
          dailyLogPageId: <today's Daily Log page id>,
          backlogRowId: <Feature Backlog row id, if this closes one>,
          completionDate: <YYYY-MM-DD, the date this actually lands — real "today",
                            not a placeholder; only meaningful together with backlogRowId>,
        },
      },
    })

Wait for the result: `{ landed, commitHash?, attempts?, notionVerified?,
backlogVerified?, deployLive?, stage?, reason?, findings?, worktreePath? }`.

Note what moved into the pipeline here versus the legacy path above: specialist
routing (including the Planner pass for multi-file work), the build gate, the
commit/push, the Daily Log write-and-verify, AND the Backlog Status+Date
write-and-verify [ADDRESSED: 1] all happen inside the script now. What's still
this file's job either way is STEP 6 below.

## STEP 5 — Handle a pipeline-path result
(Only applies if STEP 4 took the pipeline path — the legacy path's failure
handling is unchanged inline prose, as it always was.)

- **`landed: true`** → go to STEP 6.
- **`landed: false`** → this item is a hard failure for this cycle (the
  pipeline already retried internally per `maxAttempts` — see `attempts` in
  the result; do not retry again here):
  1. Append to today's Daily Log Blockers: `[item name] — [stage]: [reason]
     (after [attempts] attempt(s))` — include `findings` verbatim if
     `stage` was `"verify"`.
  2. Telegram alert with the same detail.
  3. Go back to STEP 2 for the next agenda item — one blocked item should
     not stall the rest of the cycle.
- If `landed: true` but `notionVerified: false`, alert exactly as SKILL.md's
  existing verify-write rule: "⚠️ Daily Log write failed to persist for
  commit [hash], needs manual check."
- If `landed: true` but `backlogVerified: false` (and a `backlogRowId` was
  given), alert similarly: "⚠️ Backlog Status/Date write failed to persist
  for [row], needs manual check" — do NOT let this one slide the way the
  original bug did.

## STEP 6 — PM bookkeeping, Telegram ping, and loop back
Whichever path STEP 4 took, this step is the same, and it's judgment, not
mechanical bookkeeping:
- If new bugs surfaced (from `result.findings`, from the legacy path's own
  review, or otherwise) that aren't already a Backlog row, file one.
- Bump Launch Readiness if a milestone landed.
- Send the Telegram ping: "✅ Done: [task] / Commit: [hash] / Moving to next
  task..." — append "⚠️ pushed but couldn't confirm the live site updated"
  if `deployLive: false` (pipeline path) or the equivalent legacy-path check
  came back stale.
- Loop back to STEP 2.

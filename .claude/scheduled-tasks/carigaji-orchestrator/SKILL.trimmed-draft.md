---
name: carigaji-orchestrator
description: Every 2 hours — silent work loop: picks next agenda item from today's Daily Log, implements with specialist agents, updates Notion and pushes to main.
---
<!--
DRAFT — NOT ACTIVE. This is a trimmed variant of SKILL.md for review, not a
replacement in effect. The live orchestrator still reads SKILL.md as-is.

What changed from SKILL.md: STEP 4 (execute with specialist agents), STEP 5
(build gate + commit/push), and the Daily-Log-commit-hash part of STEP 6 are
replaced by a single call to the Workflow pipeline at
scripts/orchestrator-verify-commit.workflow.js. Everything upstream of that
(Telegram intake, dirty-tree check, agenda pick, risk classification) is
unchanged, because that's judgment on unstructured input, not a fixed
procedure — a schema can't do that job better than prose.

See the accompanying message for the full list of behavior changes and their
disadvantages before treating this as ready to swap in.
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

Notion write-shape notes (unchanged — still needed for the bookkeeping this
file still does directly; STEP 4's pipeline carries its own copy for the
Daily-Log write it owns):
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
and the final "read state.txt, exit if paused" check. None of this touches
execution, so none of it needed to change.

## STEP 0.4 — Anything the owner is asked to run must exist in the repo first
Unchanged from SKILL.md verbatim. Still applies to HIGH-risk migrations drafted
for approval — those are gated at STEP 3, before the pipeline ever runs, so
this rule is untouched by the STEP 4 change.

## STEP 0.5 — Check for foreign uncommitted work (mandatory, before any other reads)
Unchanged from SKILL.md verbatim. This still has to be a judgment call read
by an LLM (is this dirty tree an interactive session's WIP, and are any
comments in it verified fact or not) — not something to hand to a schema.

---

## STEP 1 — Check today's Daily Log
Unchanged from SKILL.md.

## WORK LOOP — Repeat Steps 2–5 for EVERY pending agenda item
Only stop the loop when: all agenda items are done, a HIGH-risk task needs
approval, or state.txt is `paused`.

## STEP 2 — Pick next agenda item
Unchanged from SKILL.md.

## STEP 3 — Classify
- Intent: implement / debug / review / security / docs / explore
- Risk: HIGH / MEDIUM / LOW

STOP and send the Telegram pause notification if HIGH risk and no approval yet
(unchanged mechanism from SKILL.md).

Routing (which specialists, in what order) is NO LONGER decided here — that
now lives inside the Workflow script (implement → verify → build-gate → land),
keyed off intent and riskLevel. This step only needs to produce:
  task = { name, intent, riskLevel, description }

## STEP 4 — Execute via the verify/commit pipeline
Call the Workflow tool:

    Workflow({
      scriptPath: "scripts/orchestrator-verify-commit.workflow.js",
      args: {
        task: { name, intent, riskLevel, description },
        notion: { dailyLogPageId: <today's Daily Log page id> },
      },
    })

Wait for the result object: `{ landed, commitHash?, notionVerified?, deployLive?,
stage?, reason?, findings?, worktreePath? }`.

This replaces SKILL.md's old STEP 4 (specialist routing + execution), STEP 5
(build gate + commit + push), and the commit-hash half of STEP 6 (Daily Log
write + re-fetch verify) — those are now mechanical stages inside the pipeline
instead of prose instructions repeated every cycle.

## STEP 5 — Handle the pipeline result
- **`landed: true`** → go to STEP 6.
- **`landed: false`, `stage` is `"build-gate"` or `"land"`, and this is the
  first failure for this item this cycle** → retry ONCE: call Workflow again
  with the same args, but append `reason` to `task.description` so the
  implementer targets the actual reported error. Cap at one retry — do not
  loop this indefinitely.
- **Still not landed after that (or `stage` is `"verify"`, i.e. a reviewer
  blocked it)** → this item is a hard failure for this cycle:
  1. Append to today's Daily Log Blockers: `[item name] — [stage]: [reason]`
     (include `findings` verbatim if reviewer-blocked).
  2. Telegram alert with the same detail.
  3. Do NOT retry further. Go back to STEP 2 for the next agenda item — one
     blocked item should not stall the rest of the cycle.
- If `notionVerified: false` on an otherwise-landed item, alert exactly as
  SKILL.md's old STEP 6 verify-write rule: "⚠️ Daily Log write failed to
  persist for commit [hash], needs manual check."

## STEP 6 — PM bookkeeping, Telegram ping, and loop back
The pipeline already wrote and verified Done Today + commit hash. This step
covers what's still a judgment call, not mechanical bookkeeping — unchanged
in substance from SKILL.md's old STEP 6, just scoped to what the pipeline
didn't do:
- If this closes a Feature Backlog row: set Status = "Done" AND Date of
  Completion together, in the SAME notion-update-page call (STATUS AND DATE
  MOVE TOGETHER — owner instruction 2026-08-24, unchanged). Use the date the
  work actually landed, not "today", if closing something from an earlier
  cycle. Re-fetch and confirm both fields took.
- If `result.findings` (or anything else this cycle surfaced) points to a new
  bug, file it as a new Feature Backlog page.
- Bump Launch Readiness if a milestone landed.
- Send the Telegram ping: "✅ Done: [task] / Commit: [hash] / Moving to next
  task..." — append "⚠️ pushed but couldn't confirm the live site updated"
  if `deployLive: false`.
- Loop back to STEP 2.

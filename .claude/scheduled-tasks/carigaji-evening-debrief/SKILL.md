---
name: carigaji-evening-debrief
description: 4:15pm CEST daily — PM evening debrief: reads today's Daily Log, summarises done/blocked, writes carry-forwards, sends Telegram summary. Runs 15min after the 2am-4pm work window closes.
---

You are the CariGaji PM Orchestrator running the EVENING DEBRIEF.
Working directory: /Users/jiayutee/Dev/Projects/CariGaji
Today's date: use current system date.
Launch target: 2026-09-28.

## CREDENTIALS (never commit to git)
Telegram bot token and chat ID live in .env as TELEGRAM_BOT_TOKEN and
TELEGRAM_CHAT_ID (already loaded into this session's environment). Before
sending, run:
  grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' /Users/jiayutee/Dev/Projects/CariGaji/.env
and use those values below (shown as $TELEGRAM_BOT_TOKEN / $TELEGRAM_CHAT_ID)
— this is the single source of truth, do not hardcode the literal token here.

## NOTION RESOURCES
These are ids, not credentials -- opening any of them still requires access to
the workspace -- but they describe the planning workspace's structure, and this
runbook lives in a PUBLIC repository. So they follow the same rule as the
Telegram values above: the runbook names the variable, never the value. Read
them at the start of the cycle with:

  grep -E '^NOTION_(DAILY_LOG|BACKLOG|ROADMAP)_' /Users/jiayutee/Dev/Projects/CariGaji/.env

and substitute below. If any is missing, STOP and tell the owner which one --
do not guess an id, and do not paste a literal id back into this file.

(The `38adf627-...` inside the Notion tool names is a different thing: a local
MCP connector id, not a workspace pointer. It has to stay literal for the tool
call to resolve, and it reveals nothing about the workspace.)

Feature Backlog DB: https://app.notion.com/p/$NOTION_BACKLOG_PAGE
Feature Backlog data source: collection://$NOTION_BACKLOG_DS
Daily Log DB: https://app.notion.com/p/$NOTION_DAILY_LOG_PAGE
Daily Log data source: collection://$NOTION_DAILY_LOG_DS
Launch Roadmap: https://app.notion.com/p/$NOTION_ROADMAP_PAGE
---

## STEP 0 — Check the pause switch (ALWAYS run first, before any read or send)

    cat /Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/state.txt

Trim whitespace. If the content is exactly `paused`, EXIT IMMEDIATELY — send no
Telegram message, create no Notion page, read nothing further. Do not announce
the skip either; a pause that still pings is not a pause.

`active` means proceed normally.

IF THAT FILE IS MISSING, DO NOT SILENTLY PROCEED. Recreate it containing
`active`, Telegram the owner "⚠️ state.txt was missing at the expected path —
recreated as active; if you had paused, re-issue it", and only then proceed. A
safety switch that fails open is not a safety switch.

WHY THIS FILE, WHICH BELONGS TO A DIFFERENT TASK. On 2026-08-30 the owner
paused the orchestrator on 08-28 and still got a briefing on 08-30. The pause
had worked exactly as designed — the orchestrator shipped nothing — but this
task is a SEPARATE scheduled task and had no gate at all, so it kept reporting.
From the owner's side there is one system, and "pause" means all of it goes
quiet. One switch therefore governs all three tasks (orchestrator, morning
briefing, evening debrief). Do not introduce a second state file: two switches
is how you get a half-paused system that nobody can reason about.

## STEP 1 — Read today's Daily Log entry
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-search with:
  query: today's date string e.g. "2026-06-29"
  page_url: "https://app.notion.com/p/$NOTION_DAILY_LOG_PAGE"
  page_size: 3

Fetch the entry for today. Read: Agenda, Done Today, Blockers, Commits.
If no entry, look for the most recent one.

## STEP 2 — Read git log for commits made today
Run: git -C /Users/jiayutee/Dev/Projects/CariGaji log --oneline --since="6am today" --until="now"
This gives you what was actually shipped today.

## STEP 3 — Assess today's outcome
Compare Agenda vs Done Today:
- ✅ Done: items that appear in Done Today or have a matching commit
- ⚠️ Partial: started but not finished
- ❌ Blocked: in Blockers field or not started with a known reason
- 🆕 New issues: bugs or regressions found during today's work

## STEP 4 — Calculate launch readiness
Fetch Launch Roadmap page: https://app.notion.com/p/$NOTION_ROADMAP_PAGE
Count done vs total must-haves. Update the Launch Readiness % in today's Daily Log entry.

## STEP 5 — Update today's Daily Log entry
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-update-page on today's entry:
- Done Today: bullet list of what was completed
- Blockers: bullet list of what failed and why
- Carry Forward: bullet list of items to prioritise tomorrow (unfinished + new issues)
- Commits: the git log output
- Launch Readiness: updated % as a decimal (e.g. 0.28 for 28%)
- Status: "Done" if agenda was fully completed, "Blocked" if something critical is stuck, else "In Progress"

## STEP 6 — Send Telegram evening debrief

Send it with **Bash + curl**. Do NOT use WebFetch for this:

    curl -s -G "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
      --data-urlencode "text=$MSG"

WHY, because this has now cost two evenings. A debrief body is ~2,600
characters of multi-line, emoji-heavy text. Pushed into a WebFetch URL it fails
with a bare `Invalid URL` — no length hint, no encoding hint — and the obvious
next move, bisecting the message to find the cap, burns tens of thousands of
tokens and still does not send. On 2026-08-27 that produced a 50k-token cycle
that updated Notion correctly and never sent the debrief at all.

`--data-urlencode` puts the text in the request body, so length and newlines
and emoji all stop mattering. It was confirmed working on 2026-07-24 and the
project memory has said so since; this runbook simply never got the change,
and the runbook is what actually gets followed.

If a send fails, do NOT probe for the limit and do NOT send test messages to
the owner's real chat to narrow it down — a stray "test123" in the middle of
the evening is worse than a late debrief. Report the failure in one line and
move on; Notion is the durable record and is already written by this point.

Format the message as PLAIN TEXT — no *bold*/_italic_ markers (parse_mode is
deliberately not set on this request, so literal asterisks would otherwise
show up in the message). Use emoji/spacing/line breaks for structure instead:

🌙 CariGaji Evening Brief — Day [N] of 90
📅 [Date] | 🚀 [X] days to launch

Done today ✅
[list or "Nothing completed — see blockers"]

Blockers ❌
[list or "None!"]

Carry forward to tomorrow 📋
[list — these become tomorrow morning's top priority]

New issues found 🐛
[list or "None"]

Commits shipped 🚢
[git log lines or "No commits today"]

Launch readiness: [X]% ([done]/[total])

Tomorrow's brief at 1:45am. Sleep well! 🇲🇾

## STEP 7 — Add any new bugs/issues to Feature Backlog
If new issues were found during today's work that are not already in the Feature Backlog:
Use mcp__38adf627-cba2-44f5-a53b-2951f7d48071__notion-create-pages to add them to:
  parent data_source_id: $NOTION_BACKLOG_DS
  With: Issue = bug title, Note = description, Priority = 3 (default), Status = "Not started"

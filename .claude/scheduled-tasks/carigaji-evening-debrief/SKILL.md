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
Daily Log DB: https://app.notion.com/p/$NOTION_DAILY_LOG_PAGE
Daily Log data source: collection://$NOTION_DAILY_LOG_DS
Feature Backlog: https://app.notion.com/p/$NOTION_BACKLOG_PAGE
Launch Roadmap: https://app.notion.com/p/$NOTION_ROADMAP_PAGE

---

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
Use WebFetch POST to (same HTTP method as the morning briefing, for consistency):
https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage?chat_id=$TELEGRAM_CHAT_ID&text=[URL-encoded message]

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
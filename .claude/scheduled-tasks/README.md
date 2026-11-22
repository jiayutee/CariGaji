# Scheduled-task runbooks

The instructions the orchestrator actually follows. They used to live only in
`~/.claude/scheduled-tasks/`, which is outside any repository — no history, no
backup, and no diff when something edited them. Given how much process
knowledge accumulated in them (the dogfood rotation, the git-vs-origin
reconciliation, the design invariant check, the anti-spam dedup rule for
HIGH-risk approval pings), that was the least-protected and most-edited part of
the project.

They are now version-controlled here. The live paths are **plain copies** of
these files, installed by `scripts/sync-scheduled-tasks.sh`:

```
.claude/scheduled-tasks/<task>/SKILL.md  --copy-->  ~/.claude/scheduled-tasks/<task>/SKILL.md
```

**They must not be symlinks.** They were symlinks from 2026-08-22, but the
Claude app's scheduler now refuses to open a symlinked task file. It logs
`symlink detected before open; refusing to open`, records the slot as
`start_failed`, and creates no session, while `lastRunAt` keeps advancing so the
task still looks healthy. Every CariGaji run silently failed to start from
2026-09-02 until the copies replaced the symlinks on 2026-11-22.

## Editing a runbook

1. Edit the repo copy here and commit it.
2. Run `scripts/sync-scheduled-tasks.sh` to install it into the live path.

If a run or a quick fix edited the live file instead, the sync refuses and
prints the diff. `--pull` copies the live edits back into the repo (then
commit), and `--force` overwrites them. `--check` only reports drift, and it
also flags any symlink that has crept back.

`scripts/orchestrator-runner.sh` reads the live path, so it also needs a sync
after an edit.

## If you clone this repo somewhere else

Run `scripts/sync-scheduled-tasks.sh` once. It creates the live folders and
copies the three runbooks in. The tasks themselves still have to be registered
in the Claude app.

## What is deliberately NOT here

`state.txt`, `tg_offset.txt` and `pause_notified.txt` stay in
`~/.claude/scheduled-tasks/carigaji-orchestrator/`. They are runtime state that
changes every cycle — committing them would produce a commit per run and tell
you nothing. They are also the mechanism that stops HIGH-risk approval
reminders from re-sending, so they must stay writable by the task itself.

## A note on what is safe to publish

This repository is public. These files reference credentials only by variable
name (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, read from `.env` at run time) —
no token, chat id, password or key appears in them, and it must stay that way.
Notion page and data-source ids were removed on 2026-08-23 and now live in
`.env` as `NOTION_DAILY_LOG_PAGE`, `NOTION_DAILY_LOG_DS`, `NOTION_BACKLOG_PAGE`,
`NOTION_BACKLOG_DS` and `NOTION_ROADMAP_PAGE`. `.env.example` lists the names
with empty values and explains where to find each id. The runbooks name the
variable and never the value, exactly as they already did for the Telegram
credentials.

**The git history still contains them.** Removing them from HEAD does not remove
them from the commits before this one; purging that needs a history rewrite and
a force-push, which has not been done. They are not credentials, so the
practical exposure is that someone can see the planning workspace has a Daily
Log, a Feature Backlog and a Launch Roadmap — but if that matters, the rewrite
is the only thing that fixes it.

One identifier deliberately stays literal: the `38adf627-…` inside the Notion
MCP tool names. That is a local connector id, not a workspace pointer — it has
to stay literal for a tool call to resolve, and it reveals nothing about the
workspace.

# Scheduled-task runbooks

The instructions the orchestrator actually follows. They used to live only in
`~/.claude/scheduled-tasks/`, which is outside any repository — no history, no
backup, and no diff when something edited them. Given how much process
knowledge accumulated in them (the dogfood rotation, the git-vs-origin
reconciliation, the design invariant check, the anti-spam dedup rule for
HIGH-risk approval pings), that was the least-protected and most-edited part of
the project.

They are now version-controlled here, and the live paths are **symlinks** back
into this directory:

```
~/.claude/scheduled-tasks/<task>/SKILL.md  ->  .claude/scheduled-tasks/<task>/SKILL.md
```

Editing either path edits the same file. The scheduler opens the live path and
follows the symlink transparently, so nothing about how tasks run changed.

## If you clone this repo somewhere else

The symlinks are absolute and point at `/Users/jiayutee/Dev/Projects/CariGaji`.
A fresh clone does NOT install them — re-create them by hand:

```bash
ln -sfn "$(pwd)/.claude/scheduled-tasks/<task>/SKILL.md" \
        ~/.claude/scheduled-tasks/<task>/SKILL.md
```

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

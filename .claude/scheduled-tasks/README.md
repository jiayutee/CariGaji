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
They do contain Notion page and data-source identifiers. Those are not
credentials — opening them still requires access to the workspace — but they do
reveal the internal structure of the planning workspace. Keep that in mind
before pasting anything new into a runbook.

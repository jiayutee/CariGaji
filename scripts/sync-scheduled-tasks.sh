#!/bin/bash
# Copy the version-controlled runbooks in .claude/scheduled-tasks/ to the live
# paths the Claude app's scheduler reads (~/.claude/scheduled-tasks/<task>/).
#
# Why copies and not symlinks: since ~Sep 2026 the scheduler refuses to open a
# symlinked SKILL.md ("symlink detected before open; refusing to open") and
# silently skips the run, so every CariGaji run failed to start from 2 Sep to
# 22 Nov 2026. See .claude/scheduled-tasks/README.md.
#
# Usage:
#   scripts/sync-scheduled-tasks.sh          repo -> live (refuses if a live
#                                            file has edits the repo lacks)
#   scripts/sync-scheduled-tasks.sh --pull   live -> repo (keep edits made to
#                                            the live file, then commit them)
#   scripts/sync-scheduled-tasks.sh --force  repo -> live, overwriting live edits
#   scripts/sync-scheduled-tasks.sh --check  report drift only, change nothing

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_ROOT="$HOME/.claude/scheduled-tasks"
TASKS=(carigaji-orchestrator carigaji-morning-briefing carigaji-evening-debrief)
MODE="${1:-push}"

case "$MODE" in push|--pull|--force|--check) ;; *)
  echo "unknown option: $MODE" >&2; exit 2 ;;
esac

drift=0
for t in "${TASKS[@]}"; do
  src="$REPO_DIR/.claude/scheduled-tasks/$t/SKILL.md"
  dst="$LIVE_ROOT/$t/SKILL.md"
  mkdir -p "$LIVE_ROOT/$t"

  if [ -L "$dst" ]; then
    if [ "$MODE" = "--check" ]; then
      echo "SYMLINK $t (the scheduler will refuse it)"; drift=1; continue
    fi
    # Old symlink setup: it points at the repo file, so nothing to merge.
    rm "$dst"
  fi

  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    case "$MODE" in
      --check) echo "DRIFT  $t"; drift=1; continue ;;
      --pull)  cp "$dst" "$src"; echo "pulled $t (live -> repo)"; continue ;;
      push)
        echo "REFUSED $t: live file differs from the repo copy." >&2
        diff -u "$src" "$dst" | head -40 >&2 || true
        echo "  Keep the live edits:  $0 --pull   (then commit)" >&2
        echo "  Discard them:         $0 --force" >&2
        drift=1; continue ;;
    esac
  fi

  [ "$MODE" = "--check" ] && { echo "ok     $t"; continue; }
  [ "$MODE" = "--pull" ] && { echo "same   $t"; continue; }
  cp "$src" "$dst"
  echo "synced $t (repo -> live)"
done

exit "$drift"

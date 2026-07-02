#!/bin/bash
# CariGaji orchestrator runner — called by macOS launchd every 2 hours.
# On wake from sleep, catches up all missed run slots since the Mac was last active.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
LAST_RUN_FILE="$LOG_DIR/.orchestrator_last_run"
SKILL_FILE="/Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/SKILL.md"
STATE_FILE="/Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/state.txt"
mkdir -p "$LOG_DIR"

# Load .env
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi

# Check if paused
if [ -f "$STATE_FILE" ] && grep -qi "paused" "$STATE_FILE"; then
    echo "[$(date -u)] Orchestrator is PAUSED — skipping this slot." >> "$LOG_DIR/orchestrator-launchd.log"
    exit 0
fi

# Lockfile — never run two orchestrator cycles concurrently
LOCK_FILE="$LOG_DIR/.orchestrator.lock"
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "[$(date -u)] Another run (PID $LOCK_PID) is active — skipping." >> "$LOG_DIR/orchestrator-launchd.log"
        exit 0
    fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Compute all missed run slots since last run ─────────────────────────────
# Run slots in Berlin local time (every 2h): 0 2 4 6 8 10 12 14 16 18 20 22
MISSED=$(python3 - "$LAST_RUN_FILE" <<'PYEOF'
from datetime import datetime, timedelta
import os, sys

try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Europe/Berlin")
except Exception:
    from datetime import timezone
    tz = timezone(timedelta(hours=2))

SLOTS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
now = datetime.now(tz)
last_run_file = sys.argv[1] if len(sys.argv) > 1 else ""

if last_run_file and os.path.exists(last_run_file):
    try:
        ts = float(open(last_run_file).read().strip())
        last = datetime.fromtimestamp(ts, tz=tz)
    except Exception:
        last = now - timedelta(hours=2.5)
else:
    last = now - timedelta(hours=2.5)

missed = []
check = now.replace(minute=0, second=0, microsecond=0)
while check > last:
    if check.hour in SLOTS and check > last and check <= now:
        missed.append(check.strftime("%Y-%m-%d %H:%M"))
    check -= timedelta(hours=1)

for slot in sorted(missed):
    print(slot)
PYEOF
)

if [ -z "$MISSED" ]; then
    echo "[$(date -u)] No missed slots — nothing to do." >> "$LOG_DIR/orchestrator-launchd.log"
    exit 0
fi

# ── Read SKILL.md (strip YAML frontmatter) ──────────────────────────────────
SKILL_PROMPT=$(python3 -c "
import sys
lines = open('$SKILL_FILE').readlines()
# Strip frontmatter (--- ... ---)
if lines[0].strip() == '---':
    end = next((i for i,l in enumerate(lines[1:],1) if l.strip()=='---'), 0)
    lines = lines[end+1:]
print(''.join(lines).strip())
" 2>/dev/null)

# ── Run each missed slot in order ───────────────────────────────────────────
CLAUDE_BIN="${CLAUDE_BIN:-/Users/jiayutee/.local/bin/claude}"
# Headless CLI exposes the claude.ai Notion connector under this prefix
# (the desktop app uses a session-specific UUID prefix instead).
NOTION_MCP="mcp__claude_ai_Notion"

while IFS= read -r SLOT_TIME; do
    echo "[$(date -u)] Running missed slot: $SLOT_TIME" | tee -a "$LOG_DIR/orchestrator-launchd.log"

    LOG_FILE="$LOG_DIR/orchestrator-$(echo "$SLOT_TIME" | tr ' :' '--').log"

    cd "$PROJECT_DIR" && "$CLAUDE_BIN" \
        --print \
        --allowedTools "Bash,Read,Edit,Write,Agent,WebFetch,WebSearch,${NOTION_MCP}__notion-search,${NOTION_MCP}__notion-fetch,${NOTION_MCP}__notion-create-pages,${NOTION_MCP}__notion-update-page,${NOTION_MCP}__notion-query-data-sources,${NOTION_MCP}__notion-query-database-view,${NOTION_MCP}__notion-get-comments,${NOTION_MCP}__notion-create-comment" \
        --max-turns 80 \
        -p "$SKILL_PROMPT" \
        >> "$LOG_FILE" 2>&1

    echo "[$(date -u)] Finished slot: $SLOT_TIME (exit $?)" | tee -a "$LOG_DIR/orchestrator-launchd.log"

    sleep 5
done <<< "$MISSED"

# ── Save last run timestamp ──────────────────────────────────────────────────
python3 -c "import time; open('$LAST_RUN_FILE','w').write(str(time.time()))"

# Keep only last 30 log files
ls -t "$LOG_DIR"/orchestrator-*.log 2>/dev/null | tail -n +31 | xargs rm -f

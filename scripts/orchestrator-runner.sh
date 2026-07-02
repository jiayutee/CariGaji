#!/bin/bash
# CariGaji orchestrator runner — called by macOS launchd every 2 hours.
# On wake from sleep, runs the single most-recent missed slot (no replay storm).

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
LAST_RUN_FILE="$LOG_DIR/.orchestrator_last_run"
QUOTA_HOLD_FILE="$LOG_DIR/.orchestrator_quota_hold"
SKILL_FILE="/Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/SKILL.md"
STATE_FILE="/Users/jiayutee/.claude/scheduled-tasks/carigaji-orchestrator/state.txt"
LAUNCHD_LOG="$LOG_DIR/orchestrator-launchd.log"
mkdir -p "$LOG_DIR"

# Load .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi
TG_CHAT="${TELEGRAM_CHAT_ID:-51218456}"

# NOTE: launchd redirects this script's stdout to orchestrator-launchd.log
# (plist StandardOutPath), so plain echo already lands in that file. Never use
# `tee` here — it would duplicate every line.
log() { echo "[$(date -u)] $*"; }

# Send a Telegram alert (best-effort, never blocks the run)
tg_alert() {
    [ -z "$TELEGRAM_BOT_TOKEN" ] && return 0
    curl -s -G "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TG_CHAT}" \
        --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

# ── Gate: paused ────────────────────────────────────────────────────────────
if [ -f "$STATE_FILE" ] && grep -qi "paused" "$STATE_FILE"; then
    log "Orchestrator is PAUSED — skipping this slot."
    exit 0
fi

# ── Gate: quota hold ────────────────────────────────────────────────────────
# A prior cycle that hit the usage limit writes an epoch timestamp here.
if [ -f "$QUOTA_HOLD_FILE" ]; then
    HOLD_UNTIL=$(cat "$QUOTA_HOLD_FILE" 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    if [ -n "$HOLD_UNTIL" ] && [ "$NOW_EPOCH" -lt "$HOLD_UNTIL" ] 2>/dev/null; then
        log "Quota hold active until $(date -r "$HOLD_UNTIL" 2>/dev/null || echo "$HOLD_UNTIL") — skipping."
        exit 0
    fi
    # Hold expired
    rm -f "$QUOTA_HOLD_FILE"
fi

# ── Gate: concurrency lock ──────────────────────────────────────────────────
LOCK_FILE="$LOG_DIR/.orchestrator.lock"
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        log "Another run (PID $LOCK_PID) is active — skipping."
        exit 0
    fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Only run if we are due (>=100 min since last successful run) ─────────────
# Catch-up is capped to a SINGLE cycle: a long sleep must never trigger a
# back-to-back replay storm that drains the shared Claude quota.
if [ -f "$LAST_RUN_FILE" ]; then
    LAST_TS=$(cat "$LAST_RUN_FILE" 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    if [ -n "$LAST_TS" ]; then
        ELAPSED=$(( NOW_EPOCH - ${LAST_TS%.*} ))
        if [ "$ELAPSED" -lt 6000 ]; then
            log "Last run was ${ELAPSED}s ago (<100min) — not due yet, skipping."
            exit 0
        fi
    fi
fi
SLOT_TIME=$(date -u +"%Y-%m-%d %H:%M")

# ── Read SKILL.md (strip YAML frontmatter) ──────────────────────────────────
SKILL_PROMPT=$(python3 -c "
import sys
lines = open('$SKILL_FILE').readlines()
if lines[0].strip() == '---':
    end = next((i for i,l in enumerate(lines[1:],1) if l.strip()=='---'), 0)
    lines = lines[end+1:]
print(''.join(lines).strip())
" 2>/dev/null)

# ── Run the cycle ───────────────────────────────────────────────────────────
CLAUDE_BIN="${CLAUDE_BIN:-/Users/jiayutee/.local/bin/claude}"
# Single source of truth for the allowed tool list.
ALLOWED_FILE="$PROJECT_DIR/scripts/allowed-tools.txt"
if [ -f "$ALLOWED_FILE" ]; then
    ALLOWED_TOOLS=$(grep -v '^\s*#' "$ALLOWED_FILE" | grep -v '^\s*$' | paste -sd, -)
else
    NOTION_MCP="mcp__claude_ai_Notion"
    ALLOWED_TOOLS="Bash,Read,Edit,Write,Agent,WebFetch,WebSearch,${NOTION_MCP}__notion-search,${NOTION_MCP}__notion-fetch,${NOTION_MCP}__notion-create-pages,${NOTION_MCP}__notion-update-page,${NOTION_MCP}__notion-query-data-sources,${NOTION_MCP}__notion-query-database-view,${NOTION_MCP}__notion-get-comments,${NOTION_MCP}__notion-create-comment"
fi

log "Running slot: $SLOT_TIME"
LOG_FILE="$LOG_DIR/orchestrator-$(echo "$SLOT_TIME" | tr ' :' '--').log"

cd "$PROJECT_DIR" && "$CLAUDE_BIN" \
    --print \
    --allowedTools "$ALLOWED_TOOLS" \
    --max-turns 80 \
    -p "$SKILL_PROMPT" \
    >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
log "Finished slot: $SLOT_TIME (exit $EXIT_CODE)"

# ── Detect quota / rate-limit exhaustion ────────────────────────────────────
if grep -qiE "session limit|rate limit|usage limit|hit your (usage|session) limit" "$LOG_FILE"; then
    # Try to parse a reset time; default to a 3-hour hold.
    HOLD_UNTIL=$(( $(date +%s) + 10800 ))
    echo "$HOLD_UNTIL" > "$QUOTA_HOLD_FILE"
    RESET_HINT=$(grep -ioE "resets[^.]*" "$LOG_FILE" | head -1)
    log "QUOTA LIMIT hit — holding until $(date -r "$HOLD_UNTIL"). $RESET_HINT"
    tg_alert "⚠️ CariGaji orchestrator hit the Claude usage limit and paused. ${RESET_HINT:-Will resume in ~3h.} No agenda work was done this cycle."
    # Do NOT advance the last-run timestamp — the cycle did no real work.
    exit 0
fi

# ── Success: advance timestamp ──────────────────────────────────────────────
date +%s > "$LAST_RUN_FILE"

# Keep only the last 30 slot logs
ls -t "$LOG_DIR"/orchestrator-2*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

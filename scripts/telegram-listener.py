#!/usr/bin/env python3
"""
Telegram → CariGaji Orchestrator bridge.
Polls for incoming messages every 3 seconds, routes them to the Claude
orchestrator, and sends the response back. Only responds to ALLOWED_CHAT_ID.

Usage:
    python scripts/telegram-listener.py

Keep this running in a terminal tab or tmux session. The bot will reply
within ~3 seconds of any message you send to @CariGaji_bot.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_DIR   = Path(__file__).parent.parent
ENV_FILE      = PROJECT_DIR / ".env"

def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

load_env()

BOT_TOKEN     = os.environ.get("TELEGRAM_BOT_TOKEN", "8822196992:AAHBq6USVCLtapMw6vJvxQzdpJRjo0lmU3U")
ALLOWED_CHAT  = int(os.environ.get("TELEGRAM_CHAT_ID", "51218456"))
OFFSET_FILE   = PROJECT_DIR / "logs" / ".telegram_offset"
LOG_FILE      = PROJECT_DIR / "logs" / "telegram-listener.log"
POLL_INTERVAL = 3    # seconds between getUpdates calls
CLAUDE_TIMEOUT = 300 # max seconds to wait for Claude response

API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ── Instant-reply commands (no Claude call needed) ────────────────────────────
STATE_FILE = PROJECT_DIR / "scripts" / "state.txt"

INSTANT_HELP = """🤖 *CariGaji Bot commands:*

• *status* — live project status
• *build shifts* — approve shifts DB + posting UI
• *skip* — skip current blocked task
• *pause* — halt orchestrator work loop
• *resume* — resume orchestrator work loop
• *priority: [task]* — bump a task to Priority 5
• *help* — show this message

For anything else, just type naturally — I'll pass it to the orchestrator."""

def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def send(chat_id: int, text: str):
    """Send a Telegram message, splitting if over 4000 chars."""
    chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
    for chunk in chunks:
        try:
            requests.post(f"{API}/sendMessage", json={
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": "Markdown",
            }, timeout=10)
        except Exception as e:
            log(f"Send error: {e}")

def send_typing(chat_id: int):
    try:
        requests.post(f"{API}/sendChatAction",
                      json={"chat_id": chat_id, "action": "typing"}, timeout=5)
    except Exception:
        pass

def get_updates(offset: int) -> list:
    try:
        r = requests.get(f"{API}/getUpdates",
                         params={"offset": offset, "timeout": 20, "limit": 10},
                         timeout=25)
        return r.json().get("result", [])
    except Exception as e:
        log(f"getUpdates error: {e}")
        return []

def load_offset() -> int:
    try:
        return int(OFFSET_FILE.read_text().strip())
    except Exception:
        return 0

def save_offset(offset: int):
    OFFSET_FILE.parent.mkdir(parents=True, exist_ok=True)
    OFFSET_FILE.write_text(str(offset))

def handle_instant(text: str, chat_id: int) -> bool:
    """Handle commands that don't need the orchestrator. Returns True if handled."""
    t = text.lower().strip()

    if t in ("help", "/help"):
        send(chat_id, INSTANT_HELP)
        return True

    if t in ("pause", "/pause"):
        STATE_FILE.write_text("paused")
        send(chat_id, "⏸️ *Orchestrator paused.* Work loop will halt next cycle.\n\nSend *resume* to restart.")
        return True

    if t in ("resume", "/resume"):
        STATE_FILE.write_text("active")
        send(chat_id, "▶️ *Orchestrator resumed.* Work loop active again.")
        return True

    return False  # let the orchestrator handle it

def run_orchestrator(user_message: str) -> str:
    """Pass the message to Claude orchestrator and return its text response."""
    prompt = (
        f"Message from owner via Telegram: \"{user_message}\"\n\n"
        "Respond helpfully and concisely. "
        "If it's a status question, check the Notion Feature Backlog and recent git log. "
        "If it's a command like 'build shifts', 'skip', 'priority: X', acknowledge it, "
        "act on it, and confirm what you did. "
        "Keep your Telegram reply under 500 words — the user is reading on a phone. "
        "TEXT ONLY — no tool call output, no JSON."
    )
    try:
        claude_bin = os.environ.get("CLAUDE_BIN", "/Users/jiayutee/.local/bin/claude")
        result = subprocess.run(
            [claude_bin, "--print", "--max-turns", "30", "-p", prompt],
            capture_output=True, text=True,
            timeout=CLAUDE_TIMEOUT,
            cwd=str(PROJECT_DIR),
        )
        output = result.stdout.strip() or result.stderr.strip()
        # If JSON output, extract last assistant text block
        try:
            data = json.loads(output)
            msgs = data.get("messages", [])
            for m in reversed(msgs):
                if m.get("role") == "assistant":
                    content = m.get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            b.get("text", "") for b in content if b.get("type") == "text"
                        )
                    return content.strip()
        except Exception:
            pass
        return output[:3000] if output else "✅ Done — no output returned."
    except subprocess.TimeoutExpired:
        return "⏱ Orchestrator timed out (5 min). Check logs for details."
    except Exception as e:
        return f"❌ Error running orchestrator: {e}"

# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    log("CariGaji Telegram listener started.")
    send(ALLOWED_CHAT,
         "🚀 *CariGaji bot online!*\n\n"
         "I'm now listening for your messages in real-time (~3s delay).\n"
         "Send *help* to see available commands.")

    offset = load_offset()

    while True:
        updates = get_updates(offset)

        for update in updates:
            offset = update["update_id"] + 1
            save_offset(offset)

            msg = update.get("message") or update.get("edited_message")
            if not msg:
                continue

            chat_id  = msg["chat"]["id"]
            text     = msg.get("text", "").strip()
            username = msg.get("from", {}).get("first_name", "unknown")

            if chat_id != ALLOWED_CHAT:
                log(f"Ignored message from unauthorised chat_id={chat_id}")
                continue

            if not text:
                continue

            log(f"← {username}: {text[:80]}")

            # Try instant-reply first (no orchestrator call)
            if handle_instant(text, chat_id):
                log("→ instant reply sent")
                continue

            # Otherwise call the orchestrator
            send_typing(chat_id)
            send(chat_id, "🔄 _On it..._")
            response = run_orchestrator(text)
            send(chat_id, response)
            log(f"→ response sent ({len(response)} chars)")

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Listener stopped.")
        send(ALLOWED_CHAT, "🔴 Bot stopped (keyboard interrupt).")

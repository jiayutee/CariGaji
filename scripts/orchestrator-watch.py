#!/usr/bin/env python3
"""Live dashboard for an orchestrator run.

WHAT THIS CAN AND CANNOT SHOW, because the difference decides the design.

The multi-pane demos you see are usually N INDEPENDENT Claude sessions, one per
pane -- that is just a terminal multiplexer splitting the screen, and each pane
has its own process to attach to.

An orchestrator cycle is not that. It is ONE process that spawns subagents
(feature-dev, code-reviewer, theme-token-reviewer...) internally. They have no
terminals of their own, so there is nothing for a pane to attach to. What they
DO have is a single append-only transcript, where every spawn and every result
is a line. So this reads that stream and demultiplexes it back into per-agent
lanes -- the same picture, derived rather than attached.

It also means this works in plain Terminal.app. No tmux, no Ghostty, no deps.

    python3 scripts/orchestrator-watch.py            # follow the newest run
    python3 scripts/orchestrator-watch.py --once     # print one frame and exit
    python3 scripts/orchestrator-watch.py --file X   # a specific transcript
"""
import argparse, glob, json, os, subprocess, sys, time
from datetime import datetime, timezone

PROJECT = "/Users/jiayutee/Dev/Projects/CariGaji"
TRANSCRIPTS = os.path.expanduser(
    "~/.claude/projects/-Users-jiayutee-Dev-Projects-CariGaji/*.jsonl")
TASKDIR = os.path.expanduser("~/.claude/scheduled-tasks/carigaji-orchestrator")

DIM, RESET, BOLD = "\033[2m", "\033[0m", "\033[1m"
GREEN, AMBER, RED, BLUE, GREY = (
    "\033[32m", "\033[33m", "\033[31m", "\033[34m", "\033[90m")


def newest_transcript():
    files = glob.glob(TRANSCRIPTS)
    return max(files, key=os.path.getmtime) if files else None


def sh(cmd, cwd=PROJECT):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                              timeout=8, shell=True).stdout.strip()
    except Exception:
        return ""


def parse(path, tail_bytes=4_000_000):
    """Walk the transcript and rebuild agent lanes.

    Only the tail is read: these files reach hundreds of MB on a long session,
    and re-reading all of it every second would make the dashboard the heaviest
    thing on the machine.
    """
    agents, events = {}, []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
                fh.readline()          # discard the partial line
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return agents, events

    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        ts = d.get("timestamp", "")
        msg = d.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                name = c.get("name", "")
                inp = c.get("input") or {}
                if name in ("Task", "Agent"):
                    agents[c.get("id")] = {
                        "type": inp.get("subagent_type", "agent"),
                        "desc": (inp.get("description") or "")[:44],
                        "started": ts, "done": None, "ok": None,
                    }
                else:
                    events.append((ts, name, brief(name, inp)))
            elif c.get("type") == "tool_result":
                a = agents.get(c.get("tool_use_id"))
                if a and not a["done"]:
                    a["done"] = ts
                    a["ok"] = not c.get("is_error")
    return agents, events


def brief(name, inp):
    """One line of what a tool call actually did."""
    for k in ("command", "file_path", "pattern", "query", "url", "description"):
        if inp.get(k):
            return str(inp[k]).replace("\n", " ")[:66]
    return ""


def hhmm(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")) \
            .astimezone().strftime("%H:%M:%S")
    except Exception:
        return "--:--:--"


def secs_since(ts):
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds()
    except Exception:
        return None


def read(p):
    try:
        return open(p).read().strip()
    except OSError:
        return ""


def frame(path):
    cols = shutil_cols()
    agents, events = parse(path)
    running = [a for a in agents.values() if not a["done"]]
    finished = [a for a in agents.values() if a["done"]][-6:]

    dirty = sh("git status --porcelain")
    head = sh("git log -1 --pretty=%h\\ %s")
    ahead = sh("git rev-list --count origin/main..HEAD") or "?"
    state = read(f"{TASKDIR}/state.txt") or "(none)"
    notified = read(f"{TASKDIR}/dirty_tree_notified.txt")[:7]

    out = []
    bar = "─" * (cols - 2)
    out.append(f"{BOLD}┌{bar}┐{RESET}")
    out.append(f"  {BOLD}CariGaji orchestrator{RESET}   {DIM}{os.path.basename(path)[:8]}"
               f"   {datetime.now().strftime('%H:%M:%S')}{RESET}")
    out.append(f"{DIM}└{bar}┘{RESET}")

    # ── state ────────────────────────────────────────────────────────────────
    tree = (f"{RED}dirty ({len(dirty.splitlines())} file(s)) — STEP 0.5 will stand down{RESET}"
            if dirty else f"{GREEN}clean{RESET}")
    loop = f"{GREEN}active{RESET}" if state == "active" else f"{AMBER}{state}{RESET}"
    out.append(f" {BOLD}STATE{RESET}   loop: {loop}    tree: {tree}")
    out.append(f"         HEAD: {head[:cols-18]}")
    out.append(f"         unpushed: {ahead}    last dirty-notice at: {notified or '—'}")
    out.append("")

    # ── agent lanes ──────────────────────────────────────────────────────────
    out.append(f" {BOLD}AGENTS{RESET}  {DIM}(spawned by this run; ● = still working){RESET}")
    if not running and not finished:
        out.append(f"   {DIM}no subagents in the visible tail — the cycle may be"
                   f" between steps, or exited at STEP 0.5{RESET}")
    for a in running:
        age = secs_since(a["started"])
        out.append(f"   {GREEN}●{RESET} {BOLD}{a['type']:<22}{RESET} {a['desc']:<46}"
                   f" {DIM}{int(age)}s{RESET}" if age else
                   f"   {GREEN}●{RESET} {BOLD}{a['type']:<22}{RESET} {a['desc']}")
    for a in finished:
        mark = f"{GREY}✓{RESET}" if a["ok"] else f"{RED}✗{RESET}"
        out.append(f"   {mark} {GREY}{a['type']:<22} {a['desc']:<46}"
                   f" {hhmm(a['done'])}{RESET}")
    out.append("")

    # ── worktrees ────────────────────────────────────────────────────────────
    # The closest thing to a real per-agent lane. Agents spawned with
    # isolation:"worktree" get their own checkout and branch, so unlike the
    # transcript this is state you can inspect directly -- and it survives the
    # run, which is how a stalled or abandoned agent becomes visible at all.
    out.append(f" {BOLD}WORKTREES{RESET}  {DIM}(one checkout per isolated agent){RESET}")
    wt = sh("git worktree list --porcelain")
    entries, cur = [], {}
    for ln in wt.split("\n"):
        if ln.startswith("worktree "):
            if cur:
                entries.append(cur)
            cur = {"path": ln.split(" ", 1)[1]}
        elif ln.startswith("branch "):
            cur["branch"] = ln.rsplit("/", 1)[-1]
        elif ln.startswith("HEAD "):
            cur["head"] = ln.split(" ", 1)[1][:7]
    if cur:
        entries.append(cur)
    agents_wt = [e for e in entries if "/.claude/worktrees/" in e["path"]]
    if not agents_wt:
        out.append(f"   {DIM}none — no isolated agent is checked out right now{RESET}")
    for e in agents_wt:
        short = e["path"].rsplit("/", 1)[-1]
        d = sh("git status --porcelain", cwd=e["path"])
        n = len(d.splitlines())
        mark = f"{AMBER}✎ {n} uncommitted{RESET}" if n else f"{GREY}committed{RESET}"
        subj = sh(f"git log -1 --pretty=%s {e.get('head','HEAD')}")[:44]
        out.append(f"   {BLUE}▪{RESET} {short:<26} {e.get('head','?'):<8} {subj:<46} {mark}")
    out.append("")

    # ── recent activity ──────────────────────────────────────────────────────
    out.append(f" {BOLD}ACTIVITY{RESET}")
    for ts, name, detail in events[-10:]:
        out.append(f"   {DIM}{hhmm(ts)}{RESET} {BLUE}{name:<16}{RESET}"
                   f" {DIM}{detail}{RESET}")
    out.append("")

    # ── commits ──────────────────────────────────────────────────────────────
    out.append(f" {BOLD}COMMITS TODAY{RESET}")
    today = sh("git log --since=midnight --pretty='   %h %ad %s' --date=format:%H:%M")
    out.append(today if today else f"   {DIM}none yet{RESET}")
    return "\n".join(out)


def shutil_cols():
    try:
        import shutil
        return max(70, min(shutil.get_terminal_size().columns, 120))
    except Exception:
        return 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()

    path = args.file or newest_transcript()
    if not path:
        print("no transcript found", file=sys.stderr)
        return 1
    if args.once:
        print(frame(path))
        return 0
    try:
        while True:
            # Re-resolve each tick: a new cycle writes a NEW transcript, and the
            # dashboard should follow it rather than sit on a finished run.
            path = args.file or newest_transcript()
            sys.stdout.write("\033[H\033[J" + frame(path) + "\n")
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

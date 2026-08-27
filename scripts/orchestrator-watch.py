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
    usage = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0,
             "first": None, "last": None, "model": None, "recent5h": 0}
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
                fh.readline()          # discard the partial line
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return agents, events, usage

    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        ts = d.get("timestamp", "")
        msg = d.get("message") or {}

        # Token accounting. Only assistant turns carry usage, and each one
        # reports the whole request -- so these are sums over requests, not a
        # running context size.
        u = msg.get("usage")
        if u:
            usage["in"] += u.get("input_tokens", 0) or 0
            usage["out"] += u.get("output_tokens", 0) or 0
            usage["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
            usage["cache_write"] += u.get("cache_creation_input_tokens", 0) or 0
            if msg.get("model"):
                usage["model"] = msg["model"]
            if ts:
                usage["first"] = usage["first"] or ts
                usage["last"] = ts
                age = secs_since(ts)
                if age is not None and age <= 5 * 3600:
                    usage["recent5h"] += (u.get("output_tokens", 0) or 0)

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
                        "desc": (inp.get("description") or "")[:34],
                        # A spawn may pin a model; none of this project's do,
                        # so in practice they inherit the session's. Shown as
                        # "↳" to make "inherited" visible rather than implied.
                        "model": inp.get("model"),
                        "started": ts, "done": None, "ok": None,
                    }
                else:
                    events.append((ts, name, brief(name, inp)))
            elif c.get("type") == "tool_result":
                a = agents.get(c.get("tool_use_id"))
                if a and not a["done"]:
                    a["done"] = ts
                    a["ok"] = not c.get("is_error")
                    body = c.get("content")
                    if isinstance(body, list):
                        body = " ".join(str(b.get("text", "")) for b in body
                                        if isinstance(b, dict))
                    body = str(body or "").strip()
                    # An agent that hits its turn limit returns PARTIAL work and
                    # says so in the first line. Silently showing that as a tick
                    # is how half-finished work gets mistaken for done.
                    a["partial"] = "turn limit" in body[:200]
                    a["out"] = " ".join(body.split())
    return agents, events, usage


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


def pane(a, w, usage):
    """One agent, boxed. Fixed height so the grid never reflows mid-run."""
    model = (a["model"].replace("claude-", "") if a.get("model")
             else (usage.get("model") or "session").replace("claude-", ""))
    if not a["done"]:
        age = secs_since(a["started"])
        dot, state = f"{GREEN}●{RESET}", f"running {int(age)}s" if age is not None else "running"
    elif a.get("partial"):
        dot, state = f"{AMBER}⚠{RESET}", f"PARTIAL — hit turn limit  {hhmm(a['done'])}"
    elif a["ok"]:
        dot, state = f"{GREY}✓{RESET}", f"done {hhmm(a['done'])}"
    else:
        dot, state = f"{RED}✗{RESET}", f"failed {hhmm(a['done'])}"

    inner = w - 4
    title = f"{a['type']} · {model}"[:inner]
    lines = [f"{DIM}┌─ {RESET}{BOLD}{title}{RESET} {DIM}" + "─" * max(0, inner - len(title) - 1) + f"┐{RESET}"]
    lines.append(f"{DIM}│{RESET} {a['desc'][:inner]:<{inner}} {DIM}│{RESET}")
    lines.append(f"{DIM}│{RESET} {dot} {state[:inner-2]:<{inner-2}} {DIM}│{RESET}")
    # Whatever the agent actually said, wrapped to the pane rather than spilling.
    body = a.get("out") or ("" if a["done"] else "working…")
    for i in range(2):
        chunk = body[i * inner:(i + 1) * inner]
        lines.append(f"{DIM}│{RESET} {GREY}{chunk:<{inner}}{RESET} {DIM}│{RESET}")
    lines.append(f"{DIM}└" + "─" * (w - 2) + f"┘{RESET}")
    return lines


def grid(agents, cols_total, usage):
    """Lay panes out side by side, newest activity first."""
    ordered = ([a for a in agents if not a["done"]] +
               list(reversed([a for a in agents if a["done"]])))[:6]
    if not ordered:
        return [f"   {DIM}no subagents in the visible tail — the cycle may be"
                f" between steps, or it exited at STEP 0.5{RESET}"]
    ncol = 2 if cols_total >= 96 else 1
    w = (cols_total - 4) // ncol - 1
    out = []
    for i in range(0, len(ordered), ncol):
        row = [pane(a, w, usage) for a in ordered[i:i + ncol]]
        for r in range(len(row[0])):
            out.append("  " + "  ".join(p[r] for p in row))
    return out


def frame(path, budget=0):
    cols = shutil_cols()
    agents, events, usage = parse(path)
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

    # ── the numbers band ─────────────────────────────────────────────────────
    # tok/s is OUTPUT tokens over the run's wall clock, which is the number that
    # tracks how fast work is actually being produced. Input and cache-read
    # dwarf it and would only flatter the figure.
    span = None
    if usage["first"] and usage["last"]:
        a, b = secs_since(usage["last"]), secs_since(usage["first"])
        if a is not None and b is not None:
            span = max(b - a, 1)
    toks = f"{usage['out']:,} out / {usage['in'] + usage['cache_read'] + usage['cache_write']:,} in"
    rate = f"{usage['out'] / span:.1f} tok/s" if span else "— tok/s"
    model = (usage["model"] or "unknown").replace("claude-", "")
    online = f"{GREEN}{len(running)} online{RESET}" if running else f"{DIM}0 online{RESET}"
    out.append(f" {BOLD}LIVE{RESET}   {online}   {BOLD}MODEL{RESET} {BLUE}{model}{RESET}"
               f"   {BOLD}TOKENS{RESET} {toks}   {BOLD}RATE{RESET} {rate}")

    # The 5-hour rate-limit allowance is NOT in any transcript -- Claude Code
    # does not write it there -- so this is measured usage, not a quota read
    # back from the service. Pass --budget to turn it into a remaining figure;
    # without one, only what was actually spent is shown, which is honest.
    win = f"{usage['recent5h']:,} output tokens in the last 5h"
    if budget:
        left = budget - usage["recent5h"]
        colour = GREEN if left > budget * 0.3 else (AMBER if left > 0 else RED)
        win += f"   {colour}{left:,} left of {budget:,}{RESET}"
    else:
        win += f"   {DIM}(pass --budget N to show remaining){RESET}"
    out.append(f" {DIM}5H WINDOW{RESET} {win}")

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
    out.extend(grid(list(agents.values()), cols, usage))
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
    ap.add_argument("--budget", type=int, default=0,
                    help="output-token allowance for the 5h window, if you know it")
    args = ap.parse_args()

    path = args.file or newest_transcript()
    if not path:
        print("no transcript found", file=sys.stderr)
        return 1
    if args.once:
        print(frame(path, args.budget))
        return 0
    try:
        while True:
            # Re-resolve each tick: a new cycle writes a NEW transcript, and the
            # dashboard should follow it rather than sit on a finished run.
            path = args.file or newest_transcript()
            sys.stdout.write("\033[H\033[J" + frame(path, args.budget) + "\n")
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

# GitHub Support request — purge unreachable objects after a history rewrite

Send from: https://support.github.com/request  (category: Account / Repository)

---

**Subject:** Please garbage-collect unreachable objects on jiayutee/CariGaji after a history rewrite

Hello,

I rewrote the history of the `main` branch on my public repository
`jiayutee/CariGaji` to remove internal Notion workspace identifiers that had
been committed by mistake, and force-pushed the cleaned history on 2026-08-23.

The branch now points at the cleaned history, but the pre-rewrite commits are
still reachable by SHA. For example these all still return the old file
contents:

    https://raw.githubusercontent.com/jiayutee/CariGaji/e508067/.claude/scheduled-tasks/carigaji-morning-briefing/SKILL.md
    https://raw.githubusercontent.com/jiayutee/CariGaji/51d0006/.github/agents/orchestrator.agent.md

Could you please run a garbage collection on the repository to drop the
unreachable objects, and clear any cached views of them?

Relevant details:
- The repository has 0 forks and a network count of 0, so no fork holds copies.
- No pull requests reference the old commits.
- GitHub Pages is enabled and builds from `gh-pages`; that branch was not
  rewritten and does not contain the affected files.

Thank you.

---

## Notes for me (not part of the message)

- The identifiers are NOT credentials: opening any of those Notion pages still
  requires access to the workspace. The exposure is that someone who already
  knows an old commit SHA can see the workspace has a Daily Log, a Feature
  Backlog, a Launch Roadmap and a parent page. Old SHAs are not listed anywhere
  once the branch moves, so this is low risk but not zero.
- If Support declines or is slow, the only other way to guarantee removal is to
  delete and recreate the repository, which would lose stars/watchers, break the
  existing Pages URL and require re-pushing. Not worth it for non-credentials.
- Do NOT rotate anything: no token, password or key was ever in these files.
  Verified by scanning all 4223 blobs of the pre-rewrite history.

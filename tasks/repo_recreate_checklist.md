> **DECISION, 2026-08-23: not doing this.** The owner chose to leave the old
> objects in place. They are workspace pointers, not credentials; nothing needs
> rotating; the old SHAs are referenced nowhere public and there are no forks.
> A pre-commit guard now blocks any future commit that would reintroduce one,
> so the exposure is frozen rather than growing. Kept for reference in case
> that judgement changes.

# Removing the old objects without contacting GitHub Support

A force-push moves the branch; it does not delete the objects behind it.
GitHub keeps unreachable commits and serves them by SHA. The only self-service
way to be certain they are gone is to delete the repository and push the
cleaned history into a fresh one — a new repository is new storage, so the old
SHAs cannot resolve because there is nothing left to resolve them against.

## What this costs, measured rather than assumed

| | |
|---|---|
| stars / watchers / forks | 0 / 0 / 0 — nothing socially lost |
| open issues | 0 |
| closed PRs | 2 (#1 codespace export, #2 a code-review fix) — **these are lost** |
| Actions secrets | 3, all recoverable from local .env |
| workflows | 4, all defined in-repo except the two dynamic Copilot ones |
| rulesets | 1 ("Copilot review for default branch") to recreate |
| Pages URL | unchanged, as long as the repo is recreated with the same name |

Both PRs were merged BEFORE the ids were first committed (21 and 27 June;
the ids arrived 28 June in 51d0006), and their pinned commits contain zero
ids — verified. So nothing of value is entangled with what we are removing.

## Steps

1. Confirm the local clone is the cleaned history and is complete:

       git log --oneline -1          # expect the latest commit
       git rev-list --count HEAD     # expect 334
       git fsck --full               # expect no errors

   A pre-rewrite backup already exists at
   scratchpad/backup/carigaji-pre-rewrite.bundle if anything needs recovering.

2. Delete the repository:
   https://github.com/jiayutee/CariGaji/settings → Danger Zone → Delete this
   repository. GitHub asks you to type the name.

3. Recreate it, PUBLIC, with the exact same name `CariGaji`, and with **no**
   README/gitignore/licence (an initial commit would conflict with the push):
   https://github.com/new

4. Push the cleaned history:

       cd /Users/jiayutee/Dev/Projects/CariGaji
       git remote set-url origin https://github.com/jiayutee/CariGaji.git
       git push -u origin main

5. Re-add the three Actions secrets (Settings → Secrets and variables →
   Actions). The values are in your local .env / .env.local:

       VITE_SUPABASE_URL
       VITE_SUPABASE_ANON_KEY
       VITE_GOOGLE_MAPS_API_KEY

6. Re-enable Pages: Settings → Pages → Source = Deploy from a branch =
   `gh-pages` / root. The `gh-pages` branch does not need restoring by hand —
   the Deploy workflow rebuilds it on the next push to main. Re-run it from the
   Actions tab if it does not fire on its own.

7. Recreate the ruleset if you want it back: Settings → Rules → New ruleset,
   target `main`, with Restrict deletions + Block force pushes (+ Copilot
   review if you were using it).

8. Verify the old SHAs are dead:

       for c in e508067 51d0006 ff2243a; do
         curl -s -o /dev/null -w "$c -> %{http_code}\n" \
           "https://raw.githubusercontent.com/jiayutee/CariGaji/$c/.github/agents/orchestrator.agent.md"
       done

   All three should return 404. They return 200 today.

## The alternative: do nothing

Defensible, and worth weighing honestly before spending the 10 minutes above:

- These are ids, not credentials. Opening any of those Notion pages still
  requires access to the workspace. Nothing needs rotating.
- The old SHAs are now referenced nowhere public — not by the branch, not by
  either PR, and there are no forks. Reading them requires already knowing a
  specific 40-character hash.
- GitHub does eventually garbage-collect unreachable objects on its own. The
  timing is neither documented nor guaranteed, but the exposure tends to
  decay without intervention.

The case FOR doing it: certainty, and it costs two closed PRs nobody will read
again.

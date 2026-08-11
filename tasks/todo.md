# Todo — Portal URL routing

Give each top-level portal its own address so links, refresh, bookmarks and
browser Back work natively:

- `/CariGaji/` → worker app
- `/CariGaji/employer` → Employer Console
- `/CariGaji/admin` → Admin Dashboard

Scope is deliberately **top-level portals only**. Tabs (Discover/My Bids/…),
sub-views (`view === "shifts"`) and modals stay as component state — routing
those too would multiply the regression surface across flows stabilised this
session, for a fraction of the benefit.

## Design decisions
- **No router dependency.** Three routes don't justify react-router in an app
  whose only deps are React + Supabase. A ~30-line history helper matches the
  codebase's existing zero-dependency, single-file style.
- **Keep `setPortal`'s signature.** It has 9 call sites; wrapping it so it also
  pushes history means every existing call site keeps working untouched
  (Simplicity First / Minimal Impact per CLAUDE.md).
- **`base` is `/CariGaji/`**, so all path math must be relative to that prefix,
  never assume the app is at the domain root.

## Steps
- [x] 1. Path helpers + derive initial portal from `location.pathname`
- [x] 2. `navigateToPortal` wrapper: pushState + setState; popstate syncs back
- [x] 3. GitHub Pages SPA fallback (`404.html`) so deep links don't 404
- [x] 4. Reconcile with BackGestureManager (mobile sentinel trap) — no regression
- [x] 5. Verify: refresh, direct deep link, Back between portals, sign-out,
        notification deep links, mobile back gesture

## Review

Shipped. `/CariGaji/`, `/CariGaji/employer` and `/CariGaji/admin` are now real
addresses: refresh, bookmarks, direct links and browser Back all work.

### What went in
- **Path helpers** (`portalToPath` / `portalFromPath`, both relative to Vite's
  `base`). Unknown segments fall back to the worker app rather than a blank
  screen.
- **`setPortal` wrapper** — same signature, so all 9 existing call sites are
  untouched. It now moves the URL too.
- **`404.html` SPA fallback** via a post-build copy of `dist/index.html`
  (Vite plugin). Had to be a build-time copy, not a `public/404.html`, or it
  would never get the hashed asset `<script src>`.
- **Service worker navigation fallback** — offline, a portal deep link is a
  cache miss on a URL that was never fetched as itself; navigations now fall
  back to the cached app shell.

### Two things the plan didn't anticipate
1. **BackGestureManager conflict (step 4).** Its sentinel trap owns the mobile
   history stack and counts entries with a `depth` counter. A pushed portal
   entry sits *above* the sentinel, so a back gesture would pop ours instead,
   decrementing `depth` for a sentinel that was never consumed — corrupting
   the "really exit" `history.go(-(depth+1))`. Resolved with two navigation
   models: desktop pushes and lets popstate drive `portal`; mobile replaces
   and re-asserts the URL *from* `portal` on popstate. Shared
   `MOBILE_BREAKPOINT` keeps the two tests in agreement.
2. **Signed-out visitors can now type `/employer`.** EmployerPortal has no
   signed-out branch — every query short-circuits on `!user`, so they'd get a
   convincing but permanently empty dashboard with no way in. Added a redirect
   to the landing page, gated on a new `authResolved` flag so it can't fire
   during session restore and bounce a real employer off their own console.

Also fixed in passing: the role-based landing redirect re-ran on every profile
load (harmless before, but it would now fight Back), and `setPortal` was
mutating history inside a `setState` updater, which StrictMode would run twice.

### Verified
Desktop: root → `/employer` via replace (no stray history entry); switch to
worker preview → Back returns to the console → Forward returns to preview, no
reload; refresh on `/employer` holds; `/admin` as an employer and an unknown
segment both resolve and clean up the URL; sign-out returns to `/CariGaji/`.
Mobile (375px): deep link loads the console; portal switch uses replace and
leaves the sentinel topmost; repeated Back stays in-app with no portal flip.
Signed out: `/employer` → landing page. Production build served through a
GitHub-Pages simulator (404.html at HTTP 404): `/CariGaji/admin` boots and
routes to the admin gate with the URL intact. Console clean apart from a
pre-existing React style-shorthand warning.

### Known trade-off (not a regression)
An employer who refreshes while in worker preview is still bounced to
`/employer` by the role redirect — same as before this change. Making the
preview URL stick would require distinguishing "employer deliberately opened
`/`" from "employer opened the app fresh", which `/` alone can't express.
Left as-is; worth revisiting if the preview gets used enough to matter.

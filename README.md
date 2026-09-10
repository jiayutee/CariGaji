# CariGaji

A verified marketplace for short-term shifts in Malaysia. Employers post a shift
with a wage range; workers bid their own rate within it; both sides sign a
digital contract before the shift and check in with a rotating QR code.

**Live:** https://carigaji.jiayutee.workers.dev (canonical)
Also deployed to https://jiayutee.github.io/CariGaji/

The app is served at a language-prefixed path — `/en`, `/bm`, `/ch`. A URL
without one still works and is normalised on load, so older links keep working.

---

## Status

Pre-launch. Some of the marketplace is enforced in the database today and some
of it is not, and the difference matters if you are reading this to decide
whether to use it:

**Enforced now**

- The pay is on the ad before you apply — hourly range, hours, estimated total
- The worker names their own rate inside the employer's range
- Both sides sign a digital contract carrying the agreed wage and hours
- QR check-in / check-out timestamps what actually happened
- Late employer cancellation owes the worker 50% by contract, or 100% if they
  turned up — computed server-side from the signed wage
- Employers cannot post until an admin has verified their SSM registration
- Two-sided ratings and a reliability score

**Not built yet**

- No payment gateway. Money enters only by an admin recording a bank transfer
- Employer funds are **not** held in escrow. `employer_wallet_enforced()` reads
  a `platform_settings` row that does not exist, so offers are never blocked on
  funding
- `payout_item` records an obligation; there is no disbursement rail behind it
- Worker bank-account "verification" is a client-side simulation

Please do not describe the unbuilt half as working. See `tasks/go_to_market.md`
for the reasoning.

---

## Architecture

- **`carigaji-app.jsx`** — the entire client, one file, ~18k lines. It is one
  file on purpose: the whole app is legible to a single reader and to a single
  agent context, and there is no module graph to reason about when changing a
  screen. The cost is that it is large; the mitigation is that shared UI lives in
  a small set of primitives near the top (`Card`, `Btn`, `Badge`, `Pill`,
  `Avatar`, `Stat`, `FilterToggle`, …) that screens are expected to reuse rather
  than re-style.
- **Three portals** — worker, employer, admin — chosen by URL and role.
- **Supabase** for Postgres, auth, storage and realtime. Row-level security is
  the authorization boundary; the client holds no privileged key.
- **Vite** build, deployed to **Cloudflare Workers** static assets with
  `not_found_handling: "single-page-application"` so client-routed paths resolve.
- **Three languages** — `en` / `bm` / `zh`, in one `TRANSLATIONS` map with
  enforced key parity.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in the Supabase values
npm run dev
```

`.env.example` documents every variable. Only `VITE_`-prefixed values reach the
browser; the anon key is public by design, a service-role key is not and must
never appear here.

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the built bundle |
| `npm run test:payout-rules` | payout-date rules (weekends, federal holidays) |
| `node scripts/design-check/token-lint.mjs` | flags hardcoded colours where a theme token exists |

`scripts/design-check/contrast-sweep.js` is pasted into the browser console (or
evaluated by an agent) and measures every rendered text/background pair against
WCAG AA. Both checks are worth running before shipping a UI change — most bugs
this project has shipped were a fill colour used as text, which only fails in
one theme.

## Database

Migrations live in `supabase/migrations/`, named `YYYYMMDD[letter]_summary.sql`,
and are applied by hand in the Supabase SQL editor. There is no migration
runner; ordering is the filename.

Conventions worth knowing before writing one:

- **Guard triggers revert rather than raise.** Pinning a column by resetting it
  to `old.value` lets an ordinary update to other columns still succeed. Raising
  would break unrelated writes. See `guard_platform_fee_pct`.
- **Migrations verify themselves.** Several run their assertions inside a
  subtransaction that always rolls back, so the test leaves no rows behind. See
  `20260829_employer_fee_trial.sql`.
- **A gate and the change it guards belong in one `DO` block.** Split across
  statements, a client that continues past an error applies the change anyway.

One-off operational scripts live in `tasks/` and are also run by hand.

## Repo layout

```
carigaji-app.jsx        the client
src/lib/                supabase client, theme tokens
supabase/migrations/    schema, RLS, triggers, RPCs
scripts/design-check/   token lint + contrast sweep
tasks/                  one-off SQL, plans, todo/lessons
public/                 icons, manifest, service worker
```

## Deploying

Pushing to `main` triggers **two independent deploys**, and it is worth knowing
they are separate things:

- `.github/workflows/deploy.yml` builds and publishes to **GitHub Pages**, and
  Telegrams on failure.
- **Cloudflare Workers** builds the same commit through its own Git integration
  — there is no wrangler step in CI. `wrangler.jsonc` sets
  `not_found_handling: "single-page-application"`, which is what makes
  client-routed paths like `/bm/shift/<id>` resolve. A `_redirects` file is not
  the mechanism and Workers rejects the usual SPA rule in one.

Both need the `VITE_*` variables present at build time. Without them Rollup
tree-shakes the app chunk away and ships an entry bundle that loads to a blank
page — the give-away is a ~200 kB build where a healthy one is ~1 MB.

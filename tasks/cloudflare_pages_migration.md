# Moving the app to Cloudflare Pages

## Why

GitHub Pages has no rewrite rule. A deep link like `/shift/<id>` has no file
behind it, so Pages answers with its 404 handler — which we point at the app,
so the page *works*, but the HTTP status is **404**. Verified in production:

```
https://jiayutee.github.io/CariGaji/            HTTP 200
https://jiayutee.github.io/CariGaji/employer    HTTP 404   (app in the body)
https://jiayutee.github.io/CariGaji/admin       HTTP 404   (app in the body)
```

Googlebot will not index a 404 whatever the body says. So per-shift URLs earn
sharing today and nothing in search. Cloudflare Pages serves the same file with
a real **200** via one `_redirects` line, which is the entire reason to move.

## Why Cloudflare Pages specifically

Free tier, honest numbers: **unlimited bandwidth and requests**, **500 builds
per month**, unlimited custom domains with free SSL, and a free
`<project>.pages.dev` subdomain to run on until a domain is bought. Netlify's
free tier caps bandwidth at 100GB and build minutes at 300/month; Vercel's free
tier is non-commercial only, which this is not.

Note "unlimited deploying" isn't quite true anywhere — 500 builds/month is the
real ceiling. At the current rate (a handful of commits a day) that is not
close to binding.

## What already changed in the repo

The app is now **base-agnostic** — the same commit builds for either host:

| Piece | Before | Now |
|---|---|---|
| `vite.config.js` | `base: "/CariGaji/"` | `base: process.env.BASE_PATH \|\| "/"` |
| `index.html` | `/CariGaji/manifest.json` | `%BASE_URL%manifest.json` |
| `public/manifest.json` | `"start_url": "/CariGaji/"` | `"./"` (resolves against wherever it is served) |
| `src/main.jsx` | registers `/CariGaji/service-worker.js` | registers `${import.meta.env.BASE_URL}service-worker.js` |
| `public/service-worker.js` | icons/links hardcoded | resolved against `self.registration.scope` |
| `send-push` | emits `/CariGaji/employer` | emits `employer` — base-relative |
| GH Pages workflow | implicit | sets `BASE_PATH=/CariGaji/` explicitly |

The service worker accepts **both** link shapes, old and new, because a push
subscription carries no record of which origin it belongs to and both origins
will be live during the cutover.

Verified locally: both builds emit correct asset paths, and a server mimicking
the `_redirects` rule returns **200** for `/`, `/employer`, `/admin` and
`/shift/<id>` — with the app booting straight onto the shift.

## What you have to do — I cannot do these

Creating accounts and signing in is not something I can do for you.

### 1. Create the Pages project
- Sign in at dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages**
  → **Connect to Git** → pick `jiayutee/CariGaji`.
- Build settings:
  - Framework preset: **Vite**
  - Build command: `npm run build`
  - Build output directory: `dist`
  - **Do not set `BASE_PATH`.** Its absence is what selects the root base.

### 2. Add the four build variables
Same values as the GitHub Actions secrets — without them the build produces an
app that cannot reach Supabase:

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_GOOGLE_MAPS_API_KEY
VITE_VAPID_PUBLIC_KEY
```

### 3. Tell Supabase about the new origin  ← the one that breaks sign-in
Supabase → **Authentication → URL Configuration → Redirect URLs**, add:

```
https://<project>.pages.dev/**
```

Skip this and Google sign-in and password-reset links bounce on the new host.
Leave the GitHub Pages entry in place until you retire it.

### 4. Google Maps key referrers
If the key is restricted by HTTP referrer, add `https://<project>.pages.dev/*`
or the map silently fails to load.

### 5. Redeploy the push function
```
supabase functions deploy send-push
```
It now emits base-relative links. Existing subscribers on either origin keep
working.

## After it is live

- Check `curl -o /dev/null -w '%{http_code}' https://<project>.pages.dev/shift/<any-id>` returns **200**.
- Sign in on the new origin, open a shift, confirm the URL and Share.
- Push notifications need re-subscribing per origin — that is how the web push
  spec works, not a bug.

Only once a real domain is bought does GitHub Pages get retired; until then both
hosts run happily from the same commit.

# Search plan: get found by people looking for a short shift or mini job

Written 2026-09-21. Plan only, nothing here is built yet. Numbers marked (validate) are
hypotheses to check in Search Console / Keyword Planner, not measured facts.

## 1. Where we are today (checked in the repo)

| Finding | Why it matters |
|---|---|
| `index.html` has `<title>CariGaji</title>`, description "CariGaji worker app", no canonical, no hreflang, no Open Graph, no structured data, no `<h1>` in the initial HTML | A crawler's first look at every page is a brand name and an empty `<div id="root">`. Nothing to rank for. |
| No `robots.txt`, no `sitemap.xml` | Crawlers get no map and no rules. |
| Live host is GitHub Pages: every inner address answers **HTTP 404** (app in the body) | Google will not index a 404. Nothing but the home page can rank until we move to Cloudflare (already planned in `tasks/cloudflare_pages_migration.md`, not cut over). |
| Public shifts are readable while signed out; employer names and pay are public | Good: the content Google needs already exists and needs no login. |
| Every route serves the same shell, and the new routing added `/en/my-shifts` (was `/en/my-bids`, still redirects), `/en/chat`, `/en/employer/...`, `/en/admin/...` | These private pages must not be indexed. **Do first.** |
| One 1 MB JavaScript file loads everything (employer + admin code included) even for a visitor on the landing page | Slow first load on phones hurts both ranking and bounce. |
| "CariGaji" is hard-coded ~116 times in the app, plus `index.html`, `manifest.json`, service worker, 4 edge functions, scripts | Renaming today means a find-and-replace across the repo, and search signals would be lost with it. |
| ~~Demo and QA shifts (Demo Staff, "REAPPLY probe") appear in the public feed~~ **Half done (2026-10-13, `fa95d3b`):** QA/test accounts carry `profiles.is_test_account` and RLS hides their shifts from anon and real users, so anything built on the anon key (the edge Worker, sitemaps) never sees them. **Demo Staff shifts are still public on purpose** (they are the intended demo feed); since `20261013c` the account carries `profiles.is_demo_account`, readable signed-out via `is_demo_account(employer_id)`, so the Worker can skip them. The exclusion itself lands with the Worker. Today all Demo Staff shifts are `completed`, so the live feed is empty. | Publishing job markup for fake jobs is a Google spam-policy violation (manual-action risk). Demo shifts must still be excluded from anything we send to Google. |

## 2. Who we are trying to catch

A person on a phone, not looking for us by name. They type what they need:
"part time job near me", "kerja sambilan", "kerja part time KL", "one day job",
"weekend job", "student holiday job", "event crew part time", "waiter part time",
"promoter part time", "临时工 / 兼职 吉隆坡" (validate volumes and wording per language).
They do not search a brand name, so the plan is about being the answer to those searches,
and the brand name is kept out of the way of that (section 3).

Two surfaces matter, in this order:
1. **Google for Jobs** (the "Jobs" box above results). Strongest route for a new site with no
   authority, because it is fed by job markup on real listings, not by backlinks.
2. **Ordinary results** for hub pages: "part time jobs in Kuala Lumpur", "kerja sambilan
   Selangor", per category and city.

## 3. Name-proof design (the requirement that the name will change)

Principle: **everything that earns ranking must be independent of the name.** The name is a
display value that lives in exactly one place.

**3.1 One source of truth.** `brand.config.json`: `name`, `shortName`, `legalName`,
`alternateNames[]` (former names), `siteUrl`, `supportEmail`, `themeColor`, social links.
Consumed by:
- a Vite plugin that fills `index.html` (title, OG, JSON-LD), generates `manifest.json`,
  `robots.txt`, and the per-page head;
- the app: the 116 hard-coded strings become a `{brand}` parameter in translations (`t()`
  already supports parameters);
- the edge functions and the edge worker via one env var each (`BRAND_NAME`, `SITE_URL`);
- a CI check that **fails the build if the brand literal appears outside the config**, and a
  rename rehearsal: `BRAND_NAME=Foo npm run build`, then grep `dist/` for the old name = 0 hits.

**3.2 What keeps ranking flat through a rename**
- **Brand-free paths.** Already true (`/en/my-shifts`, `/en/jobs/kuala-lumpur`). Never put the
  name in a slug, image filename or alt text.
- **Titles lead with the keyword, the name comes last:** "Part-Time & Short Shift Jobs in
  Malaysia | {brand}". Rename changes the tail only.
- **Job markup is about the employer, not us.** `hiringOrganization` is the employer, so it
  does not change with our name.
- **Entity continuity.** `Organization` / `WebSite` markup carries `alternateName` = former
  names, kept for 12+ months, and an "Formerly {old name}" line on the About page, so people
  and Google who know the old name still connect.
- **The domain is the one thing that cannot be config.** If the domain contains the name,
  renaming means moving domains. So: (a) do NOT buy or promote a domain until the name is
  final; (b) until then, serve `noindex` on the temporary hosts (`github.io`, `pages.dev`) so
  no ranking builds up somewhere that will be abandoned; (c) if the name changes after launch,
  run a path-preserving 301 from every old URL to the same path on the new domain (one
  Cloudflare bulk-redirect rule, kept 12+ months), use Search Console "Change of address",
  and keep the sitemap and canonical on the new host. Expect a dip of a few weeks, not a loss.
- **Canonical host is a variable** (`SITE_URL`), used for canonicals, hreflang, sitemap and
  markup, so a domain change is one value plus the redirect.

## 4. Technical foundation

**4.1 Real answers for crawlers.** Move to Cloudflare so every address returns 200 (the
existing migration plan). This is the single biggest unlock.

**4.2 One Cloudflare Worker in front of the app** (HTMLRewriter, free tier is plenty). For
each request it fills the head and crawler-visible content, then the normal app boots:
- `/{lang}/shift/<id>`: title, description, canonical, hreflang, Open Graph, `JobPosting`
  JSON-LD, and a readable summary in the HTML, all from the shift's public data;
- hub and evergreen pages: same, with the live shift list;
- private routes (`/my-shifts`, legacy `/my-bids`, `/chat`, `/profile`, `/earnings`, `/employer/*`, `/admin/*`,
  sign-in): `X-Robots-Tag: noindex`;
- `/sitemap.xml`, `/sitemap-shifts.xml`, `/robots.txt` generated live from the database, so a
  shift appears the hour it is posted and leaves when it fills or ends.
Static evergreen pages can also be pre-rendered at build time from the same templates.
Rejected: rewriting in Next.js/Astro (too big, no gain over the Worker for this app).

**4.3 Languages.** URLs already carry `/en`, `/bm`, `/ch`. Add `hreflang` `en`, `ms`,
`zh-Hans` and `x-default`, each page listing its siblings, plus matching sitemap entries.
Malay and Chinese copy written natively, not machine-translated.

**4.4 Speed.** Split the single 1 MB bundle by portal so a worker on the landing page does not
download the employer and admin apps; preload the hero font/image; measure Core Web Vitals in
Search Console once live.

**4.5 Structured data.** `WebSite` and `Organization` (site-wide), `BreadcrumbList` (hubs and
shifts), `JobPosting` (shifts, next section). No FAQ markup: Google now shows it only for
authoritative sites.

## 5. Google for Jobs (the fast lane for "short shift" searches)

Each open shift page carries `JobPosting` JSON-LD:
`title`, `description`, `datePosted`, `validThrough` (application close, else shift start),
`employmentType` (`PART_TIME` / `TEMPORARY` / `CONTRACTOR`), `baseSalary` (MYR, min-max per
`HOUR`), `hiringOrganization` (employer name, plus the new company description),
`jobLocation` (city/state/country; the exact address stays hidden until acceptance, which
Google accepts), `directApply`, `identifier`.

Rules we must respect or risk a manual action:
- **Only real, open, current jobs.** QA/test shifts are already excluded at the database level
  (`is_test_account` + RLS, 20261013); the Worker must use the anon key so it inherits that.
  Demo Staff shifts stay public but must never be indexed: the account carries
  `profiles.is_demo_account` (20261013c). The Worker calls `is_demo_account(employer_id)`
  (anon can't read profiles directly) and, when true, emits `noindex`, no `JobPosting`,
  and leaves the shift out of the sitemap.
- Marked-up content must match what a visitor sees (pay range, place, time).
- Remove the markup and return 410 (or a clear "no longer available" page with `noindex`) when
  a shift is filled, ended or deleted. Shifts are short-lived, so this is the norm, not an edge case.
- Job details visible without signing in (already true); applying may require an account.

Shifts expire in days, so **the Google Indexing API** (allowed for job posting pages) is worth
adding after the basics: it tells Google the moment a shift is created, updated or removed,
instead of waiting for a crawl. Needs a Search Console-verified property and a service account.

Check first: that Google for Jobs is shown for Malaysian searches, using Search Console's
Rich Results test on a real shift page after cutover.

## 6. Content that matches how people search

**Hub pages** (auto-generated from live shifts, brand-free slugs):
`/en/jobs` · `/en/jobs/<city>` · `/en/jobs/<category>` · `/en/jobs/<category>/<city>`.
The 12 categories already exist (F&B, Retail, Event, Promotion, Warehouse, Office, Security,
Production, Market Research, Student, Logistics, Other). Start with KL and Selangor, add
Penang and Johor Bahru when there is supply.
- **No thin pages.** A hub is indexable only when it has enough live shifts (start at 3) or
  meaningful evergreen text; otherwise `noindex, follow`, showing related hubs and a
  "get notified" prompt. An empty indexable page reads as a soft-404 and drags the site down.
- Each hub: keyword H1, a short intro, the live list, related hubs, breadcrumbs.

**Evergreen guides** (each targets a question, in all three languages): what a short-shift job
is and how it works; how a one-day job pays and when; student holiday jobs; part-time work
rights and pay in Malaysia (link to official sources, no legal advice); how to stay safe when
taking casual work. These are what rank while there are few live shifts.

**Internal linking:** footer lists of categories and cities, related shifts on each shift,
breadcrumbs everywhere.

## 7. Getting discovered outside Google

- Shareable previews: Open Graph title, description and image per shift (people share shifts
  into WhatsApp/Telegram/Facebook groups, and that traffic and those links are real signal).
- Link sources that fit this audience: university and college career/student-affairs pages,
  student union and society groups, community Facebook/WhatsApp groups, employer "we hire via
  {brand}" links and badges, local press at launch.
- Bing and Bing Webmaster Tools too (it feeds other engines).
- Verify the domain as a Search Console **domain property** (DNS record) so subdomain and
  protocol changes are covered.

## 8. Measure it

Search Console: impressions and clicks for non-brand vs brand queries, indexed page count,
JobPosting enhancement report, Core Web Vitals. Our own analytics: organic landing to
sign-up rate (add a landing-source field to the existing `logAnalyticsEvent`).
Targets to set after the first 30 days of real data, not before.

## 9. Order of work

| Phase | What | Depends on | Size |
|---|---|---|---|
| **0. Now** (no domain needed) | `brand.config.json` + Vite plugin + `{brand}` in strings + CI literal check; real title/description/canonical/OG in `index.html`; `noindex` for private routes and for temporary hosts; `robots.txt`; Demo Staff flag in place (`is_demo_account`, 20261013c) and QA already hidden (`fa95d3b`); the Worker applies the exclusion | nothing | M |
| **1. Cutover** | Cloudflare (real 200s), `SITE_URL`, hreflang, `WebSite`/`Organization` markup, Search Console + Bing verification | name and domain final | M |
| **2. Shifts get indexed** | Worker: shift head + `JobPosting` + crawler HTML + live sitemap; per-shift OG image | phase 1 | L |
| **3. Hubs and content** | Hub pages, thin-page rule, evergreen guides (en/bm/zh), breadcrumbs, internal links, Indexing API | phase 2, supply of shifts | L |
| **4. Speed** | Split the bundle by portal, font/image preload, watch Core Web Vitals | none (can run in parallel) | M |
| **5. Outreach and loop** | Career-centre and community outreach, monthly Search Console review | phase 1 | ongoing |

Realistic expectation: a new domain has no authority. Google for Jobs and long-tail hub pages
are the routes that can show results in weeks; competing for "part time job Malaysia" against
the established job boards is a months-to-years effort and should not be the first target.

## 10. Decisions needed from the owner

1. **Domain:** hold until the name is final? (recommended). Until then, temporary hosts stay `noindex`.
2. **Cities to launch hubs for**, and whether to hold hubs until there are real shifts.
3. ~~**Demo shifts**~~ Decided 2026-10-13: QA/probe shifts hidden everywhere public; Demo Staff shifts stay visible to visitors but are never indexed (`is_demo_account`).
4. **Who writes the Malay and Chinese guides** (native copy is worth much more than translation).
5. **Employer-facing search** ("hire part-timers Malaysia"): same plan later, or out of scope?

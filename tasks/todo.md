# Dispute evidence + review integrity (2026-10-16)

Approved by the owner: Phase 1 and 2, reveal window 7 days, "New" until 3 reviews.
Defaults I chose where they did not say: reviews are hidden (soft, audited), never hard-deleted;
evidence is kept 12 months after resolution (documented, no auto-delete job yet).

Note on an earlier claim: disputes were already READABLE by both parties (disputes_owner_read);
what was missing was a thread, files, a counterparty notification and a resolution both sides see.

## Phase 1 — disputes: thread, evidence, shared status
- [x] Migration 20261016: disputes (+awaiting_info status, awaiting_role, resolution_note, rating_id,
      review_report category), dispute_messages (incl. internal admin notes), dispute_attachments,
      private bucket `dispute-evidence` (5 MB; jpg/png/webp/pdf), RLS via is_dispute_party(),
      notifications (filed against you / new message / status), admin_notes moved to internal messages
- [x] Client: shared DisputeThread (history, files via signed URLs, composer, status timeline)
- [x] File-a-dispute modals (worker + employer): attach up to 5 files
- [x] Worker "My disputes" opens the thread; employer gets a Disputes view (route + nav)
- [x] Admin: thread + files + internal notes, request info from worker/employer, resolve/dismiss with note both see  (code-complete; NOT exercised in a browser — no admin session)
- [x] i18n en/bm/ch, route-check, notifications

## Phase 2 — review integrity
- [x] Migration 20261016b: ratings.revealed_at/hidden_*/flagged_reason; rating RLS + get_ratee_ratings + recompute
      only count revealed, non-hidden; reveal when both rated or after 7 days, held while a dispute is open;
      hourly cron; flag repeat/habitual lows; review-report limit (3/30 days); admin_set_review_visibility
- [x] Client: "New" below 3 reviews; "revealed together" copy in rating modal; "Report this review" on received feedback
- [x] Admin: review reports show the review, Hide / Restore; flagged reviews list  (code-complete; NOT exercised in a browser)
- [x] Verify with real accounts in the browser (both directions), then clean up

## Verification
- [x] undef-check, i18n-check, route-check, brand-check, vite build, console clean after clicks

## Review (2026-10-16)
Verified live with QA accounts + real uploads: filing with photo/PDF, type/size validation, signed-URL thumbnails,
counterparty notification, reply with files from the other side, ask-for-info -> answer -> back to review,
resolve -> composer closes + outcome shown (live poll), reveal-together (1-star held until the other side rated;
counts unchanged while held), "New" below 3 reviews and the score at 3, report-a-review with evidence + rater notified.
DB self-tests (rolled back): RLS for party/outsider/admin, internal notes hidden from parties, dispute holds reveal,
duplicate / not-about-you report refused, non-admin cannot hide a review.
Not verified: the admin console screens (no admin session), 7-day cron reveal (unit-tested via function only).
Known leftovers: 5 test files in the dispute-evidence bucket (SQL cannot delete storage objects); purge in Dashboard.

---

# BlaBlaCar-style restyle — worker app

Reference: eight BlaBlaCar screenshots supplied by the owner (2026-09-08).
Plan: `~/.claude/plans/mutable-forging-riddle.md`.

Decisions taken by the owner before implementation:
- 5 bottom tabs, Settings folded into Profile as a sub-tab pair
- Worker app only; employer and admin consoles untouched
- Emoji replaced with line icons

## Done

- [x] `Icons` → `currentColor` (19 strokes) + password eye (5). Fixes the active
      tab's glyph never changing colour, and 1.73:1 icons in dark mode.
- [x] 15 new line icons
- [x] Layout kit: `ScreenTitle`, `StatStrip`, `ListRow`, `Timeline`, `InfoNote`, `Money`
- [x] `WorkerBottomNav` — three drifted copies collapsed to one; 6 tabs → 5;
      profile tab shows the user's photo
- [x] Profile | Settings sub-tabs; disputes loader re-gated
- [x] Settings rows → `ListRow` + line icons
- [x] Discover card strip → line icons
- [x] Chat inbox: avatars (were absent entirely) + big title
- [x] Chat thread: person-led header + shift context strip
- [x] Payouts: title + `StatStrip` + note, replacing gradient hero + 2×2 grid
- [x] Payout status labels — was rendering the raw DB enum in all 3 languages
- [x] My Bids: horizontal time range + location
      (first attempt used a vertical dotted timeline copied from the ride
      card -- owner flagged it as reading like a route. Wrong metaphor:
      two dots joined by a line means from-here-to-there, and a shift has
      one place. Replaced; the `Timeline` primitive was deleted with it.)
- [x] Payout method chooser (their screenshot 2)

## Review

Three commits: `86d5254`, `784d831`, `9257534`.

Verified: esbuild clean; token-lint no new findings over the 71-item baseline;
1200 translation keys each present exactly 3×; contrast sweep on all five screens
in both themes (light clean; dark's only failure is the "Gaji" logotype at 3.45,
the documented WCAG 1.4.3 exemption); SVG stroke sweep 24 icons, none below 3:1,
worst 6.41; new strings render in en/bm/zh.

Three real bugs fixed in passing, none of them cosmetic:
1. Nav icons invisible in dark mode (1.73:1).
2. Tab bar duplicated 3×, one copy calling `setTab` directly, leaving QR /
   bid-modal / selected-shift state behind on exit from the shift-detail screen.
3. Payout status rendered as the raw enum ("processed internal").

## Not done — deliberately

- Employer and admin consoles (owner scoped this pass to the worker app). The
  worker and employer chat views are near-verbatim duplicates, so three edits had
  to be pinned to the worker portal by index and the two chats now differ.
  Extracting one shared component is the obvious next step.
- Employer applicant `<table>`; a `Modal` primitive for the ~15 hand-written
  overlays; `settings.title`/`.subtitle` left defined but unused.
- Appearance light/dark/system buttons keep their emoji — the owner designed
  those explicitly on 2026-08-29 and they carry meaning.

## 2026-09-10 — refresh no longer changes which portal you are in
- [x] Landing redirect now: explicit URL > portal this tab was last in > role default.
      The redirect ran on every session restore, not only on sign-in, so refreshing
      threw an admin back to /admin (and an employer to /employer) however deep into
      worker view they were. Worker's path is "" so the URL alone cannot tell "I chose
      worker" from "I have not chosen" — sessionStorage supplies that, and dies with
      the tab, so a new tab still opens at the role's home.
- [x] Chat badge counted rooms the user cannot open. The unread query trusted RLS
      to scope itself; messages_admin_all grants an admin every row in the table,
      so an admin's badge counted strangers' conversations that their inbox never
      lists — unopenable, therefore unclearable. Now scoped with the same two
      queries the inbox uses.

## 2026-09-10 — dogfood pass
Swept worker + employer, light + dark, 375px + 1280px, en/bm/zh.
- [x] 6 contrast defects (10abd8c) — amber-on-amberLight KYC nudge, primary-as-text,
      green-as-text est. budget, invisible stepper arrows, bulk-upload step drift
- [x] 14 primary-as-text sites in dark (76221f7)
- [x] 9 green-as-text sites; 2 payout pills rendering raw DB enums; 2 banking
      labels concatenating the raw English status
- Not covered: admin portal (no admin credential available).
- Noted, not changed: employer applicant pool is a 723px table scrolling inside a
  341px wrapper on mobile. Verified scrollable and reachable, so it works — but
  it is the one screen that does not match the rest of the mobile design.
- [x] Applicant pool: cards on mobile, table kept on desktop. Extracted four
      shared render helpers so the two layouts cannot drift. Also stacked the
      shift-detail action row on mobile — it was the last 654px element on the
      screen. Shift detail now has zero elements wider than 375px.
- [x] Applicant pool filter + sort. Sort: default / bid low / bid high / newest /
      oldest / rating / reliability (stable — ties keep the order applied).
      Filter: by status. Both layouts read one derived list; shift facts (open
      slots, bulk counter, "N applied") stay on the unfiltered list.
- [x] Applicant pool filter now uses Discover's existing pattern, extracted into
      FilterToggle / FilterPanel / FilterField / FilterClearAll + a shared control
      style. Discover converted to the same primitives. `discover.filtersLabel` /
      `hideFiltersLabel` / `clearAll` renamed to `filters.*` since they are no
      longer Discover-only.

## 2026-09-11 — shifts never became 'completed'
- [x] Reported: employers cannot rate workers after a shift ends. Root cause was
      not in the rating code — shifts.status='completed' is required by ~10
      features (both rating directions, disputes, "shifts done", the rate
      prompts) and NOTHING ever wrote it. Live: 6 shifts, all 'open', 4 over.
- [x] 20260911_complete_ended_shifts.sql: shift_ends_at() (last occurrence, KL
      time, overnight wrap) + parameterless complete_ended_shifts() sweep +
      one-off backfill + self-test. No pg_cron here, so both portals call the
      sweep on load, best-effort.
- [x] OWNER ran it 2026-09-12. Verified live: 6 shifts -> 2 open / 4 completed,
      "ended but still open" = 0; shift_ends_at returns the LAST occurrence and
      wraps overnight; the completed shift now renders Rate + File a Dispute for
      both accepted workers, and the dashboard rate prompt is back.
- [x] Decide: anon can EXECUTE complete_ended_shifts. Not introduced by that
      migration — Supabase default privileges grant EXECUTE to anon explicitly,
      so `revoke from public` does not remove it. Confirmed project-wide: anon
      can also call is_shift_chat_member and platform_fee_pct. Harmless here (no
      arguments, only the correct transition) and it makes the sweep run for
      signed-out Discover visitors too. Lock it with
      `revoke execute on function public.complete_ended_shifts() from anon;`
      if you would rather it were authenticated-only.

## 2026-09-12 — "N shifts done" was a hardcoded zero
- [x] carigaji-app.jsx mapped every applicant with `completedShifts: 0`, so the
      employer's applicant card read "0 shifts done" for everyone, always.
      Separate defect from the completed-shifts fix; found while verifying it.
- [x] 20260912_worker_completed_shift_counts.sql: SECURITY DEFINER count, scoped
      to workers who have applied to the caller's own shifts. RLS cannot compute
      this client-side (employers see only their own shifts' applications), so a
      client count would have silently meant "shifts done with me".
- [x] OWNER: run the migration. Until then every card keeps showing 0, which is
      today's behaviour — verified the pool still renders with the RPC 404ing.
- [x] OWNER ran it 2026-09-12. Verified live: RPC returns 1 for each of the two
      accepted workers on the completed shift; a worker who never applied to that
      employer is omitted; a different employer asking about those same workers
      gets []. UI shows "1 shift done / 1 shift done / 0 shifts done" (the third
      is the pending applicant).
- [x] Pluralisation: the card read "1 shifts done" as soon as the count became
      real — the hardcoded 0 had hidden it. Now uses the existing {plural} +
      common.pluralSuffix pattern.

## 2026-09-12 — the two unverified rating items, now verified
- [x] EMPLOYER -> WORKER rating: inserted live. overall 4.7, computed by the
      trigger from 6 aspects, propagated to profiles.rating (was 0).
- [x] WORKER -> EMPLOYER rating: inserted live. overall 4.5, propagated. This is
      the direction that had never been exercised.
- [x] unique(application_id, direction) holds — a second same-direction insert
      returns 409.
- [x] UI closes the loop: on the completed shift the Rate button is GONE for the
      rated worker, View contract / File a Dispute remain, card reads
      "1 shift done", status Completed.
- [x] OWNER ran 20260912b 2026-09-12. Verified live: anon -> 42501 "permission
      denied for function complete_ended_shifts" (HTTP 401); authenticated still
      200; platform_fee_pct (which the signed-out landing reads) untouched at
      0.1500. Employer console loads and the probe shift is still completed.
      Signed-out landing renders, Discover lists shifts, and the completed probe
      shift is correctly absent from it.
      Confirmed by observation, not by reading the guard: on a signed-out load
      the only RPCs called are platform_fee_pct and
      get_public_employer_trust_signals -- complete_ended_shifts is never called
      by anon, so the revoke produces no 401s on the visitor path.
- NOTE: verifying this required building the condition, because no account I
  hold was a worker on a completed shift. Left behind permanently in QA data:
  shift "RATINGS QA probe" (c95d42aa, 2026-09-08, completed), one accepted
  application, and two ratings. Not removable — ratings has no DELETE policy and
  guard_delete_of_booked_shift blocks deleting a shift that has applications.
  Test Worker One now shows rating 4.7, Test Employer Two 4.5.
- [x] Discover now hides finished shifts client-side (shiftLastEndsAt), so the
      feed is correct regardless of whether anyone has triggered the sweep. This
      closes the gap the anon revoke left for signed-out visitors.

## Written ratings — ON HOLD (decided 2026-09-12)
Owner's call: not now. Recorded so the reasoning does not have to be re-derived.

- Blocked on capability, not effort: free text about a named person needs a
  report queue, a content policy, and someone to action reports. None exist.
- Two-sided prose needs simultaneous reveal (neither side sees the other's until
  both submit or the window closes), or it becomes a retaliation weapon after a
  dispute or a no-show report. That changes the one-rating-per-booking flow, so
  it is a design requirement rather than a later add-on.
- Density: under ~100 completed shifts most profiles would show zero reviews,
  which reads worse than showing none.
- Not the bottleneck. Fill rate is; the launch gates are SSM, bank account,
  payment rail, KYC.

Worth knowing: ratings today are PRIVATE (RLS: rater or ratee only). So there
are two separate products here — FEEDBACK (text the rated person sees, low risk)
and REVIEWS (text future counterparties see, all the risk above). Easy to
conflate.

Cheaper 80% if this comes back: structured TAGS instead of prose ("early",
"took initiative", "clear instructions", "paid on time"). Nothing to moderate,
translates across en/bm/zh where free text will not, machine-usable for matching
later, and it fits the existing schema as another key in ratings.aspects.
Optionally plus a private admin-only note for early warning on problem accounts.

Revisit when: a few hundred completed shifts AND simultaneous reveal + a review
window + report/appeal flow + a written policy + a named person handling
reports. Get a legal read on Malaysian defamation exposure first (marketing.md
already routes this class of question to a lawyer).
- [x] Chat: incoming bubbles had a fill and no edge (grayLight #F9FAFB on #FFFFFF
      = 1.05:1), so only the sender's blue bubble looked like a bubble. Added a
      1px border in all three chat copies. Light edge 1.24:1, dark 1.34:1.

## 2026-09-19 — Attendance windows, missed check-in/out, reminders

Owner ask: no check-in after the shift ends; missed check-in -> notify, talk to
employer, employer can check in on their behalf, else dispute. Check-out only
within 48h of shift end, reminder right after the shift and every 8h, then the
employer submits hours on their behalf, else dispute. "Think holistically."

Findings (live DB, 2026-09-19): worker_check_in has NO time window at all (the
2h-before/2h-after window in 20260725d was dropped by the 20260726b rewrite);
employer_mark_no_show exists but nothing reverses it; no scheduler (pg_cron
available, not installed); notifications are localised client-side by
notif.<type>.title/body + params, DB title/body is the English fallback.

- [x] DB: check-in window [start-2h, last end]; check-out window end+48h
      (bypassed once a proposal has been rejected); methods recorded
      (code/employer/admin), attendance_requests table, notify_safe helper
- [x] RPCs: worker_request_attendance, employer_check_in_worker,
      employer_decline_attendance_request, employer_submit_hours_for_worker,
      employer_undo_no_show, admin_apply_attendance_correction
- [x] Reminders: send_attendance_reminders() + pg_cron every 10 min
- [x] Worker UI: missed check-in / window closed / request pending / declined /
      no-show states; employer-submitted hours proposal
- [x] Employer UI: check in on behalf, decline, submit hours for worker, undo
      no-show; shift-list badge
- [x] Admin UI: attendance ruling inside the dispute panel
- [x] Live-verify every path with the QA accounts (self-reviewed; no separate reviewer agent run)

- Review 2026-09-19: DB applied via Supabase MCP (20260915 + cron); strict self-test
  passed; real-JWT REST pass proved grants/RLS. UI written (worker/employer/admin +
  95 i18n keys, all 3x). NOT yet deployed: DB rules are live, UI catches up on push.
- Open policy question: employer never confirms submitted hours. Reminders +
  worker escalation exist; auto-confirm after N days deliberately NOT built
  (it pays without the employer's consent) -- owner's call.

## 2026-09-21 — Search visibility plan (workers finding short shifts / minijobs)
Plan only, full text in tasks/seo_plan.md. Name is not final, so the plan makes the brand a
single config value and keeps every ranking signal brand-independent.
- [x] Phase 0 (2026-10-13, live): brand.config.json + build plugin (scripts/brand-plugin.mjs) +
      {brand}/SITE.name in the app + scripts/brand-check.mjs rename rehearsal (now also scans the
      3 user-facing edge functions and runs in CI before every build); real title/description/OG/
      hreflang/JSON-LD/og-image (only on an indexable build); noindex on temp hosts and private
      routes; generated robots.txt, sitemap.xml, manifest.json; per-page head; shift pages noindex
      until the employer is confirmed non-demo. Edge functions send-notification-email, send-push,
      support-chat read the BRAND_NAME secret (fallback annotated brand-ok); redeployed 2026-10-13.
      telegram-webhook (owner-only bot) deliberately left alone.
      To go live for search: SITE_URL=https://<domain> INDEXABLE=true in the build env, and
      `supabase secrets set BRAND_NAME=<name>` if the name changes.
- [x] Phase 1: Cloudflare cutover (real 200s) once name/domain are final
- [x] Phase 2: edge Worker (shift head + JobPosting + live sitemap)
- [x] Phase 3: hub pages + evergreen guides en/bm/zh + Indexing API
- [x] Phase 4 (2026-10-13): employer and admin portals split into src/portals/ and lazy-loaded
      (main chunk 1,027 -> 816 kB, 265 -> 220 kB gzip; employer 160 kB and admin 54 kB on demand).
      Stale-tab safe (reloads once on a missing chunk). Guards: check:undef, parse gate and
      pre-commit now cover src/portals. Translations (2026-10-13): bm and ch moved to src/i18n/ and
      load on demand (main 816 -> 631 kB, 220 -> 163 kB gzip; total 1,027 -> 631 kB). NOT done:
      font/image preload, Core Web Vitals baseline (needs the live domain).

## 2026-10-13 — Top 5 UX fixes from the design review
Review canvas: https://claude.ai/artifact/Wk11g2hCJ3FVrKxpZrwU7E. Owner decisions: test-account
flag, copy + URL rename (with redirect), FULL token sweep, commit + push each fix separately.
Orchestrator already paused (state.txt = paused).
- [x] 1. Browse first: "Find a shift near you" scrolls to the feed (no Register); signed-out
      header shows no role badge; signed-out nav shows Discover only + Sign in
- [x] 2. Test data: profiles.is_test_account (migration), mark the 4 +qa accounts, Discover
      excludes their shifts; real empty state for an empty feed
- [x] 4. "Needs you": worker My Bids grouped (Needs you / Upcoming / Waiting / Past);
      employer dashboard action list; admin sidebar counts + open-first lists
- [x] 3. One vocabulary (en/ms/zh): Apply · Your rate · Applicants · Send offer / Offer sent ·
      My shifts; /en/my-bids → /en/my-shifts with redirect; code identifiers unchanged
- [x] 5. Tokens: one shared status map, icons not emoji, all literal fontSize → TYPE scale
      (13 px floor), radii → 8/12/999
Each: vite build + pre-commit + browser check (signed-out live; signed-in paths need owner).
Review (2026-10-13): shipped as fc59aee (1), fa95d3b (2, migration applied + checked per role),
c4a2c4b (4), 5786755 (3), 8820b9d + a21dafb (5). Build + route-check (87/87) + signed-out browser
checks passed for each; signed-in screens (worker My shifts, employer dashboard, admin) not yet
clicked through -- needs an owner sign-in. Follow-ups: signed-out deep links fall back to Discover
(task chip raised); SQL notification fallback text still says "bid"; 130/150px label columns and
"4 pos · 0 applied" wrap at 13px; a few #fff on solid fills → BRAND.onSolid; SSM stamp overlaps
"Pay shown" on the landing sample card.
Follow-ups done 2026-10-13: 4baa482 (DB notification/rate-cap text, migration 20261013b applied +
checked), 3c51a03 (seal overlap, flexible label columns, two-line pos/applied, tooltip size,
#fff -> BRAND.onSolid). Deep-link fallback is being fixed in its own session. Still open:
signed-in click-through by owner. Transport tile fixed (see git log).

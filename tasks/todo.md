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
- [ ] Decide: anon can EXECUTE complete_ended_shifts. Not introduced by that
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
- [ ] OWNER: run the migration. Until then every card keeps showing 0, which is
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
- [ ] OWNER: run 20260912b (corrected — revokes from public AND anon; the first
      draft revoked anon only, which leaves EXECUTE via the PUBLIC grant).
- NOTE: verifying this required building the condition, because no account I
  hold was a worker on a completed shift. Left behind permanently in QA data:
  shift "RATINGS QA probe" (c95d42aa, 2026-09-08, completed), one accepted
  application, and two ratings. Not removable — ratings has no DELETE policy and
  guard_delete_of_booked_shift blocks deleting a shift that has applications.
  Test Worker One now shows rating 4.7, Test Employer Two 4.5.

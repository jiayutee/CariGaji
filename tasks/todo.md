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

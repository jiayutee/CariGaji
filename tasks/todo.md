# Todo — Notify applicants when a shift is edited

Today an employer can silently change a shift's time, place or pay. Applicants
— including workers who already signed a contract — are never told. This closes
that gap.

## Decisions (owner, 2026-08-12)
- **Notify on every listed field**: start_at, end_at, occurrences, location,
  wage_min, wage_max, title, headcount, dress_code, requirements.
- **Material changes require re-confirmation.** A worker who already signed is
  notified *and* their booking is put back into a pending state — they must
  actively re-accept the new terms.
- Material = **start_at, end_at, occurrences, location, wage_min, wage_max**.
  Title/headcount/dress code/requirements notify only; they don't unwind a
  signature.

## Who gets notified
`pending`, `shortlisted`, `offered`, `accepted` — anyone with a live stake.
Never `rejected`, `withdrawn`, `expired`.

## Design decisions
- **No `status` change for re-confirmation.** Dedicated columns instead, so the
  20260717g status-transition guard is untouched and the signature audit trail
  survives. `worker_signed_at` is never cleared — it's a record that they *did*
  sign, and destroying it to express "needs re-signing" loses evidence.
- **Guard the new columns.** Follows the established trusted-write idiom
  (20260726b): a BEFORE UPDATE trigger reverts them unless a security-definer
  RPC set the session flag. Without this an employer could clear
  `terms_changed_at` via REST and keep a worker bound to terms they never
  agreed to — which is the exact thing this feature exists to prevent.
- **No background job for lapsing.** The deadline is derived at read time
  (`min(shift start, terms_changed_at + 24h)`) rather than a scheduler
  flipping rows. No new infra, and it can't leave rows in a stale state.
- **Notification bodies are English-only**, consistent with every existing
  notification in this codebase — they're generated in SQL, which has no access
  to the app's TRANSLATIONS table. The in-app UI around them is translated.

## Steps
- [x] 1. Migration: widen `notifications_type_check` (+`shift_updated`,
        +`shift_terms_changed`)
- [x] 2. Migration: `applications` gains `terms_changed_at`,
        `terms_reconfirmed_at`, `terms_change_summary`
- [x] 3. Migration: guard trigger for those 3 columns + `worker_reconfirm_terms`
        RPC
- [x] 4. Migration: `notify_shift_updated` trigger on shifts — diffs old/new,
        notifies active applicants, stamps `terms_changed_at` on signed
        accepted rows for material changes only
- [x] 5. Migration: fix `notify_shift_cancelled` to include `offered`
        (pre-existing bug — a worker holding a live offer is never told the
        shift was cancelled)
- [x] 6. Owner runs migration; verify every object via REST before wiring JS
- [x] 7. Worker UI: re-confirm prompt showing what changed; calls the RPC
- [x] 8. Employer UI: "awaiting re-confirmation" badge in the applicant pool
- [x] 9. i18n EN+BM for all new strings
- [ ] 10. Verify end-to-end against production, clean up test data

## Review

Feature works end-to-end and is verified in the browser in both languages.
Migration `20260812c` still needs running (see Outstanding).

### Shipped
- `trg_notify_shift_updated` — diffs watched fields, notifies
  pending/shortlisted/offered/accepted, never rejected/withdrawn/expired.
- Material changes (date/time, location, pay) put an already-signed booking on
  hold via `terms_changed_at`; the worker clears it through
  `worker_reconfirm_terms`. Guarded columns, so neither side can fake it.
- Worker UI: re-confirm banner (first thing in the bid detail, above the
  status pills) plus a list badge, so a held booking is visible without
  opening anything.
- Employer UI: "awaiting re-confirmation" badge in the applicant pool, so a
  slot at risk is visible while there's still time to backfill.
- `t(key, params)` interpolation + `notificationText()` — notifications render
  from `params` through TRANSLATIONS, in the reader's current language.
- Pre-existing bug fixed: `notify_shift_cancelled` never told `offered`
  workers, because 'offered' was added to the enum the day after that filter
  was written.

### The incident
`20260812` broke shift editing in production. `changed || 'title'` is
ambiguous — Postgres has both `anyarray || anyelement` and
`anyarray || anyarray`, an unquoted literal is unknown-typed, so it resolved
to array-to-array and tried to parse 'title' AS an array literal. The trigger
raised inside AFTER UPDATE, which aborted the employer's UPDATE. Edits
appeared to silently do nothing.

I shipped it flagged as "unverified" because there's no local Postgres. That
flag was worth nothing — the feature still broke. Two things changed as a
result:
1. `array_append()` everywhere; it has one meaning and can't mis-resolve.
2. **Both notification triggers now have `exception when others` handlers.**
   A notification is a side effect and must never be able to take down the
   write that triggered it. Degrading to "no notification sent" restores the
   status quo; raising takes out a core feature.

### Verified
Eight-case suite, all passing: no-op save doesn't notify; reordered
occurrences don't notify (fingerprint); non-material edit notifies without
demanding re-confirmation; material edit on a signed booking stamps
`terms_changed_at` and notifies; employer tampering with `terms_changed_at`
is reverted; worker self-stamping `terms_reconfirmed_at` is reverted; the RPC
works; double re-confirm is rejected. Browser: banner and badge render, the
button clears the hold (confirmed against the DB, not just the UI), a second
material change re-arms it, and BM renders throughout. No console errors.

### Outstanding
- `20260812c` not yet run. It adds `notifications.params`, converts three
  types to it, and deletes 15 orphaned QA notification rows.
- Until it runs, `terms_change_summary` holds English prose, so the one
  untranslated fragment in the BM banner is the change list ("date/time").
  After it runs that's a code and renders as "tarikh/masa".
- 11 notification types still write English-only text. The infrastructure
  covers them; each needs its trigger updated to emit `params`.
- `notifications` has no FK or cascade to shifts/applications, so deleting a
  shift leaves workers with notifications whose link 404s. Separate fix.

import { useState, useEffect, useRef, useMemo, useCallback, useContext, createContext, memo, Fragment, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./src/lib/supabase.js";

// The product name and site address come from brand.config.json at BUILD time
// (scripts/brand-plugin.mjs) and from nowhere else. Never write the name in this
// file: use SITE.name, or {brand} inside a translation string (t() fills it).
// Portals other than the worker app load on demand (src/portals/). A deploy
// deletes the previous build's hashed files, so a tab opened BEFORE a deploy that
// then asks for a portal gets a 404 for its chunk. Reload once to pick up the new
// build; if it still fails after that, surface the error rather than loop.
const CHUNK_RELOAD_KEY = "app-chunk-reload";
const importOrReload = (factory) => factory().then(
  (mod) => { try { window.sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch { /* private mode */ } return mod; },
  (err) => {
    try {
      if (!window.sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
        window.location.reload();
        return new Promise(() => {});
      }
    } catch { /* private mode: fall through and report */ }
    throw err;
  },
);
const lazyPortal = (factory) => lazy(() => importOrReload(factory));

export const SITE = typeof __BRAND_CONFIG__ !== "undefined"
  ? __BRAND_CONFIG__
  : { name: "App", shortName: "App", legalName: "App", supportEmail: "", siteUrl: "", indexable: false, alternateNames: [] };
import { applyThemeToDocument, buildThemeVars, cycleThemePreference, getSystemTheme, readThemePreference, resolveThemeMode, writeThemePreference } from "./src/lib/theme.js";

// ─── Malaysia-pinned date/time formatting ────────────────────────────────────
// Shifts happen at a physical location in Malaysia, so their start/end times
// and offer deadlines must always read in Malaysia time regardless of the
// viewer's device timezone — otherwise a worker or employer outside MYT sees
// the wrong shift time. Chat timestamps etc. are intentionally left on the
// viewer's local timezone (that's the correct behavior for "when did I see
// this"), so only shift-time-critical call sites use these.
const MY_TIMEZONE = "Asia/Kuala_Lumpur";
// Identifies which build a report came from. Vite replaces import.meta.env
// at build time, so this pins to the deploy the reporter was actually running
// -- without it, "it broke" arrives with no way to tell whether the fix that
// followed was already live for them.
const APP_BUILD_ID = `${import.meta.env.MODE ?? "unknown"}-${import.meta.env.VITE_BUILD_SHA ?? "local"}`;

export const formatShiftTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", timeZone: MY_TIMEZONE }) : "";
export const formatShiftDate = (iso, opts = {}) => iso ? new Date(iso).toLocaleDateString("en-MY", { ...opts, timeZone: MY_TIMEZONE }) : "";
// 24h "HH:MM" in Malaysia time, for time-of-day filtering/sorting (not display).
const shiftHHMM = (iso) => {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: MY_TIMEZONE }).formatToParts(new Date(iso));
  const h = parts.find(p => p.type === "hour")?.value ?? "00";
  const m = parts.find(p => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
};

// ─── Multi-day shift occurrences ─────────────────────────────────────────────
// A shift's `occurrences` column (see supabase/migrations/20260712d_shift_occurrences.sql)
// is an array of {date: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM"}, sorted by
// date. Every shift has one — including ordinary single-day shifts, which just
// get a one-element array — so this is the single source of truth for a
// shift's schedule; start_at/end_at are a denormalized mirror of occurrences[0]
// kept only for sorting/offer-deadline code that predates this feature.

// Duration in hours of one occurrence, handling an overnight shift (end time
// past midnight) the same way the reserve-estimate calc already did.
const occurrenceHours = (occ) => {
  if (!occ?.start || !occ?.end) return 0;
  const [sh, sm] = occ.start.split(':').map(Number);
  const [eh, em] = occ.end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
};
export const totalOccurrenceHours = (occurrences) => (occurrences ?? []).reduce((sum, occ) => sum + occurrenceHours(occ), 0);

// When a shift actually FINISHES: the last occurrence's end, in Malaysia time,
// with an occurrence ending at or before its start treated as running past
// midnight -- the same +24h wrap occurrenceHours applies. This is the client
// mirror of public.shift_ends_at() (20260911); the two must agree, which is why
// the rule lives here once rather than inline at the call site.
//
// NOT end_at: that column mirrors the EARLIEST occurrence (20260712d), so on a
// Sat + Mon shift it says Saturday. It is only the fallback, for a shift whose
// occurrences carry nothing parseable.
//
// Returns null when nothing can be read. Callers treat null as "cannot tell"
// and must leave such a shift alone -- never hide one on a guess.
//
// Malaysia is fixed UTC+8 with no DST, so the literal offset is exact, and it
// is already how this file builds KL timestamps (see the post-shift form).
// Workers may check out until this long after the shift's last occurrence ends
// (enforced server-side in worker_submit_checkout; this only drives the UI).
export const CHECKOUT_WINDOW_MS = 48 * 60 * 60 * 1000;

export const shiftLastEndsAt = (occurrences, endAt = null) => {
  let last = null;
  for (const occ of occurrences ?? []) {
    if (!occ?.date || !occ?.start || !occ?.end) continue;
    const t = new Date(`${occ.date}T${occ.end}:00+08:00`);
    if (Number.isNaN(t.getTime())) continue;
    if (occ.end <= occ.start) t.setDate(t.getDate() + 1);   // runs past midnight
    if (!last || t > last) last = t;
  }
  if (last) return last;
  const fallback = endAt ? new Date(endAt) : null;
  return fallback && !Number.isNaN(fallback.getTime()) ? fallback : null;
};

// Estimated late-cancellation payout for a given multiplier (0.5 for the
// contract_50 choice, 1.0 for show_up_100) — mirrors create_cancellation_payout
// in 20260717h exactly (same floor of 0.25h, same round-to-2dp), so the
// worker-facing decision card never disagrees with what the server actually
// queues once they make their choice.
// startAt/endAt mirror shift_contracted_hours' FALLBACK: when no occurrence
// carries a parseable start/end, the SQL derives hours from end_at - start_at
// instead. Without it this returned the 0.25h floor, so a worker would be
// shown RM5.00 for a shift the server pays RM160.00 for. No live row hits
// that today (every occurrence written by the app has start/end), but the
// payout is real money and the estimate must not be able to drift from it.
const cancellationPayoutAmount = (wageBid, occurrences, multiplier, startAt = null, endAt = null) => {
  let hours = totalOccurrenceHours(occurrences);
  if (hours <= 0 && startAt && endAt) {
    hours = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3600000;
  }
  return Math.round(Number(wageBid ?? 0) * Math.max(0.25, hours) * multiplier * 100) / 100;
};

// occurrenceHours is exact minutes/60 (e.g. a 4:10-4:50 shift is
// 0.6666666666666666h) — correct for math (pay = rate x hours), but
// unreadable shown raw as "0.6666666666666666h". This is display-only:
// callers doing arithmetic (estimated pay, budgets) must keep using the
// raw number from occurrenceHours/totalOccurrenceHours directly, never this.
const formatDurationHours = (hours) => {
  const totalMinutes = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

// Formats a date+time-range for a single day, in the same style as the
// existing formatShiftTime/formatShiftDate helpers, but from plain
// "YYYY-MM-DD"/"HH:MM" strings (no timezone conversion needed — these are
// already the Malaysia-local wall-clock values entered/stored).
export const formatOccurrenceLine = (occ, opts = { day: 'numeric', month: 'short' }) => {
  if (!occ?.date) return '';
  const dateLabel = new Date(`${occ.date}T00:00:00`).toLocaleDateString('en-MY', opts);
  const to12h = (hhmm) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const period = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  return occ.start && occ.end ? `${dateLabel}, ${to12h(occ.start)}–${to12h(occ.end)}` : dateLabel;
};

// Compact summary for cards/lists: single line for a one-day shift, or
// "N days: <date1>, <date2>, ..." for a multi-day posting.
export const formatOccurrencesSummary = (occurrences) => {
  const list = occurrences ?? [];
  if (list.length === 0) return '';
  if (list.length === 1) return formatOccurrenceLine(list[0]);
  return `${list.length} days: ${list.map(o => formatOccurrenceLine(o, { day: 'numeric', month: 'short' })).join(', ')}`;
};


// ─── Basic analytics ─────────────────────────────────────────────────────────
// Fire-and-forget event logging (see supabase/migrations/20260720_analytics_events.sql).
// Gated on the user's cookie consent decision (see hasAnalyticsConsent below) —
// never awaited by callers and never throws — a missing migration, RLS
// denial, or network blip must not block or break any UI flow.
const logAnalyticsEvent = (eventType, metadata = {}, userId = null) => {
  try {
    if (!hasAnalyticsConsent()) return;
    supabase.from('analytics_events').insert({ event_type: eventType, metadata, user_id: userId }).then(() => {}, () => {});
  } catch {
    // Swallow — analytics must never break the app.
  }
};

// ─── Shift categories ────────────────────────────────────────────────────────
// Kept in sync with the shifts_category_check DB constraint (see
// supabase/migrations/20260705g_widen_shift_categories.sql).
export const SHIFT_CATEGORIES = ["F&B", "Retail", "Event", "Promotion", "Warehouse", "Office", "Security", "Production", "Market Research", "Student", "Logistics", "Other"];

// Categories are STORED in English -- shifts.category is constrained to exactly
// these strings by shifts_category_check, and the bulk-upload parser matches
// against them. So this translates the LABEL only; the value written to the
// database, filtered on, and compared never changes. Anything that renders a
// category to a person should go through here, and nothing should ever write
// what this returns.
export const shiftCategoryLabel = (value, t) => {
  const key = `category.${value}`;
  return hasTranslation(key) ? t(key) : String(value ?? '');
};

// banking_details.verification_status is a raw database value ('pending',
// 'verified', 'rejected') and was rendered straight into the Earnings panel, so
// a Chinese or Malay reader saw an English word where a status was promised.
// Unknown values fall back to the raw string rather than to an empty cell: a
// status nobody has a label for is still information.
export const bankVerificationLabel = (status, t) => {
  const key = `earnings.bankStatus${String(status || 'pending').replace(/^./, c => c.toUpperCase())}`;
  return hasTranslation(key) ? t(key) : String(status || 'pending');
};

// ─── Shift language requirements ─────────────────────────────────────────────
// Kept in sync with the shifts_language_requirements_check DB constraint (see
// supabase/migrations/20260711_shift_language_requirements.sql).
export const SHIFT_LANGUAGES = ["Bahasa Melayu", "English", "Mandarin", "Tamil", "Other"];

// Employer-side commission: worker take-home is always wage_min/wage_max as
// bid, the employer pays that wage plus this % on top. Owner-decided fee
// model (2026-08-03) — worker payout math must never subtract this.
// Fallback only. The rate that actually bills lives in Postgres
// (platform_fee_pct(), 20260824b) and is snapshotted onto every shift at post
// time, so raising it prices new shifts without touching agreed ones. This
// constant is what we draw with until that value arrives, and must match the
// migration's launch rate: zero, to get employers posting.
export const PLATFORM_FEE_PCT = 0;

// Documents an employer can require on a shift (Post Shift step 2). Stored as
// value codes in shifts.requirements.documents, next to requirements.special,
// so no schema change -- and codes, not labels, so they translate on read.
export const SHIFT_REQUIRED_DOCUMENTS = [
  { value: "ic_passport", labelKey: "employer.docIcPassport" },
  { value: "food_handler", labelKey: "employer.docFoodHandler" },
  { value: "first_aid", labelKey: "employer.docFirstAid" },
  { value: "driving_license", labelKey: "employer.docDrivingLicense" },
];
export const shiftRequiredDocuments = (requirements) =>
  Array.isArray(requirements?.documents)
    ? requirements.documents.filter(v => SHIFT_REQUIRED_DOCUMENTS.some(d => d.value === v))
    : [];

// Worker Sedcard qualifications — reuses the same real-world labels as the
// employer's "required documents" checkboxes on the Post Shift form, so the
// two sides speak the same vocabulary, plus one addition relevant to
// Warehouse/Logistics shifts.
export const SEDCARD_QUALIFICATIONS = [
  { value: "food_handler", labelKey: "employer.docFoodHandler" },
  { value: "first_aid", labelKey: "employer.docFirstAid" },
  { value: "driving_license", labelKey: "employer.docDrivingLicense" },
  { value: "forklift_license", labelKey: "qualification.forkliftLicense" },
];

 





// Anti-CSV-injection: if a free-text value starts with a character a
// spreadsheet app would interpret as a formula trigger, prefix it with an
// apostrophe so it's stored/re-exported as inert text.
export const sanitizeBulkTextValue = (v) => {
  const trimmed = String(v ?? "").trim();
  return /^[=+\-@\t\r]/.test(trimmed) ? `'${trimmed}` : trimmed;
};

// Reverses sanitizeBulkTextValue's protective apostrophe for display purposes.
export const displayProtectedText = (v) => {
  const s = String(v ?? "");
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
};





// ─── Design tokens ─────────────────────────────────────────────────────────
export const BRAND = {
  primary: "#2563EB",
  primaryDark: "#1D4ED8",
  primaryLight: "#EFF4FF",
  primaryMid: "#BBD0FF",
  dark: "#0A1428",
  accent: "#0891B2",
  accentLight: "#E0F7FB",
  green: "#1A9E5C",
  greenDark: "#15803D",
  greenLight: "#E8F7EF",
  blue: "#0284C7",
  blueLight: "#E0F2FE",
  amber: "#D97706",
  amberLight: "#FEF3C7",
  tealLight: "#CCFBF1",
  // Text colours for the fixed-light surfaces above. amberLight/redLight/
  // greenLight/blueLight are literal hex and do NOT flip with the theme,
  // while BRAND.text does -- so `background: amberLight, color: BRAND.text`
  // renders light-on-light in dark mode. These mirror what Badge already
  // pairs with each surface; use them instead of BRAND.text on any *Light bg.
  onAmberLight: "#92400E",
  onRedLight: "#991B1B",
  onGreenLight: "#065F46",
  onPrimaryLight: "#1E40AF",
  onAccentLight: "#155E75",
  onBlueLight: "#075985",
  onTealLight: "#0F766E",
  // Text/glyph on a fixed SOLID brand fill (BRAND.blue/primary/red). Those
  // fills do not flip with the theme, so white stays correct in both modes.
  onSolid: "#FFFFFF",
  red: "#DC2626",
  redLight: "#FEE2E2",
  gray: "var(--cg-text-muted)",
  grayLight: "var(--cg-surface-muted)",
  surface: "var(--cg-surface)",
  surfaceElevated: "var(--cg-surface-elevated)",
  panel: "var(--cg-panel)",
  input: "var(--cg-input)",
  page: "var(--cg-page)",
  border: "var(--cg-border)",
  text: "var(--cg-text)",
  textMuted: "var(--cg-text-muted)",
  // Use instead of BRAND.primary whenever primary is TEXT sitting on a
  // surface. BRAND.primary is a fixed brand blue chosen against white; it
  // stays correct as a BUTTON fill with white text, but as text on the dark
  // card it measures 3.43:1. This token is the same blue in light mode and a
  // lighter one in dark, so the brand reads the same and the contrast holds.
  primaryOnSurface: "var(--cg-primary-on-surface)",
  // Same idea as primaryOnSurface, for BRAND.red/BRAND.green used as TEXT
  // (not a button fill). Each token only changes in the mode where the base
  // color actually fails AA -- red on dark surfaces (3.7:1), green on light
  // ones (3.45:1) -- and is a no-op in the other mode.
  redOnSurface: "var(--cg-red-on-surface)",
  greenOnSurface: "var(--cg-green-on-surface)",
  shadow: "var(--cg-shadow)",
  overlay: "var(--cg-overlay)",
};

// One type scale, colocated with BRAND for the same reason: a single named
// definition beats the same semantic reappearing at a different size every
// place it's used. Before this, "a screen title" rendered at 34/28 (worker's
// restyled ScreenTitle), 22 (every employer/admin console header, flat, no
// mobile variant), 20, 18, 15 -- six sizes for one role, spread across three
// portals that never agreed with each other.
//
// Weight ladder: 800 screen title / 700 section heading / 600 card title and
// button / 400 body. Sizes below intentionally clear the 12px floor -- the
// landing page's own body copy and the SSM seal did not (11px, 8px).
//
// Only `title`/`titleMobile` are wired up in this pass (ScreenTitle, plus the
// 16 employer/admin screen headers that were flat 22px with no responsive
// behavior of their own). `section`/`cardTitle`/`body`/`label` are declared
// as the reference values for that future sweep -- the ~50 section-heading
// call sites across three consoles are a separate, larger pass, not
// mechanically listed the way the 16 titles were.
export const TYPE = {
  title: { fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.12 },
  titleMobile: { fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.12 },
  section: { fontSize: 16, fontWeight: 700, lineHeight: 1.3 },
  cardTitle: { fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
  body: { fontSize: 14, fontWeight: 400, lineHeight: 1.5 },
  label: { fontSize: 13, fontWeight: 600, lineHeight: 1.3 },
};

// Named size + radius scales (full token sweep). FS.meta (13) is the floor
// for any body/meta text on phones; FS.micro (11) is reserved for bottom-nav
// tab labels, numeric count badges and the brand tagline only.
export const FS = { micro: 11, meta: 13, body: 14, bodyLg: 15, card: 16, lead: 18, h3: 20, h2: 22, h1: 28, display: 34 };
export const RADIUS = { control: 8, card: 12, pill: 999 };

// One z-index scale. Before this, "a full-screen backdrop dialog" -- the same
// role every time -- sat at 100, 200, 300, 1000, 1100 or 1200 depending only
// on which screen wrote it, with no two ever open at once to justify the
// spread. The plan named 5 tiers (nav, sticky, drawer, modal, toast); two more
// are added here because collapsing them into those 5 would have inverted a
// real, currently-correct stacking relationship rather than just renaming it:
//   - `popover`: a small anchored dropdown (account menu, notification bell)
//     is not a full-screen backdrop the way a modal is, and belongs BELOW
//     modal so an opened dialog correctly covers it.
//   - `panel` (cookie consent) and `gate` (mandatory T&C/KYC/welcome) both
//     used to share a tier with an ordinary modal by coincidence, not design.
//     Cookie consent can appear unprompted over an open toast; the onboarding
//     gates block the whole app and must outrank even that.
export const Z = {
  nav: 50,       // reserved: bottom nav / top bars carry no explicit z-index
                 // today (DOM order + position:sticky/fixed already keeps
                 // them on top of page content) -- declared for the day one
                 // needs to be pinned above a scrolling list explicitly.
  popover: 400,
  sticky: 900,   // persistent floating chrome that survives navigation: the
                 // cookie reopener bubble, the support-chat launcher button.
  modal: 1100,
  drawer: 1250,  // above modal: opening the hamburger menu should cover
                 // anything already on screen.
  toast: 1300,   // fire-and-forget notifications, and the support-chat
                 // widget -- both stay visible even while a modal is open.
  panel: 1400,
  gate: 1500,
};

// ─── i18n dictionary (v1 foundation — core strings only, not exhaustive) ────
// English only. It is the fallback for any key another language lacks and the
// language most visitors read, so it ships in the main bundle. Malay and Chinese
// live in src/i18n/ and load on demand (loadLanguage below); `npm run check:i18n`
// keeps their keys and {placeholders} in step with this table.
const TRANSLATIONS = {
  en: {
    "nav.discover": "Discover",
    "nav.myBids": "My shifts",
    "nav.chat": "Chat",
    "nav.earnings": "Earnings",
    "nav.profile": "Profile",
    "nav.settings": "Settings",
    "settings.title": "Settings",
    "settings.subtitle": "Manage your account and access hidden consoles",
    "settings.account": "Account",
    "settings.language": "Language",
    "settings.theme": "Appearance",
    "settings.languageEnglish": "English",
    "settings.languageBM": "Bahasa Melayu",
    "settings.languageChinese": "Chinese",
    "settings.notifications": "Notifications",
    "settings.notificationsValue": "Enabled",
    "settings.pushTitle": "Push notifications",
    "settings.pushOn": "On — shift updates and new chat messages reach your phone even when {brand} is in the background or closed.",
    "settings.pushOff": "Off — turn on to get shift updates and new chat messages without keeping {brand} open.",
    "settings.pushDenied": "Blocked in your browser settings. Allow notifications for this site, then come back.",
    "settings.pushUnsupported": "Not available in this browser, so shift updates and chat messages will not reach your phone. On iPhone, add {brand} to your Home Screen first. You'll still get emails either way.",
    "settings.pushEnableBtn": "Turn on",
    "settings.pushDisableBtn": "Turn off",
    "settings.privacy": "Privacy",
    "settings.privacyValue": "Standard",
    "common.signIn": "Sign in",
    "common.signUp": "Sign up",
    "common.createAccount": "Create account",
    "common.postAShift": "Post a Shift",
    "common.accept": "Accept",
    "common.reject": "Reject",
    "common.submitBid": "Apply →",
    "common.placeBid": "Apply →",
    "common.signInToBid": "Sign in to apply →",
    "toast.avatarUpdated": "Profile picture updated.",
    "toast.ratingSubmitted": "Rating submitted.",
    "toast.ratingFailed": "Failed to submit rating: ",
    "toast.avatarUpdateFailed": "Could not update photo: ",
    "toast.sendFailed": "Failed to send: ",
    "toast.checkinSuccess": "Checked in successfully.",
    "toast.checkoutSuccess": "Checkout submitted. Your employer will confirm your hours.",
    "toast.acceptModificationSuccess": "Accepted. Your employer will be paid based on this.",
    "toast.acceptModificationFailed": "Failed to accept: ",
    "toast.rejectModificationSuccess": "Your hours were resubmitted. The employer will review them.",
    "toast.rejectModificationFailed": "Failed to reject: ",
    "toast.maxBidPrefix": "Max rate is RM",
    "toast.sampleShiftBidInfo": "This is a sample shift. Apply to a live shift to send an application.",
    "toast.applicationFailed": "Failed to submit application: ",
    "toast.signFailed": "Failed to sign: ",
    "toast.contractSigned": "Contract signed! You can now chat with your employer.",
    "toast.cancellationContractSigned": "Cancellation contract signed — your 50% payout is on its way.",
    "toast.showUpProofSubmitted": "Proof submitted — your full payout is on its way.",
    "toast.showUpProofFailed": "Failed to submit proof: ",
    "toast.updateFailed": "Update failed: ",
    "toast.escrowTopupUnavailable": "Adding funds isn’t available yet — coming with FPX/DuitNow integration.",
    "toast.signInToPostShift": "Sign in to post a shift.",
    "toast.shiftFieldsRequired": "Title, location, date, and start/end times are required.",
    "toast.scheduleDatePast": "Every scheduled day must be today or later.",
    "toast.scheduleDuplicateDate": "Each day can only be added once — remove the duplicate date.",
    "toast.maxPayGteMinPay": "Max pay must be ≥ min pay.",
    "toast.applicationDeadlinePast": "Application deadline must be in the future.",
    "toast.applicationDeadlineAfterStart": "Application deadline must be before the shift starts.",
    "toast.postShiftFailed": "Failed to post shift: ",
    "toast.shiftPublished": "Shift published! Workers will start applying shortly.",
    "toast.contractSent": "Contract sent to worker for signature!",
    "chat.signInTitle": "Sign in to view messages",
    "chat.signInHint": "Messages with employers appear here once you're signed in and have an accepted application.",
    "chat.title": "Chat",
    "chat.emptyTitleWorker": "No accepted shifts yet.",
    "chat.emptyHintWorker": "Messages appear here once an employer accepts your application.",
    "chat.emptyTitleEmployer": "No accepted applications yet.",
    "chat.emptyHintEmployer": "Chats appear here once you accept a worker's application.",
    "chat.employerSubtitle": "Chat with workers on accepted shifts",
    "chat.loading": "Loading...",
    "chat.dayToday": "Today",
    "chat.previewYou": "You",
    "chat.newMessagesDivider": "New messages",
    "chat.viewShiftBtn": "View shift",
    "chat.membersCount": "{n} in this chat",
    "chat.membersTitle": "In this chat",
    "chat.membersEmpty": "Nobody else here yet.",
    "chat.membersYou": "(you)",
    "chat.roleEmployer": "Employer",
    "chat.roleWorker": "Worker",
    "chat.previewSomeone": "Someone",
    "chat.dayYesterday": "Yesterday",
    "chat.unreadA11y": "{n} conversation(s) with new messages",
    "chat.inputPlaceholder": "Type a message…",
    "chat.send": "Send",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.pluralSuffix": "s",
    "shiftDetail.placeBidTitle": "Apply for This Shift",
    "shiftDetail.employerRange": "Employer range: RM",
    "shiftDetail.maxBid": " · Max rate: RM",
    "shiftDetail.wageAskLabel": "Your wage ask (RM/hour)",
    "shiftDetail.estimatedTotalPay": "Estimated total pay",
    "shiftDetail.transportAllowanceSuffix": " transport allowance",
    "shiftDetail.bidSubmitted": "Application Sent!",
    "shiftDetail.bidSubmittedHint": "You'll be notified when shortlisted",
    "shiftDetail.positions": "Positions",
    "shiftDetail.applied": "Applied",
    "shiftDetail.wageRange": "Wage Range",
    "shiftDetail.perHour": "per hour",
    "shiftDetail.shareBtn": "Share",
    "shiftDetail.shiftDuration": "Shift Duration",
    "shiftDetail.daysCount": "{count} days",
    "shiftDetail.estimatedGross": "Estimated Gross",
    "shiftDetail.atAvgRate": "at average rate",
    "shiftDetail.estimatedGrossTooltip": "Average hourly rate (midpoint of RM{min}–{max}) × shift hours. Your actual pay depends on your rate once your application is accepted.",
    "shiftDetail.transportAllowance": "Transport Allowance",
    "shiftDetail.title": "Shift Details",
    "shiftDetail.aboutRole": "About this role",
    "shiftDetail.location": "Location",
    "shiftDetail.date": "Date",
    "shiftDetail.time": "Time",
    "shiftDetail.dressCode": "Dress Code",
    "shiftDetail.languagesRequired": "Languages Required",
    "shiftDetail.headcount": "Headcount",
    "shiftDetail.applicationDeadline": "Applications close",
    "shiftDetail.workersNeeded": "workers needed",
    "shiftDetail.employerScore": "Employer Score",
    "shiftDetail.employerScoreSignInToView": "Sign in to view this employer's reliability score.",
    "shiftDetail.locationNote": "Exact address revealed once your application is accepted.",
    "shiftDetail.employerReliability": "Employer Reliability",
    "shiftDetail.applicants": "applicants",
    "shiftDetail.notProvided": "Not provided",
    "shiftDetail.tba": "TBA",
    "shiftDetail.dressCodeNone": "None specified",
    "shiftDetail.notApplicable": "N/A",
    "shiftDetail.yourBid": "Your rate",
    "myBids.transportAllowanceRow": "Transport allowance",
    "myBids.employerLabel": "Employer",
    "myBids.employerRangeRow": "Employer range",
    "myBids.shortlistedBanner": "You've been shortlisted! Open chat to discuss and receive your offer.",
    "myBids.loadingBids": "Loading your shifts…",
    "myBids.noBidsYet": "No shifts yet",
    "myBids.loadingBidsHint": "Hang tight while we fetch your shifts.",
    "myBids.noBidsHint": "Head to Discover and apply for a shift to see it here.",
    "myBids.sectionNeedsYou": "Needs you",
    "myBids.sectionUpcoming": "Upcoming",
    "myBids.sectionWaiting": "Waiting to hear back",
    "myBids.pastToggle": "Past shifts · {n}",
    "myBids.employerDecidesByPrefix": "Employer decides by ",
    "myBids.respondByPrefix": "Respond by ",
    "myBids.pillShiftCancelled": "Shift Cancelled",
    "myBids.pillConfirmNow": "Reply to offer",
    "myBids.pillShortlisted": "Shortlisted",
    "myBids.pillAccepted": "Accepted",
    "myBids.pillOfferExpired": "Offer expired",
    "myBids.pillNotSelected": "Not selected",
    "myBids.pillPending": "Pending",
    "myBids.yourBidPrefix": "Your rate: ",
    "myBids.chatBtn": "Chat →",
    "worker.checkInBtn": "Check In",
    "worker.checkInOpensAt": "Check-in opens {when}",
    "worker.previewModeBanner": "Preview only — this is how the app looks to workers. You can browse, but not apply or take worker actions.",
    "worker.previewModeExitBtn": "Exit preview",
    "worker.previewModeBlocked": "Preview only — switch to a worker account to actually do this.",
    "worker.roleLoading": "One moment — still loading your account.",
    "worker.previewModeBidBtn": "Preview — can't submit",
    "myBids.signContractBtn": "Sign Contract",
    "myBids.contractSignedBadge": "Contract signed",
    "myBids.shiftCancelledNotice": "This shift was cancelled by the employer. No further action is needed.",
    "myBids.lateCancellationTitle": "This shift was cancelled less than 24 hours before it started",
    "myBids.lateCancellationBody": "Choose to sign a 50% cancellation payout now, or show up in person and submit a photo for 100% of your agreed wage.",
    "myBids.cancellation50Btn": "Sign cancellation contract (50% — you'll receive {amount})",
    "myBids.cancellationShowUpLabel": "Show up for full pay (100% — you'll receive {amount})",
    "myBids.cancellationShowUpHint": "Take a photo of yourself at the shift location to claim full payout.",
    "myBids.cancellationProofUploading": "Uploading proof…",
    "myBids.cancellationChose50": "You chose the 50% cancellation payout. It's on its way.",
    "myBids.cancellationProofSubmitted": "Proof submitted — your full payout is on its way.",
    "myBids.cancellationAwaitingProof": "You chose to show up — take a photo at the location to claim your full payout.",
    "myBids.selectedNotice": "You've got an offer! Confirm or decline before the deadline above — if you don't respond in time, the offer is automatically released back to the employer.",
    "myBids.viewContractTermsBtn": "View contract terms",
    "myBids.hideContractTermsBtn": "Hide contract terms",
    "myBids.offerExpiredNotice": "This offer expired because it wasn't confirmed in time.",
    "myBids.cancelling": "Cancelling…",
    "myBids.cancelBidBtn": "Cancel Application",
    "myBids.declineBtn": "Decline",
    "myBids.confirmShiftBtn": "Confirm Shift",
    "myBids.fileDisputeBtn": "File a Dispute",
    "myBids.disputeAlreadyFiledBadge": "Dispute filed",
    "myBids.fileDisputeTitle": "File a Dispute",
    "myBids.disputeCategoryLabel": "What's the issue?",
    "myBids.disputeDescriptionLabel": "Describe what happened",
    "myBids.disputeSubmitBtn": "Submit Dispute",
    "dispute.categoryHoursDisputed": "Hours disputed",
    "dispute.categoryNoShowClaim": "No-show claim",
    "dispute.categoryUnsafeConditions": "Unsafe working conditions",
    "dispute.categoryPaymentIssue": "Payment issue",
    "dispute.categoryOther": "Other",
    "disputes.myDisputesTitle": "My Disputes",
    "disputes.myDisputesEmpty": "No disputes yet.",
    "disputes.filedByYou": "Filed by you",
    "disputes.filedAgainstYou": "Filed against you",
    "disputes.statusOpen": "Open",
    "disputes.statusUnderReview": "Under review",
    "disputes.statusResolved": "Resolved",
    "disputes.statusDismissed": "Dismissed",
    "disputes.resolvedLabel": "Resolved:",
    "disputes.viewShiftChat": "View shift chat",
    "rating.rateBtn": "Rate",
    "employer.ratePromptTitle": "You have {count} worker(s) to rate",
    "employer.ratePromptBody": "How did {name} do on \"{shift}\"? Your rating is what other employers see when choosing who to book \u2014 and workers see yours too.",
    "employer.ratePromptCta": "Rate {name}",
    "rating.promptTitle": "You have {count} shift(s) to rate",
    "rating.promptBody": "How was working on \"{shift}\"? Your rating helps other workers pick good employers \u2014 and employers see yours too.",
    "rating.promptCta": "Rate now",
    "rating.modalTitle": "Rate your experience",
    "rating.overallPreview": "Overall rating",
    "rating.submitBtn": "Submit Rating",
    "rating.detailsTitle": "Rating details",
    "rating.aspectAvgEmpty": "No ratings yet.",
    "rating.aspect.onTime": "On time",
    "rating.aspect.polite": "Polite",
    "rating.aspect.hardworking": "Hardworking",
    "rating.aspect.followingDirections": "Following directions",
    "rating.aspect.accountability": "Accountability",
    "rating.aspect.rapidAction": "Rapid action",
    "rating.aspect.responsible": "Responsible",
    "rating.aspect.kind": "Kind",
    "rating.aspect.helpful": "Helpful",
    "rating.aspect.organized": "Organized",
    "rating.aspect.wellPlanned": "Well planned",
    "rating.aspect.clearInstructions": "Clear instructions",
    "admin.disputesEmptyState": "No disputes filed yet.",
    "employer.workerProfileTitle": "Worker profile",
    "nav.menuTitle": "Menu",
    "admin.navOverview": "Overview",
    "admin.navKycQueue": "KYC Queue",
    "admin.navEmployerQueue": "Employer Queue",
    "admin.navDisputes": "Disputes",
    "admin.navFlags": "Flags",
    "admin.navPayouts": "Payouts",
    "admin.navDeposits": "Deposits",
    "admin.navConfig": "Config",
    "admin.navReports": "Issue Reports",
    "admin.reportsTitle": "Issue Reports",
    "admin.reportsCount": "{n} report{s} total",
    "admin.reportsEmpty": "No issue reports yet.",
    "admin.reportsNoneOpen": "No open reports.",
    "admin.disputesNoneOpen": "No open disputes.",
    "admin.showClosed": "Show closed ({n})",
    "admin.hideClosed": "Hide closed",
    "admin.reportStatusNew": "New",
    "admin.reportStatusInvestigating": "Investigating",
    "admin.reportStatusResolved": "Resolved",
    "admin.reportStatusWontFix": "Won't fix",
    "admin.reportStatusDuplicate": "Duplicate",
    "admin.reportReportedBy": "Reported by",
    "admin.reportPage": "Page",
    "admin.reportNoteLabel": "Admin note",
    "admin.reportNotePlaceholder": "Internal note — not shown to the reporter",
    "admin.reportSave": "Save",
    "admin.reportSaved": "Saved.",
    "admin.reportSaveFailed": "Failed to save: ",
    "admin.statNewReports": "Open reports",
    "admin.statPayoutsToRelease": "Payouts to release",
    "admin.overviewTitle": "Platform Overview",
    "admin.kycQueueTitle": "KYC Review Queue",
    "admin.employerQueueTitle": "Employer Verification Queue",
    "admin.disputesTitle": "Disputes Dashboard",
    "admin.flagsTitle": "Fraud & No-Show Flags",
    "admin.payoutsTitle": "Payout Overrides",
    "admin.configTitle": "Platform Configuration",
    "admin.flagsEmptyTitle": "No flag source connected",
    "admin.flagsEmptyHint": "Fraud and no-show detection is not built yet. Nothing in the schema records GPS mismatches, QR token reuse or confirmed no-shows, so there is nothing to review here. This screen stays empty on purpose rather than showing example cases that could be mistaken for real ones.",
    "admin.flagsCount": "{n} active flags requiring review",
    "admin.depositsTitle": "Employer deposits",
    "admin.depositsIntro": "Record a bank transfer an employer has already made. This is the only way funds enter the deposit ledger until an FPX/DuitNow gateway exists — so only enter an amount you can see on a bank statement.",
    "admin.depositsAppendOnlyWarning": "The ledger is append-only. A recorded top-up cannot be edited or deleted — a mistake can only be offset by another entry, which someone will have to explain later. Check the amount before confirming.",
    "admin.depositEmployerLabel": "Which employer?",
    "admin.depositSearchPlaceholder": "Search by name…",
    "admin.depositLoading": "Loading…",
    "admin.depositNoEmployers": "No employer accounts found.",
    "admin.depositUnnamed": "Unnamed employer",
    "admin.depositUnverifiedNote": "· not SSM-verified",
    "admin.depositFormTitle": "Record a transfer for {name}",
    "admin.depositAmountLabel": "Amount received (RM)",
    "admin.depositReferenceLabel": "Bank reference",
    "admin.depositReferencePlaceholder": "e.g. FT26082312345",
    "admin.depositReferenceHint": "The reference ties this row to a real transfer, and it is what stops the same transfer being credited twice — entering it again will be refused.",
    "admin.depositReviewBtn": "Review",
    "admin.depositConfirmBody": "Credit RM{amount} to {name}, against bank reference {reference}. This cannot be undone.",
    "admin.depositConfirmBtn": "Yes, record it",
    "admin.depositCancelBtn": "Go back",
    "admin.depositRecording": "Recording…",
    "admin.depositRecorded": "Recorded RM{amount} for {name}.",
    "admin.depositAmountInvalid": "Enter an amount greater than zero.",
    "admin.depositReferenceRequired": "A bank reference is required.",
    "admin.depositFailed": "Could not record the top-up: ",
    "admin.depositDuplicate": "Reference {reference} has already been credited. If this is a second, genuine transfer, use its own reference.",
    "admin.depositDoneTitle": "Top-up recorded",
    "admin.depositDoneBody": "RM{amount} credited to {name}. Their balance is now RM{available} available, RM{held} held.",
    "admin.depositRecentTitle": "Recent top-ups",
    "admin.depositRecentEmpty": "No top-ups recorded yet.",
    "admin.disputeResolve": "Resolve",
    "admin.disputeDismiss": "Dismiss",
    "admin.disputeResolved": "Dispute resolved.",
    "admin.disputeDismissed": "Dispute dismissed.",
    "admin.disputeResolveFailed": "Failed to resolve dispute: ",
    "admin.disputeDismissFailed": "Failed to dismiss dispute: ",
    "admin.disputeMarkUnderReview": "Mark Under Review",
    "admin.disputeUnderReviewSet": "Dispute marked under review.",
    "admin.disputeUnderReviewFailed": "Failed to mark under review: ",
    "admin.disputeInvestigate": "Investigate",
    "admin.disputeInvestigateTitle": "Investigate dispute",
    "admin.disputeEvidenceTitle": "Evidence",
    "admin.disputeCheckedIn": "Checked in",
    "admin.disputeCheckedOut": "Checked out",
    "admin.disputeWorkerSigned": "Worker signed contract",
    "admin.disputeEmployerSigned": "Employer signed contract",
    "admin.disputeWageAsk": "Agreed wage",
    "admin.disputeWageRange": "Shift wage range",
    "admin.disputeShiftWindow": "Shift window",
    "admin.disputeNotRecorded": "Not recorded",
    "admin.disputeChatTitle": "Shift chat",
    "admin.disputeChatEmpty": "No messages in this shift's chat yet.",
    "admin.disputeChatSendFailed": "Failed to send message: ",
    "profile.signInTitle": "Sign in to view your profile",
    "profile.signInHint": "Your KYC status, reliability score, ratings, and shift history live here once you sign in.",
    "profile.changePhoto": "Change profile picture",
    "profile.standardKyc": "Standard KYC",
    "profile.basicKycBadge": "Basic KYC",
    "profile.advancedKycBadge": "Advanced KYC",
    "profile.kycInReview": "ID check in review",
    "profile.reliabilitySuffix": "Reliability",
    "profile.shiftsDone": "Shifts done",
    "profile.rating": "Rating",
    "profile.strikes": "Strikes",
    "profile.cleanRecord": "Clean record",
    "profile.onTimeRate": "On-time rate",
    "profile.notTrackedYet": "Not tracked yet",
    "common.comingSoon": "Coming soon",
    "profile.kycVerification": "KYC Verification",
    "profile.kycBasic": "Basic (Phone/Email)",
    "profile.kycStandard": "Standard (MyKad + Selfie)",
    "profile.kycAdvanced": "Advanced (Certifications)",
    "profile.verified": "Verified",
    "profile.reliabilityScoreLabel": "Reliability Score: ",
    "profile.reliabilityExcellent": "Excellent — top 15% of workers",
    "profile.reliabilityGood": "Good standing — keep it up",
    "profile.reliabilityBuilding": "Building your reputation",
    "profile.reliabilityLow": "Complete more shifts to improve your score",
    "profile.recentRatings": "Recent Ratings",
    "profile.viewEditSedcard": "View / edit my profile ›",
    "profile.shiftsDoneBadge": "{count} shifts done",
    "sedcard.title": "My Profile",
    "sedcard.subtitle": "Shown to employers reviewing your applications.",
    "sedcard.bioLabel": "About me / experience",
    "sedcard.bioPlaceholder": "e.g. 2 years of F&B service experience, comfortable with high-volume events…",
    "sedcard.languagesLabel": "Languages I speak",
    "sedcard.qualificationsLabel": "Qualifications",
    "sedcard.qualificationsOtherLabel": "Other qualifications",
    "sedcard.qualificationsOtherPlaceholder": "e.g. Barista certified, cash handling experience…",
    "sedcard.saveBtn": "Save profile",
    "sedcard.notProvided": "Not provided",
    "toast.sedcardSaved": "Profile saved.",
    "toast.sedcardSaveFailed": "Could not save profile: ",
    "qualification.forkliftLicense": "Forklift License",
    "personalDetails.title": "Personal Details",
    "personalDetails.subtitle": "Keep your contact and identity details up to date.",
    "personalDetails.saveBtn": "Save details",
    "toast.personalDetailsSaved": "Personal details saved.",
    "toast.personalDetailsSaveFailed": "Could not save details: ",
    "profile.noRatingsTitle": "No ratings yet",
    "profile.noRatingsHint": "Ratings from employers will appear here after you complete shifts.",
    "auth.registerTitle": "Register",
    "auth.registerSubtitle": "Create your account and complete your profile and KYC details.",
    "auth.employerFreeTrial": "Your first 2 months are free — the platform fee only starts 2 months after you post your first shift.",
    "auth.resetTitle": "Reset password",
    "auth.resetSubtitle": "We will send a password reset email to your inbox.",
    "auth.sendResetEmail": "Send reset email",
    "auth.emailAddress": "Email address",
    "auth.password": "Password",
    "auth.forgetPassword": "Forget password?",
    "auth.noAccountYet": "No account yet? Register Here",
    "auth.resetHint": "We will email you a secure link to reset your password.",
    "auth.fullName": "Full name *",
    "auth.country": "Country *",
    "auth.phoneNumber": "Phone number *",
    "auth.emailAddressReq": "Email address *",
    "auth.passwordReq": "Password *",
    "auth.createPassword": "Create a password",
    "auth.confirmPasswordReq": "Confirm password *",
    "auth.retypePassword": "Re-type your password",
    "auth.passwordsNoMatch": "Passwords do not match.",
    "auth.identityType": "Identity type *",
    "auth.icMyKad": "IC (MyKad)",
    "auth.passport": "Passport",
    "auth.myPR": "MyPR",
    "auth.myKadNumber": "MyKad Number *",
    "auth.myPRNumber": "MyPR Number *",
    "auth.passportNumber": "Passport Number *",
    "auth.dateOfBirth": "Date of birth *",
    "auth.underageWarning": "You must be at least {age} years old to register and work on {brand}.",
    "auth.kycLevelNote": "Your KYC level will be assigned based on uploaded documents.",
    "auth.address": "Address *",
    "auth.addressPlaceholder": "Street, city, state",
    "auth.uploadDocuments": "Upload documents",
    "auth.uploadDocumentsHint": "Upload clear photos of your {doc}. The identity number must be readable and match what you entered above.",
    "auth.passportDoc": "passport",
    "auth.myPRCardDoc": "MyPR card",
    "auth.myKadDoc": "MyKad",
    "auth.uploadFrontHelper": "Upload a photo or PDF of the front side.",
    "auth.uploadBackHelper": "Upload a photo or PDF of the back side.",
    "auth.ocrChecking": "Checking the ID number on your photo…",
    "auth.ocrMatch": "The identity number on your photo matches what you entered.",
    "auth.ocrMismatchTitle": "We couldn't match the ID number on your photo to what you typed.",
    "auth.ocrMismatchHint": "This usually means one of:",
    "auth.ocrMismatchReason1": "the photo is blurry or the number isn't fully visible,",
    "auth.ocrMismatchReason2": "the identity number you entered has a typo, or",
    "auth.ocrMismatchReason3": "the wrong document photo was uploaded.",
    "auth.ocrMismatchAction": "Please double-check both. You can still submit — our team will verify manually.",
    "auth.selfie": "Selfie",
    "auth.selfieHelper": "Upload a clear selfie for identity verification.",
    "auth.certification": "Certification",
    "auth.certificationHelper": "Optional: food handler, first aid, or other certifications.",
    "auth.finalRegisterHint": "Add your personal and KYC details now. Selected files will be uploaded to Supabase Storage during registration.",
    "auth.pleaseCompleteFields": "Please complete the highlighted fields:",
    "auth.docMyKadFront": "MyKad (front)",
    "auth.docMyKadBack": "MyKad (back)",
    "auth.docMyPRFront": "MyPR card (front)",
    "auth.docMyPRBack": "MyPR card (back)",
    "auth.docPassportFront": "Passport photo page",
    "auth.docPassportBack": "Passport back page",
    "auth.docIdFront": "ID document (front)",
    "auth.docIdBack": "ID document (back)",
    "auth.fieldFullName": "Full name",
    "auth.fieldPhone": "Phone number",
    "auth.fieldEmail": "Email address",
    "auth.fieldPassword": "Password",
    "auth.fieldConfirmPassword": "Confirm password",
    "auth.fieldIdNumber": "Identity number",
    "auth.fieldDateOfBirth": "Date of birth",
    "auth.fieldDateOfBirthAge": "Date of birth (must be {age}+)",
    "auth.fieldAddress": "Address",
    "auth.fieldSelfie": "Selfie",
    "auth.fieldTnC": "Terms & Conditions consent",
    "employerNav.dashboard": "Dashboard",
    "employerNav.shifts": "Shifts",
    "employerNav.postShift": "Post Shift",
    "employerNav.bulkUpload": "Bulk Upload",
    "employerNav.chat": "Chat",
    "employerNav.billing": "Billing",
    "employerNav.account": "Account",
    "employer.dashboardTitle": "Dashboard",
    "employer.goodMorning": "Good morning, ",
    "employer.statActiveShifts": "Active shifts",
    "employer.statTotalApplicants": "Total applicants",
    "employer.statFilledSlots": "Filled slots",
    "employer.statReliability": "Reliability score",
    "employer.activeShiftsHeading": "Active Shifts",
    "employer.quickActions": "Quick Actions",
    "employer.postNewShift": "+ Post New Shift",
    "employer.recentActivity": "Recent Activity",
    "employer.noActivity": "No activity yet — post a shift to start hiring.",
    "employer.activityAccepted": "{who} was accepted for {shift}",
    "employer.activityDeclined": "{who}'s application for {shift} was declined",
    "employer.activityBid": "{who} applied for {shift} at RM{amount}/h",
    "employer.activityUnknownWorker": "A worker",
    "employer.activityAShift": "a shift",
    "employer.shiftsTitle": "Your Shifts",
    "employer.postShiftBtn": "+ Post Shift",
    "employer.listCardChatBtn": "Chat",
    "employer.editShift": "Edit shift",
    "employer.chatDisabledHint": "Chat unlocks once a worker is confirmed for this shift.",
    "employer.cancelShift": "Cancel shift",
    "employer.cancelQuoteTitle": "Cancel this shift?",
    "employer.cancelQuoteLoading": "Working out what this will cost\u2026",
    "employer.cancelQuoteNoWorkers": "No worker has confirmed this shift yet, so cancelling costs you nothing and nobody is left without work.",
    "employer.cancelQuoteRate": "Agreed rate",
    "employer.cancelQuoteHours": "Hours",
    "employer.cancelQuoteShare": "Owed",
    "employer.cancelQuoteAmount": "Amount",
    "employer.cancelQuoteTotal": "Total you will be charged",
    "employer.cancelQuoteShowUpNote": "Each worker may instead choose to come to the venue anyway and be paid in full. If all of them do, the total becomes RM{max}.",
    "employer.cancelQuoteNoCharge": "You are giving enough notice that no compensation is owed. The workers will be told the shift is off.",
    "employer.cancelQuoteAccept": "I understand I will be charged RM{total} to cancel this shift.",
    "employer.cancelQuoteKeep": "Keep the shift",
    "employer.cancelQuoteConfirm": "Cancel shift",
    "employer.cancelQuoteFailed": "Could not work out the cancellation cost: ",
    "employer.closeApplicationsBtn": "Close applications",
    "employer.closingApplications": "Closing…",
    "employer.closeApplicationsHint": "Stop taking new applications now, without cancelling the shift. Workers who already applied are unaffected.",
    "employer.confirmCloseApplications": "Stop taking new applications for \"{title}\"? Workers who already applied keep their place — you can still review, shortlist, and offer to them as normal.",
    "employer.toastCloseApplicationsFailed": "Failed to close applications: ",
    "employer.toastApplicationsClosed": "Applications closed. No new workers can apply — your existing applicants are unaffected.",
    "employer.applicationDeadlineLabel": "Application deadline (optional)",
    "employer.applicationDeadlineHint": "Applications stop automatically at this time. Leave blank to keep taking applications until you close them manually or the shift fills. Must be before the shift starts.",
    "employer.applicationDeadlinePassedBanner": "This shift's application deadline has passed and it's still short on workers. Applications won't reopen on their own — if you need more applicants for a short-notice fill, extend or clear the deadline.",
    "employer.applicationDeadlineActiveLabel": "Applications close:",
    "employer.selectedTotalLabel": "Total for this selection:",
    "employer.cancellingShift": "Cancelling…",
    "employer.applicantPool": "Applicants",
    "employer.sortLabel": "Sort",
    "employer.sortDefault": "Default (order applied)",
    "employer.sortBidLow": "Rate: lowest first",
    "employer.sortBidHigh": "Rate: highest first",
    "employer.sortNewest": "Applied: newest first",
    "employer.sortOldest": "Applied: oldest first",
    "employer.sortRating": "Rating: highest first",
    "employer.sortReliability": "Reliability: highest first",
    "employer.filterStatusLabel": "Status",
    "employer.filterAll": "All applicants",
    "employer.showingCount": "Showing {shown} of {total}",
    "employer.noneMatchFilter": "No applicants match this filter",
    "employer.noneMatchFilterHint": "Try “All applicants”, or clear the sort.",
    "employer.postAShiftTitle": "Post a Shift",
    "employer.editShiftTitle": "Edit Shift",
    "employer.postAShiftSubtitle": "Fill in shift details and required workers",
    "employer.editShiftSubtitle": "Update the details of your posted shift",
    "employer.stepShiftDetails": "Shift Details",
    "employer.stepRequirements": "Requirements",
    "employer.stepReview": "Review & Post",
    "employer.saveChanges": "Save Changes",
    "employer.publishShift": "Publish Shift",
    "employer.bulkUploadBtn": "Bulk Upload",
    "employer.bulkUploadTitle": "Bulk Upload Shifts",
    "employer.bulkUploadSubtitle": "Upload a CSV of multiple shifts at once",
    "employer.bulkStepUpload": "Upload",
    "employer.bulkStepReview": "Review & Fix",
    "employer.bulkStepPublish": "Publish",
    "employer.bulkChooseFile": "Shift CSV file",
    "employer.bulkChooseFileHelper": "CSV only, up to 2MB, up to 200 shifts per file.",
    "employer.bulkDownloadTemplate": "Download CSV template",
    "employer.bulkFileTooLarge": "That file is larger than 2MB. Please split it into smaller batches.",
    "employer.bulkInvalidFileType": "Please select a .csv file.",
    "employer.bulkParseFailed": "Couldn't read that CSV: ",
    "employer.bulkRowsSummary": "{ready} of {total} rows ready to publish, {needsFix} need fixes",
    "employer.bulkBackToUpload": "← Back to upload",
    "employer.bulkContinueToPublish": "Continue: Publish →",
    "employer.bulkPublishReady": "Publish ready rows",
    "employer.bulkPublishing": "Publishing {done} of {total}…",
    "employer.bulkPublishSummary": "{published} published, {failed} failed",
    "employer.bulkBackToFix": "← Back to fix rows",
    "employer.bulkDone": "Done",
    "employer.bulkColRow": "Row",
    "employer.bulkColStatus": "Status",
    "employer.billingTitle": "Billing & Payouts",
    "employer.accountTitle": "Account",
    "earnings.title": "Earnings",
    "earnings.subtitle": "Live payout schedule and internal settlement status",
    "earnings.totalPayouts": "Total Internal Payouts",
    "earnings.verified": "Banking verified for salary payout",
    "earnings.notVerified": "Complete SecureSign bank verification to receive payout",
    "earnings.statRecords": "Payout records",
    "earnings.statReady": "Ready to release",
    "earnings.statHeld": "Held payouts",
    "earnings.statBanking": "Banking status",
    "earnings.recentPayouts": "Recent Payouts",
    "earnings.noPayoutsTitle": "No payouts yet",
    "earnings.noPayoutsHint": "Complete a shift and verify your bank details to receive your first payout here.",
    "earnings.viewSlip": "View payment slip",
    "slip.title": "Payment slip",
    "slip.subtitle": "Generated by {brand} from the signed contract and your confirmed hours.",
    "slip.reference": "Reference",
    "slip.job": "Job",
    "slip.employer": "Employer",
    "slip.when": "When",
    "slip.where": "Where",
    "slip.hoursWorked": "Hours worked",
    "slip.amount": "Amount",
    "slip.status": "Status",
    "slip.payoutDate": "Payout date",
    "slip.viewShift": "View the shift →",
    "slip.notYetPaid": "A record of what you are owed, not a receipt. There is no payment gateway yet — during the pilot the transfer is made by hand.",
    "toast.shiftUnavailable": "This shift can no longer be opened.",
    "earnings.salaryPayout": "salary payout",
    "earnings.payoutStatusQueued": "Queued",
    "earnings.payoutStatusReady": "Ready",
    "earnings.payoutStatusScheduled": "Scheduled",
    "earnings.payoutStatusProcessed": "Processed",
    "earnings.payoutStatusFailed": "Failed",
    "earnings.payoutStatusHeld": "On hold",
    "earnings.monthlyChartTitle": "Monthly earnings",
    "earnings.monthlyChartEmpty": "Your monthly earnings will appear here once you complete a shift.",
    "earnings.monthlyChartTruncatedNote": "Showing the most recent 12 months.",
    "earnings.loadMoreBtn": "Load more",
    "earnings.loadingMoreBtn": "Loading…",
    "settings.salaryBankingTitle": "Salary Banking Details",
    "settings.salaryBankingHint": "Mid-month payouts require verified bank details via SecureSign.",
    "settings.bankLabel": "Bank",
    "settings.accountHolderName": "Account holder name",
    "settings.accountNumber": "Account number",
    "settings.status": "Status",
    "settings.saveBanking": "Save banking",
    "settings.verifySecureSign": "Verify via SecureSign (Demo)",
    "settings.payoutMethodTitle": "How would you like to be paid?",
    "settings.payoutMethodBank": "Bank transfer",
    "settings.payoutMethodEwallet": "E-wallet",
    "settings.payoutMethodEwalletSoon": "Not available yet — coming with FPX/DuitNow",
    "settings.payoutMethodBankHint": "Paid into the account below once your hours are confirmed.",
    "cookie.bannerTitle": "We use cookies",
    "cookie.bannerBody": "We use essential cookies to keep you signed in, plus optional cookies to remember your preferences. Choose what you're comfortable with — you can change this anytime.",
    "cookie.acceptAll": "Accept All",
    "cookie.declineAll": "Decline All",
    "cookie.configure": "Configure",
    "cookie.panelTitle": "Cookie Preferences",
    "cookie.tab.categories": "Categories",
    "cookie.tab.services": "Services",
    "cookie.tab.about": "About",
    "cookie.essentialTitle": "Essential",
    "cookie.essentialDesc": "Required to keep you signed in and the app working. Always on.",
    "cookie.functionalTitle": "Functional",
    "cookie.functionalDesc": "Remembers your language and display theme so you don't have to reset them each visit.",
    "cookie.analyticsTitle": "Analytics & Marketing",
    "cookie.analyticsDesc": "Helps us understand usage (page views, sign-ups, applications) so we can improve the app. Off by default — you control whether this is on.",
    "cookie.servicesEssential": "Keeps you signed in via your Supabase authentication session, and stores basic session state needed for the app to function. These can't be switched off.",
    "cookie.servicesFunctional": "Stores your language choice (English/Bahasa Melayu/Simplified Chinese, key \"carigaji_lang\") and your light/dark theme preference in your browser's local storage.",
    "cookie.servicesAnalytics": "When enabled, {brand} logs basic usage events (page views, sign-ups, applications sent) to help us understand how the app is used. Nothing is logged for this category until you turn it on, and it stops immediately if you turn it back off.",
    "cookie.aboutBody": "{brand} uses browser local storage — not third-party tracking cookies — to keep you signed in and to remember your preferences on this device. We don't use this data for tracking, and nothing here is shared with advertisers. See our Privacy Policy for the full details on what we collect and why, and our Terms of Service for how the platform works.",
    "cookie.savePreferences": "Save Preferences",
    "cookie.reopenPreferences": "Cookie preferences",
    "cookie.hideBubble": "Hide this button (still available in Settings)",
    "supportChat.title": "{brand} Support",
    "supportChat.greeting": "Hi! I'm the {brand} support assistant. Ask me anything about shifts, applying, KYC, payments, or your account.",
    "supportChat.inputPlaceholder": "Type your question…",
    "supportChat.send": "Send",
    "supportChat.minimize": "Minimize",
    "supportChat.close": "Close chat",
    "supportChat.restore": "Open support chat",
    "supportChat.thinking": "Typing…",
    "supportChat.escalateText": "Still need help? Our team can take it from here.",
    "supportChat.emailSupport": "Email support",
    "supportChat.errorMessage": "Something went wrong. Please try again or email our support team.",
    "common.close": "Close",
    "account.menuLabel": "Account menu",
    "account.help": "Help",
    "account.contactSupport": "Contact customer support",
    "account.referFriends": "Refer friends",
    "account.signOut": "Sign out",
    "account.referShareText": "Find or post flexible shift work in Malaysia with {brand}:",
    "toast.inviteLinkCopied": "Invite link copied! Share it with friends.",
    "toast.shiftLinkCopied": "Shift link copied — paste it to share this shift.",
    "help.title": "Help Centre",
    "help.faqWorkQ": "How does {brand} work?",
    "help.faqWorkA": "Employers post short shifts with a wage range. Workers browse open shifts and apply with an hourly rate within the allowed range. If the employer accepts your application, you both sign a contract in-app and the shift is confirmed.",
    "help.faqPaidQ": "How do I get paid?",
    "help.faqPaidA": "Employers commit funds for accepted workers before the shift starts. After the shift is completed, payment is released to your registered bank account — check the Earnings tab for your payout history.",
    "help.faqKycQ": "What are the KYC levels?",
    "help.faqKycA": "Basic: email verified only. Standard: ID document uploaded. Advanced: ID + selfie + supporting document verified. Higher KYC levels unlock higher-paying shifts and build trust with employers.",
    "help.faqLocationQ": "Why can't I see the exact shift location?",
    "help.faqLocationA": "Some employers reveal the exact address only to accepted workers, showing just the city/region publicly for safety. Once you're accepted, the full address appears on the shift details page.",
    "help.faqWrongQ": "What if something goes wrong during a shift?",
    "help.faqWrongA": "Contact customer support using the option in this menu and our team will help resolve the issue directly.",
    "help.stillNeedHelp": "Still need help?",
    "help.contactSupportLink": "Contact support",
    "notification.title": "Notifications",
    "notification.targetGone": "This shift is no longer listed.",

    // Notification text rendered from a row's `params` instead of the English
    // prose the DB trigger stored. See notificationText().
    "notif.shift_updated.title": "Shift details changed",
    "notif.shift_updated.body": "The employer changed the {changed} for \"{shift_title}\". Open the shift to see the updated details.",
    "notif.shift_terms_changed.title": "Confirm the new shift terms",
    "notif.shift_terms_changed.body": "The {changed} changed for \"{shift_title}\" after you signed. Your booking is on hold until you confirm the new terms.",
    "notif.shift_cancelled.title": "Shift cancelled",
    "notif.shift_cancelled.body": "The shift \"{shift_title}\" was cancelled by the employer.",
    "notif.change.datetime": "date/time",
    // Remaining notification types (20260813). Variant keys cover the three
    // notifications whose body branches on an outcome.
    "notif.payout_created.title": "You have been paid",
    "notif.payout_created.body": "Your hours for \"{shift_title}\" were confirmed. RM{amount} is on its way.",
    "notif.worker_withdrew.title": "A worker withdrew",
    "notif.worker_withdrew.body": "{worker_name} withdrew from \"{shift_title}\" with {notice_hours} hours notice. The slot is open again.",
    "notif.slot_reopened.title": "A slot reopened",
    "notif.slot_reopened.body": "A slot has reopened on \"{shift_title}\". Apply again if you are still free.",
    "notif.offer_confirmed.title": "Worker confirmed",
    "notif.offer_confirmed.body": "{worker_name} accepted your offer for \"{shift_title}\".",
    "notif.marked_no_show.title": "You were reported as not attending",
    "notif.marked_no_show.body": "The employer reported that you did not attend \"{shift_title}\". This costs {points} reliability points. If you did attend, open the shift and raise a dispute.",
    "notif.attendance_missed_checkin.title": "You missed check-in",
    "notif.attendance_missed_checkin.body": "The shift \"{shift_title}\" has ended and you did not check in. If you attended, open the shift and ask the employer to check you in. If they disagree you can raise a dispute.",
    "notif.attendance_employer_missed_checkin.title": "A worker did not check in",
    "notif.attendance_employer_missed_checkin.body": "{worker_name} did not check in for \"{shift_title}\". If they attended, check them in on their behalf; otherwise report a no-show.",
    "notif.attendance_request.title": "A worker sent an attendance request",
    "notif.attendance_request.body": "{worker_name} sent an attendance request for \"{shift_title}\". Open the shift to respond.",
    "notif.attendance_request_reminder.title": "A worker is still waiting for you",
    "notif.attendance_request_reminder.body": "{worker_name} sent an attendance request for \"{shift_title}\" more than a day ago. Please respond so it can be settled without an admin.",
    "notif.attendance_request_approved.title": "The employer checked you in",
    "notif.attendance_request_approved.body": "The employer confirmed you attended \"{shift_title}\" and checked you in. You can now submit your hours.",
    "notif.attendance_request_declined.title": "The employer declined your request",
    "notif.attendance_request_declined.body": "For \"{shift_title}\", the employer declined your attendance request. If you disagree you can raise a dispute from the shift and an admin will review it.",
    "notif.attendance_checkout_reminder.title": "Check out of your shift",
    "notif.attendance_checkout_reminder.window.body": "Please submit your hours for \"{shift_title}\". You have about {hours_left} hours left to check out.",
    "notif.attendance_checkout_reminder.resubmit.body": "You rejected the employer's proposal for \"{shift_title}\". Please submit your own hours so the employer can review them.",
    "notif.attendance_checkout_window_closed.title": "Check-out window closed",
    "notif.attendance_checkout_window_closed.body": "The 48-hour window to check out of \"{shift_title}\" has closed. Ask the employer to submit your hours on your behalf, or raise a dispute.",
    "notif.attendance_employer_not_checked_out.title": "A worker did not check out",
    "notif.attendance_employer_not_checked_out.body": "{worker_name} did not check out of \"{shift_title}\" within 48 hours. You can submit their hours on their behalf.",
    "notif.shift_hours_submitted_on_behalf.title": "The employer submitted your hours",
    "notif.shift_hours_submitted_on_behalf.body": "The employer recorded {hours} hours for \"{shift_title}\" because you did not check out. Accept them to be paid, or reject and submit your own.",
    "notif.hours_confirmation_reminder.title": "Hours are waiting for your confirmation",
    "notif.hours_confirmation_reminder.body": "{worker_name} submitted hours for \"{shift_title}\". Please confirm them, propose different hours, or dispute.",
    "notif.hours_awaiting_employer.title": "Still waiting for the employer",
    "notif.hours_awaiting_employer.body": "The employer has not responded to the hours you submitted for \"{shift_title}\". If it stays unanswered you can raise a dispute from the shift and an admin will review it.",
    "notif.no_show_reversed.title": "Your no-show report was withdrawn",
    "notif.no_show_reversed.body": "The no-show report for \"{shift_title}\" was withdrawn and your reliability points were restored.",
    "notif.attendance_admin_ruling.title": "An admin ruled on an attendance dispute",
    "notif.attendance_admin_ruling.body": "An admin ruled on the attendance dispute for \"{shift_title}\". Open the shift to see the outcome.",
    "notif.bid_received.title": "New application received",
    "notif.bid_received.body": "Someone applied for \"{shift_title}\".",
    "notif.bid_accepted.title": "Application accepted",
    "notif.bid_accepted.body": "Your application for \"{shift_title}\" was accepted.",
    "notif.bid_rejected.title": "Application rejected",
    "notif.bid_rejected.body": "Your application for \"{shift_title}\" was rejected.",
    "notif.shift_offer.title": "You've got an offer!",
    "notif.shift_offer.body": "You've been offered \"{shift_title}\". Please confirm or decline before {deadline_at}.",
    "notif.offer_declined_or_expired.title": "Pick a substitute",
    "notif.offer_declined_or_expired.declined.body": "{worker_name} declined \"{shift_title}\". Choose another applicant.",
    "notif.offer_declined_or_expired.expired.body": "{worker_name} did not respond in time for \"{shift_title}\". Choose another applicant.",
    "notif.not_selected.title": "Not selected this time",
    "notif.not_selected.body": "The shift \"{shift_title}\" has been fully staffed. You were not selected.",
    "notif.shift_cancellation_choice_pending.title": "Shift cancelled \u2014 choose your payout",
    "notif.shift_cancellation_choice_pending.body": "The shift \"{shift_title}\" was cancelled less than 24 hours before it started. Choose to sign a 50% cancellation payout, or show up in person for 100% of your agreed wage. Respond by {deadline_at}.",
    "notif.shift_cancellation_choice_made.title": "Worker responded to shift cancellation",
    "notif.shift_cancellation_choice_made.contract_50.body": "A worker accepted the 50% cancellation payout for \"{shift_title}\".",
    "notif.shift_cancellation_choice_made.show_up_100.body": "A worker is showing up for \"{shift_title}\" and has submitted proof for full pay.",
    "notif.shift_checkout_submitted.title": "Worker submitted checkout hours",
    "notif.shift_checkout_submitted.body": "A worker reported {hours} hours for \"{shift_title}\". Please confirm or dispute.",
    "notif.shift_checkout_disputed.title": "Employer disputed your checkout hours",
    "notif.shift_checkout_disputed.with_reason.body": "Reason: {reason}",
    "notif.shift_checkout_disputed.no_reason.body": "The employer disputed the hours you reported. Please resubmit.",
    "notif.change.location": "location",
    "notif.change.pay": "pay",
    "notif.change.title": "title",
    "notif.change.headcount": "headcount",
    "notif.change.dress_code": "dress code",
    "notif.change.requirements": "requirements",
    // Worker re-confirmation of changed terms
    // Withdrawing from a booking already accepted
    // Launch-phase issue reporting
    "discover.applicationsClosed": "Applications for this shift have closed.",
    "discover.alreadyApplied": "You have already applied for this shift — see it under My shifts. Each worker can apply once per shift.",
    "discover.reapplyRefused": "That application couldn't be reopened. If the employer already turned it down, the shift isn't open to you again.",
    "discover.reapplyNote": "You applied for this shift before and it lapsed. Applying again replaces your old application.",
    "employer.reportNoShowBtn": "Report no-show",
    "employer.noShowReported": "Reported as no-show",
    "employer.noShowTitle": "Report a no-show?",
    "employer.noShowBody": "{name} was confirmed for this shift and never checked in. Only report this if they genuinely did not turn up.",
    "employer.noShowConsequence": "This costs the worker 25 reliability points \u2014 more than withdrawing would have \u2014 and employers see that score when choosing who to book. They will be told, and can dispute it. It cannot be undone.",
    "employer.noShowNoteLabel": "What happened? (optional)",
    "employer.noShowNotePlaceholder": "The worker will see this. A short note helps if they dispute it.",
    "employer.noShowConfirmBtn": "Report no-show",
    "employer.noShowReporting": "Reporting\u2026",
    "employer.noShowFailed": "Could not report the no-show: ",
    "issue.menuItem": "Report a problem",
    "issue.title": "Report a problem",
    "issue.subtitle": "Tell us what went wrong and we'll look into it. We're in early launch \u2014 reports like yours are how things get fixed quickly.",
    "issue.categoryLabel": "What kind of problem?",
    "issue.cat.bug": "Something is broken",
    "issue.cat.confusing": "Confusing to use",
    "issue.cat.missing": "Something is missing",
    "issue.cat.payment": "Payment",
    "issue.cat.account": "My account",
    "issue.cat.other": "Other",
    "issue.severityLabel": "How much is it blocking you?",
    "issue.sev.blocking": "Can't continue",
    "issue.sev.normal": "Annoying",
    "issue.sev.minor": "Minor",
    "issue.descriptionLabel": "What happened?",
    "issue.descriptionPlaceholder": "What were you trying to do, and what happened instead? If you saw an error message, paste it here.",
    "issue.contextNote": "We'll automatically include which page you were on ({page}) and your app version, so you don't have to describe it.",
    "issue.submitBtn": "Send report",
    "issue.sending": "Sending\u2026",
    "issue.thanks": "Thank you \u2014 your report was sent and will be investigated.",
    "issue.needDescription": "Please describe what happened.",
    "issue.failed": "Could not send the report: ",
    "withdraw.btn": "Withdraw from this shift",
    "withdraw.title": "Withdraw from this shift?",
    "withdraw.body": "You accepted \"{shift}\". Withdrawing frees your slot so the employer can fill it \u2014 the earlier you tell them, the easier that is.",
    "withdraw.noticeLabel": "You are giving about {hours} hours notice.",
    "withdraw.penaltyWarning": "This will cost you {points} reliability points. Employers see your reliability score when choosing who to book.",
    "withdraw.noPenalty": "That is enough notice that there is no reliability penalty.",
    "withdraw.reasonLabel": "Reason (optional)",
    "withdraw.reasonPlaceholder": "The employer will see this. A short reason helps them plan.",
    "withdraw.keepBtn": "Keep the shift",
    "withdraw.confirmBtn": "Withdraw",
    "withdraw.withdrawing": "Withdrawing\u2026",
    "withdraw.done": "You have withdrawn. The employer has been told and your slot is open again.",
    "withdraw.failed": "Could not withdraw: ",
    "reconfirm.heading": "The employer changed this shift",
    "reconfirm.body": "The {changed} changed after you signed. Your booking is on hold until you confirm you still want it on the new terms.",
    "reconfirm.cta": "Confirm new terms",
    "reconfirm.confirming": "Confirming\u2026",
    "reconfirm.done": "New terms confirmed \u2014 your booking is active again.",
    "reconfirm.failed": "Could not confirm. Please try again.",
    "reconfirm.deadline": "Please confirm by {deadline}.",
    "reconfirm.expired": "The deadline to confirm has passed. Contact the employer if you still want this shift.",
    // Employer-side view of the same state
    "employer.awaitingReconfirm": "Awaiting re-confirmation",
    "employer.awaitingReconfirmHint": "You changed this shift's terms after this worker signed. Their booking is on hold until they confirm.",
    "notification.markAllRead": "Mark all as read",
    "notification.clearRead": "Clear read",
    "notification.viewInbox": "Inbox",
    "notification.viewArchived": "Archived",
    "notification.emptyArchived": "Nothing archived yet.",
    "notification.archive": "Archive",
    "notification.restore": "Move back to inbox",
    "notification.empty": "No notifications yet",
    "notification.justNow": "Just now",
    "notification.minAgo": "{n}m ago",
    "notification.hourAgo": "{n}h ago",
    "notification.dayAgo": "{n}d ago",
    "filters.label": "Filters",
    "filters.hide": "Hide Filters",
    "discover.verifiedEmployerTooltip": "SSM-verified employer",
    "discover.viewEmployerRatings": "View this employer's ratings",
    "discover.welcomeBack": "Welcome back, {name}",
    "discover.subtitleLoggedIn": "Find shifts near you — set your own rate",
    "discover.browseHeading": "Browse open shifts",
    "landing.eyebrow": "Verified shift marketplace · Malaysia",
    "landing.headline1": "Work a shift.",
    "landing.headline2": "Get paid. No chasing.",
    "landing.subhead": "Part-time jobs, one-day gigs and short shifts across Malaysia. See the pay before you apply, set your own rate, and get paid once your hours are confirmed.",
    "landing.ctaFindShift": "Find a shift near you",
    "landing.ctaPostShift": "Post a shift as an employer",
    "landing.microFree": "Free to browse",
    "landing.microKyc": "ID-verified workers",
    "landing.microSsm": "SSM-verified employers",
    "landing.sectionPayTitle": "How do I know I'll get paid?",
    "landing.sectionPaySubtitle": "How your pay is agreed, recorded and settled",
    "landing.sectionTrustTitle": "Who am I working for?",
    "landing.sectionTrustSubtitle": "ID checks, registered employers, signed terms",
    "landing.sectionWorkerTitle": "How it works for workers",
    "landing.sectionWorkerSubtitle": "Find a shift, set your rate, get paid",
    "landing.sectionEmployerTitle": "Hiring instead?",
    "landing.sectionEmployerSubtitle": "How posting a shift works for employers",
    "landing.employerFreeTrial": "First 2 months free. The clock starts when you post your first shift, not when you sign up — and any shift posted while it is running stays free, even if it pays out later.",
    "landing.trustIdTitle": "Workers are ID-verified",
    "landing.trustIdBody": "MyKad or passport checked against a selfie before higher-paying shifts unlock.",
    "landing.trustSsmTitle": "Employers are business-verified",
    "landing.trustSsmBody": "Every employer's SSM registration is checked by our team before they can post a shift.",
    "landing.trustEscrowTitle": "Your rate is agreed in writing",
    "landing.trustEscrowBody": "You and the employer both sign a contract at the agreed rate before the shift. Your hours are confirmed in-app, and payouts are tracked against that contract.",
    "landing.trustDisputeTitle": "Disputes get a human",
    "landing.trustDisputeBody": "Disagree on hours or conditions? File a dispute in-app and our team reviews it — pay isn't just forfeited.",
    "landing.moneyStep1Title": "The rate is agreed in writing",
    "landing.moneyStep1Body": "You set your own rate when you apply. If the employer accepts, you both sign a contract carrying that rate and the hours — before the shift starts.",
    "landing.moneyStep1Status": "Agreed",
    "landing.moneyStep2Title": "Your hours are timestamped",
    "landing.moneyStep2Body": "You check in with a rotating code and check out with your real hours worked.",
    "landing.moneyStep2Status": "Recorded",
    "landing.moneyStep3Title": "Hours confirmed",
    "landing.moneyStep3Body": "The employer confirms your hours — or disputes them, which routes to our team instead of silence.",
    "landing.moneyStep3Status": "Confirmed",
    "landing.moneyStep4Title": "Paid out",
    "landing.moneyStep4Body": "The confirmed amount is paid to your verified bank account and recorded against the contract you signed.",
    "landing.moneyStep4Status": "Paid",
    "landing.sampleRateLabel": "Rate",
    "landing.sampleRateUnit": " / hr",
    "landing.sampleLengthLabel": "Shift length",
    "landing.sampleLengthUnit": " hrs",
    "landing.samplePayLabel": "Estimated pay",
    "landing.sampleEscrowNote": "RM 96.00 agreed in the contract, paid out once your hours are confirmed.",
    "landing.sampleSealLine1": "SSM",
    "landing.sampleSealLine2": "Verified",
    "landing.sampleSealLine3": "Employer",
    "landing.sampleFundedBadge": "Pay shown",
    "discover.filterCity": "City",
    "discover.anyCity": "Any city",
    "discover.filterAreaPlaceholder": "Area e.g. Bukit Bintang",
    "discover.filterDate": "Date",
    "discover.filterMaxDuration": "Max Duration (hrs)",
    "discover.filterJobType": "Job Type",
    "discover.allTypes": "All types",
    "discover.filterMinPay": "Min Pay (RM/hr)",
    "discover.filterMaxPay": "Max Pay (RM/hr)",
    "discover.filterStartsAfter": "Starts after",
    "discover.filterEndsBy": "Ends by",
    "discover.highBookingChance": "High booking chance",
    "discover.weekendsOnly": "Weekends only",
    "filters.clearAll": "Clear all",
    "discover.loadingShifts": "Loading shifts…",
    "discover.loadingShiftsHint": "Hang tight while we fetch open shifts.",
    "discover.noShiftsMatch": "No shifts match right now",
    "discover.noShiftsMatchHint": "Try widening your filters, or check back soon — new shifts are posted regularly.",
    "discover.noOpenShifts": "No open shifts right now",
    "discover.noOpenShiftsHint": "New shifts appear here as soon as employers post them. Check back soon.",
    "worker.checkinTitle": "Shift check-in",
    "worker.checkinCodeSubtitle": "Ask your employer for today's 6-digit check-in code and enter it below. The code changes every 30 seconds.",
    "worker.submitCheckin": "Check in",
    "worker.checkedInBadge": "Checked in",
    "worker.checkOutBtn": "Check Out",
    "worker.checkoutTitle": "Shift checkout",
    "worker.checkoutSubtitle": "Report the hours you actually worked. Your employer will confirm or dispute this before payout.",
    "worker.checkoutHoursLabel": "Hours worked",
    "worker.checkoutBreakLabel": "Break minutes (optional)",
    "worker.checkoutNoteLabel": "Note (optional)",
    "worker.submitCheckout": "Submit checkout",
    "worker.resubmitCheckout": "Resubmit hours",
    "worker.checkoutPendingBadge": "Checkout submitted — awaiting confirmation",
    "worker.hoursConfirmedBadge": "Hours confirmed",
    "worker.hoursDisputedBadge": "Employer disputed your hours",
    "worker.employerProposedLabel": "Employer proposed {hours}h",
    "worker.resubmitTitle": "Resubmit your hours",
    "worker.resubmitProposalHint": "Submitting rejects the employer's proposal and sends your hours instead. Add a note so they understand the difference.",
    "worker.acceptModificationBtn": "Accept",
    "worker.rejectModificationBtn": "Reject & resubmit hours",
    "employer.checkinCodeBtn": "Check-in code",
    "employer.checkinCodeTitle": "Worker check-in code",
    "employer.checkinCodeRotateHint": "Show this to workers at the venue. It changes every 30 seconds — read it fresh each time.",
    "employer.checkinCodeRefreshBtn": "Refresh now",
    "employer.reportedHoursPrefix": "Reported: ",
    "employer.hoursConfirmedLabel": "Hours confirmed",
    "employer.hoursDisputedLabel": "Hours disputed",
    "employer.confirmHoursBtn": "Confirm",
    "employer.disputeHoursBtn": "Dispute",
    "employer.disputeHoursPrompt": "Why are you disputing these hours? (optional)",
    "employer.disputeHoursPlaceholder": "Why are you disputing these hours? (optional)",
    "employer.modifyHoursBtn": "Decline & Modify",
    "employer.modifyHoursPlaceholder": "Hours worked",
    "employer.modifyHoursNotePlaceholder": "Why are you proposing a different number?",
    "employer.modifyHoursSubmitBtn": "Send proposal",
    "employer.hoursProposedPendingLabel": "You proposed {hours}h — waiting for the worker",
    "seo.homeTitle": "Part-Time & Short Shift Jobs in Malaysia | {brand}",
    "seo.homeDescription": "Find part-time jobs, one-day gigs and short shifts in Malaysia. See the pay before you apply, set your own rate, and get paid once your hours are confirmed.",
    "rating.commentPlaceholder": "Additional comments (optional)",
    "rating.commentPrivacyHint": "Only they can read this. It is not shown on their public profile.",
    "rating.feedbackReceivedTitle": "Comments you received",
    "shiftDetail.aboutEmployer": "About the employer",
    "employer.aboutCompanyTitle": "About your company",
    "employer.aboutCompanyHint": "A short introduction that workers see on your profile and on your shift pages before they apply.",
    "employer.aboutCompanyPlaceholder": "e.g. Family-run catering team in Bangsar. We run corporate dinners and weddings.",
    "employer.aboutCompanySaveBtn": "Save",
    "employer.aboutCompanySaved": "Company description saved",
    "employer.aboutCompanySaveFailed": "Could not save: ",
    "admin.rulingTitle": "Attendance ruling",
    "admin.rulingHint": "Settle the attendance record itself. This closes the dispute and notifies both sides.",
    "admin.rulingOutcomeLabel": "Outcome",
    "admin.rulingGrant": "Grant attendance and pay hours",
    "admin.rulingConfirmNoShow": "Confirm no-show",
    "admin.rulingReverseNoShow": "Reverse no-show (restore points)",
    "admin.rulingHoursLabel": "Hours to pay",
    "admin.rulingNoteLabel": "Note to both parties",
    "admin.rulingApplyBtn": "Apply ruling",
    "confirm.optional": "optional",
    "confirm.noteRequired": "Add a reason to continue.",
    "admin.confirmApproveKycTitle": "Approve {name} as {level}?",
    "admin.confirmApproveStandardBody": "They'll be able to apply to every shift.",
    "admin.confirmApproveAdvancedBody": "They'll also be able to apply to shifts that need extra documents. Only choose this if you've checked those documents.",
    "admin.confirmDocsNotOpened": "You haven't opened their documents yet.",
    "admin.confirmApproveBtn": "Approve",
    "admin.confirmRejectKycTitle": "Reject {name}'s ID check?",
    "admin.confirmRejectKycBody": "Their ID level goes back to Basic, so they can't apply for shifts until they send their documents again. They aren't told why.",
    "admin.confirmRejectBtn": "Reject",
    "admin.confirmVerifyEmployerTitle": "Verify {name}?",
    "admin.confirmVerifyEmployerBody": "They'll be able to post shifts straight away. Check the SSM number on ssm-einfo.my first.",
    "admin.confirmVerifyBtn": "Verify",
    "admin.confirmRejectEmployerTitle": "Reject {name}'s company registration?",
    "admin.confirmRejectEmployerBody": "They can't post shifts until they submit their registration again. They aren't told why.",
    "admin.confirmResolveTitle": "Close this dispute as resolved?",
    "admin.confirmResolveBody": "This only closes the case. It doesn't change attendance or pay. Use Investigate, then Apply ruling, for that.",
    "admin.confirmResolveNote": "Note for the record",
    "admin.confirmDismissTitle": "Dismiss this dispute?",
    "admin.confirmDismissBody": "The case closes with no change to attendance or pay.",
    "admin.confirmDismissNote": "Reason",
    "admin.confirmRulingTitle": "Apply this ruling?",
    "admin.confirmRulingGrant": "Records attendance with {hours} hours, which sets the worker's pay for this shift. The dispute closes and both sides are notified.",
    "admin.confirmRulingNoShow": "Confirms the no-show, so the worker isn't paid for this shift. The dispute closes and both sides are notified.",
    "admin.confirmRulingReverse": "Reverses the no-show and restores the worker's record. The dispute closes and both sides are notified.",
    "admin.confirmReleaseTitle": "Release {amount} to {name}?",
    "admin.confirmReleaseBody": "Marks this payout as paid. Only do this after the bank transfer has gone out. It can't be undone here.",
    "admin.confirmReleaseBtn": "Release",
    "admin.confirmHoldTitle": "Hold {amount} for {name}?",
    "admin.confirmHoldBody": "The payout stops until someone releases it.",
    "admin.confirmHoldNote": "Reason (saved to the payout log)",
    "admin.confirmHoldBtn": "Hold",
    "admin.payoutNoActions": "No actions",
    "admin.unnamedWorker": "Unnamed worker",
    "admin.reportStatusUnsaved": "Status change not saved yet",
    "admin.rulingApplied": "Ruling applied and dispute closed",
    "admin.disputeCheckedInBy": "Check-in method",
    "admin.disputeCheckedOutBy": "Check-out method",
    "admin.disputeNoShow": "No-show mark",
    "admin.disputeReportedHours": "Reported hours",
    "admin.method.code": "Rotating code",
    "admin.method.employer": "By employer",
    "admin.method.admin": "By admin",
    "admin.method.worker": "By worker",
    "attendance.employerNotCheckedIn": "Not checked in",
    "attendance.employerRequestCheckIn": "The worker says they attended and asks to be checked in",
    "attendance.employerCheckInBehalfBtn": "Check in on their behalf",
    "attendance.employerDeclineBtn": "Decline",
    "attendance.employerDeclineNotePlaceholder": "Reason (optional)",
    "attendance.employerConfirmDeclineBtn": "Decline request",
    "attendance.employerNotCheckedOut": "The worker has not checked out",
    "attendance.employerRequestCheckOut": "The worker missed check-out and asks you to submit their hours",
    "attendance.employerAwaitingCheckout": "Has not checked out yet — they have until {when}",
    "attendance.employerSubmitHoursBtn": "Submit hours for worker",
    "attendance.employerHoursPlaceholder": "Hours worked",
    "attendance.employerNotePlaceholder": "Note (optional)",
    "attendance.employerSubmitHoursHint": "The worker still has to accept these hours before they are paid.",
    "attendance.employerSubmitHoursConfirmBtn": "Send to worker",
    "attendance.employerOnBehalfPending": "You submitted {hours}h for the worker — waiting for them",
    "attendance.employerUndoNoShowBtn": "Undo no-show",
    "attendance.toastCheckedIn": "Worker checked in",
    "attendance.toastDeclined": "Request declined",
    "attendance.toastHoursSubmitted": "Hours sent to the worker",
    "attendance.toastNoShowUndone": "No-show report withdrawn",
    "employer.actionAttendance": "Resolve attendance ({count})",
    "attendance.requestTitle": "Message the employer",
    "attendance.requestCheckInIntro": "Tell the employer you attended. If they agree, they can check you in on your behalf.",
    "attendance.requestCheckOutIntro": "Tell the employer roughly how long you worked. They can submit your hours for you to accept.",
    "attendance.requestNotePlaceholder": "Add a note (optional)",
    "attendance.requestSendBtn": "Send request",
    "attendance.requestSent": "Request sent to the employer",
    "attendance.noShowTitle": "Reported as not attending",
    "attendance.noShowHint": "The employer says you did not attend. If you did, ask them to review it, or raise a dispute.",
    "attendance.missedCheckInTitle": "You missed check-in",
    "attendance.missedCheckInHint": "The shift has ended, so check-in is closed. If you attended, ask the employer to check you in.",
    "attendance.checkoutClosedTitle": "Check-out window closed",
    "attendance.checkoutClosedHint": "You had 48 hours after the shift to check out. Ask the employer to submit your hours for you.",
    "attendance.askCheckInBtn": "Ask employer to check me in",
    "attendance.askReviewBtn": "Ask employer to review",
    "attendance.askCheckoutBtn": "Ask employer to submit my hours",
    "attendance.requestPending": "Request sent — waiting for the employer",
    "attendance.requestDeclined": "The employer declined",
    "attendance.checkoutBy": "Check out by {when}",
    "worker.employerSubmittedLabel": "Employer submitted {hours}h for you",
    "employer.hoursAwaitingResubmit": "The worker rejected your proposal — waiting for their resubmitted hours",
    "hours.employerNoteLabel": "Note from the employer",
    "hours.yourNoteLabel": "Your note",
    "hours.workerNoteLabel": "Note from the worker",
    "employer.actionBidsToReview": "Review applicants ({count})",
    "employer.actionHoursToConfirm": "Confirm timesheets ({count})",
    "employer.actionToRate": "Rate workers ({count})",
    "employer.actionWaitingOnWorker": "Waiting on workers ({count})",
    "employer.needsYouTitle": "Needs you",
    "employer.needsYouAllCaughtUp": "You're all caught up.",
    "employer.needsYouOpenBtn": "Open shift",
    "employer.toastHoursModifyProposed": "Proposal sent to the worker.",
    "employer.toastModifyHoursFailed": "Failed to send proposal: ",
    "employer.toastHoursConfirmed": "Hours confirmed.",
    "employer.toastHoursDisputed": "Hours disputed. The worker has been notified to resubmit.",
    "employer.toastConfirmHoursFailed": "Could not confirm hours: ",
    "employer.toastDisputeHoursFailed": "Could not dispute hours: ",
    "shiftDetail.rateHelperText": "Scroll to choose your rate",
    "myBids.signInTitle": "Sign in to view your shifts",
    "myBids.signInHint": "Track the shifts you've applied to and their status once you're signed in.",
    "myBids.backToBids": "Back to My shifts",
    "earnings.signInTitle": "Sign in to view earnings",
    "earnings.signInHint": "Track your payouts, internal settlement status, and bank verification once you're signed in.",
    "toast.confirmOfferFailed": "Failed to confirm: ",
    "toast.shiftConfirmed": "Shift confirmed! Sign the contract to finish.",
    "toast.declineOfferFailed": "Failed to decline: ",
    "toast.offerDeclined": "Offer declined.",
    "toast.cancelBidFailed": "Failed to cancel application: ",
    "toast.bidCancelled": "Application cancelled.",
    "toast.disputeFiled": "Dispute filed. Our team will review it shortly.",
    "toast.pushEnabled": "Push notifications are on.",
    "toast.pushDisabled": "Push notifications are off for this device.",
    "toast.pushDenied": "Notifications are blocked for this site — allow them in your browser settings to turn this on.",
    "toast.pushFailed": "Couldn't turn on notifications. Try again in a moment.",
    "toast.disputeFiledFailed": "Failed to file dispute: ",
    "employer.fieldShiftTitle": "Shift title",
    "employer.shiftTitlePlaceholder": "e.g. F&B Server – Corporate Dinner",
    "employer.fieldJobDescription": "Job description",
    "employer.jobDescriptionPlaceholder": "Describe the role, responsibilities, and what a good day looks like…",
    "employer.labelCategory": "Category",
    "employer.labelLocation": "Location",
    "employer.locationHint": "Can't find it in the suggestions? You can type any area or landmark name — it doesn't need to match a suggestion.",
    "employer.addressVisibilityLabel": "Address visibility",
    "employer.addressVisibilityPublic": "Show full address on listing",
    "employer.addressVisibilityPrivate": "Reveal only to accepted workers",
    "employer.labelDate": "Date",
    "employer.labelHeadcount": "Headcount",
    "employer.fieldStartTime": "Start time",
    "employer.fieldEndTime": "End time",
    "employer.labelSchedule": "Schedule",
    "employer.multiDayCheckbox": "This job runs on more than one day",
    "employer.addAnotherDay": "Add another day",
    "employer.removeDay": "Remove this day",
    "employer.scheduleHint": "Add every day this job runs — each day can have its own start and end time. Applicants commit to all of them as one job.",
    "employer.wageRangeLabel": "Wage Range (RM/hour)",
    "employer.wageMinPlaceholder": "Min e.g. 12",
    "employer.wageMaxPlaceholder": "Max e.g. 16",
    "employer.bidCapHint": "Workers can ask up to RM{amount}/h (150% of max)",
    "employer.offerTransportAllowance": "Offer a transport allowance",
    "employer.transportAllowanceHint": "Optional flat amount (RM) paid on top of hourly wage to help cover workers' travel costs.",
    "employer.nextRequirements": "Next: Requirements →",
    "employer.labelDressCode": "Dress code",
    "employer.dressCodePlaceholder": "e.g. All black formal",
    "employer.requiredDocumentsLabel": "Required documents",
    "employer.docIcPassport": "IC / Passport",
    "employer.docFoodHandler": "Food Handler Certificate",
    "employer.docFirstAid": "First Aid Certification",
    "employer.docDrivingLicense": "Driving License",
    "employer.labelLanguageRequirements": "Language Requirements",
    "employer.specialRequirementsLabel": "Special requirements",
    "employer.specialRequirementsPlaceholder": "Any additional requirements…",
    "employer.nextReview": "Next: Review →",
    "employer.reviewYourShift": "Review your shift",
    "employer.reviewLabelTitle": "Title",
    "employer.reviewNotSet": "(not set)",
    "employer.reviewLabelWageRange": "Wage range",
    "employer.reviewLabelTransportAllowance": "Transport allowance",
    "employer.reviewLabelLanguages": "Languages Required",
    "employer.transportNotOffered": "Not offered",
    "employer.dressCodeNone": "None",
    "employer.estimatedReserveLabel": "Estimated amount to reserve",
    "employer.estimatedReserveFormula": "wage_max × headcount × shift hours + {feePct}% platform fee",
    "employer.estimatedReserveFormulaNoFee": "wage_max × headcount × shift hours — no platform fee during launch",
    "employer.feeTrialActive": "Free until {date} — no platform fee on shifts you post before then, even when they pay out later.",
    "employer.tagline": "Employer Console",
    "employer.openMenu": "Open menu",
    "employer.paidToWorkers": "Paid to Workers",
    "employer.topUpBtn": "Add funds",
    "employer.returnToWorkerApp": "Return to Worker App",
    "employer.manageShiftsSubtitle": "Manage all your posted shifts",
    "employer.loadingShifts": "Loading shifts…",
    "employer.loadingShiftsHint": "Hang tight while we fetch your shifts.",
    "employer.noActiveShifts": "No active shifts",
    "employer.noActiveShiftsHint": "Post a shift to start hiring workers.",
    "employer.noShiftsPostedYet": "No shifts posted yet",
    "employer.noShiftsPostedYetHint": "Post your first shift to start hiring workers.",
    "employer.backToShifts": "Back to shifts",
    "employer.listCardPositionsNeeded": "Positions needed: {count}",
    "employer.listCardPositionsBadge": "Positions {count}",
    "employer.listCardAppliedBadge": "Applied {count}",
    "employer.listCardFilled": "Filled: {count}",
    "employer.listCardCategory": "Category: {category}",
    "employer.listCardLanguages": "Languages: {languages}",
    "employer.toastLoadShiftFailed": "Could not load shift for editing.",
    "employer.confirmCancelShift": "Cancel \"{title}\"? All applicants will be notified.",
    "employer.cancellationOutcomesTitle": "Cancellation outcomes",
    "employer.cancellationAwaitingChoice": "Awaiting choice",
    "employer.cancellationTook50": "Took 50% payout",
    "employer.cancellationShowedUp100": "Showed up — 100% paid",
    "employer.cancellationAwaitingProofEmployer": "Chose to show up — awaiting proof",
    "employer.toastCancelShiftFailed": "Failed to cancel shift: ",
    "employer.toastShiftCancelled": "Shift cancelled. Applicants have been notified.",
    "employer.statAppliedUsers": "Applied users",
    "employer.statSlotsFilled": "Slots filled",
    "employer.statEstBudget": "Est. budget (max)",
    "employer.statEstBudgetTooltip": "Max hourly wage × total shift hours × headcount, plus {feePct}% platform fee. Your actual cost may be lower if accepted rates are below max wage.",
    "employer.statEstBudgetTooltipNoFee": "Max hourly wage × total shift hours × headcount. No platform fee on this shift. Your actual cost may be lower if accepted rates are below max wage.",
    "employer.listCardEstBudget": "RM{amount} est. budget",
    "employer.statAvgBid": "Average asked rate",
    "employer.statAvgBidTooltip": "Average hourly rate asked for in all applications to this shift so far.",
    "employer.positionsOpenHint": "{open} of {total} position{plural} still open.",
    "employer.appliedBadge": "{count} applied",
    "employer.selectMultiple": "Select multiple",
    "employer.selectedOfTotal": "{selected} / {total} selected",
    "employer.sendingOffer": "Sending…",
    "employer.offerToWorkers": "Send offer to {count} worker{plural}",
    "employer.loadingApplicants": "Loading applicants…",
    "employer.loadingApplicantsHint": "Hang tight while we fetch applicants.",
    "employer.noApplicantsYet": "No applicants yet",
    "employer.noApplicantsHint": "Applicants will appear here once workers apply for this shift.",
    "employer.colWorker": "Worker",
    "employer.colKYC": "KYC",
    "employer.colReliability": "Reliability",
    "employer.colRating": "Rating",
    "employer.colBidRate": "Rate (RM/h)",
    "employer.colStatus": "Status",
    "employer.colAction": "Action",
    "employer.shiftsDoneSuffix": "shift{plural} done",
    "employer.awaitingResponse": "Offer sent",
    "employer.shortlistBtn": "Shortlist",
    "employer.selectBtn": "Send offer",
    "employer.waitingOnWorker": "Waiting on worker",
    "employer.confirmedStatus": "Confirmed",
    "employer.notSelected": "Not selected",
    "employer.offerExpiredStatus": "Offer expired",
    "employer.pillPending": "Pending",
    "employer.pillShortlisted": "Shortlisted",
    "employer.pillAccepted": "Accepted",
    "employer.pillCheckedIn": "Checked In",
    "employer.pillNotSelected": "Not selected",
    "employer.pillOfferExpired": "Offer expired",
    "employer.pillWithdrawn": "Withdrawn",
    "toast.offerSentMultiple": "Offer sent to {count} workers.",
    "toast.offerSentSingle": "Offer sent — waiting for the worker to confirm.",
    "toast.tooManySelected": "Only {open} position{plural} still open — select {open} or fewer.",
    "employer.bulkUploadCsvHeading": "Upload your shifts CSV",
    "employer.bulkStatusReady": "Ready",
    "employer.bulkStatusNeedsFix": "Needs fix",
    "employer.bulkStatusPublished": "Published",
    "employer.bulkStatusFailed": "Failed",
    "employer.bulkColTitle": "Title",
    "employer.bulkColCategory": "Category",
    "employer.bulkColDate": "Date",
    "employer.bulkColStart": "Start",
    "employer.bulkColEnd": "End",
    "employer.bulkColMinWage": "Min RM/h",
    "employer.bulkColMaxWage": "Max RM/h",
    "employer.bulkColHeadcount": "Headcount",
    "employer.bulkColLocation": "Location",
    "employer.bulkColDressCode": "Dress code",
    "employer.bulkColTransport": "Transport (RM)",
    "employer.bulkColVisibility": "Address visibility",
    "employer.bulkColLanguages": "Languages",
    "employer.bulkColSpecialReq": "Special requirements",
    "employer.bulkColGroupId": "Group ID",
    "employer.bulkGuideToggle": "CSV format guide",
    "employer.bulkGuideIntro": "The uploader matches columns by name, so header wording is flexible (e.g. \"Start\" works for \"Start Time\") — this is the exact format, and the downloaded template already follows it.",
    "employer.bulkGuideRequired": "Required: Title, Date (YYYY-MM-DD), Start Time (HH:MM), End Time (HH:MM).",
    "employer.bulkGuideCategory": "Category must exactly match one of: F&B, Retail, Event, Promotion, Warehouse, Office, Security, Production, Market Research, Student, Logistics, Other.",
    "employer.bulkGuideOptional": "Optional: Description, Location, Dress Code, Min Wage, Max Wage (RM/hour), Headcount, Transport Allowance (RM), Address Visibility (Public or Accepted Only), Language Requirements (comma-separated, e.g. \"English, Bahasa Melayu\"), Special Requirements — same fields as posting a shift one by one.",
    "employer.bulkGuideMultiDay": "Multi-day shifts: give every day the same Group ID and one row per day. Only the first row of the group needs the other columns filled in — continuation rows just need Date, Start Time, and End Time.",
    "employer.bulkSelectCategoryPlaceholder": "— Select —",
    "employer.bulkRetry": "Retry",
    "employer.bulkUntitled": "(untitled)",
    "settings.bankingSignInTitle": "Sign in to manage banking",
    "settings.bankingSignInHint": "Add and verify your bank details for salary payouts after signing in.",
    "settings.accountHolderPlaceholder": "As per bank account",
    "settings.accountNumberPlaceholder": "Enter bank account number",
    "settings.secureSignPending": "SecureSign pending",
    "settings.accessOtherConsoles": "Access other consoles",
    "settings.accessOtherConsolesHint": "These are hidden from the main app and can only be opened here.",
    "settings.openEmployerConsole": "Open Employer Console",
    "settings.openAdminDashboard": "Open Admin Dashboard",
    "employer.companyDetailsTitle": "Company Details",
    "employer.profilePhotoTitle": "Profile photo",
    "employer.profilePhotoHint": "A company logo or a clear photo of the hiring contact. Workers see this next to your name when they open one of your shifts.",
    "employer.noRatingsHint": "Ratings from workers will appear here once shifts you post are completed.",
    "employer.personalDetailsHint": "Your own contact and identity details as the hiring contact — separate from your company's registration above.",
    "employer.viewContractBtn": "View contract",
    "employer.viewWorkerProfileHint": "View worker profile",
    "employer.contractSignaturesHeading": "Signatures",
    "employer.contractSignedOnPrefix": "signed on ",
    "employer.contractNotSignedYet": "not signed yet",
    "employer.contractAwaitingWorker": "The worker has not signed this contract yet.",
    "employer.profileHistoryTitle": "History with your company",
    "employer.profileNoHistory": "No previous applications to your shifts.",
    "employer.historyCompleted": "completed",
    "employer.shiftStatusOpen": "Open",
    "employer.shiftStatusClosed": "Closed",
    "employer.shiftStatusCompleted": "Completed",
    "employer.shiftStatusCancelled": "Cancelled",
    "employer.shiftStatusFilled": "Filled",
    "employer.shiftStatusDraft": "Draft",
    "employer.profileHistoryScopeNote": "For privacy, this only shows the worker's history with your own shifts, verified KYC level, and platform-wide reliability/rating scores.",
    "employer.verifiedBadge": "Verified",
    "employer.verifiedBadgeTitle": "SSM verification approved — you can post shifts.",
    "employer.applicantVerifiedTitle": "KYC verified — this worker has completed identity verification.",
    "employer.companyNameLabel": "Company name",
    "employer.companyNamePlaceholder": "e.g. Grand Hyatt Kuala Lumpur",
    "employer.ssmNumberLabel": "SSM registration number",
    "employer.ssmNumberPlaceholder": "e.g. 1234567-A",
    "auth.fieldSsmNumber": "SSM registration number *",
    "auth.ssmFormatHint": "Enter a valid SSM number (12 digits, or up to 8 digits with a letter suffix).",
    "employer.ssmCertLabel": "SSM certificate (recommended)",
    "employer.ssmCertHint": "Upload your SSM registration certificate (image or PDF). Our team compares it with the official registry during review — submissions with a certificate are verified faster.",
    "employer.ssmCertOnFile": "Certificate on file — uploading a new one replaces it for review.",
    "employer.ssmCertUploadFailed": "Certificate upload failed: ",
    "employer.postShiftUnverifiedHint": "Posting is locked until your company is verified. Submit your SSM number (and ideally your SSM certificate) under Account → Company Details, then wait for admin review — you'll be notified once verified.",
    "auth.employerVerifyNote": "Your company details will be reviewed by our team. You can sign in right away, but posting shifts unlocks once verification is complete.",
    "employer.verifyPendingTitle": "Verification pending",
    "employer.verifyPendingBody": "Your SSM registration is under review. This usually takes 1-2 business days.",
    "employer.verifyRejectedTitle": "Verification rejected",
    "employer.verifyRejectedBody": "We couldn't verify your SSM registration. Please update your company details and contact support.",
    "employer.verifyUnverifiedBody": "Submit your SSM registration number to unlock shift posting.",
    "employer.verifyWorkflowSteps": "Submit SSM number → Admin review → Verified → Post shifts",
    "employer.postingLockedToast": "Verify your company details before posting shifts.",
    "employer.contactEmailLabel": "Contact email",
    "employer.bankingSectionTitle": "Employer Banking (Salary Funding)",
    "employer.bankingSectionHint": "Funding account must be verified through SecureSign before payouts can move to ready state.",
    "employer.accountHolderPlaceholder": "Company account holder",
    "employer.accountNumberPlaceholder": "Employer funding account",
    "employer.fundingReadyLabel": "Funding account has sufficient balance for this cycle",
    "employer.walletTitle": "Your deposit balance",
    "employer.walletAvailable": "Available",
    "employer.walletHeld": "Held for booked shifts",
    "employer.walletHeldHint": "When you offer a shift, the full agreed wage is set aside so the worker's pay is committed, not just promised. It is released if the offer is declined or the shift is called off in time.",
    "employer.walletWarnOnlyNote": "Deposits are not required yet — you can still hire with a zero balance. We will tell you well before that changes.",
    "employer.walletShortfallWarning": "Heads up: your deposit balance is RM{amount} short of covering the wages for this offer. Nothing is blocked yet.",
    "employer.walletHistoryTitle": "Deposit activity",
    "category.F&B": "F&B",
    "category.Retail": "Retail",
    "category.Event": "Event",
    "category.Promotion": "Promotion",
    "category.Warehouse": "Warehouse",
    "category.Office": "Office",
    "category.Security": "Security",
    "category.Production": "Production",
    "category.Market Research": "Market Research",
    "category.Student": "Student",
    "category.Logistics": "Logistics",
    "category.Other": "Other",
    "category.all": "All",
    "discover.perHour": "/hour",
    "discover.posApplied": "{headcount} pos\n{applied} applied",
    "earnings.bankStatusPending": "Pending",
    "earnings.bankStatusVerified": "Verified",
    "earnings.bankStatusRejected": "Rejected",
    "form.locationPlaceholder": "e.g. KLCC, Kuala Lumpur",
    "employer.walletHistoryHint": "Each line is one movement. The available and held figures above are worked out from these, never stored as a number of their own.",
    "employer.walletHistoryEmpty": "No deposit activity yet.",
    "employer.walletHistoryError": "Couldn't load your deposit activity just now. Your balance and history are unaffected — try again in a moment.",
    "employer.walletHistoryTruncated": "Showing the {n} most recent movements.",
    "employer.walletHistoryShiftGone": "Shift no longer listed",
    "employer.walletKind.topup": "Added",
    "employer.walletKind.hold": "Set aside",
    "employer.walletKind.release": "Returned",
    "employer.walletKind.capture": "Paid to worker",
    "employer.walletKind.refund": "Refunded",
    "employer.walletKind.fee": "Platform fee",
    "employer.verificationLabel": "Verification",
    "employer.outgoingObligationsTitle": "Outgoing Salary Obligations",
    "employer.noPayoutObligations": "No payout obligations yet for this employer account.",
    "payout.holdReasonNotCheckedIn": "On hold — worker did not check in for this shift.",
    "payout.holdReasonHoursDisputed": "On hold — employer disputed the worker's reported hours.",
    "payout.holdReasonWorkerBanking": "On hold — worker's banking details are not yet verified.",
    "payout.holdReasonEmployerBanking": "On hold — employer's funding account is not verified or not funded.",
    "payout.holdReasonGeneric": "On hold — contact support for details.",
    "employer.savedAccountPrefix": "Saved account: ••••",
    "employer.tbaShort": "TBA",
    "employer.pendingPayout": "Pending payout",
    "employer.pendingPayoutTooltip": "Funds committed for shifts that are queued, ready, or held — not yet released to workers.",
    "employer.totalPaidOut": "Total paid out",
    "employer.totalPaidOutTooltip": "Funds already released to workers for completed, confirmed shifts.",
    "employer.escrowUnavailableNote": "There's no online payment yet — FPX/DuitNow is still to come. During the pilot we set deposits up directly: get in touch and we'll arrange the transfer and credit it to your balance.",
    "employer.addFundsBtn": "+ Add funds",
    "employer.payoutLedgerTitle": "Payout Ledger",
    "employer.colDateShort": "Date",
    "employer.colAmount": "Amount",
    "auth.oauthDivider": "or",
    "auth.oauthConnector": "{label} with {provider}",
    "auth.iWantTo": "I want to…",
    "auth.roleWorkerTitle": "Find shift work",
    "auth.roleWorkerHint": "Browse and apply for shifts",
    "auth.roleEmployerTitle": "Hire workers",
    "auth.roleEmployerHint": "Post shifts and manage applicants",
    "auth.socialSignupHint": "Signing up with Google, Apple, or Facebook creates your account instantly. You'll be asked to complete identity (KYC) verification afterwards to start working.",
    "auth.tncAgreeText": "I have read and agree to the",
    "auth.tncLinkText": "Terms & Conditions and Privacy Notice",
    "auth.tncSuffixText": ", including the collection and use of my identity document (MyKad/passport) for employment verification purposes.",
    "auth.tncScrollHint": "Open and scroll the Terms & Conditions to the end to enable this checkbox.",
    "auth.tncGateTitle": "Before you continue",
    "auth.tncGateSubtitle": "Please read and accept our Terms & Conditions and Privacy Notice to keep using {brand}.",
    "auth.tncGateAcceptBtn": "I agree — Continue",
    "auth.quickSignupHint": "That's all we need to get started — we'll ask for your name and other details right after you sign up.",
    "details.title": "Complete your details",
    "details.subtitleWorker": "Just a few details before you can start applying for shifts. This is required to work legally under Malaysian law.",
    "details.subtitleEmployer": "Just a few details before you can start posting shifts.",
    "details.companyContactName": "Company / contact name",
    "details.companyNameFinalHint": "This is the company name shown to workers on shift listings. Once confirmed, it cannot be changed — contact customer support if it needs correction.",
    "details.avatarTitle": "Profile photo",
    "details.avatarOptionalHint": "Optional, but employers see this when reviewing applicants — a real, clear photo helps your application stand out.",
    "details.avatarChooseBtn": "Choose photo",
    "details.avatarChangeBtn": "Change photo",
    "details.avatarUploadFailed": "Photo upload failed (saving the rest of your details anyway): ",
    "details.avatarGuide1Worker": "Show your own face clearly, looking at the camera",
    "details.avatarGuide2Worker": "Good lighting, no sunglasses or face covering",
    "details.avatarGuide3Worker": "No group photos, cartoons, memes, or logos",
    "details.avatarGuide4Worker": "A square, front-facing photo fits the circle guide best",
    "details.avatarGuide1Employer": "A company logo or a clear photo of the hiring contact",
    "details.avatarGuide2Employer": "No memes, unrelated images, or blurry photos",
    "details.fullNameFinalHint": "Enter your legal name exactly as it appears on your MyKad/passport. Once confirmed, it cannot be changed — contact customer support if it needs correction.",
    "details.ssmOptional": "SSM registration number (optional)",
    "details.kycDeferHint": "Optional for now — you can upload your identity documents later from your Profile tab. Verified workers stand out to employers.",
    "details.kycOnlyTitle": "Complete identity verification",
    "details.kycOnlySubtitle": "Upload your identity documents to get verified.",
    "details.kycOnlyHint": "All three are needed for verification: document front, back, and a clear selfie.",
    "details.kycUploadedToast": "Documents uploaded! Our team will review them shortly.",
    "details.saveBtn": "Save & continue",
    "details.saveFailed": "Could not save details: ",
    "intro.title": "Welcome to {brand}!",
    "intro.subtitle": "Here's how it works:",
    "intro.workerStep1": "Browse open shifts on the Discover tab — filter by category, date, and pay.",
    "intro.workerStep2": "Apply for the shifts you want, with your own hourly rate.",
    "intro.workerStep3": "If the employer sends you an offer, confirm it and sign the digital contract.",
    "intro.workerStep4": "Show up, work the shift, and track your earnings in the Earnings tab.",
    "intro.workerStep5": "About getting paid: the employer's funds are committed before the shift starts, and your pay is released as soon as your hours are confirmed. If hours are ever disputed, it goes to our team rather than nowhere.",
    "intro.employerStep1": "Post a shift with the role, schedule, and wage range.",
    "intro.employerStep2": "Review applicants as workers apply — see their ratings and reliability.",
    "intro.employerStep3": "Send offers to the workers you want; they confirm and sign the digital contract.",
    "intro.employerStep4": "Chat with confirmed workers and manage everything from your dashboard.",
    "intro.employerStep5": "About paying: wages are committed up front and released once you confirm the hours worked, so workers can see their pay is real before they turn up.",
    "intro.helpHint": "You can find this again anytime under Help in the account menu.",
    "intro.getStartedBtn": "Get started",
    "toast.backAgainToExit": "Swipe again to exit",
    "profile.completeKycTitle": "Complete identity verification",
    "profile.completeKycHint": "You haven't uploaded your identity documents yet. Verified workers are more likely to be selected by employers.",
    "profile.completeKycBtn": "Upload documents",
    "auth.selectShort": "Select",
    "auth.selectCountry": "Select country",
    "auth.searchCountryPlaceholder": "Search by name or code...",
    "auth.enterYourPassword": "Enter your password",
    "contract.workerTitle": "Your Employment Contract",
    "contract.readCarefully": "Please read carefully before signing.",
    "contract.agreementHeading": "{brand} Platform — Shift Work Agreement",
    "contract.printBtn": "Print / Save as PDF",
    "contract.viewContractBtn": "View contract",
    "toast.popupBlocked": "Pop-up blocked — please allow pop-ups for {brand} to print the contract.",
    "contract.employerLabel": "Employer:",
    "contract.workerLabel": "Worker:",
    "contract.youLabel": "You",
    "contract.roleLabel": "Role:",
    "contract.dateLabel": "Date:",
    "contract.agreedWageLabel": "Agreed wage:",
    "contract.agreeToTermsHeading": "By signing you agree to:",
    "contract.workerClause1": "Attend the shift punctually and perform the assigned duties.",
    "contract.workerClause2": "Accept the agreed wage as full payment for hours worked.",
    "contract.workerClause3": "Notify the employer promptly if you are unable to attend.",
    "contract.workerClause4": "Comply with the employer's workplace rules and safety requirements.",
    "contract.workerClause5": "This is a casual short-term engagement. You are responsible for declaring your own income tax to LHDN if applicable.",
    "contract.workerClause6": "{brand} acts as a marketplace intermediary and is not your employer.",
    "contract.workerClause7": "Governed by Malaysian law including the Employment Act 1955.",
    "contract.workerClause8": "I confirm that I am in good health and fit to attend and perform this shift on the scheduled date (binding confirmation).",
    "contract.cancellationTitle": "Cancellation Payout Contract",
    "contract.cancellationHeading": "{brand} Platform — Shift Cancellation Agreement",
    "contract.cancellationClause1": "The employer cancelled this shift less than 24 hours before it was due to start.",
    "contract.cancellationClause2": "By signing, you accept a one-time payout of 50% of your agreed wage for this shift, and release the employer from any further obligation for it.",
    "contract.cancellationClause3": "You will not attend the shift location for this engagement.",
    "contract.cancellationClause4": "This payout is processed the same way as your other {brand} earnings — see your Earnings tab for status.",
    "contract.signBtn": "I have read and agree — Sign",
    "contract.employerTitle": "Employment Contract",
    "contract.employerSubtitle": "Auto-generated when an application is accepted. Both parties must sign.",
    "contract.enteredBetween": "This agreement is entered into between:",
    "contract.employerOnFile": "(your business name on file)",
    "contract.shiftDetailsHeading": "Shift Details:",
    "contract.locationLabel": "Location:",
    "contract.timeLabel": "Time:",
    "contract.termsHeading": "Terms:",
    "contract.employerClause1": "This is a short-term casual engagement and does not constitute permanent employment.",
    "contract.employerClause2": "The employer will pay the agreed wage rate for all hours worked, no less than the Malaysian minimum wage of RM8.72/hr.",
    "contract.employerClause3": "The employer is responsible for EPF, SOCSO, and EIS contributions as required by Malaysian law.",
    "contract.employerClause4": "The worker agrees to attend the shift punctually and perform the duties as described.",
    "contract.employerClause5": "Either party may cancel with reasonable notice. Last-minute cancellation may result in platform penalties.",
    "contract.employerClause6": "{brand} acts as a marketplace intermediary and is not the employer in this arrangement.",
    "contract.employerClause7": "This agreement is governed by Malaysian law including the Employment Act 1955 and Gig Workers Act 2025.",
    "contract.contractRefLabel": "Contract ref:",
    "contract.generatedOnLabel": "Generated on:",
    "contract.categoryLabel": "Category:",
    "contract.scheduleLabel": "Schedule:",
    "contract.totalHoursLabel": "Total contracted hours:",
    "contract.dressCodeLabel": "Dress code:",
    "contract.languagesLabel": "Language requirements:",
    "contract.transportAllowanceLabel": "Transport allowance:",
    "contract.estimatedTotalPayLabel": "Estimated total pay:",
    "contract.jobDescriptionLabel": "Job description:",
    "contract.notSpecified": "Not specified",
    "contract.sectionParties": "Parties",
    "contract.sectionEngagement": "Engagement Details",
    "contract.sectionRemuneration": "Remuneration",
    "contract.sectionAttendance": "Attendance & Hours",
    "contract.sectionCancellation": "Cancellation & No-Show",
    "contract.sectionHealthSafety": "Health & Safety",
    "contract.sectionDataPrivacy": "Data Privacy",
    "contract.sectionDisputes": "Disputes",
    "contract.sectionPlatformRole": "Platform Role",
    "contract.sectionGoverningLaw": "Governing Law",
    "contract.paymentTimingText": "Payment is processed together with the worker's other {brand} earnings for the month, on the 15th (or nearest business day) of the month following the shift.",
    "contract.clauseAttendance": "The worker must check in via the {brand} app's rotating code at the start of the shift, and submit the actual hours worked at checkout. The employer confirms or disputes the reported hours before payout.",
    "contract.clauseCancellationNoShow": "A worker who does not check in for a shift they are contracted for forfeits pay for that shift and may see their reliability score affected.",
    "contract.clauseCancellationLateByEmployer": "If the employer cancels the shift less than 24 hours before it is due to start, the worker may choose a one-time payout of 50% of the agreed wage, or show up in person and receive the full agreed wage.",
    "contract.clauseCancellationMutual": "Outside of the above, either party may cancel with reasonable notice given through the app.",
    "contract.clauseHealthSafety": "Both parties must comply with the Occupational Safety and Health Act 1994 and any workplace-specific safety rules communicated by the employer.",
    "contract.clauseDataPrivacy": "Personal data collected for this shift (contact details, identity verification level) is shared only as needed to coordinate the engagement, and is otherwise handled per {brand}'s privacy policy.",
    "contract.clauseDisputes": "Either party may file a dispute in the {brand} app after the shift is completed. {brand} may review and mediate but is not a party to the underlying employment relationship.",
    "contract.confirmSendNote": "By clicking \"Confirm & Send to Worker\", you agree to these terms and the contract will be sent to {name} for their signature.",
    "contract.confirmSendBtn": "Confirm & Send to Worker",
    "auth.showPassword": "Show password",
    "auth.hidePassword": "Hide password",
    "auth.fullNamePlaceholder": "e.g. Nurul Ain Hassan",
    "discover.filterMaxDurationPlaceholder": "e.g. 8",
    "discover.filterMinPayPlaceholder": "e.g. 10",
    "discover.filterMaxPayPlaceholder": "e.g. 25",
    "employer.transportAllowancePlaceholder": "e.g. 10",
    "app.tagline": "Verified shift marketplace",
    "app.homeAriaLabel": "{brand} home — go to Discover",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.ariaLabel": "Theme: {mode}. Click to change.",
    "theme.title": "Theme: {mode}",
    "admin.accessRequiredTitle": "Admin access required",
    "admin.notAdminHint": "Your account is not an administrator.",
    "admin.signInHint": "Sign in with an administrator account to continue.",
    "admin.backToWorkerApp": "Back to Worker App",
    "footer.quickLinks": "Quick Links",
    "footer.categories": "Job Categories",
    "footer.rightsReserved": "All rights reserved.",
  },
    };

export const MALAYSIAN_BANK_OPTIONS = [
  "Maybank",
  "CIMB",
  "Public Bank",
  "RHB",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "Bank Rakyat",
  "OCBC",
  "HSBC",
  "UOB",
];

// Hierarchical city → region mapping for location filtering.
// Keys are the canonical city names shown in the dropdown.
// Values list all sub-areas / landmarks that belong to that city.
// Matching is case-insensitive substring, so "KLCC" matches "KLCC, KL City Centre".
const CITY_REGIONS = {
  "Kuala Lumpur": [
    "kuala lumpur", "kl", "klcc", "kl city centre", "city centre",
    "bukit bintang", "chow kit", "titiwangsa", "sentul", "kepong",
    "wangsa maju", "setapak", "gombak", "batu caves", "segambut",
    "bangsar", "bangsar south", "mid valley", "pantai", "pandan",
    "ampang", "pandan indah", "pandan jaya", "ulu klang",
    "cheras", "taman connaught", "taman maluri",
    "desa petaling", "bukit jalil", "sri petaling",
    "taman tun dr ismail", "ttdi", "damansara",
    "mont kiara", "hartamas", "duta", "jalan ipoh",
    "stadium merdeka", "merdeka", "masjid india", "brickfields",
    "pudu", "imbi", "jalan raja laut", "pusat bandar",
  ],
  "Petaling Jaya": [
    "petaling jaya", "pj", "ss2", "ss3", "ss7", "damansara jaya",
    "damansara utama", "uptown", "kelana jaya", "sea park",
    "taman jaya", "ara damansara", "sunway", "bandar sunway",
    "kota damansara", "mutiara damansara", "one utama", "1 utama",
    "bandar utama", "puchong", "subang",
  ],
  "Subang Jaya": [
    "subang jaya", "subang", "ss15", "ss16", "ss18", "uep subang",
    "empire subang", "usj", "taipan", "sunway pyramid",
  ],
  "Shah Alam": [
    "shah alam", "section 14", "section 7", "section 13",
    "bukit raja", "i-city", "alam megah", "kota kemuning",
    "banting", "meru", "klang", "port klang",
  ],
  "Klang": [
    "klang", "port klang", "port swettenham", "meru klang",
    "bukit tinggi", "bandar botanik", "kapar",
  ],
  "Cheras": [
    "cheras", "taman connaught", "taman miharja", "taman mulia",
    "taman segar", "alam damai", "balakong", "kajang",
  ],
  "Kajang": [
    "kajang", "semenyih", "bangi", "nilai", "seremban",
    "bandar baru bangi", "presint bangi",
  ],
  "Putrajaya": [
    "putrajaya", "cyberjaya", "presint",
  ],
  "Penang": [
    "penang", "pulau pinang", "george town", "georgetown",
    "batu ferringhi", "tanjung bungah", "air itam", "gelugor",
    "bukit mertajam", "butterworth", "nibong tebal", "seberang jaya",
    "bayan lepas", "bayan baru", "sungai ara",
  ],
  "Johor Bahru": [
    "johor bahru", "jb", "johor", "skudai", "tebrau",
    "danga bay", "bukit indah", "mount austin", "masai",
    "pasir gudang", "kulai", "kluang", "pontian",
    "ulu tiram", "larkin", "tampoi",
  ],
  "Ipoh": [
    "ipoh", "menglembu", "bercham", "chemor", "taiping",
    "teluk intan", "lumut", "manjung",
  ],
  "Kota Kinabalu": [
    "kota kinabalu", "kk", "sabah", "penampang", "putatan",
    "inanam", "menggatal", "tuaran", "sandakan", "lahad datu", "tawau",
  ],
  "Kuching": [
    "kuching", "sarawak", "kota samarahan", "bintawa", "petra jaya",
    "miri", "sibu", "bintulu",
  ],
};

// Returns the canonical city name if the location string belongs to that city, else null.
const resolveCity = (locationStr) => {
  if (!locationStr) return null;
  const lower = locationStr.toLowerCase();
  for (const [city, regions] of Object.entries(CITY_REGIONS)) {
    if (regions.some(r => lower.includes(r))) return city;
  }
  return null;
};

// Coarse location for public listing cards — only ever a city or region,
// never the exact place/street. Prefers the canonical city; if the city is
// unknown, falls back to the last (coarsest) comma segment of the address.
const overviewLocation = (locationStr) => {
  if (!locationStr) return "Area on request";
  const city = resolveCity(locationStr);
  if (city) return city;
  const parts = locationStr.split(",").map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || locationStr;
};

export const validateMalaysianBankAccount = (bankName, accountNumber) => {
  if (!bankName || !accountNumber) {
    return { valid: false, message: "Bank name and account number are required." };
  }
  const digits = String(accountNumber).replace(/\D/g, "");
  const code = bankName.toUpperCase().replace(/\s+/g, "_");
  const lengthMap = {
    MAYBANK: [12, 12],
    CIMB: [14, 14],
    PUBLIC_BANK: [10, 10],
    RHB: [14, 14],
    HONG_LEONG_BANK: [10, 12],
    AMBANK: [12, 14],
    BANK_ISLAM: [14, 14],
    BANK_RAKYAT: [12, 12],
    OCBC: [9, 12],
    HSBC: [12, 12],
    UOB: [10, 12],
  };
  const [min, max] = lengthMap[code] ?? [8, 17];
  if (digits.length < min || digits.length > max) {
    const range = min === max ? `${min}` : `${min}–${max}`;
    return { valid: false, message: `${bankName} account numbers must be ${range} digits (you entered ${digits.length}).` };
  }
  return { valid: true, message: "" };
};

export const toCurrency = (value) => `RM ${Number(value || 0).toFixed(2)}`;


// Plain-language name for a ledger movement. Deliberately NOT signed (+/-):
// a movement's effect on `available` is not its own amount -- capturing RM150
// against a RM160 hold RAISES available, because the untouched RM10 is released
// and the whole hold stops being reserved. Signing each line would state
// arithmetic that does not hold, so the kind carries the meaning instead.
// Mirrors the disputes_owner_insert policy (20260822c) exactly. Kept as one
// predicate rather than repeated inline, because when the two drift the failure
// is silent in the worse direction: a button that RLS then refuses looks like a
// broken app, and a missing button removes a worker's only escalation route
// without anyone noticing. If the policy changes, this changes in the same
// commit.
const canFileDispute = (a) => (
  a?.shiftStatus === "completed"
  || (a?.shiftStatus === "cancelled" && a?.status === "accepted" && Boolean(a?.workerSignedAt))
);


// A status chip carries meaning in its colour, so it cannot just be grey -- but
// the way it was built could not survive a theme flip. It tinted the hue at 10%
// for the background and used the SAME hue at full strength for the text:
//
//     background: `${BRAND.amber}1A`, color: BRAND.amber
//
// Over white that is a pale wash behind a saturated word, which reads. Over the
// dark page the same 10% tint composites to a dark, barely-there version of the
// hue, and the text measured 3.16:1 against it.
//
// Fixed by using the surface/on pairs this file already has for exactly this --
// the same ones Pill uses. Both halves are fixed light values, so the chip
// looks identical in both themes and cannot invert. The tone is named rather
// than derived from a colour value, so an unmapped tone fails visibly here
// instead of silently rendering an unreadable chip.
const CHIP_TONES = {
  primary: { background: BRAND.primaryLight, color: BRAND.onPrimaryLight },
  amber: { background: BRAND.amberLight, color: BRAND.onAmberLight },
  green: { background: BRAND.greenLight, color: BRAND.onGreenLight },
  red: { background: BRAND.redLight, color: BRAND.onRedLight },
};
const chipTone = (tone) => CHIP_TONES[tone] || CHIP_TONES.primary;

// The shift-detail header is a primary-colour gradient in both themes, so the
// controls sitting on it are fixed white rather than theme-aware -- named, so
// the intent is legible and the values cannot drift apart.
const ON_GRADIENT_TEXT = "#fff";
const ON_GRADIENT_CHIP_BG = "rgba(255,255,255,0.2)";


// Shared by the offer-deadline scaling below and the late-cancellation
// 24-hour threshold check — how many hours from now until a shift starts.
// Defaults to a large number (effectively "far away") when no start time is
// known yet, so callers don't need a separate null-check.
// A booking whose terms changed after the worker signed is on hold until they
// re-confirm. The deadline is DERIVED rather than stored -- min(shift start,
// 24h after the change) -- so there is no scheduled job to fall behind and no
// row that can be left in a stale state.
//
// terms_change_summary holds change CODES ('datetime,pay'), not prose, so the
// labels can be translated. Older rows may hold prose; notificationChangeLabel
// falls back to showing the raw value, which degrades to English rather than
// breaking.
// Mirrors public.cancellation_tier_for('worker', n) so the warning shown
// before confirming matches the penalty the RPC actually applies. Kept as a
// literal ladder rather than fetched, because it only ever DISPLAYS the
// consequence -- the server recomputes it from cancellation_tiers and its
// number is the one that counts. If the two ever disagree the worker was
// warned about the wrong figure, so the tiers are read from the DB on mount
// where possible (see WITHDRAW_TIERS_FALLBACK use).
const WITHDRAW_TIERS_FALLBACK = [
  { minNoticeHours: 168, penalty: 0 },
  { minNoticeHours: 48, penalty: 2 },
  { minNoticeHours: 24, penalty: 5 },
  { minNoticeHours: 0, penalty: 15 },
];

const withdrawalPenaltyFor = (shiftStartAt, tiers) => {
  const ladder = (tiers && tiers.length ? tiers : WITHDRAW_TIERS_FALLBACK)
    .slice()
    .sort((a, b) => b.minNoticeHours - a.minNoticeHours);
  const hours = Math.max(hoursUntilShift(shiftStartAt), 0);
  const tier = ladder.find(x => hours >= x.minNoticeHours) ?? ladder[ladder.length - 1];
  return { hours, penalty: tier?.penalty ?? 0 };
};

const RECONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;

export const reconfirmState = (a) => {
  if (!a?.termsChangedAt) return null;
  const changedAt = new Date(a.termsChangedAt).getTime();
  if (a.termsReconfirmedAt && new Date(a.termsReconfirmedAt).getTime() >= changedAt) return null;
  const startAt = a.shiftStartAt ? new Date(a.shiftStartAt).getTime() : Infinity;
  const deadline = Math.min(startAt, changedAt + RECONFIRM_WINDOW_MS);
  return {
    deadline,
    expired: Date.now() > deadline,
    codes: String(a.termsChangeSummary || "").split(",").map(c => c.trim()).filter(Boolean),
  };
};

export const hoursUntilShift = (shiftStartAt) => {
  const now = Date.now();
  const start = shiftStartAt ? new Date(shiftStartAt).getTime() : now + 999 * 3600000;
  return (start - now) / 3600000;
};


export const mapVerificationPillColor = (status) => {
  if (status === "verified") return "green";
  if (status === "rejected") return "red";
  return "amber";
};

// payout_item.status was being rendered raw -- a worker saw the literal enum,
// "processed internal", in every language. These are the six values the column's
// check constraint allows; the fallback keeps an unknown future value readable
// rather than blank.
const PAYOUT_STATUS_KEYS = {
  queued: "earnings.payoutStatusQueued",
  ready: "earnings.payoutStatusReady",
  scheduled: "earnings.payoutStatusScheduled",
  processed_internal: "earnings.payoutStatusProcessed",
  failed_internal: "earnings.payoutStatusFailed",
  held: "earnings.payoutStatusHeld",
};
export const payoutStatusLabel = (t, status) => {
  const key = PAYOUT_STATUS_KEYS[status || "queued"];
  return key ? t(key) : String(status).replaceAll("_", " ");
};

export const mapPayoutPillColor = (status) => {
  if (status === "processed_internal") return "green";
  if (status === "held" || status === "failed_internal") return "red";
  if (["ready", "scheduled", "processing"].includes(status)) return "blue";
  return "gray";
};

// A "held" payout_item's error_message (really an error_code, per the
// scheduler) was never surfaced anywhere in the UI — a held payout looked
// identical whether it was the worker's own unverified banking, the
// employer's, or (new, 20260725) a missed check-in. Translates the known
// codes; anything unrecognized falls back to a generic contact-support
// hint rather than showing the raw machine code.
export const payoutHoldReasonLabel = (t, errorMessage) => ({
  worker_not_checked_in: t("payout.holdReasonNotCheckedIn"),
  worker_banking_not_verified: t("payout.holdReasonWorkerBanking"),
  employer_banking_not_verified_or_funding_not_ready: t("payout.holdReasonEmployerBanking"),
  hours_disputed: t("payout.holdReasonHoursDisputed"),
}[errorMessage] || (errorMessage ? t("payout.holdReasonGeneric") : null));

// ─── Language / i18n ────────────────────────────────────────────────────────
const LANGUAGE_STORAGE_KEY = "carigaji_lang";

// Chinese is stored as "ch". It was "zh" until 2026-08-20, so a browser that
// last set the language before the rename still holds "zh" -- mapped rather
// than ignored, because falling through to the default would silently switch a
// Chinese reader back to English on their next visit.
const LANGUAGE_LEGACY_CODES = { zh: "ch" };
const SUPPORTED_LANGUAGES = ["en", "bm", "ch"];

const normalizeLanguage = (value) => {
  const mapped = LANGUAGE_LEGACY_CODES[value] || value;
  return SUPPORTED_LANGUAGES.includes(mapped) ? mapped : "en";
};

const readLanguagePreference = () => {
  if (typeof window === "undefined") return "en";
  return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
};

// Malay and Chinese text is fetched the first time it is needed and registered
// into TRANSLATIONS. Resolves (never rejects): if a table cannot be fetched even
// after the stale-chunk reload, t() falls back to the English text for every key
// rather than leaving the app unusable.
const LANGUAGE_LOADERS = {
  bm: () => import("./src/i18n/bm.js"),
  ch: () => import("./src/i18n/ch.js"),
};
const languageLoads = {};
const loadLanguage = (code) => {
  if (code === "en" || TRANSLATIONS[code]) return Promise.resolve();
  if (!languageLoads[code]) {
    languageLoads[code] = importOrReload(LANGUAGE_LOADERS[code])
      .then((mod) => { TRANSLATIONS[code] = mod.default; })
      .catch(() => { delete languageLoads[code]; });
  }
  return languageLoads[code];
};

// The URL wins over localStorage on first load. A /bm/... link is someone
// deliberately sharing the Malay page -- honouring a stored "en" instead
// would silently defeat the point of having per-language addresses at all.
const initialLanguage = () => {
  if (typeof window !== "undefined") {
    const fromUrl = langFromPath(window.location.pathname);
    if (fromUrl) return normalizeLanguage(fromUrl);
  }
  return readLanguagePreference();
};

const LanguageContext = createContext({ language: "en", setLanguage: () => {}, t: (key) => key });
export const useLanguage = () => useContext(LanguageContext);

const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(initialLanguage);

  // A visitor who opens /bm/... or /ch/... sees nothing until that language's
  // text has arrived (it is requested the moment this module loads, see the end
  // of the file), rather than a flash of English that then rewrites itself.
  // English needs no wait.
  const [ready, setReady] = useState(() => language === "en" || Boolean(TRANSLATIONS[language]));
  useEffect(() => {
    if (ready) return undefined;
    let live = true;
    loadLanguage(language).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [ready, language]);

  // Switching language loads the new text first and only then flips, so the UI
  // never shows a half-English screen. Latest click wins if they arrive out of order.
  const switchToken = useRef(0);
  const setLanguage = useCallback((lang) => {
    const next = normalizeLanguage(lang);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    }
    const token = ++switchToken.current;
    loadLanguage(next).then(() => { if (token === switchToken.current) setLanguageState(next); });
  }, []);

  // `params` interpolates {placeholders}. Optional, so every existing
  // single-argument t("key") call site is unaffected. Needed because
  // notification text is assembled from DB values (shift title, what changed)
  // that can't live in TRANSLATIONS, and the two languages order those values
  // differently — BM puts the shift name before the verb where EN doesn't, so
  // string concatenation can't express both.
  const t = useCallback((key, params) => {
    const stored = TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key;
    const raw = stored.includes("{brand}") ? stored.split("{brand}").join(SITE.name) : stored;
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (match, name) =>
      (params[name] === undefined || params[name] === null ? match : String(params[name]))
    );
  }, [language]);

  // Two side effects of a language change that are easy to forget and both
  // matter outside the React tree: the document's lang attribute (screen
  // readers, and Google deciding what language this page is in), and the
  // address bar, so the URL a user copies is the one they are looking at.
  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.setAttribute("lang", language === "ch" ? "zh-Hans" : language === "bm" ? "ms" : "en");
    const { lang: inUrl, rest } = splitLangPath(window.location.pathname);
    if (inUrl === language) return;
    const target = withLang(language, rest);
    if (!samePath(target, window.location.pathname)) {
      // replaceState, not push: changing language is not a navigation, and an
      // extra history entry would make Back appear to do nothing.
      window.history.replaceState(window.history.state, "", target + window.location.search);
    }
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  if (!ready) return null;
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

// ─── Cookie consent ─────────────────────────────────────────────────────────
// GDPR/PDPA-style consent: essential storage (Supabase auth session) is
// always on and can't be switched off; functional (language + theme
// preference) and analytics/marketing (gates the analytics_events logging —
// see logAnalyticsEvent above and hasAnalyticsConsent below) are
// user-controlled. Persisted the same way as LANGUAGE_STORAGE_KEY above, via
// a single JSON blob.
const COOKIE_CONSENT_STORAGE_KEY = "carigaji_cookie_consent";
const COOKIE_CONSENT_VERSION = 1;

const readCookieConsent = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCookieConsent = (decision) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(decision));
};

// Used by logAnalyticsEvent above to gate real event logging on the user's
// recorded consent decision. No decision yet (banner not actioned) is
// treated as "no" — analytics only fires once the user opts in.
const hasAnalyticsConsent = () => readCookieConsent()?.analytics === true;

// The floating cookie bubble (bottom-left, see CookieConsentManager) sits
// low enough to cover real content on some screens/viewport sizes. Once a
// decision has been recorded, it's just a re-entry point — not something
// that needs to sit on-screen permanently — so it can be dismissed. The
// setting still has to stay reachable somehow, so dismissing it doesn't
// delete the consent decision, just this one shortcut to it; Settings and
// the footer both carry their own "Cookie preferences" link that works
// even after the bubble is hidden (see CookieConsentManager's
// carigaji:open-cookie-prefs listener below).
const COOKIE_BUBBLE_HIDDEN_KEY = "carigaji_cookie_bubble_hidden";
const readCookieBubbleHidden = () => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COOKIE_BUBBLE_HIDDEN_KEY) === "true";
};
const writeCookieBubbleHidden = (hidden) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COOKIE_BUBBLE_HIDDEN_KEY, hidden ? "true" : "false");
};
export const OPEN_COOKIE_PREFS_EVENT = "carigaji:open-cookie-prefs";

// ─── Toast system ───────────────────────────────────────────────────────────
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

const TOAST_ACCENT = {
  success: "var(--cg-toast-success, #1A9E5C)",
  error: "#DC2626",
  info: "#2563EB",
};

const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message, type = "info", duration = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list, { id, message, type }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
          transform: "translateX(-50%)",
          zIndex: Z.modal,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "min(420px, calc(100% - 32px))",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              background: "var(--cg-surface, #fff)",
              color: "var(--cg-text, #111827)",
              border: "1px solid var(--cg-border, #E5E7EB)",
              borderLeft: `4px solid ${TOAST_ACCENT[t.type] || TOAST_ACCENT.info}`,
              borderRadius: RADIUS.card,
              padding: "12px 16px",
              fontSize: FS.body,
              lineHeight: 1.45,
              fontWeight: 500,
              boxShadow: "0 8px 28px var(--cg-shadow, rgba(15,23,42,0.12))",
              whiteSpace: "pre-line",
              animation: "cg-toast-in 0.18s ease-out",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

// ─── Shared helpers ─────────────────────────────────────────────────────────
// One message in the hours conversation (proposal note, dispute note, checkout
// note). A bubble with a label, not muted small print: these notes are how the
// two sides settle the hours without a dispute, so they must be read.
// tone "them" = the other party's words, "me" = your own.
export const HoursNote = ({ label, text, tone = "them", align = "left" }) => {
  if (!text) return null;
  const them = tone === "them";
  return (
    <div style={{
      marginTop: 8, padding: "8px 10px", borderRadius: RADIUS.control, textAlign: "left",
      fontSize: FS.meta, lineHeight: 1.4, overflowWrap: "anywhere", maxWidth: 260,
      marginLeft: align === "right" || align === "center" ? "auto" : undefined,
      marginRight: align === "center" ? "auto" : undefined,
      background: them ? BRAND.blueLight : BRAND.grayLight,
      color: them ? BRAND.onBlueLight : BRAND.text,
      border: `1px solid ${them ? BRAND.blue : BRAND.border}`,
    }}>
      <div style={{ fontSize: FS.meta, fontWeight: 700, letterSpacing: "0.02em", marginBottom: 2, opacity: 0.9 }}><InlineIcon icon={Icons.Chat} size={13} />{label}</div>
      <div style={{ fontWeight: 500 }}>{text}</div>
    </div>
  );
};

// Comments other people left when rating YOU. Private feedback: RLS lets only
// the rater and the rated person read a rating row, and the public
// get_ratee_ratings RPC never returns the comment.
export const ReceivedFeedback = ({ items }) => {
  const { t } = useLanguage();
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 4 }}>{t("rating.feedbackReceivedTitle")}</div>
      {items.map((f, i) => (
        <div key={i} style={{ marginTop: 6, padding: "8px 10px", borderRadius: RADIUS.control, background: BRAND.grayLight, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, lineHeight: 1.4, color: BRAND.text, overflowWrap: "anywhere" }}>
          <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 2 }}>
            <InlineIcon icon={Icons.Star} size={12} />{Number(f.overall).toFixed(1)} · {formatShiftDate(f.created_at, { day: "numeric", month: "short", year: "numeric" })}
          </div>
          {f.comment}
        </div>
      ))}
    </div>
  );
};

export const Badge = memo(({ color = "gray", children, size = "sm" }) => {
  const map = {
    gray: { bg: BRAND.grayLight, text: BRAND.textMuted },
    green: { bg: BRAND.greenLight, text: BRAND.onGreenLight },
    red: { bg: BRAND.redLight, text: BRAND.onRedLight },
    amber: { bg: BRAND.amberLight, text: BRAND.onAmberLight },
    blue: { bg: BRAND.blueLight, text: BRAND.onBlueLight },
    orange: { bg: BRAND.accentLight, text: BRAND.onAccentLight },
    teal: { bg: BRAND.tealLight, text: BRAND.onTealLight },
  };
  const c = map[color] || map.gray;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "xs" ? "1px 6px" : "2px 10px",
      borderRadius: RADIUS.pill,
      fontSize: FS.meta,
      fontWeight: 600,
      letterSpacing: "0.02em",
      background: c.bg, color: c.text,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
});

export const Card = memo(({ children, style = {}, onClick, hover = false }) => (
  <div onClick={onClick} style={{
    background: BRAND.surface,
    border: `1px solid ${BRAND.border}`,
    borderRadius: RADIUS.card,
    padding: "20px 24px",
    cursor: onClick ? "pointer" : "default",
    transition: "box-shadow 0.15s, transform 0.15s",
    ...style,
  }}
    onMouseEnter={e => { if (hover || onClick) { e.currentTarget.style.boxShadow = `0 4px 20px ${BRAND.shadow}`; e.currentTarget.style.transform = "translateY(-1px)"; } }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
  >{children}</div>
));

export const Btn = memo(({ children, variant = "primary", onClick, size = "md", style = {}, disabled = false, type = "button", ...rest }) => {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    border: "none", borderRadius: RADIUS.control, cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600, fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1,
    minHeight: size === "xs" ? 28 : 36,
    fontSize: size === "sm" ? FS.meta : size === "xs" ? FS.meta : FS.body,
    padding: size === "sm" ? "7px 14px" : size === "xs" ? "4px 10px" : "10px 20px",
  };
  const variants = {
    primary: { background: BRAND.primary, color: BRAND.onSolid },
    secondary: { background: BRAND.grayLight, color: BRAND.text, border: `1px solid ${BRAND.border}` },
    ghost: { background: "transparent", color: BRAND.primaryOnSurface, border: `1px solid ${BRAND.primaryOnSurface}` },
    danger: { background: BRAND.red, color: BRAND.onSolid },
    success: { background: BRAND.greenDark, color: BRAND.onSolid },
  };
  return (
    <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = "0.85"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
      {...rest}
    >{children}</button>
  );
});

// Fallback-initials colours for Avatar, keyed by the brand hue callers pass
// in. color+"22" text-on-its-own-13%-tint measured 3.04:1 in dark mode and
// 4.28:1 in light -- both under AA, because alpha blending means the
// rendered tint depends on whatever sits behind it. Reuse the fixed-light
// surface + onXLight text pairing Badge already uses for amber/red/green/
// primary instead: opaque, so it holds >4.5:1 in both themes by design.
const AVATAR_FALLBACK_COLORS = {
  [BRAND.primary]: { background: BRAND.primaryLight, color: BRAND.onPrimaryLight },
  [BRAND.accent]: { background: BRAND.accentLight, color: BRAND.onAccentLight },
  [BRAND.blue]: { background: BRAND.blueLight, color: BRAND.onBlueLight },
};

export const Avatar = memo(({ name = "?", size = 36, color = BRAND.primary, src = null }) => {
  const initials = name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{
          width: size, height: size, borderRadius: "50%",
          objectFit: "cover", flexShrink: 0, display: "block",
          background: color + "22",
        }}
      />
    );
  }
  const fallback = AVATAR_FALLBACK_COLORS[color] || { background: color + "22", color };
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: fallback.background, color: fallback.color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
});

// The "?" used to be aria-hidden decoration next to a native `title`, which
// only ever appears on hover -- i.e. never on a phone, where most of this app
// is used. It looked tappable and did nothing. Now it IS a button: tap toggles
// the explanation, and the native title stays for desktop hover.
export const Stat = memo(({ label, value, sub, color = BRAND.primary, tooltip }) => {
  const [open, setOpen] = useState(false);
  return (
    <div title={tooltip} style={{ position: "relative", background: BRAND.grayLight, borderRadius: RADIUS.card, padding: "16px 20px", cursor: tooltip ? "help" : "default" }}>
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, fontWeight: 500, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            aria-label={tooltip}
            style={{ color: BRAND.textMuted, opacity: 0.7, fontSize: FS.meta, background: "none", border: `1px solid ${BRAND.textMuted}`, borderRadius: "50%", width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1, padding: 0, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
          >?</button>
        )}
      </div>
      <div style={{ fontSize: FS.h1, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4 }}>{sub}</div>}
      {open && tooltip && (
        // Sits above the tile rather than inside it: these tiles are in a
        // 4-across grid and an inline expansion would resize its neighbours.
        <div
          role="note"
          onClick={() => setOpen(false)}
          style={{ position: "absolute", zIndex: 20, top: "100%", left: 0, right: 0, marginTop: 6, background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.control, padding: "10px 12px", fontSize: FS.meta, lineHeight: 1.5, color: BRAND.text, boxShadow: "0 6px 20px rgba(0,0,0,0.16)", minWidth: 190, cursor: "pointer" }}
        >{tooltip}</div>
      )}
    </div>
  );
});

export const Input = ({ label, placeholder, value, onChange, type = "text", style = {}, error = false, ...rest }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input type={type} placeholder={placeholder} value={value} onChange={onChange} {...rest}
      style={{
        width: "100%", padding: "10px 14px", borderRadius: RADIUS.control,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: FS.body, fontFamily: "inherit",
        color: BRAND.text, background: BRAND.input, outline: "none",
        boxSizing: "border-box",
      }}
    />
  </div>
);



const PasswordInput = ({ label, placeholder, value, onChange, style = {}, hideToggle = false, error = false }) => {
  const [show, setShow] = useState(false);
  const { t } = useLanguage();
  return (
    <div style={{ marginBottom: 16, position: "relative", ...style }}>
      {label && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          style={{
            width: "100%", padding: "10px 14px", borderRadius: RADIUS.control,
            border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: FS.body, fontFamily: "inherit",
            color: BRAND.text, background: BRAND.input, outline: "none",
            boxSizing: "border-box", height: 42, lineHeight: "20px",
          }}
        />
        {!hideToggle && (
          <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")} style={{ position: "absolute", right: 8, top: 6, border: "none", background: "transparent", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, color: BRAND.textMuted }}>
            {show ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 3L21 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10.58 10.58A3 3 0 0 0 13.42 13.42" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2.05 12.6A11 11 0 0 0 12 20c2.1 0 4.09-.5 5.95-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

export const FileInput = ({ label, onChange, accept, helper, fileName, error = false }) => (
  <div style={{ marginBottom: 16 }}>
    {label && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input
      type="file"
      accept={accept}
      onChange={onChange}
      style={{
        width: "100%",
        padding: "10px 14px",
        borderRadius: RADIUS.control,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`,
        fontSize: FS.body,
        fontFamily: "inherit",
        color: BRAND.text,
        background: BRAND.input,
        outline: "none",
        boxSizing: "border-box",
      }}
    />
    {(fileName || helper) && (
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6, lineHeight: 1.5 }}>
        {fileName ? `Selected: ${fileName}` : helper}
      </div>
    )}
  </div>
);

export const Select = ({ label, options, value, onChange, style = {} }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
    <select value={value} onChange={onChange} style={{
      width: "100%", padding: "10px 14px", borderRadius: RADIUS.control,
      border: `1px solid ${BRAND.border}`, fontSize: FS.body, fontFamily: "inherit",
      color: BRAND.text, background: BRAND.input, outline: "none",
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);


export const FilterToggle = ({ open, onToggle, activeCount = 0, t }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
    <button
      onClick={onToggle}
      aria-expanded={open}
      style={{ fontSize: FS.meta, padding: "4px 10px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor: "pointer", color: BRAND.textMuted, fontFamily: "inherit" }}
    >
      {open
        ? `${t("filters.hide")} ▲`
        : `${t("filters.label")}${activeCount > 0 ? ` (${activeCount})` : ""} ▼`}
    </button>
  </div>
);

export const FilterPanel = ({ children }) => (
  <div style={{ marginBottom: 12, padding: 12, background: BRAND.grayLight, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}` }}>
    {children}
  </div>
);


export const FilterClearAll = ({ show, onClear, t }) => (
  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
    {show && (
      <button onClick={onClear} style={{ fontSize: FS.meta, padding: "5px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.red}`, background: BRAND.redLight, cursor: "pointer", color: BRAND.onRedLight, fontFamily: "inherit" }}>
        {t("filters.clearAll")}
      </button>
    )}
  </div>
);

const PILL_TONES = {
  gray: { bg: BRAND.grayLight, text: BRAND.textMuted },
  green: { bg: BRAND.greenLight, text: BRAND.onGreenLight },
  red: { bg: BRAND.redLight, text: BRAND.onRedLight },
  amber: { bg: BRAND.amberLight, text: BRAND.onAmberLight },
  blue: { bg: BRAND.blueLight, text: BRAND.onBlueLight },
  orange: { bg: BRAND.accentLight, text: BRAND.onAccentLight },
  teal: { bg: BRAND.tealLight, text: BRAND.onTealLight },
};
// `icon` is an optional Icons component (e.g. from statusTone()), rendered
// small before the label so the cue doesn't rely on colour alone.
export const Pill = memo(({ label, color, icon: Icon }) => {
  const c = PILL_TONES[color] || PILL_TONES.gray;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: RADIUS.pill,
      fontSize: FS.meta, fontWeight: 600,
      background: c.bg, color: c.text,
    }}>{Icon && <span aria-hidden="true" style={{ display: "inline-flex" }}><Icon size={12} /></span>}{label}</span>
  );
});

export const EmptyState = memo(({ icon = <Icons.Inbox size={28} />, title, hint }) => (
  <div style={{
    border: `1px dashed ${BRAND.border}`,
    borderRadius: RADIUS.card,
    padding: "28px 20px",
    textAlign: "center",
    background: BRAND.grayLight,
  }}>
    <div style={{ display: "flex", justifyContent: "center", color: BRAND.textMuted, marginBottom: 8 }} aria-hidden="true">{icon}</div>
    <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{title}</div>
    {hint && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5 }}>{hint}</div>}
  </div>
));

const AuthGate = memo(({ onRequireAuth, title, hint, icon = <Icons.Lock size={28} /> }) => {
  const { t } = useLanguage();
  return (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: 14,
    padding: "48px 24px",
  }}>
    <div style={{
      width: 64, height: 64, borderRadius: "50%",
      background: BRAND.primaryLight, color: BRAND.onPrimaryLight, display: "flex",
      alignItems: "center", justifyContent: "center", fontSize: FS.h1,
    }} aria-hidden="true">{icon}</div>
    <div>
      <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, maxWidth: 280 }}>{hint}</div>
    </div>
    <div style={{ display: "flex", gap: 10, marginTop: 4, width: "100%", maxWidth: 280 }}>
      <Btn variant="secondary" onClick={() => onRequireAuth("register")} style={{ flex: 1, justifyContent: "center" }}>{t("common.createAccount")}</Btn>
      <Btn onClick={() => onRequireAuth("signin")} style={{ flex: 1, justifyContent: "center" }}>{t("common.signIn")}</Btn>
    </div>
  </div>
  );
});

const SkeletonRow = memo(({ height = 64 }) => (
  <div style={{
    height,
    borderRadius: RADIUS.card,
    marginBottom: 10,
    background: `linear-gradient(90deg, ${BRAND.grayLight} 25%, ${BRAND.border} 37%, ${BRAND.grayLight} 63%)`,
    backgroundSize: "400% 100%",
    animation: "cg-skeleton 1.3s ease-in-out infinite",
  }} />
));

const HELP_FAQS = [
  { qKey: "help.faqWorkQ", aKey: "help.faqWorkA" },
  { qKey: "help.faqPaidQ", aKey: "help.faqPaidA" },
  { qKey: "help.faqKycQ", aKey: "help.faqKycA" },
  { qKey: "help.faqLocationQ", aKey: "help.faqLocationA" },
  { qKey: "help.faqWrongQ", aKey: "help.faqWrongA" },
];

export const openMailtoSupport = () => {
  window.location.href = `mailto:${SITE.supportEmail}?subject=${encodeURIComponent(`${SITE.name} Support Request`)}`;
};

const ProfileMenu = ({ user, onSignOut, onOpenSupportChat, onOpenIssueReport = () => {}, isMobile = false }) => {
  const toast = useToast();
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpDialog = useDialog(helpOpen, () => setHelpOpen(false), { label: t("help.title") });
  const [openFaq, setOpenFaq] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const displayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "Account";
  const avatarUrl = getAvatarUrl(user.user_metadata?.avatar_url);

  const shareReferralLink = async () => {
    // The app's front door, never window.location.pathname: now that opening a
    // shift rewrites the address bar, reading the live path would turn a
    // "join CariGaji" referral into a link to whatever shift happened to be
    // open, with the referral wording still attached.
    const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${withLang(language, [])}` : (SITE.siteUrl || "/");
    const shareText = t("account.referShareText");
    if (navigator.share) {
      try { await navigator.share({ title: SITE.name, text: shareText, url: shareUrl }); } catch {} // user cancelled share sheet
      return;
    }
    if (navigator.clipboard) {
      // writeText can reject (e.g. permission explicitly denied by the
      // browser/OS, or a restrictive in-app webview) rather than just being
      // unsupported -- defend against that instead of letting an unhandled
      // rejection silently kill the whole function with zero user feedback.
      try {
        await navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
        toast(t("toast.inviteLinkCopied"), "success");
        return;
      } catch { /* fall through to plain-text fallback below */ }
    }
    toast(shareUrl, "info", 8000);
  };

  const items = [
    { label: t("account.help"), icon: <Icons.LifeBuoy size={18} />, onClick: () => setHelpOpen(true) },
    { label: t("account.contactSupport"), icon: <Icons.Chat size={18} />, onClick: onOpenSupportChat },
    { label: t("issue.menuItem"), icon: <Icons.Bug size={18} />, onClick: onOpenIssueReport },
    { label: t("account.referFriends"), icon: <Icons.Gift size={18} />, onClick: shareReferralLink },
    { label: t("account.signOut"), icon: <Icons.LogOut size={18} />, danger: true, onClick: onSignOut },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("account.menuLabel")}
        style={{
          display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
          border: `1px solid ${BRAND.border}`, background: BRAND.surface,
          borderRadius: RADIUS.pill, padding: isMobile ? 2 : "4px 10px 4px 4px", fontFamily: "inherit",
          flexShrink: 0,
        }}
      >
        <Avatar name={displayName} size={32} color={BRAND.primary} src={avatarUrl} />
        {/* Name text dropped on mobile — with the theme toggle and
            notification bell also on the header row, a name string here
            was pushing the row past the viewport width. Full name is still
            shown in the dropdown once opened. */}
        {!isMobile && (
          <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
        )}
        {!isMobile && <span aria-hidden="true" style={{ fontSize: FS.meta, color: BRAND.textMuted }}>▼</span>}
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: Z.popover,
          minWidth: 220, background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: RADIUS.card, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}` }}>
            <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
          </div>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", border: "none", background: "transparent",
                cursor: "pointer", fontFamily: "inherit", fontSize: FS.meta, textAlign: "left",
                color: it.danger ? BRAND.red : BRAND.text,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
      {helpOpen && createPortal(
        // Rendered via portal into document.body: the header this menu lives in
        // has backdropFilter, which creates a containing block for position:fixed
        // descendants — without escaping it, this overlay was sized/clipped to the
        // header's own box instead of the viewport.
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, paddingTop: "10vh" }} onClick={() => setHelpOpen(false)}>
          {/* alignItems: flex-start (not center) pins the panel's top edge to a
              fixed viewport position — expanding/collapsing an FAQ only grows
              or shrinks the bottom, it no longer shifts the top edge. */}
          <div {...helpDialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 480, width: "100%", maxHeight: "70vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: FS.lead, fontWeight: 700, color: BRAND.text, margin: 0 }}><InlineIcon icon={Icons.LifeBuoy} size={18} />{t("help.title")}</h3>
              <button onClick={() => setHelpOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }}><Icons.Close size={18} /></button>
            </div>
            {HELP_FAQS.map((faq, i) => (
              <div key={faq.qKey} style={{ borderBottom: `1px solid ${BRAND.border}`, padding: "10px 0" }}>
                <button onClick={() => setOpenFaq((o) => (o === i ? null : i))} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>
                  <span>{t(faq.qKey)}</span>
                  <span aria-hidden="true">{openFaq === i ? "−" : "+"}</span>
                </button>
                {openFaq === i && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8, lineHeight: 1.6 }}>{t(faq.aKey)}</div>}
              </div>
            ))}
            <div style={{ marginTop: 16, fontSize: FS.meta, color: BRAND.textMuted }}>
              {t("help.stillNeedHelp")}{" "}
              <button onClick={() => { setHelpOpen(false); onOpenSupportChat(); }} style={{ border: "none", background: "none", color: BRAND.primaryOnSurface, cursor: "pointer", fontWeight: 600, padding: 0, textDecoration: "underline", fontFamily: "inherit", fontSize: FS.meta }}>
                {t("help.contactSupportLink")}
              </button>
            </div>
            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <Btn size="sm" variant="secondary" onClick={() => setHelpOpen(false)}>{t("common.close")}</Btn>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const notificationTimeAgo = (iso, t) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t("notification.justNow");
  if (mins < 60) return t("notification.minAgo").replace("{n}", mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notification.hourAgo").replace("{n}", hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return t("notification.dayAgo").replace("{n}", days);
  return new Date(iso).toLocaleDateString("en-MY");
};

// Notification rows store their text as English prose, written by database
// triggers that have no access to TRANSLATIONS. Rows also carry `params`: the
// same event expressed as data (which shift, what changed), which CAN be
// rendered in either language at display time.
//
// Rendering from params is all-or-nothing per row. A BM title above an English
// body reads worse than consistent English, so a row falls back entirely
// unless it has params AND both keys exist. That also makes this safe to ship
// before the migration that populates `params` — every existing row simply
// keeps rendering exactly as it does today.
export const hasTranslation = (key) => TRANSLATIONS.en[key] !== undefined;

// Labels for the change codes in a shift_updated / shift_terms_changed row.
// The trigger stores codes rather than prose precisely so this list can be
// translated; a SQL-built "date/time, pay" string could only ever be English.
const notificationChangeLabel = (code, t) =>
  hasTranslation(`notif.change.${code}`) ? t(`notif.change.${code}`) : code;

const notificationText = (n, t) => {
  const params = n?.params && typeof n.params === "object" && !Array.isArray(n.params) ? n.params : null;
  const titleKey = `notif.${n?.type}.title`;
  // Three notifications have conditional bodies (offer declined vs expired,
  // 50% payout vs showing up, dispute with vs without a reason). The trigger
  // sends which branch it took as `variant` rather than baking an English
  // sentence in, so each branch gets its own translatable key.
  const bodyKey = params?.variant
    ? `notif.${n?.type}.${params.variant}.body`
    : `notif.${n?.type}.body`;

  if (!params || Object.keys(params).length === 0 || !hasTranslation(titleKey) || !hasTranslation(bodyKey)) {
    return { title: n?.title, body: n?.body };
  }

  const filled = { ...params };
  if (Array.isArray(params.changed)) {
    filled.changed = params.changed.map(code => notificationChangeLabel(code, t)).join(", ");
  }
  // Timestamps travel raw so they can be rendered in the reader's locale and
  // timezone rather than frozen in whatever format SQL's to_char() produced.
  // Money travels raw for the same reason, and for the same reason needs
  // formatting here: jsonb stores 108.00 as the number 108, so interpolating
  // it directly renders "RM108" -- less precise than the English prose the row
  // already carries, which would make the translated copy the worse one.
  for (const [key, value] of Object.entries(filled)) {
    if (key.endsWith("_at") && value) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        filled[key] = `${formatShiftDate(d.toISOString(), { day: "numeric", month: "short" })}, ${formatShiftTime(d.toISOString())}`;
      }
    } else if ((key === "amount" || key.endsWith("_amount")) && value !== null && value !== undefined && !Number.isNaN(Number(value))) {
      filled[key] = Number(value).toFixed(2);
    }
  }
  return { title: t(titleKey, filled), body: t(bodyKey, filled) };
};

// A notification's link points at a shift or application that may since have
// been deleted. Nothing cascades notifications away when that happens, so the
// row survives and the link goes nowhere -- clicking it currently navigates to
// the portal and silently opens nothing.
//
// The row is deliberately NOT deleted. "You were selected for this shift" is
// true; it happened. If the employer later removes the posting, erasing the
// worker's copy quietly rewrites their history and destroys the only trace
// they ever applied. Better to keep the record and say plainly that the shift
// is gone.
//
// Resolution is batched: one query per table for the whole loaded page, not
// one per row.
const parseNotificationLink = (link) => {
  const m = /^\/(worker|employer)\/(shifts|applications)\/([0-9a-f-]{36})$/i.exec(link || "");
  return m ? { table: m[2], id: m[3] } : null;
};

const resolveDeadNotificationLinks = async (rows) => {
  const wanted = { shifts: new Set(), applications: new Set() };
  for (const n of rows || []) {
    const target = parseNotificationLink(n?.link);
    if (target) wanted[target.table].add(target.id);
  }
  const dead = new Set();
  for (const table of ["shifts", "applications"]) {
    const ids = [...wanted[table]];
    if (!ids.length) continue;
    const { data, error } = await supabase.from(table).select("id").in("id", ids);
    // On error, assume everything is alive. Showing a live notification as
    // dead is worse than the reverse: it tells the worker a real shift has
    // vanished.
    if (error) continue;
    const alive = new Set((data ?? []).map(r => r.id));
    ids.filter(id => !alive.has(id)).forEach(id => dead.add(id));
  }
  return dead;
};

const isNotificationDead = (n, deadIds) => {
  const target = parseNotificationLink(n?.link);
  return Boolean(target && deadIds?.has(target.id));
};

const NOTIFICATION_PAGE_SIZE = 20;

// Launch-phase issue reporting. Distinct from Contact Support (a
// conversation) -- this captures "something is broken" with the context a
// reporter shouldn't have to describe: which page, which role, which build.
// Without those, "the button does nothing" is unactionable.
const IssueReportModal = ({ open, onClose, user, userRole, pageContext }) => {
  const { t } = useLanguage();
  const toast = useToast();
  // Declared AFTER the useLanguage() destructure above, not before it: the hook
  // takes t("issue.title") as the dialog's accessible name, and referencing `t`
  // one line above its own const is a TDZ crash -- which esbuild does not catch
  // and which has white-screened this file four times before.
  const dialog = useDialog(open, onClose, { label: t("issue.title") });
  const [category, setCategory] = useState("bug");
  const [severity, setSeverity] = useState("normal");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setCategory("bug"); setSeverity("normal"); setDescription(""); }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!description.trim()) { toast(t("issue.needDescription"), "error"); return; }
    setSaving(true);
    const { error } = await supabase.from("issue_reports").insert({
      user_id: user?.id ?? null,
      reporter_role: userRole ?? null,
      category,
      severity,
      description: description.trim(),
      page_context: pageContext ?? null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 400) : null,
      app_version: APP_BUILD_ID,
    });
    setSaving(false);
    if (error) { toast(t("issue.failed") + error.message, "error"); return; }
    toast(t("issue.thanks"), "success");
    onClose();
  };

  const CATEGORIES = ["bug", "confusing", "missing", "payment", "account", "other"];
  const SEVERITIES = ["blocking", "normal", "minor"];

  return (
    <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16}} onClick={onClose}>
      <div {...dialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 22, maxWidth: 460, width: "100%", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h3 style={{ fontSize: FS.card, fontWeight: 800, color: BRAND.text, margin: 0 }}><InlineIcon icon={Icons.Bug} size={16} />{t("issue.title")}</h3>
          <button onClick={onClose} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }}><Icons.Close size={18} /></button>
        </div>
        <p style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, margin: "0 0 16px" }}>{t("issue.subtitle")}</p>

        <label style={{ display: "block", fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 6 }}>{t("issue.categoryLabel")}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setCategory(c)} style={{
              padding: "6px 11px", borderRadius: RADIUS.pill, fontSize: FS.meta, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              border: `1px solid ${category === c ? BRAND.primary : BRAND.border}`,
              background: category === c ? BRAND.blueLight : "transparent",
              color: category === c ? BRAND.primary : BRAND.textMuted,
            }}>{t(`issue.cat.${c}`)}</button>
          ))}
        </div>

        <label style={{ display: "block", fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 6 }}>{t("issue.severityLabel")}</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {SEVERITIES.map(sv => (
            <button key={sv} onClick={() => setSeverity(sv)} style={{
              flex: 1, padding: "7px 8px", borderRadius: RADIUS.control, fontSize: FS.meta, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              border: `1px solid ${severity === sv ? BRAND.primary : BRAND.border}`,
              background: severity === sv ? BRAND.blueLight : "transparent",
              color: severity === sv ? BRAND.primary : BRAND.textMuted,
            }}>{t(`issue.sev.${sv}`)}</button>
          ))}
        </div>

        <label style={{ display: "block", fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 6 }}>{t("issue.descriptionLabel")}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder={t("issue.descriptionPlaceholder")}
          style={{ width: "100%", padding: 10, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.bg, color: BRAND.text, fontFamily: "inherit", fontSize: FS.meta, resize: "vertical", marginBottom: 8 }}
        />
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16, lineHeight: 1.45 }}>
          {t("issue.contextNote", { page: pageContext || "—" })}
        </div>

        <Btn onClick={submit} disabled={saving} style={{ width: "100%", justifyContent: "center" }}>
          {saving ? t("issue.sending") : t("issue.submitBtn")}
        </Btn>
      </div>
    </div>
  );
};

// ─── Web Push ───────────────────────────────────────────────────────────────
// Delivers a notification to the phone's tray even when the app is closed.
//
// SCOPE, deliberately: Android and desktop. iOS supports Web Push only for a
// site the user has added to the Home Screen -- in a Safari tab there is no
// push and no way to ask -- so iPhone users keep getting the existing email
// (send-notification-email) and nothing here breaks for them. `pushSupported()`
// is what decides, so an iPhone never sees a toggle it cannot honour.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

const pushSupported = () => (
  typeof window !== "undefined"
  && "serviceWorker" in navigator
  && "PushManager" in window
  && "Notification" in window
  && Boolean(VAPID_PUBLIC_KEY)
);

// The VAPID key travels as base64url but applicationServerKey wants bytes.
const urlBase64ToUint8Array = (base64String) => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

// Asks the browser, subscribes, and stores the endpoint. Returns a string
// reason rather than throwing, because every outcome here is a normal thing a
// user can do -- including saying no.
export const enablePushNotifications = async (user) => {
  if (!pushSupported()) return "unsupported";
  if (!user?.id) return "signed-out";
  if (Notification.permission === "denied") return "denied";

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const registration = await navigator.serviceWorker.ready;
  // Reuse an existing subscription if the browser already has one for this
  // device; re-subscribing would hand back the same endpoint anyway.
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const json = subscription.toJSON();
  if (!json?.endpoint || !json.keys?.p256dh || !json.keys?.auth) return "failed";

  // Upsert on endpoint: the same device re-subscribing must update its row,
  // not accumulate duplicates that would each get their own copy of every push.
  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 300),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });

  return error ? "failed" : "enabled";
};

// Signing out must stop this device receiving the next person's notifications.
// Both halves matter: dropping the row stops the server sending, and
// unsubscribing stops the browser holding a live endpoint for us.
export const disablePushNotifications = async () => {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.toJSON()?.endpoint;
    if (endpoint) await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    await subscription.unsubscribe();
  } catch { /* best effort -- never block sign-out on this */ }
};

// The state the SETTINGS ROW needs, which is not the same as the browser
// permission. Permission stays "granted" after you unsubscribe, so keying the
// UI on it alone left the row stuck on "Turn off" with no way back once the
// user had switched notifications off -- reported from a real phone.
//
// What matters is whether a subscription exists right now:
//   "unsupported"  no service worker / no PushManager / no VAPID key
//   "denied"       the browser blocked it; only site settings can undo that
//   "on"           permission granted AND a live subscription
//   "off"          everything else -- never asked, or asked and then turned off
// "off" covers granted-but-unsubscribed, where enabling again subscribes
// silently without a second prompt.
export const readPushStatus = async () => {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "on" : "off";
  } catch {
    return "off";
  }
};

// ─── Chat: unread badge + day-aware timestamps ──────────────────────────────
//
// Chat in this app is a per-shift ROOM, not a 1:1 thread: every message is
// written with recipient_id = null and read back the same way (see 20260719d).
// That means the messages table's `read_at` column cannot carry unread state --
// it is one column shared by everyone in the room, so "read" has no single
// meaning. Per-user read state would need its own table.
//
// So the badge is tracked client-side: the timestamp of the newest message the
// user has actually looked at, per room, in localStorage. Keyed by user id as
// well as shift id, because two accounts on one device (worker + employer, or a
// QA pair) must not inherit each other's read state.
//
// The tradeoff, stated plainly: this is per-device. Reading a message on a
// phone does not clear the badge on a laptop. That is the normal behaviour for
// an unsynced badge and is fine for a nudge; if it ever needs to be exact
// across devices, the fix is a `chat_room_reads (user_id, shift_id,
// last_read_at)` table, not more localStorage.
const CHAT_SEEN_KEY = "carigaji_chat_seen";

export const readChatSeen = (userId) => {
  if (typeof window === "undefined" || !userId) return {};
  try {
    const all = JSON.parse(window.localStorage.getItem(CHAT_SEEN_KEY) || "{}");
    return all[userId] || {};
  } catch { return {}; }
};

export const writeChatSeen = (userId, shiftId, iso) => {
  if (typeof window === "undefined" || !userId || !shiftId) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(CHAT_SEEN_KEY) || "{}");
    const mine = all[userId] || {};
    // Never move the marker backwards: an older message opened later must not
    // un-read newer ones.
    if (!mine[shiftId] || new Date(iso) > new Date(mine[shiftId])) {
      all[userId] = { ...mine, [shiftId]: iso };
      window.localStorage.setItem(CHAT_SEEN_KEY, JSON.stringify(all));
    }
  } catch { /* storage unavailable — the badge degrades, nothing breaks */ }
};

// Rooms with a message newer than what this user has seen, ignoring their own
// messages. Returns the room COUNT rather than a message count: "3" meaning
// three conversations need attention is more useful than three messages in one.
// Dialog behaviour for the ~35 hand-rolled overlays in this file. Before this,
// NOT ONE of them could be closed with Escape, none announced itself as a
// dialog, and none moved focus -- a keyboard or screen-reader user could open a
// modal and have no way out of it. The single Escape listener in the whole file
// was on the language dropdown.
//
// Deliberately a hook and not a <Modal> component: converting 35 call sites to a
// wrapper would move a lot of JSX across the boundary that has already produced
// four TDZ white-screens here. This attaches to an overlay that stays exactly
// where it is -- one hook call, one ref, one prop spread.
//
// Returns props for the PANEL (not the backdrop). tabIndex -1 makes the panel
// focusable so focus has somewhere to land without stealing it from a specific
// control; the browser then tabs forward into the panel's own inputs.
// `label` gives the dialog its accessible name. Prefer passing the SAME t() key
// the visible heading uses, so the announced name and the on-screen title read
// from one translation entry and cannot drift apart. `labelledBy` is available
// where a heading already has a stable id worth pointing at.
export const useDialog = (open, onClose, { labelledBy, label } = {}) => {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  // onClose is passed as an inline arrow at every call site, so its identity
  // changes on EVERY render. Depending on it directly would tear the effect
  // down and rebuild it each render -- and the cleanup restores focus, so
  // typing one character into a modal's textarea would re-render, fire the
  // cleanup, and yank focus back to whatever opened the modal. Hold it in a ref
  // and depend on `open` alone.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!open) return undefined;
    // Remember who opened this, so focus can go home on close. Without it,
    // dismissing a modal drops focus to <body> and a keyboard user restarts
    // from the top of the page.
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel) panel.focus({ preventScroll: true });

    // Selector for the standard interactive-element set. Panel itself carries
    // tabIndex={-1} (see the return value below), so `:not([tabindex="-1"])`
    // excludes it from the trap boundary -- Tab cycles the REAL controls
    // inside it, not the container.
    const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();   // nested overlays: only the topmost one closes
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // Queried fresh on every Tab press, not cached at effect setup -- a
      // dialog's content can change while it's open (an FAQ accordion
      // expanding, a rating form revealing more stars), and a stale list
      // would trap focus against elements that no longer exist or miss ones
      // that just appeared. offsetParent!==null filters out anything
      // display:none, so a hidden control never becomes a false trap boundary.
      const focusable = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;   // nothing inside to cycle -- let Tab behave natively
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      // Any other position: let Tab move naturally within the panel.
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      // Only restore if the opener is still in the document and focusable --
      // a row that has since re-rendered away would throw or scroll oddly.
      if (restore && document.contains(restore) && typeof restore.focus === "function") {
        restore.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return {
    ref: panelRef,
    role: "dialog",
    "aria-modal": "true",
    ...(labelledBy ? { "aria-labelledby": labelledBy } : {}),
    ...(!labelledBy && label ? { "aria-label": label } : {}),
    tabIndex: -1,
  };
};

// One confirmation step for anything that changes someone's money, access or
// record and can't be taken back from the same screen. Before this, admin
// approve/reject/verify/release/hold/ruling all ran on a single click, and the
// two places that did ask used different mechanisms (window.confirm vs an
// inline panel). Promise-based so a handler reads top to bottom:
//
//   const [confirm, confirmDialog] = useConfirm();
//   const res = await confirm({ title, body, confirmLabel, tone: "danger",
//                               note: { label, required: true } });
//   if (!res) return;            // cancelled
//   ... res.note ...             // trimmed text, "" when no note was asked for
//
// Render {confirmDialog} once in the component. Built on useDialog, so Escape,
// focus trap and the accessible name come for free.
export const useConfirm = () => {
  const { t } = useLanguage();
  const [req, setReq] = useState(null);         // { title, body, confirmLabel, tone, note, resolve }
  const [note, setNote] = useState("");
  const close = (result) => { req?.resolve(result); setReq(null); setNote(""); };
  const dialog = useDialog(Boolean(req), () => close(null), { label: req?.title });
  const confirm = useCallback((opts) => new Promise((resolve) => {
    setNote("");
    setReq({ ...opts, resolve });
  }), []);
  const noteMissing = Boolean(req?.note?.required) && !note.trim();
  const element = req ? createPortal(
    <div onClick={() => close(null)} style={{ position: "fixed", inset: 0, background: "rgba(10,20,40,0.55)", zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div {...dialog} onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 440, background: BRAND.surfaceElevated, borderRadius: RADIUS.card, padding: 22, boxShadow: "0 20px 50px rgba(0,0,0,0.25)", outline: "none" }}>
        <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, marginBottom: 8, lineHeight: 1.3 }}>{req.title}</div>
        {req.body && <div style={{ fontSize: FS.body, color: BRAND.textMuted, lineHeight: 1.55, marginBottom: 16, whiteSpace: "pre-line" }}>{req.body}</div>}
        {req.note && (
          <label style={{ display: "block", marginBottom: 16 }}>
            <span style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>
              {req.note.label}{req.note.required ? " *" : ` (${t("confirm.optional")})`}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={req.note.placeholder || ""}
              rows={3}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.body, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical" }}
            />
          </label>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Btn variant="secondary" onClick={() => close(null)}>{t("common.cancel")}</Btn>
          <Btn
            variant={req.tone === "danger" ? "danger" : req.tone === "success" ? "success" : "primary"}
            disabled={noteMissing}
            onClick={() => close({ note: note.trim() })}
          >
            {req.confirmLabel}
          </Btn>
        </div>
        {noteMissing && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8, textAlign: "right" }}>{t("confirm.noteRequired")}</div>}
      </div>
    </div>,
    document.body
  ) : null;
  return [confirm, element];
};

export const useUnreadChatRooms = (user) => {
  const [unreadRooms, setUnreadRooms] = useState(0);
  const [previewSenderNames, setPreviewSenderNames] = useState({});
  const [unreadRoomIds, setUnreadRoomIds] = useState(() => new Set());

  // The newest message per room, whoever sent it -- this is what the chat list
  // previews. Kept in the same pass as the unread count because both need the
  // same rows; a second query would double the traffic to answer half a
  // question.
  const [roomPreviews, setRoomPreviews] = useState(() => new Map());

  const recompute = useCallback((rows) => {
    if (!user?.id) { setUnreadRooms(0); setUnreadRoomIds(new Set()); setRoomPreviews(new Map()); return; }
    const seen = readChatSeen(user.id);
    const newestByRoom = new Map();      // excludes my own -- drives the badge
    const previewByRoom = new Map();     // includes my own -- drives the list
    for (const m of rows || []) {
      const prevPreview = previewByRoom.get(m.shift_id);
      if (!prevPreview || new Date(m.created_at) > new Date(prevPreview.created_at)) {
        previewByRoom.set(m.shift_id, m);
      }
      if (m.sender_id === user.id) continue;          // my own messages are read by definition
      const prev = newestByRoom.get(m.shift_id);
      if (!prev || new Date(m.created_at) > new Date(prev)) newestByRoom.set(m.shift_id, m.created_at);
    }
    const unread = new Set();
    for (const [shiftId, newest] of newestByRoom) {
      const mark = seen[shiftId];
      if (!mark || new Date(newest) > new Date(mark)) unread.add(shiftId);
    }
    setUnreadRoomIds(unread);
    setUnreadRooms(unread.size);
    setRoomPreviews(previewByRoom);
  }, [user?.id]);

  const refresh = useCallback(async () => {
    if (!user?.id) { setUnreadRooms(0); return; }

    // Scope this to the rooms the user can actually OPEN, rather than to
    // whatever RLS happens to return.
    //
    // The comment that used to sit here said RLS already limits the query to
    // the user's own rooms, so no filter was needed. That is true for workers
    // and employers and FALSE for admins: messages_admin_all (20260703d) grants
    // an admin `for all` on public.messages, so this returned every
    // conversation on the platform. The badge then counted strangers' rooms --
    // which the inbox never lists, so they could not be opened, could not be
    // marked seen, and the count sat there permanently. Opening every one of
    // your own chats did nothing, because the room being counted was never
    // yours.
    //
    // An employer could hit a smaller version of the same bug: a worker who was
    // accepted, chatted, and then moved off 'accepted' leaves messages the
    // employer can still read (they own the shift) in a room the inbox no
    // longer lists.
    //
    // These two queries mirror how the inbox builds its list, so the badge can
    // no longer count a room the user has no way to reach. Two extra lookups
    // per refresh, both indexed and both tiny; correctness is worth more here
    // than the round trip the old comment was protecting.
    const [asWorker, asEmployer] = await Promise.all([
      supabase.from('applications').select('shift_id')
        .eq('worker_id', user.id).eq('status', 'accepted'),
      supabase.from('applications').select('shift_id, shift:shifts!inner(employer_id)')
        .eq('status', 'accepted').eq('shift.employer_id', user.id),
    ]);
    const roomIds = [...new Set([
      ...(asWorker.data || []).map(r => r.shift_id),
      ...(asEmployer.data || []).map(r => r.shift_id),
    ].filter(Boolean))];
    if (!roomIds.length) {
      setUnreadRooms(0); setUnreadRoomIds(new Set());
      setRoomPreviews(new Map()); setPreviewSenderNames({});
      return;
    }

    const { data, error } = await supabase
      .from('messages')
      .select('shift_id, sender_id, content, created_at')
      .is('recipient_id', null)
      .in('shift_id', roomIds)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) { setUnreadRooms(0); setUnreadRoomIds(new Set()); setRoomPreviews(new Map()); return; }
    recompute(data || []);

    // Names for whoever sent those previews. One query for the distinct
    // senders rather than one per row, and skipped entirely when the only
    // sender is the current user.
    const senderIds = [...new Set((data || []).map(m => m.sender_id).filter(id => id && id !== user.id))];
    if (senderIds.length) {
      const { data: profiles } = await supabase
        .from('profiles').select('id, full_name').in('id', senderIds);
      if (profiles?.length) {
        setPreviewSenderNames(prev => ({
          ...prev,
          ...Object.fromEntries(profiles.map(pr => [pr.id, pr.full_name || null])),
        }));
      }
    }
  }, [user?.id, recompute]);

  useEffect(() => {
    refresh();
    if (!user?.id) return undefined;
    const channel = supabase
      .channel(`chat-unread-${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
        // Cheaper to re-derive than to reason about whether this row belongs to
        // a room the user is in -- RLS decides that, and only on a read.
        refresh();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refresh]);

  return { unreadRooms, refreshUnreadChat: refresh, roomPreviews, previewSenderNames, unreadRoomIds };
};

// A bare time is ambiguous across days: a reply sent at 08:05 the next morning
// reads as five minutes after an 08:00 message from yesterday. Messages are
// therefore grouped under a day heading, and the full date and time is on the
// bubble's title attribute for anyone who needs to be precise.
// The preview line under a conversation title: who spoke last and what they
// said. Truncated here rather than by CSS so the string that reaches the DOM is
// already short -- a 2000-character message would otherwise sit in the markup
// of every row, clipped only visually.
const CHAT_PREVIEW_MAX = 70;

// Most recently active room first, which is the only order that stays useful as
// a list grows: the conversation you need is almost always the one that just
// moved. Sorted at render time from roomPreviews rather than in the loader, so
// a message arriving re-orders the list immediately instead of at the next
// fetch.
//
// Rooms with no messages yet sink below the active ones, keeping their original
// relative order. They are real rooms the user can open, so they are not
// hidden -- but an empty room has nothing to be recent about, and floating it
// above a live conversation on the strength of its shift date would be noise.
export const sortConversationsByRecent = (conversations, previews) => {
  const at = (conv) => {
    const msg = previews?.get(conv.shiftId);
    return msg?.created_at ? new Date(msg.created_at).getTime() : null;
  };
  return [...(conversations || [])].sort((a, b) => {
    const ta = at(a), tb = at(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
};

export const chatPreviewLine = (msg, user, senderNames, t) => {
  if (!msg) return null;
  const isMe = msg.sender_id === user?.id;
  const name = isMe
    ? t("chat.previewYou")
    : (senderNames?.[msg.sender_id] || t("chat.previewSomeone"));
  const body = (msg.content || "").replace(/\s+/g, " ").trim();
  const text = body.length > CHAT_PREVIEW_MAX ? `${body.slice(0, CHAT_PREVIEW_MAX)}…` : body;
  return { name, text, at: msg.created_at, isMe };
};

export const chatDayKey = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: MY_TIMEZONE });
};

export const chatDayLabel = (iso, t) => {
  const key = chatDayKey(iso);
  if (!key) return "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: MY_TIMEZONE });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: MY_TIMEZONE });
  if (key === today) return t("chat.dayToday");
  if (key === yesterday) return t("chat.dayYesterday");
  const d = new Date(iso);
  const sameYear = d.toLocaleDateString("en-CA", { timeZone: MY_TIMEZONE }).slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString("en-MY", sameYear
    ? { day: "numeric", month: "short", timeZone: MY_TIMEZONE }
    : { day: "numeric", month: "short", year: "numeric", timeZone: MY_TIMEZONE });
};

export const chatFullTimestamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: MY_TIMEZONE })}, ${formatShiftTime(iso)}`;
};

const NotificationBell = ({ user, onNavigate = () => {} }) => {
  const { t } = useLanguage();
  const [notifications, setNotifications] = useState([]);
  // ids of shifts/applications a loaded notification links to that no longer
  // exist -- those rows render as a tombstone instead of a dead link.
  const [deadLinkIds, setDeadLinkIds] = useState(() => new Set());
  const [open, setOpen] = useState(false);
  // "inbox" hides archived rows; "archived" shows only those. Archiving never
  // deletes -- see 20260822e. The archive lives in this same panel rather than
  // a settings screen, because people look for what they just cleared where
  // they cleared it.
  const [notifView, setNotifView] = useState("inbox");
  const [panelPos, setPanelPos] = useState(null); // { top, left } in viewport coords
  const [notifHasMore, setNotifHasMore] = useState(false);
  const [notifLoadingMore, setNotifLoadingMore] = useState(false);
  const ref = useRef(null);

  // The panel only ever loads the most recent NOTIFICATION_PAGE_SIZE rows
  // (below) -- a worker with months of history can easily have more unread
  // notifications than that sitting further back, so the badge can't just
  // count what's loaded, or it silently stops climbing past that page. A
  // separate exact-count query keeps it honest regardless of how many
  // pages exist.
  const [unreadTotal, setUnreadTotal] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // The panel used to be position:absolute anchored to this tiny 36px bell
  // wrapper with right:0 — on narrow phones the bell isn't flush with the
  // screen edge (the account menu sits to its right), so the panel's fixed
  // 320px width overflowed off the left edge of the viewport. Position it
  // with fixed viewport coordinates instead, clamped to stay fully on-screen.
  useEffect(() => {
    if (!open || !ref.current) return undefined;
    const panelWidth = Math.min(320, window.innerWidth - 32);
    const computePosition = () => {
      const rect = ref.current.getBoundingClientRect();
      const desiredLeft = rect.right - panelWidth;
      const clampedLeft = Math.min(Math.max(16, desiredLeft), window.innerWidth - panelWidth - 16);
      setPanelPos({ top: rect.bottom + 8, left: clampedLeft, width: panelWidth });
    };
    computePosition();
    window.addEventListener("resize", computePosition);
    return () => window.removeEventListener("resize", computePosition);
  }, [open]);

  // Archived rows are excluded by the query, not filtered client-side: the list
  // is paginated, so filtering a page after the fact would return short pages
  // and eventually an empty one while rows still existed further back.
  const applyViewFilter = useCallback((q) => (
    notifView === "archived" ? q.not('dismissed_at', 'is', null) : q.is('dismissed_at', null)
  ), [notifView]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    applyViewFilter(
      supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
    )
      .order('created_at', { ascending: false })
      .range(0, NOTIFICATION_PAGE_SIZE - 1)
      .then(async ({ data }) => {
        if (!active) return;
        setNotifications(data ?? []);
        setNotifHasMore((data ?? []).length === NOTIFICATION_PAGE_SIZE);
        const dead = await resolveDeadNotificationLinks(data ?? []);
        if (active) setDeadLinkIds(dead);
      });
    // Unread counts the INBOX only. Archiving something unread should quiet the
    // badge -- otherwise the badge points at a list the user cannot see.
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false)
      .is('dismissed_at', null)
      .then(({ count }) => {
        if (active) setUnreadTotal(count ?? 0);
      });
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, payload => {
        if (!active) return;
        // A brand-new row is never archived, so it belongs in the inbox. While
        // the archived view is open, prepending it would show the user a row
        // that contradicts the filter they are looking at.
        if (notifView === "inbox") setNotifications(prev => [payload.new, ...prev]);
        setUnreadTotal(prev => prev + 1);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id, applyViewFilter]);

  const loadMoreNotifications = async () => {
    if (!user?.id || notifLoadingMore) return;
    setNotifLoadingMore(true);
    const offset = notifications.length;
    const { data } = await applyViewFilter(
      supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
    )
      .order('created_at', { ascending: false })
      .range(offset, offset + NOTIFICATION_PAGE_SIZE - 1);
    setNotifications(prev => [...prev, ...(data ?? [])]);
    setNotifHasMore((data ?? []).length === NOTIFICATION_PAGE_SIZE);
    setNotifLoadingMore(false);
    const dead = await resolveDeadNotificationLinks(data ?? []);
    // union, not replace: earlier pages were already resolved and this batch
    // only knows about its own rows.
    if (dead.size) setDeadLinkIds(prev => new Set([...prev, ...dead]));
  };

  const markRead = async (id) => {
    setNotifications(prev => prev.map(n => (n.id === id && !n.read ? { ...n, read: true } : n)));
    const target = notifications.find(n => n.id === id);
    if (target && !target.read) setUnreadTotal(prev => Math.max(0, prev - 1));
    await supabase.from('notifications').update({ read: true }).eq('id', id);
  };

  const archivableCount = notifications.filter(n => n.read).length;

  const handleNotificationClick = (n) => {
    markRead(n.id);
    // A tombstone is still worth marking read, but navigating would land the
    // user on a portal with nothing opened and no explanation.
    if (isNotificationDead(n, deadLinkIds)) return;
    if (n.link) {
      setOpen(false);
      onNavigate(n.link);
    }
  };

  // Updates every unread row for this user server-side (not just the
  // loaded page) -- clearing only the on-screen rows used to leave older
  // unread notifications permanently stuck as unread with no way to reach
  // them, since the panel never paginated back far enough on its own.
  const markAllRead = async () => {
    if (unreadTotal === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadTotal(0);
    await supabase.from('notifications').update({ read: true })
      .eq('user_id', user.id).eq('read', false).is('dismissed_at', null);
  };

  // The "clear my clutter" gesture. Archives every READ inbox row server-side,
  // not just the loaded page -- same reasoning as markAllRead: the panel never
  // paginates back far enough on its own, so a page-scoped clear would leave
  // older rows stranded with no way to reach them.
  //
  // Read-only on purpose. Sweeping away something unread is how a worker loses
  // "choose your payout, reply before Thursday" without ever having seen it.
  const clearRead = async () => {
    if (notifView !== "inbox" || archivableCount === 0) return;
    setNotifications(prev => prev.filter(n => !n.read));
    setNotifHasMore(false);
    await supabase.from('notifications')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('user_id', user.id).eq('read', true).is('dismissed_at', null);
  };

  const restoreNotification = async (id) => {
    const target = notifications.find(n => n.id === id);
    setNotifications(prev => prev.filter(n => n.id !== id));
    const { error } = await supabase.from('notifications')
      .update({ dismissed_at: null }).eq('id', id);
    // Put the row back if the write failed, rather than leaving the user
    // believing they restored something they did not. Re-inserted in place by
    // created_at, since the list is ordered newest-first.
    if (error && target) {
      setNotifications(prev => [...prev, target].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      ));
    }
  };

  const archiveNotification = async (id) => {
    const target = notifications.find(n => n.id === id);
    setNotifications(prev => prev.filter(n => n.id !== id));
    if (target && !target.read) setUnreadTotal(prev => Math.max(0, prev - 1));
    await supabase.from('notifications')
      .update({ dismissed_at: new Date().toISOString() }).eq('id', id);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("notification.title")}
        style={{
          position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, cursor: "pointer",
          border: `1px solid ${BRAND.border}`, background: BRAND.surface,
          borderRadius: RADIUS.pill, padding: 0, fontFamily: "inherit", fontSize: FS.card,
        }}
      >
        <span aria-hidden="true" style={{ display: "inline-flex" }}><Icons.Bell size={18} /></span>
        {unreadTotal > 0 && (
          <span aria-hidden="true" style={{
            position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, padding: "0 3px",
            borderRadius: RADIUS.pill, background: BRAND.red, color: BRAND.onSolid, fontSize: FS.micro, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
          }}>
            {unreadTotal > 9 ? "9+" : unreadTotal}
          </span>
        )}
      </button>
      {open && panelPos && (
        <div role="menu" style={{
          position: "fixed", top: panelPos.top, left: panelPos.left, zIndex: Z.popover,
          width: panelPos.width, background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: RADIUS.card, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}`,
          }}>
            <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text }}>{t("notification.title")}</div>
            <div style={{ display: "flex", gap: 10 }}>
              {notifView === "inbox" && unreadTotal > 0 && (
                <button
                  onClick={markAllRead}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
                    fontSize: FS.meta, fontWeight: 600, color: BRAND.primaryOnSurface, padding: 0,
                  }}
                >
                  {t("notification.markAllRead")}
                </button>
              )}
              {notifView === "inbox" && archivableCount > 0 && (
                <button
                  onClick={clearRead}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
                    fontSize: FS.meta, fontWeight: 600, color: BRAND.primaryOnSurface, padding: 0,
                  }}
                >
                  {t("notification.clearRead")}
                </button>
              )}
            </div>
          </div>
          {/* Inbox / Archived. Nothing is ever deleted, so the archive has to be
              reachable -- and it is reachable from the same panel the clearing
              happened in, which is where people look for it. */}
          <div style={{ display: "flex", borderBottom: `1px solid ${BRAND.border}` }}>
            {[["inbox", "notification.viewInbox"], ["archived", "notification.viewArchived"]].map(([view, key]) => (
              <button
                key={view}
                onClick={() => { if (notifView !== view) { setNotifView(view); setNotifications([]); setNotifHasMore(false); } }}
                aria-pressed={notifView === view}
                style={{
                  flex: 1, padding: "8px 0", border: "none", cursor: "pointer", fontFamily: "inherit",
                  fontSize: FS.meta, fontWeight: 700,
                  background: notifView === view ? BRAND.grayLight : "transparent",
                  color: notifView === view ? BRAND.primaryOnSurface : BRAND.textMuted,
                  borderBottom: `2px solid ${notifView === view ? BRAND.primaryOnSurface : "transparent"}`,
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center", fontSize: FS.meta, color: BRAND.textMuted }}>
                {t(notifView === "archived" ? "notification.emptyArchived" : "notification.empty")}
              </div>
            ) : (
              notifications.map((n) => {
                const { title: notifTitle, body: notifBody } = notificationText(n, t);
                const notifDead = isNotificationDead(n, deadLinkIds);
                const archived = notifView === "archived";
                return (
                // A row is a container, not a button: it holds the navigating
                // area AND an archive/restore control, and a button inside a
                // button is invalid markup that browsers resolve unpredictably.
                <div
                  key={n.id}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 6,
                    padding: "10px 14px", borderBottom: `1px solid ${BRAND.border}`,
                    background: n.read ? "transparent" : BRAND.grayLight,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? "transparent" : BRAND.grayLight; }}
                >
                  <button
                    role="menuitem"
                    onClick={() => handleNotificationClick(n)}
                    style={{
                      flex: 1, minWidth: 0, display: "flex", alignItems: "flex-start", gap: 8,
                      padding: 0, border: "none", background: "transparent",
                      cursor: notifDead ? "default" : "pointer", fontFamily: "inherit", textAlign: "left",
                    }}
                  >
                    {!n.read && (
                      <span aria-hidden="true" style={{
                        width: 7, height: 7, borderRadius: RADIUS.pill, background: BRAND.primaryOnSurface,
                        marginTop: 5, flexShrink: 0,
                      }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: FS.meta, fontWeight: 700, color: notifDead ? BRAND.textMuted : BRAND.text }}>{notifTitle}</div>
                      {notifBody && (
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.4 }}>{displayProtectedText(notifBody)}</div>
                      )}
                      {/* The record stays -- it really happened -- but says so
                          plainly instead of being a link that goes nowhere. */}
                      {notifDead && (
                        <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginTop: 3, fontStyle: "italic" }}>
                          {t("notification.targetGone")}
                        </div>
                      )}
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4 }}>{notificationTimeAgo(n.created_at, t)}</div>
                    </div>
                  </button>
                  <button
                    onClick={() => (archived ? restoreNotification(n.id) : archiveNotification(n.id))}
                    title={t(archived ? "notification.restore" : "notification.archive")}
                    aria-label={t(archived ? "notification.restore" : "notification.archive")}
                    style={{
                      flexShrink: 0, border: "none", background: "transparent", cursor: "pointer",
                      fontFamily: "inherit", fontSize: FS.meta, lineHeight: 1, padding: "2px 4px",
                      color: BRAND.textMuted,
                    }}
                  >
                    {archived ? "\u21A9" : "\u00D7"}
                  </button>
                </div>
                );
              })
            )}
            {notifHasMore && (
              <button
                onClick={loadMoreNotifications}
                disabled={notifLoadingMore}
                style={{
                  width: "100%", padding: "10px 14px", border: "none", background: "transparent",
                  cursor: notifLoadingMore ? "default" : "pointer", fontFamily: "inherit",
                  fontSize: FS.meta, fontWeight: 600, color: BRAND.primaryOnSurface,
                }}
              >
                {notifLoadingMore ? t("earnings.loadingMoreBtn") : t("earnings.loadMoreBtn")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const StarRating = ({ value = 4.5, size = 14, onClick = null }) => {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <span key={i} style={{ color: i <= Math.round(value) ? BRAND.accent : BRAND.border, fontSize: size }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "inline-block", verticalAlign: "middle" }}>
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill={i <= Math.round(value) ? BRAND.accent : BRAND.border} />
        </svg>
      </span>
    );
  }
  const content = <span>{stars} <span style={{ fontSize: size - 2, color: BRAND.textMuted }}>({value})</span></span>;
  if (!onClick) return content;
  return (
    <span onClick={onClick} role="button" tabIndex={0} style={{ cursor: "pointer" }} onKeyDown={e => { if (e.key === "Enter") onClick(e); }}>
      {content}
    </span>
  );
};

// Interactive 1-5 star picker used by the rating modal (distinct from the
// read-only StarRating display above).
export const StarInput = ({ value = 0, onChange, size = 20 }) => (
  <span style={{ display: "inline-flex", gap: 3 }}>
    {[1, 2, 3, 4, 5].map(i => (
      <button
        key={i}
        type="button"
        onClick={() => onChange(i)}
        aria-label={`${i} star`}
        style={{ background: "none", border: "none", padding: 0, margin: 0, cursor: "pointer", lineHeight: 0 }}
      >
        <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill={i <= value ? BRAND.accent : BRAND.border} />
        </svg>
      </button>
    ))}
  </span>
);

// Per-aspect prompts for the two rating directions (v1 scope). Shared by
// both WorkerPortal and EmployerPortal rating modals.
export const RATING_ASPECTS = {
  employer_to_worker: [
    { value: "onTime", labelKey: "rating.aspect.onTime" },
    { value: "polite", labelKey: "rating.aspect.polite" },
    { value: "hardworking", labelKey: "rating.aspect.hardworking" },
    { value: "followingDirections", labelKey: "rating.aspect.followingDirections" },
    { value: "accountability", labelKey: "rating.aspect.accountability" },
    { value: "rapidAction", labelKey: "rating.aspect.rapidAction" },
  ],
  worker_to_employer: [
    { value: "responsible", labelKey: "rating.aspect.responsible" },
    { value: "kind", labelKey: "rating.aspect.kind" },
    { value: "helpful", labelKey: "rating.aspect.helpful" },
    { value: "organized", labelKey: "rating.aspect.organized" },
    { value: "wellPlanned", labelKey: "rating.aspect.wellPlanned" },
    { value: "clearInstructions", labelKey: "rating.aspect.clearInstructions" },
  ],
};

// Read-only "expand details" view for a ratee's aggregated ratings —
// opened by clicking any of the three StarRating displays. Fetches its
// own data given { rateeId, direction, label, list } where list is
// null (loading) | [] (empty or the ratings table not migrated yet) |
// array of { aspects, overall }. Self-contained: reads t() from context
// directly so callers don't need to prop-drill translate.
export const RatingDetailsModal = ({ modal, onClose, about = null }) => {
  const { t } = useLanguage();
  const dialog = useDialog(Boolean(modal), onClose, { label: t("rating.detailsTitle") });
  if (!modal) return null;
  const aspectDefs = RATING_ASPECTS[modal.direction] || [];
  const list = modal.list;
  const aspectAverages = aspectDefs.map(asp => {
    const scores = (list ?? []).map(r => r.aspects?.[asp.value]).filter(v => typeof v === "number");
    const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
    return { ...asp, avg };
  });
  const overallAvg = list && list.length ? list.reduce((s, r) => s + (r.overall || 0), 0) / list.length : null;
  return (
    <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div {...dialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 420, width: "100%", maxHeight: "85vh", overflowY: "auto", border: `1px solid ${BRAND.border}` }} onClick={e => e.stopPropagation()}>
        <h3 style={{ fontSize: FS.lead, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("rating.detailsTitle")}</h3>
        {modal.label && <p style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: about ? 8 : 16 }}>{modal.label}</p>}
        {about && (
          <div style={{ padding: "10px 12px", borderRadius: RADIUS.control, background: BRAND.grayLight, border: `1px solid ${BRAND.border}`, marginBottom: 16 }}>
            <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 2 }}>{t("shiftDetail.aboutEmployer")}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{about}</div>
          </div>
        )}
        {list === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
        {list && list.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 8 }}>{t("rating.aspectAvgEmpty")}</div>}
        {list && list.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <StarRating value={Number((overallAvg ?? 0).toFixed(1))} />
              <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>({list.length})</span>
            </div>
            {aspectAverages.map(asp => (
              <div key={asp.value} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: FS.meta, color: BRAND.text }}>{t(asp.labelKey)}</span>
                  <span style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.accent }}>{asp.avg != null ? asp.avg.toFixed(1) : "—"}</span>
                </div>
                <Progress value={asp.avg != null ? (asp.avg / 5) * 100 : 0} color={BRAND.accent} />
              </div>
            ))}
          </>
        )}
        <button onClick={onClose} style={{ marginTop: 12, width: "100%", padding: "10px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor: "pointer", color: BRAND.textMuted }}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
};

// Vertical scroll-snap number picker for choosing an hourly bid rate.
// Renders every RM value from `min` to `max` (inclusive) and reports the
// value nearest the centre as the user scrolls, like an iOS picker wheel.
const WageRatePicker = ({ min, max, value, onChange, step = 1 }) => {
  const containerRef = useRef(null);
  const ITEM_H = 40;
  const VISIBLE = 3; // odd number so one item sits centred
  const values = useMemo(() => {
    const out = [];
    for (let v = Math.ceil(min); v <= Math.floor(max); v += step) out.push(v);
    if (out.length === 0) out.push(Math.round(min));
    return out;
  }, [min, max, step]);

  // Scroll to the current value whenever the picker mounts or the value is
  // set externally (e.g. modal reopened).
  useEffect(() => {
    if (!containerRef.current) return;
    const idx = Math.max(0, values.indexOf(Number(value)));
    containerRef.current.scrollTop = idx * ITEM_H;
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
    if (!containerRef.current) return;
    const idx = Math.round(containerRef.current.scrollTop / ITEM_H);
    const clamped = Math.min(values.length - 1, Math.max(0, idx));
    const v = values[clamped];
    if (v !== undefined && v !== Number(value)) onChange(v);
  };

  const padding = (ITEM_H * (VISIBLE - 1)) / 2;

  return (
    <div style={{ position: "relative", height: ITEM_H * VISIBLE }}>
      {/* Centre selection band — solid fill + white text so the selected
          value stays readable regardless of light/dark theme (a pale
          tinted band with coloured text was too low-contrast). */}
      <div style={{
        position: "absolute", top: padding, left: 0, right: 0, height: ITEM_H,
        background: BRAND.primary, borderRadius: RADIUS.control, pointerEvents: "none",
        zIndex: 1,
      }} />
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          position: "relative", zIndex: 2,
          height: "100%", overflowY: "auto", scrollSnapType: "y mandatory",
          WebkitOverflowScrolling: "touch", scrollbarWidth: "none",
        }}
      >
        <div style={{ height: padding }} />
        {values.map(v => (
          <div
            key={v}
            onClick={() => { onChange(v); if (containerRef.current) containerRef.current.scrollTop = values.indexOf(v) * ITEM_H; }}
            style={{
              height: ITEM_H, scrollSnapAlign: "center", display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: v === Number(value) ? FS.h3 : FS.bodyLg,
              fontWeight: v === Number(value) ? 800 : 500,
              color: v === Number(value) ? "#FFFFFF" : BRAND.textMuted,
              cursor: "pointer", transition: "font-size 0.1s, color 0.1s",
            }}
          >
            RM{v}/h
          </div>
        ))}
        <div style={{ height: padding }} />
      </div>
    </div>
  );
};

export const Icons = {
  Search: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  List: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Money: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  User: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Settings: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Camera: ({ size = 48 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2v11z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  Edit: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 20h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chat: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ArrowLeft: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 12H5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronDown: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Rocket: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2s4 1 6 3 3 6 3 6-4 1-6 3-6 6-6 6-4-4-6-6 6-6 6-6 1-4 3-6z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Star: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="#F5A623" />
    </svg>
  ),
  // ---- Added for the BlaBlaCar-style restyle. Same contract as the originals:
  // 24x24 box, 1.6 stroke, and `currentColor` so the caller's `color` drives them.
  Calendar: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Pin: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  Clock: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Users: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.38M15.5 5.2a3.2 3.2 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Bank: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 9.5L12 4l9 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Wallet: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="3" y="7.5" width="18" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="13.25" r="1.25" fill="currentColor" />
    </svg>
  ),
  ChevronRight: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  IdCard: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2.5" y="5" width="19" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 10h4M14 13.5h4M5.4 16.2c.5-1.3 1.7-2 3.1-2s2.6.7 3.1 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  LifeBuoy: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Bug: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 8a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 10H4M20 10h-4M8 14H4.5M20 14h-3.5M9.5 5.5L8 4M14.5 5.5L16 4M12 16v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Gift: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="9" width="18" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 13h18M12 9v11" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 9S10.5 4 8 4a2.2 2.2 0 0 0 0 5zM12 9s1.5-5 4-5a2.2 2.2 0 0 1 0 5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  LogOut: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 16l4-4-4-4M20 12H10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Check: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Shield: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Info: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </svg>
  ),
  Menu: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Lock: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Inbox: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Doc: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Alert: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Flag: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 22v-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Ban: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.7 5.7l12.6 12.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Eye: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Bell: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 20.5a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Sun: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Moon: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  Monitor: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Building: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 21V4h10v17M15 9h4v12M3 21h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 8h3M8.5 12h3M8.5 16h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Scale: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 4v16M8 20h8M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

// Small decorative Icons glyph sitting inline before a text label -- the
// replacement for emoji prefixes that used to live inside translation strings.
export const InlineIcon = ({ icon: I, size = 12 }) => (
  <span aria-hidden="true" style={{ display: "inline-flex", verticalAlign: "-0.15em", marginRight: 4, flexShrink: 0 }}><I size={size} /></span>
);

// ---------------------------------------------------------------------------
// Layout kit
//
// Defined AFTER `Icons` on purpose: several of these render an icon, and this
// file has produced four TDZ white-screens from hoisting something above the
// const it reads. Referencing `Icons` inside a render body is safe; putting it
// in a default parameter would not be, so don't.
//
// The look is lifted from BlaBlaCar: one very large screen title, a two-up
// summary strip, plain chevron rows with hairline rules, money in green, and a
// dotted timeline for anything with a start and an end. The point of extracting
// them is repetition -- the app previously inline-styled every heading and row
// at its call site, which is why no two screens quite matched.
// ---------------------------------------------------------------------------

// The single biggest visual tell of the reference app: a very large, tightly
// tracked title with real whitespace under it.
const ScreenTitle = ({ children, sub, onBack, isMobile, style }) => (
  <div style={{ margin: "4px 0 18px", ...style }}>
    {onBack && (
      <button onClick={onBack} aria-label="Back" style={{
        border: "none", background: "none", cursor: "pointer", padding: "4px 0",
        marginBottom: 10, color: BRAND.primaryOnSurface, display: "flex", alignItems: "center",
      }}>
        <Icons.ArrowLeft size={22} />
      </button>
    )}
    <h1 style={{
      margin: 0, ...(isMobile ? TYPE.titleMobile : TYPE.title), color: BRAND.text,
    }}>{children}</h1>
    {sub && (
      <div style={{ marginTop: 6, fontSize: FS.body, color: BRAND.textMuted, lineHeight: 1.45 }}>{sub}</div>
    )}
  </div>
);

// Two figures side by side, each with its glyph in a pale disc. Reused on
// Payouts, My Bids and Profile so those screens open the same way.
const StatStrip = ({ items = [] }) => (
  <div style={{
    display: "flex", gap: 8, alignItems: "stretch",
    background: BRAND.surface, border: `1px solid ${BRAND.border}`,
    borderRadius: RADIUS.card, padding: "14px 16px", marginBottom: 18,
  }}>
    {items.map((it, i) => (
      <div key={i} style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span aria-hidden="true" style={{
          width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
          // primaryLight is a FIXED-LIGHT token, so its text/icon partner must be
          // onPrimaryLight -- BRAND.primary here would go light-on-light in dark mode.
          background: BRAND.primaryLight, color: BRAND.onPrimaryLight,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{it.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, lineHeight: 1.15 }}>{it.value}</div>
          {/* Wraps rather than truncating. The reference gets away with one line
              because its labels are two short words ("Total rides"); ours are
              translated and run longer, and a clipped "Total Internal Pay..." is
              worse than two lines. */}
          <div style={{
            fontSize: FS.meta, color: BRAND.textMuted, marginTop: 1, lineHeight: 1.3,
          }}>{it.label}</div>
        </div>
      </div>
    ))}
  </div>
);

// A tappable row: glyph, label, optional second line, optional right-hand value,
// chevron. `last` suppresses the rule so a group ends clean.
const ListRow = ({ icon, label, sub, value, onClick, danger, disabled, last, chevron = true }) => {
  const tint = danger ? BRAND.redOnSurface : BRAND.text;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 12,
        padding: "14px 0", border: "none", background: "none",
        cursor: disabled ? "default" : "pointer", fontFamily: "inherit", textAlign: "left",
        color: tint, opacity: disabled ? 0.5 : 1,
        borderBottom: last ? "none" : `1px solid ${BRAND.border}`,
      }}
    >
      {icon && (
        <span aria-hidden="true" style={{
          color: danger ? BRAND.redOnSurface : BRAND.textMuted,
          display: "flex", alignItems: "center", flexShrink: 0,
        }}>{icon}</span>
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: FS.bodyLg, fontWeight: 600, color: tint }}>{label}</span>
        {sub && (
          <span style={{ display: "block", fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.4 }}>{sub}</span>
        )}
      </span>
      {value && <span style={{ fontSize: FS.body, color: BRAND.textMuted, flexShrink: 0 }}>{value}</span>}
      {chevron && !disabled && (
        <span aria-hidden="true" style={{ color: BRAND.textMuted, display: "flex", flexShrink: 0 }}>
          <Icons.ChevronRight size={16} />
        </span>
      )}
    </button>
  );
};

// The reference app's quiet explanatory line, set beside an info glyph.
const InfoNote = ({ children, style }) => (
  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "0 0 18px", ...style }}>
    <span aria-hidden="true" style={{ color: BRAND.textMuted, flexShrink: 0, marginTop: 1, display: "flex" }}>
      <Icons.Info size={18} />
    </span>
    <div style={{ fontSize: FS.meta, lineHeight: 1.5, color: BRAND.textMuted }}>{children}</div>
  </div>
);

// Money set the way the reference does it: full units large, cents raised small.
// Defaults to green because every amount the worker sees is money owed TO them;
// pass a colour for anything that isn't.
const Money = ({ value, color = BRAND.greenOnSurface, size = 17, prefix = "" }) => {
  const n = Number(value || 0);
  // Derive from the SAME formatter every other RM figure in the app uses, so
  // rounding can never disagree between this superscript display and a plain
  // toCurrency() string sitting next to it. toCurrency() always returns
  // "RM 12.34" (fixed 2 decimals, space after RM); strip that fixed prefix and
  // split on the decimal point rather than re-deriving whole/cents with a
  // second, independent round().
  const [whole, cents] = toCurrency(Math.abs(n)).slice(3).split(".");
  return (
    <span style={{ fontWeight: 800, fontSize: size, color, whiteSpace: "nowrap" }}>
      {n < 0 ? "-" : prefix}RM {whole}
      <span style={{ fontSize: Math.round(size * 0.62), verticalAlign: "super", marginLeft: 1 }}>{cents}</span>
    </span>
  );
};

// The worker tab bar. This markup used to exist in THREE places inside
// WorkerPortal and the copies had already drifted: two routed through
// handleWorkerNavClick (which clears the QR / bid-modal / selected-shift state)
// while the third called setTab directly, so leaving the shift-detail screen via
// the tab bar left that state behind. One component, one behaviour.
//
// `item.icon` may be a node or a function of the active flag, so the profile tab
// can swap in the signed-in user's photo the way the reference app does.
const WorkerBottomNav = ({ items, activeId, onSelect, isMobile, style }) => (
  <div style={style}>
    {items.map(n => {
      const active = activeId === n.id;
      return (
        <button key={n.id} onClick={() => onSelect(n.id)}
          aria-current={active ? "page" : undefined}
          style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px",
            border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row",
            alignItems: "center", gap: isMobile ? 3 : 8,
            borderRadius: isMobile ? 0 : RADIUS.control,
            // Icons inherit this through currentColor, so the active tab's glyph
            // now changes colour with its label instead of staying grey.
            color: active ? BRAND.primaryOnSurface : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
          <span style={{ fontSize: isMobile ? FS.card : FS.lead, lineHeight: 1, position: "relative", display: "inline-flex" }}>
            {typeof n.icon === "function" ? n.icon(active) : n.icon}
            {n.badge > 0 && (
              <span aria-hidden="true" style={{
                position: "absolute", top: -5, right: -7, minWidth: 15, height: 15, padding: "0 3px",
                borderRadius: RADIUS.pill, background: BRAND.red, color: BRAND.onSolid, fontSize: FS.micro, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
              }}>{n.badge > 9 ? "9+" : n.badge}</span>
            )}
          </span>
          <span style={{
            fontSize: isMobile ? FS.micro : FS.body, fontWeight: active ? 700 : 500, whiteSpace: "nowrap",
          }}>{n.label}</span>
        </button>
      );
    })}
  </div>
);

export const Progress = ({ value, max = 100, color = BRAND.primary }) => (
  <div style={{ height: 6, background: BRAND.grayLight, borderRadius: RADIUS.pill, overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${(value / max) * 100}%`, background: color, borderRadius: RADIUS.pill, transition: "width 0.3s" }} />
  </div>
);

const formatIdentityNumber = (value, identityType) => {
  if (identityType === "MyKad") {
    const digits = value.replace(/\D/g, "").slice(0, 12);
    if (digits.length <= 6) return digits;
    if (digits.length <= 8) return `${digits.slice(0, 6)}-${digits.slice(6)}`;
    return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
  }
  return value;
};

const extractDateFromIC = (icNumber) => {
  const digits = icNumber.replace(/\D/g, "");
  if (digits.length < 6) return "";
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
};

const assignKYCLevel = (hasFront, hasBack, hasSelfie, hasSupportingDoc) => {
  if (!hasSelfie) return "Basic";
  if ((hasFront || hasBack) && hasSelfie) return "pending_review";
  if (hasSupportingDoc && hasSelfie) return "pending_review";
  return "Basic";
};

export const KYC_BUCKET = "kyc-documents";
const AVATAR_BUCKET = "avatars";
const CANCELLATION_PROOF_BUCKET = "cancellation-proof";

// Downscale + re-encode images client-side before upload to cut storage cost.
const compressImage = (file, maxDim = 1280, quality = 0.82) =>
  new Promise((resolve) => {
    if (!file || !file.type?.startsWith("image/")) return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve(file);
          resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });

export const getAvatarUrl = (path) => {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
};

export const uploadAvatarFile = async (userId, file) => {
  if (!file) return null;
  const compressed = await compressImage(file, 512, 0.85);
  const path = `${userId}/avatar.jpg`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, compressed, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  return path;
};

// Escapes user-controlled strings (names, shift titles) before they're
// written into the print window's document via innerHTML-equivalent write().
const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

// Opens a same-origin popup with a print-ready contract document and
// triggers the browser's print dialog (users choose "Save as PDF" there —
// no PDF-generation library needed, and it stays printable on paper too).
// `rows` is an array of either a string (rendered as a paragraph) or
// {label, value} (rendered as "label value" — used for the signature lines).
// Content is served via a blob: URL (not window.open("") + document.write) —
// with `noopener`, browsers may isolate the new window into a separate
// process with no opener link, so a post-open document.write can silently
// no-op and leave the window blank. Navigating straight to a blob URL avoids
// that race.
// Note: "noopener" is deliberately NOT passed in the window.open features
// string — per spec, that makes window.open() always return null (even when
// the popup isn't blocked), which broke block-detection below and caused the
// blob URL to be revoked instantly, leaving a blank window every time. We
// still sever the opener link, just from the child side after we have a
// handle, which gives the same security property without losing the handle.
export const openContractPrintWindow = ({ heading, subheading, rows }) => {
  const body = rows.map((r) => {
    if (typeof r === "string") return r === "" ? "<br/>" : `<p>${escapeHtml(r)}</p>`;
    if (r.heading) return `<h2>${escapeHtml(r.heading)}</h2>`;
    return `<p><strong>${escapeHtml(r.label)}</strong> ${escapeHtml(r.value)}</p>`;
  }).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; padding: 40px; max-width: 720px; margin: 0 auto; }
  .brand { font-weight: 800; font-size: 18px; margin-bottom: 28px; color: #2563EB; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .sub { font-size: 12px; color: #6b7280; margin-bottom: 24px; }
  p { font-size: 13px; line-height: 1.9; margin: 2px 0; }
  .actions { margin-top: 28px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: none; background: #2563EB; color: #fff; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style></head><body>
<div class="brand">${escapeHtml(SITE.name)}</div>
<h1>${escapeHtml(heading)}</h1>
<div class="sub">${escapeHtml(subheading)}</div>
${body}
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
</body></html>`;
  const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const win = window.open(blobUrl, "_blank", "width=800,height=1000");
  if (!win) { URL.revokeObjectURL(blobUrl); return false; } // popup blocked — caller should toast a hint
  try { win.opener = null; } catch { /* cross-origin edge case — safe to ignore */ }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  win.focus();
  return true;
};

// Builds the full row list for a shift work contract — shared by the
// worker's and employer's on-screen modal and print/PDF output, so the two
// never drift and both carry the same complete job details + full T&Cs
// (owner request 2026-07-26, benchmarked against a real Instaff contract
// PDF: full engagement details, remuneration breakdown, and every T&C
// section, not just a party/wage/signature summary). `termClauses` is the
// perspective-specific "by signing you agree to" list (worker's own 5
// personal obligations, or the employer's own 5) — the shared sections
// below it (attendance, cancellation, health & safety, data privacy,
// disputes, platform role, governing law) apply to both perspectives
// identically since it's one shared contract.
export const buildContractRows = (t, {
  contractRef, generatedAt, employerName, workerName,
  shiftTitle, shiftCategory, shiftLocation, scheduleText, totalHours,
  wageAsk, transportAllowance, dressCode, languages, description,
  termClauses, platformRoleClause, governingLawClause,
  employerSignedAt, workerSignedAt,
}) => {
  const ns = t("contract.notSpecified");
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: MY_TIMEZONE }) : null;
  const hours = Number(totalHours) || 0;
  const estimatedTotal = (Number(wageAsk || 0) * hours + Number(transportAllowance || 0)).toFixed(2);
  return [
    { label: t("contract.contractRefLabel"), value: contractRef },
    { label: t("contract.generatedOnLabel"), value: fmt(generatedAt) || contractRef },
    "",
    { heading: t("contract.sectionParties") },
    { label: t("contract.employerLabel"), value: employerName || ns },
    { label: t("contract.workerLabel"), value: workerName || ns },
    { heading: t("contract.sectionEngagement") },
    { label: t("contract.roleLabel"), value: shiftTitle || ns },
    { label: t("contract.categoryLabel"), value: shiftCategory ? shiftCategoryLabel(shiftCategory, t) : ns },
    { label: t("contract.locationLabel"), value: shiftLocation || ns },
    { label: t("contract.scheduleLabel"), value: scheduleText || ns },
    { label: t("contract.totalHoursLabel"), value: hours ? formatDurationHours(hours) : ns },
    { label: t("contract.dressCodeLabel"), value: dressCode || ns },
    { label: t("contract.languagesLabel"), value: languages || ns },
    ...(description ? [{ label: t("contract.jobDescriptionLabel"), value: description }] : []),
    { heading: t("contract.sectionRemuneration") },
    { label: t("contract.agreedWageLabel"), value: `RM ${wageAsk}/hr` },
    ...(Number(transportAllowance) > 0 ? [{ label: t("contract.transportAllowanceLabel"), value: `RM ${transportAllowance}` }] : []),
    { label: t("contract.estimatedTotalPayLabel"), value: `RM ${estimatedTotal}` },
    t("contract.paymentTimingText"),
    { heading: t("contract.sectionAttendance") },
    t("contract.clauseAttendance"),
    { heading: t("contract.sectionCancellation") },
    t("contract.clauseCancellationNoShow"),
    t("contract.clauseCancellationLateByEmployer"),
    t("contract.clauseCancellationMutual"),
    { heading: t("contract.sectionHealthSafety") },
    t("contract.clauseHealthSafety"),
    { heading: t("contract.sectionDataPrivacy") },
    t("contract.clauseDataPrivacy"),
    { heading: t("contract.sectionDisputes") },
    t("contract.clauseDisputes"),
    { heading: t("contract.agreeToTermsHeading") },
    ...termClauses.map((c, i) => `${i + 1}. ${c}`),
    { heading: t("contract.sectionPlatformRole") },
    platformRoleClause,
    { heading: t("contract.sectionGoverningLaw") },
    governingLawClause,
    { heading: t("employer.contractSignaturesHeading") },
    { label: t("contract.employerLabel"), value: employerSignedAt ? `${t("employer.contractSignedOnPrefix")}${fmt(employerSignedAt)}` : t("employer.contractNotSignedYet") },
    { label: t("contract.workerLabel"), value: workerSignedAt ? `${t("employer.contractSignedOnPrefix")}${fmt(workerSignedAt)}` : t("employer.contractNotSignedYet") },
  ];
};

// Renders the same row list as JSX for the on-screen modal, matching the
// print output structure exactly (see buildContractRows above).
export const renderContractRowsJSX = (rows) => rows.map((r, i) => {
  if (typeof r === "string") return r === "" ? null : <p key={i}>{r}</p>;
  if (r.heading) return <p key={i} style={{ fontWeight: 700, marginTop: 14, marginBottom: 2 }}>{r.heading}</p>;
  return <p key={i}>• <strong>{r.label}</strong> {r.value}</p>;
});

export const uploadKycFile = async (userId, file, label) => {
  if (!file) return null;
  // Compress photos (keep legibility for ID docs); leave PDFs/others untouched.
  const toUpload = file.type?.startsWith("image/") ? await compressImage(file, 1600, 0.8) : file;
  const safeName = toUpload.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${userId}/${Date.now()}-${label}-${safeName}`;
  const { error } = await supabase.storage.from(KYC_BUCKET).upload(path, toUpload, {
    contentType: toUpload.type || "application/octet-stream",
    upsert: true,
  });
  if (error) throw error;
  return path;
};

// Keyed by application id (not worker id, like KYC) since the employer for
// that specific shift also needs read access — see
// 20260711d_cancellation_proof_bucket.sql for the matching RLS.
const uploadCancellationProof = async (applicationId, file) => {
  if (!file) return null;
  const compressed = await compressImage(file, 1600, 0.8);
  const path = `${applicationId}/${Date.now()}-proof.jpg`;
  const { error } = await supabase.storage.from(CANCELLATION_PROOF_BUCKET).upload(path, compressed, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  return path;
};

  const COUNTRIES = [
    { code: "MY", name: "Malaysia", flag: "🇲🇾", dialCode: "+60", placeholder: "e.g. 10-1234567" },
    { code: "AF", name: "Afghanistan", flag: "🇦🇫", dialCode: "+93", placeholder: "e.g. 701-234-567" },
    { code: "AL", name: "Albania", flag: "🇦🇱", dialCode: "+355", placeholder: "e.g. 69-123-4567" },
    { code: "DZ", name: "Algeria", flag: "🇩🇿", dialCode: "+213", placeholder: "e.g. 21-123-4567" },
    { code: "AS", name: "American Samoa", flag: "🇦🇸", dialCode: "+1-684", placeholder: "e.g. 735-1234" },
    { code: "AD", name: "Andorra", flag: "🇦🇩", dialCode: "+376", placeholder: "e.g. 312-345" },
    { code: "AO", name: "Angola", flag: "🇦🇴", dialCode: "+244", placeholder: "e.g. 923-123-456" },
    { code: "AR", name: "Argentina", flag: "🇦🇷", dialCode: "+54", placeholder: "e.g. 11-1234-5678" },
    { code: "AM", name: "Armenia", flag: "🇦🇲", dialCode: "+374", placeholder: "e.g. 10-123-456" },
    { code: "AW", name: "Aruba", flag: "🇦🇼", dialCode: "+297", placeholder: "e.g. 567-1234" },
    { code: "AU", name: "Australia", flag: "🇦🇺", dialCode: "+61", placeholder: "e.g. 2-1234-5678" },
    { code: "AT", name: "Austria", flag: "🇦🇹", dialCode: "+43", placeholder: "e.g. 1-234-5678" },
    { code: "AZ", name: "Azerbaijan", flag: "🇦🇿", dialCode: "+994", placeholder: "e.g. 12-345-6789" },
    { code: "BS", name: "Bahamas", flag: "🇧🇸", dialCode: "+1-242", placeholder: "e.g. 327-1234" },
    { code: "BH", name: "Bahrain", flag: "🇧🇭", dialCode: "+973", placeholder: "e.g. 36-123-456" },
    { code: "BD", name: "Bangladesh", flag: "🇧🇩", dialCode: "+880", placeholder: "e.g. 171-123-4567" },
    { code: "BB", name: "Barbados", flag: "🇧🇧", dialCode: "+1-246", placeholder: "e.g. 430-1234" },
    { code: "BY", name: "Belarus", flag: "🇧🇾", dialCode: "+375", placeholder: "e.g. 17-123-4567" },
    { code: "BE", name: "Belgium", flag: "🇧🇪", dialCode: "+32", placeholder: "e.g. 2-123-4567" },
    { code: "BZ", name: "Belize", flag: "🇧🇿", dialCode: "+501", placeholder: "e.g. 2-123-456" },
    { code: "BJ", name: "Benin", flag: "🇧🇯", dialCode: "+229", placeholder: "e.g. 90-123-456" },
    { code: "BT", name: "Bhutan", flag: "🇧🇹", dialCode: "+975", placeholder: "e.g. 17-123-456" },
    { code: "BO", name: "Bolivia", flag: "🇧🇴", dialCode: "+591", placeholder: "e.g. 2-123-4567" },
    { code: "BA", name: "Bosnia and Herzegovina", flag: "🇧🇦", dialCode: "+387", placeholder: "e.g. 33-123-456" },
    { code: "BW", name: "Botswana", flag: "🇧🇼", dialCode: "+267", placeholder: "e.g. 71-123-4567" },
    { code: "BR", name: "Brazil", flag: "🇧🇷", dialCode: "+55", placeholder: "e.g. 11-91234-5678" },
    { code: "BN", name: "Brunei", flag: "🇧🇳", dialCode: "+673", placeholder: "e.g. 712-3456" },
    { code: "BG", name: "Bulgaria", flag: "🇧🇬", dialCode: "+359", placeholder: "e.g. 2-123-4567" },
    { code: "BF", name: "Burkina Faso", flag: "🇧🇫", dialCode: "+226", placeholder: "e.g. 70-123-456" },
    { code: "BI", name: "Burundi", flag: "🇧🇮", dialCode: "+257", placeholder: "e.g. 79-123-456" },
    { code: "KH", name: "Cambodia", flag: "🇰🇭", dialCode: "+855", placeholder: "e.g. 12-345-678" },
    { code: "CM", name: "Cameroon", flag: "🇨🇲", dialCode: "+237", placeholder: "e.g. 6-123-4567" },
    { code: "CA", name: "Canada", flag: "🇨🇦", dialCode: "+1", placeholder: "e.g. 555-123-4567" },
    { code: "CV", name: "Cape Verde", flag: "🇨🇻", dialCode: "+238", placeholder: "e.g. 99-123-456" },
    { code: "KY", name: "Cayman Islands", flag: "🇰🇾", dialCode: "+1-345", placeholder: "e.g. 945-1234" },
    { code: "CF", name: "Central African Republic", flag: "🇨🇫", dialCode: "+236", placeholder: "e.g. 75-123-456" },
    { code: "TD", name: "Chad", flag: "🇹🇩", dialCode: "+235", placeholder: "e.g. 65-123-456" },
    { code: "CL", name: "Chile", flag: "🇨🇱", dialCode: "+56", placeholder: "e.g. 2-1234-5678" },
    { code: "CN", name: "China", flag: "🇨🇳", dialCode: "+86", placeholder: "e.g. 138-1234-5678" },
    { code: "CO", name: "Colombia", flag: "🇨🇴", dialCode: "+57", placeholder: "e.g. 1-234-5678" },
    { code: "KM", name: "Comoros", flag: "🇰🇲", dialCode: "+269", placeholder: "e.g. 321-23-45" },
    { code: "CG", name: "Congo", flag: "🇨🇬", dialCode: "+242", placeholder: "e.g. 06-123-456" },
    { code: "CD", name: "Congo (DRC)", flag: "🇨🇩", dialCode: "+243", placeholder: "e.g. 81-123-4567" },
    { code: "CR", name: "Costa Rica", flag: "🇨🇷", dialCode: "+506", placeholder: "e.g. 2222-2222" },
    { code: "CI", name: "Côte d'Ivoire", flag: "🇨🇮", dialCode: "+225", placeholder: "e.g. 01-23-45-67" },
    { code: "HR", name: "Croatia", flag: "🇭🇷", dialCode: "+385", placeholder: "e.g. 1-123-4567" },
    { code: "CU", name: "Cuba", flag: "🇨🇺", dialCode: "+53", placeholder: "e.g. 5-123-4567" },
    { code: "CY", name: "Cyprus", flag: "🇨🇾", dialCode: "+357", placeholder: "e.g. 22-123-456" },
    { code: "CZ", name: "Czech Republic", flag: "🇨🇿", dialCode: "+420", placeholder: "e.g. 602-123-456" },
    { code: "DK", name: "Denmark", flag: "🇩🇰", dialCode: "+45", placeholder: "e.g. 12-34-56-78" },
    { code: "DJ", name: "Djibouti", flag: "🇩🇯", dialCode: "+253", placeholder: "e.g. 77-12-34-56" },
    { code: "DM", name: "Dominica", flag: "🇩🇲", dialCode: "+1-767", placeholder: "e.g. 275-1234" },
    { code: "DO", name: "Dominican Republic", flag: "🇩🇴", dialCode: "+1-809", placeholder: "e.g. 829-123-4567" },
    { code: "EC", name: "Ecuador", flag: "🇪🇨", dialCode: "+593", placeholder: "e.g. 9-123-4567" },
    { code: "EG", name: "Egypt", flag: "🇪🇬", dialCode: "+20", placeholder: "e.g. 10-1234-5678" },
    { code: "SV", name: "El Salvador", flag: "🇸🇻", dialCode: "+503", placeholder: "e.g. 7777-7777" },
    { code: "GQ", name: "Equatorial Guinea", flag: "🇬🇶", dialCode: "+240", placeholder: "e.g. 222-123-456" },
    { code: "ER", name: "Eritrea", flag: "🇪🇷", dialCode: "+291", placeholder: "e.g. 7-123-456" },
    { code: "EE", name: "Estonia", flag: "🇪🇪", dialCode: "+372", placeholder: "e.g. 5123-4567" },
    { code: "ET", name: "Ethiopia", flag: "🇪🇹", dialCode: "+251", placeholder: "e.g. 911-23-456" },
    { code: "FJ", name: "Fiji", flag: "🇫🇯", dialCode: "+679", placeholder: "e.g. 701-1234" },
    { code: "FI", name: "Finland", flag: "🇫🇮", dialCode: "+358", placeholder: "e.g. 40-123-4567" },
    { code: "FR", name: "France", flag: "🇫🇷", dialCode: "+33", placeholder: "e.g. 06-12-34-56-78" },
    { code: "PF", name: "French Polynesia", flag: "🇵🇫", dialCode: "+689", placeholder: "e.g. 87-123-456" },
    { code: "GA", name: "Gabon", flag: "🇬🇦", dialCode: "+241", placeholder: "e.g. 06-12-34-56" },
    { code: "GM", name: "Gambia", flag: "🇬🇲", dialCode: "+220", placeholder: "e.g. 301-2345" },
    { code: "GE", name: "Georgia", flag: "🇬🇪", dialCode: "+995", placeholder: "e.g. 599-12-345" },
    { code: "DE", name: "Germany", flag: "🇩🇪", dialCode: "+49", placeholder: "e.g. 151-12345678" },
    { code: "GH", name: "Ghana", flag: "🇬🇭", dialCode: "+233", placeholder: "e.g. 24-123-4567" },
    { code: "GR", name: "Greece", flag: "🇬🇷", dialCode: "+30", placeholder: "e.g. 21-1234-5678" },
    { code: "GD", name: "Grenada", flag: "🇬🇩", dialCode: "+1-473", placeholder: "e.g. 440-1234" },
    { code: "GU", name: "Guam", flag: "🇬🇺", dialCode: "+1-671", placeholder: "e.g. 969-1234" },
    { code: "GT", name: "Guatemala", flag: "🇬🇹", dialCode: "+502", placeholder: "e.g. 4-1234-5678" },
    { code: "GN", name: "Guinea", flag: "🇬🇳", dialCode: "+224", placeholder: "e.g. 30-123-456" },
    { code: "GW", name: "Guinea-Bissau", flag: "🇬🇼", dialCode: "+245", placeholder: "e.g. 95-123-456" },
    { code: "GY", name: "Guyana", flag: "🇬🇾", dialCode: "+592", placeholder: "e.g. 223-1234" },
    { code: "HT", name: "Haiti", flag: "🇭🇹", dialCode: "+509", placeholder: "e.g. 34-12-3456" },
    { code: "HN", name: "Honduras", flag: "🇭🇳", dialCode: "+504", placeholder: "e.g. 9-9123-4567" },
    { code: "HK", name: "Hong Kong", flag: "🇭🇰", dialCode: "+852", placeholder: "e.g. 1234-5678" },
    { code: "HU", name: "Hungary", flag: "🇭🇺", dialCode: "+36", placeholder: "e.g. 20-123-4567" },
    { code: "IS", name: "Iceland", flag: "🇮🇸", dialCode: "+354", placeholder: "e.g. 861-1234" },
    { code: "IR", name: "Iran", flag: "🇮🇷", dialCode: "+98", placeholder: "e.g. 912-123-4567" },
    { code: "IQ", name: "Iraq", flag: "🇮🇶", dialCode: "+964", placeholder: "e.g. 770-123-4567" },
    { code: "IE", name: "Ireland", flag: "🇮🇪", dialCode: "+353", placeholder: "e.g. 87-123-4567" },
    { code: "IL", name: "Israel", flag: "🇮🇱", dialCode: "+972", placeholder: "e.g. 50-123-4567" },
    { code: "IT", name: "Italy", flag: "🇮🇹", dialCode: "+39", placeholder: "e.g. 345-123-4567" },
    { code: "JM", name: "Jamaica", flag: "🇯🇲", dialCode: "+1-876", placeholder: "e.g. 876-123-4567" },
    { code: "JP", name: "Japan", flag: "🇯🇵", dialCode: "+81", placeholder: "e.g. 90-1234-5678" },
    { code: "JO", name: "Jordan", flag: "🇯🇴", dialCode: "+962", placeholder: "e.g. 79-123-4567" },
    { code: "KZ", name: "Kazakhstan", flag: "🇰🇿", dialCode: "+7", placeholder: "e.g. 701-123-4567" },
    { code: "KE", name: "Kenya", flag: "🇰🇪", dialCode: "+254", placeholder: "e.g. 71-123-4567" },
    { code: "KI", name: "Kiribati", flag: "🇰🇮", dialCode: "+686", placeholder: "e.g. 731-2345" },
    { code: "KP", name: "North Korea", flag: "🇰🇵", dialCode: "+850", placeholder: "e.g. 123-4567" },
    { code: "KR", name: "South Korea", flag: "🇰🇷", dialCode: "+82", placeholder: "e.g. 10-1234-5678" },
    { code: "KW", name: "Kuwait", flag: "🇰🇼", dialCode: "+965", placeholder: "e.g. 500-12345" },
    { code: "KG", name: "Kyrgyzstan", flag: "🇰🇬", dialCode: "+996", placeholder: "e.g. 555-123456" },
    { code: "LA", name: "Laos", flag: "🇱🇦", dialCode: "+856", placeholder: "e.g. 20-123-4567" },
    { code: "LV", name: "Latvia", flag: "🇱🇻", dialCode: "+371", placeholder: "e.g. 2-123-4567" },
    { code: "LB", name: "Lebanon", flag: "🇱🇧", dialCode: "+961", placeholder: "e.g. 71-123456" },
    { code: "LS", name: "Lesotho", flag: "🇱🇸", dialCode: "+266", placeholder: "e.g. 58-123-456" },
    { code: "LR", name: "Liberia", flag: "🇱🇷", dialCode: "+231", placeholder: "e.g. 077-123-456" },
    { code: "LY", name: "Libya", flag: "🇱🇾", dialCode: "+218", placeholder: "e.g. 91-123-4567" },
    { code: "LI", name: "Liechtenstein", flag: "🇱🇮", dialCode: "+423", placeholder: "e.g. 660-1234" },
    { code: "LT", name: "Lithuania", flag: "🇱🇹", dialCode: "+370", placeholder: "e.g. 612-34567" },
    { code: "LU", name: "Luxembourg", flag: "🇱🇺", dialCode: "+352", placeholder: "e.g. 621-123456" },
    { code: "MO", name: "Macau", flag: "🇲🇴", dialCode: "+853", placeholder: "e.g. 6-123-4567" },
    { code: "MK", name: "North Macedonia", flag: "🇲🇰", dialCode: "+389", placeholder: "e.g. 70-123-456" },
    { code: "MG", name: "Madagascar", flag: "🇲🇬", dialCode: "+261", placeholder: "e.g. 32-12-345-67" },
    { code: "MW", name: "Malawi", flag: "🇲🇼", dialCode: "+265", placeholder: "e.g. 88-123-4567" },
    { code: "MX", name: "Mexico", flag: "🇲🇽", dialCode: "+52", placeholder: "e.g. 55-1234-5678" },
    { code: "FM", name: "Micronesia", flag: "🇫🇲", dialCode: "+691", placeholder: "e.g. 350-1234" },
    { code: "MD", name: "Moldova", flag: "🇲🇩", dialCode: "+373", placeholder: "e.g. 79-123-456" },
    { code: "MC", name: "Monaco", flag: "🇲🇨", dialCode: "+377", placeholder: "e.g. 6-12-34-56" },
    { code: "MN", name: "Mongolia", flag: "🇲🇳", dialCode: "+976", placeholder: "e.g. 99-123-4567" },
    { code: "ME", name: "Montenegro", flag: "🇲🇪", dialCode: "+382", placeholder: "e.g. 67-123-456" },
    { code: "MA", name: "Morocco", flag: "🇲🇦", dialCode: "+212", placeholder: "e.g. 6-123-45678" },
    { code: "MZ", name: "Mozambique", flag: "🇲🇿", dialCode: "+258", placeholder: "e.g. 82-123-4567" },
    { code: "MM", name: "Myanmar", flag: "🇲🇲", dialCode: "+95", placeholder: "e.g. 9-123-45678" },
    { code: "NA", name: "Namibia", flag: "🇳🇦", dialCode: "+264", placeholder: "e.g. 81-123-4567" },
    { code: "NR", name: "Nauru", flag: "🇳🇷", dialCode: "+674", placeholder: "e.g. 555-1234" },
    { code: "NP", name: "Nepal", flag: "🇳🇵", dialCode: "+977", placeholder: "e.g. 98-123-4567" },
    { code: "NL", name: "Netherlands", flag: "🇳🇱", dialCode: "+31", placeholder: "e.g. 6-1234-5678" },
    { code: "NI", name: "Nicaragua", flag: "🇳🇮", dialCode: "+505", placeholder: "e.g. 8-1234-5678" },
    { code: "NE", name: "Niger", flag: "🇳🇪", dialCode: "+227", placeholder: "e.g. 90-123-456" },
    { code: "NG", name: "Nigeria", flag: "🇳🇬", dialCode: "+234", placeholder: "e.g. 812-123-4567" },
    { code: "NO", name: "Norway", flag: "🇳🇴", dialCode: "+47", placeholder: "e.g. 912-34-567" },
    { code: "OM", name: "Oman", flag: "🇴🇲", dialCode: "+968", placeholder: "e.g. 9-123-4567" },
    { code: "PK", name: "Pakistan", flag: "🇵🇰", dialCode: "+92", placeholder: "e.g. 300-1234567" },
    { code: "PW", name: "Palau", flag: "🇵🇼", dialCode: "+680", placeholder: "e.g. 775-1234" },
    { code: "PA", name: "Panama", flag: "🇵🇦", dialCode: "+507", placeholder: "e.g. 612-3456" },
    { code: "PG", name: "Papua New Guinea", flag: "🇵🇬", dialCode: "+675", placeholder: "e.g. 7-123-4567" },
    { code: "PY", name: "Paraguay", flag: "🇵🇾", dialCode: "+595", placeholder: "e.g. 98-123-456" },
    { code: "PE", name: "Peru", flag: "🇵🇪", dialCode: "+51", placeholder: "e.g. 9-123-45678" },
    { code: "PL", name: "Poland", flag: "🇵🇱", dialCode: "+48", placeholder: "e.g. 512-123-456" },
    { code: "PT", name: "Portugal", flag: "🇵🇹", dialCode: "+351", placeholder: "e.g. 912-345-678" },
    { code: "PR", name: "Puerto Rico", flag: "🇵🇷", dialCode: "+1-787", placeholder: "e.g. 787-123-4567" },
    { code: "QA", name: "Qatar", flag: "🇶🇦", dialCode: "+974", placeholder: "e.g. 33-123-456" },
    { code: "RO", name: "Romania", flag: "🇷🇴", dialCode: "+40", placeholder: "e.g. 72-123-4567" },
    { code: "RU", name: "Russia", flag: "🇷🇺", dialCode: "+7", placeholder: "e.g. 912-123-4567" },
    { code: "RW", name: "Rwanda", flag: "🇷🇼", dialCode: "+250", placeholder: "e.g. 78-123-4567" },
    { code: "WS", name: "Samoa", flag: "🇼🇸", dialCode: "+685", placeholder: "e.g. 72-123" },
    { code: "SM", name: "San Marino", flag: "🇸🇲", dialCode: "+378", placeholder: "e.g. 54-123-456" },
    { code: "ST", name: "Sao Tome & Principe", flag: "🇸🇹", dialCode: "+239", placeholder: "e.g. 99-1234" },
    { code: "SA", name: "Saudi Arabia", flag: "🇸🇦", dialCode: "+966", placeholder: "e.g. 5-123-4567" },
    { code: "SN", name: "Senegal", flag: "🇸🇳", dialCode: "+221", placeholder: "e.g. 77-123-4567" },
    { code: "RS", name: "Serbia", flag: "🇷🇸", dialCode: "+381", placeholder: "e.g. 64-123-4567" },
    { code: "SC", name: "Seychelles", flag: "🇸🇨", dialCode: "+248", placeholder: "e.g. 251-1234" },
    { code: "SL", name: "Sierra Leone", flag: "🇸🇱", dialCode: "+232", placeholder: "e.g. 76-123-456" },
    { code: "SG", name: "Singapore", flag: "🇸🇬", dialCode: "+65", placeholder: "e.g. 6123-4567" },
    { code: "SK", name: "Slovakia", flag: "🇸🇰", dialCode: "+421", placeholder: "e.g. 0912-123-456" },
    { code: "SI", name: "Slovenia", flag: "🇸🇮", dialCode: "+386", placeholder: "e.g. 31-123-456" },
    { code: "SB", name: "Solomon Islands", flag: "🇸🇧", dialCode: "+677", placeholder: "e.g. 7-1234" },
    { code: "SO", name: "Somalia", flag: "🇸🇴", dialCode: "+252", placeholder: "e.g. 61-123-4567" },
    { code: "ZA", name: "South Africa", flag: "🇿🇦", dialCode: "+27", placeholder: "e.g. 82-123-4567" },
    { code: "ES", name: "Spain", flag: "🇪🇸", dialCode: "+34", placeholder: "e.g. 612-34-56-78" },
    { code: "LK", name: "Sri Lanka", flag: "🇱🇰", dialCode: "+94", placeholder: "e.g. 71-123-4567" },
    { code: "SD", name: "Sudan", flag: "🇸🇩", dialCode: "+249", placeholder: "e.g. 9-123-45678" },
    { code: "SR", name: "Suriname", flag: "🇸🇷", dialCode: "+597", placeholder: "e.g. 9-612-3456" },
    { code: "SE", name: "Sweden", flag: "🇸🇪", dialCode: "+46", placeholder: "e.g. 70-123-4567" },
    { code: "CH", name: "Switzerland", flag: "🇨🇭", dialCode: "+41", placeholder: "e.g. 79-123-45-67" },
    { code: "SY", name: "Syria", flag: "🇸🇾", dialCode: "+963", placeholder: "e.g. 94-123-4567" },
    { code: "TW", name: "Taiwan", flag: "🇹🇼", dialCode: "+886", placeholder: "e.g. 912-345-678" },
    { code: "TJ", name: "Tajikistan", flag: "🇹🇯", dialCode: "+992", placeholder: "e.g. 90-123-4567" },
    { code: "TZ", name: "Tanzania", flag: "🇹🇿", dialCode: "+255", placeholder: "e.g. 71-123-4567" },
    { code: "TH", name: "Thailand", flag: "🇹🇭", dialCode: "+66", placeholder: "e.g. 2-123-4567" },
    { code: "TG", name: "Togo", flag: "🇹🇬", dialCode: "+228", placeholder: "e.g. 90-123-456" },
    { code: "TO", name: "Tonga", flag: "🇹🇴", dialCode: "+676", placeholder: "e.g. 77-1234" },
    { code: "TT", name: "Trinidad and Tobago", flag: "🇹🇹", dialCode: "+1-868", placeholder: "e.g. 628-1234" },
    { code: "TN", name: "Tunisia", flag: "🇹🇳", dialCode: "+216", placeholder: "e.g. 20-123-456" },
    { code: "TR", name: "Turkey", flag: "🇹🇷", dialCode: "+90", placeholder: "e.g. 532-123-4567" },
    { code: "TM", name: "Turkmenistan", flag: "🇹🇲", dialCode: "+993", placeholder: "e.g. 62-123-456" },
    { code: "TV", name: "Tuvalu", flag: "🇹🇻", dialCode: "+688", placeholder: "e.g. 90-123" },
    { code: "UG", name: "Uganda", flag: "🇺🇬", dialCode: "+256", placeholder: "e.g. 77-123-4567" },
    { code: "UA", name: "Ukraine", flag: "🇺🇦", dialCode: "+380", placeholder: "e.g. 67-123-4567" },
    { code: "AE", name: "United Arab Emirates", flag: "🇦🇪", dialCode: "+971", placeholder: "e.g. 50-123-4567" },
    { code: "UY", name: "Uruguay", flag: "🇺🇾", dialCode: "+598", placeholder: "e.g. 99-123-456" },
    { code: "UZ", name: "Uzbekistan", flag: "🇺🇿", dialCode: "+998", placeholder: "e.g. 90-123-4567" },
    { code: "VU", name: "Vanuatu", flag: "🇻🇺", dialCode: "+678", placeholder: "e.g. 55-123" },
    { code: "VE", name: "Venezuela", flag: "🇻🇪", dialCode: "+58", placeholder: "e.g. 412-123-4567" },
    { code: "YE", name: "Yemen", flag: "🇾🇪", dialCode: "+967", placeholder: "e.g. 77-123-4567" },
    { code: "ZM", name: "Zambia", flag: "🇿🇲", dialCode: "+260", placeholder: "e.g. 95-123-4567" },
    { code: "ZW", name: "Zimbabwe", flag: "🇿🇼", dialCode: "+263", placeholder: "e.g. 77-123-4567" }
  ];

  const SearchableCountrySelect = ({ label, value, onChange, compact = false, showDial = false }) => {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const inputRef = useRef(null);

    const filtered = COUNTRIES.filter(c =>
      c.name.toLowerCase().startsWith(search.toLowerCase()) ||
      c.code.toLowerCase().startsWith(search.toLowerCase()) ||
      c.dialCode.includes(search)
    );

    const selected = COUNTRIES.find(c => c.code === value);

    const handleSelect = (code) => {
      onChange({ target: { value: code } });
      setOpen(false);
      setSearch("");
    };

    return (
      <div style={{ marginBottom: compact ? 0 : 16, position: "relative" }}>
        {label && !compact && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={{
            width: compact ? 110 : "100%",
            padding: "10px 12px",
            borderRadius: RADIUS.control,
            height: 42,
            border: `1px solid ${BRAND.border}`,
            fontSize: FS.body,
            fontFamily: "inherit",
            color: BRAND.text,
            background: BRAND.input,
            cursor: "pointer",
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "flex-start" : "space-between",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{selected ? (showDial ? <><span>{selected.flag}</span><span style={{ fontWeight: 700 }}>{selected.dialCode}</span></> : selected.name) : (showDial ? t("auth.selectShort") : t("auth.selectCountry"))}</span>
          {!compact && <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none" }}>{Icons.ChevronDown({ size: 14 })}</span>}
        </button>
        {open && (
          <div style={{
            position: "absolute",
            top: "100%",
            left: compact ? 0 : 0,
            right: compact ? "auto" : 0,
            marginTop: 4,
            background: BRAND.surface,
            border: `1px solid ${BRAND.border}`,
            borderRadius: RADIUS.control,
            boxShadow: `0 4px 12px ${BRAND.shadow}`,
            zIndex: 10,
            maxHeight: 200,
            overflowY: "auto",
          }}>
            <input
              type="text"
              placeholder={t("auth.searchCountryPlaceholder")}
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "none",
                borderBottom: `1px solid ${BRAND.border}`,
                fontSize: FS.meta,
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {filtered.map(country => (
              <button
                key={country.code}
                type="button"
                onClick={() => handleSelect(country.code)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  border: "none",
                  background: value === country.code ? BRAND.primaryLight : "#fff",
                  color: BRAND.text,
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: FS.meta,
                  borderBottom: `1px solid ${BRAND.border}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {showDial ? (
                  <>
                    <span style={{ marginRight: 8 }}>{country.flag}</span>
                    <span>{country.name}</span>
                    <span style={{ marginLeft: "auto", fontSize: FS.meta, color: BRAND.textMuted }}>{country.dialCode}</span>
                  </>
                ) : (
                  <span>{country.name}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

// Shared legal text, reused by both the inline registration-form TnCConsent
// and the mandatory post-signup TnCGateModal (the latter exists because
// OAuth signups never see the registration form at all, so consent has to
// be enforced app-wide, not just inside one form).
const TnCLegalText = () => (
  <>
    {/* NOTE: the legal detail below is intentionally left in English —
        dense statutory legal text; translating risks inaccuracy. Deferred, same as
        the Malaysian Labor Law summary panel in Settings. */}
    <strong style={{ color: BRAND.text, fontSize: FS.meta }}>Privacy Notice & Terms of Consent</strong>
    <p style={{ marginTop: 8 }}>
      <strong>1. Data Controller</strong><br />
      {SITE.legalName} ("we", "us") operates this platform and is responsible for the personal data you provide during registration. This notice is issued pursuant to the <strong>Personal Data Protection Act 2010 (Act 709)</strong> ("PDPA").
    </p>
    <p>
      <strong>2. Personal Data Collected</strong><br />
      We collect your full name, national identity card number (MyKad) or passport number, date of birth, residential address, phone number, email address, selfie photograph, and copies of your identity document (front and back). This information is required to complete your account registration and KYC (Know Your Customer) verification.
    </p>
    <p>
      <strong>3. Purpose of Collection</strong><br />
      Your personal data and identity document are collected solely for the following purposes:
    </p>
    <ul style={{ paddingLeft: 16, margin: "4px 0 8px" }}>
      <li>Verifying your identity on the {SITE.name} platform as permitted under the <strong>National Registration Act 1959 (Act 78)</strong>;</li>
      <li>Sharing your identity information with employers who have engaged you for a shift, to enable them to fulfil their statutory record-keeping obligations under the <strong>Employment Act 1955 (Act 265)</strong> and the <strong>Gig Workers Act 2025 (Act 872)</strong>;</li>
      <li>Complying with applicable laws and regulatory requirements.</li>
    </ul>
    <p>
      <strong>4. Disclosure of Personal Data</strong><br />
      Your personal data will only be shared with (a) employers on this platform who have confirmed your engagement for a shift, and (b) relevant government authorities where required by law. We will not sell, rent, or otherwise disclose your data to any third party for marketing purposes.
    </p>
    <p>
      <strong>5. Data Retention</strong><br />
      Your personal data will be retained for as long as your account remains active and for a minimum of seven (7) years after your last transaction to meet legal and audit obligations. You may request deletion of your account; however, retention for statutory compliance purposes may continue where required by law.
    </p>
    <p>
      <strong>6. Your Rights Under PDPA</strong><br />
      You have the right to access, correct, and request the deletion of your personal data held by us. To exercise these rights, please contact us at <strong>support@carigaji.my</strong>. We will respond within fourteen (14) business days.
    </p>
    <p>
      <strong>7. Consent</strong><br />
      By ticking the checkbox, you confirm that you are at least 18 years of age (or have obtained parental/guardian consent), that the information you provide is accurate, and that you voluntarily consent to the collection, processing, and disclosure of your personal data as described above. You acknowledge that providing false identity documents may constitute an offence under Malaysian law.
    </p>
    <p style={{ marginBottom: 0 }}>
      <strong>8. Withdrawal of Consent</strong><br />
      You may withdraw this consent at any time by contacting us, but doing so may limit or terminate your access to the platform.
    </p>
  </>
);

// Shared "scroll to the end before you can tick/accept" behavior, used by
// both TnCConsent (registration form checkbox) and TnCGateModal (mandatory
// post-signup screen). Returns everything a caller needs to render its own
// scroll box + gated action.
const useTnCScrollGate = () => {
  const [hasScrolledToEnd, setHasScrolledToEnd] = useState(false);
  const boxRef = useRef(null);
  const checkScrolledToEnd = (el) => {
    if (!el) return;
    // 4px slop accounts for sub-pixel scroll rounding across browsers.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setHasScrolledToEnd(true);
  };
  const recheck = () => setTimeout(() => checkScrolledToEnd(boxRef.current), 0);
  return { hasScrolledToEnd, boxRef, onScroll: e => checkScrolledToEnd(e.target), recheck };
};

const TnCConsent = ({ checked, onChange, error = false }) => {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const { hasScrolledToEnd, boxRef, onScroll, recheck } = useTnCScrollGate();
  const toggleExpanded = () => {
    setExpanded(v => {
      const next = !v;
      // Short content that never overflows its box counts as already read.
      if (next) recheck();
      return next;
    });
  };
  return (
    <div style={{ marginBottom: 16, ...(error ? { border: `1.5px solid ${BRAND.red}`, borderRadius: RADIUS.control, padding: 10 } : {}) }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: hasScrolledToEnd ? "pointer" : "not-allowed" }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!hasScrolledToEnd}
          onChange={e => onChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: BRAND.primary, flexShrink: 0, width: 16, height: 16 }}
        />
        <span style={{ fontSize: FS.meta, color: error ? BRAND.red : BRAND.text, lineHeight: 1.5 }}>
          {t("auth.tncAgreeText")}{" "}
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.preventDefault(); toggleExpanded(); }}
            onKeyDown={e => e.key === "Enter" && toggleExpanded()}
            style={{ color: BRAND.primaryOnSurface, textDecoration: "underline", cursor: "pointer" }}
          >
            {t("auth.tncLinkText")}
          </span>
          {t("auth.tncSuffixText")}
        </span>
      </label>
      {!hasScrolledToEnd && (
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4, marginLeft: 26 }}>
          {t("auth.tncScrollHint")}
        </div>
      )}
      {expanded && (
        <div
          ref={boxRef}
          onScroll={onScroll}
          style={{ marginTop: 10, padding: "12px 14px", background: BRAND.grayLight, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.7, maxHeight: 240, overflowY: "auto" }}
        >
          <TnCLegalText />
        </div>
      )}
    </div>
  );
};

const SocialAuthButtons = ({ onOAuth, label = "Continue" }) => {
  const { t } = useLanguage();
  const providers = [
    {
      id: "google", name: "Google",
      icon: (
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" fill="#FBBC05"/>
          <path d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A8.98 8.98 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
      ),
    },
    {
      id: "apple", name: "Apple",
      icon: (
        <svg width="16" height="18" viewBox="0 0 16 18" xmlns="http://www.w3.org/2000/svg" fill="#000">
          <path d="M13.24 9.54c-.02-2.02 1.65-2.99 1.72-3.04-.94-1.37-2.4-1.56-2.92-1.58-1.24-.13-2.42.73-3.05.73-.63 0-1.6-.71-2.63-.69-1.35.02-2.6.79-3.3 2-1.4 2.44-.36 6.05 1.01 8.03.67.97 1.47 2.06 2.5 2.02 1-.04 1.39-.65 2.6-.65 1.21 0 1.56.65 2.63.63 1.09-.02 1.78-.99 2.44-1.96.77-1.12 1.09-2.21 1.1-2.27-.02-.01-2.11-.81-2.13-3.21zM11.3 3.6c.55-.67.93-1.6.82-2.53-.8.03-1.76.53-2.33 1.2-.51.59-.96 1.53-.84 2.44.89.07 1.8-.45 2.35-1.11z"/>
        </svg>
      ),
    },
    {
      id: "facebook", name: "Facebook",
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#1877F2">
          <path d="M24 12c0-6.63-5.37-12-12-12S0 5.37 0 12c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08V12h3.05V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.68.23 2.68.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87V12h3.33l-.53 3.47h-2.8v8.38C19.61 22.95 24 17.99 24 12z"/>
        </svg>
      ),
    },
  ];
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 14px" }}>
        <div style={{ flex: 1, height: 1, background: BRAND.border }} />
        <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("auth.oauthDivider")}</span>
        <div style={{ flex: 1, height: 1, background: BRAND.border }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {providers.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOAuth?.(p.id)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              width: "100%", padding: "10px 14px", borderRadius: RADIUS.control,
              border: `1px solid ${BRAND.border}`, background: BRAND.surface,
              color: BRAND.text, fontSize: FS.body, fontWeight: 600, fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {p.icon}
            <span>{t("auth.oauthConnector").replace("{label}", label).replace("{provider}", p.name)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

const AuthModal = ({
  open,
  view,
  form,
  loading,
  message,
  onClose,
  onViewChange,
  onChange,
  onSignIn,
  onRegister,
  onResetPassword,
  onOAuth,
}) => {
  const { t: translate } = useLanguage();
  const dialog = useDialog(open, onClose, { label: view === "register" ? translate("common.signUp") : translate("common.signIn") });
  const [showErrors, setShowErrors] = useState(false);
  // The modal has no fee value of its own, and the promo must not render while
  // the global rate is 0. One read, same pattern as the landing hero and the
  // employer console.
  const [authFeePct, setAuthFeePct] = useState(PLATFORM_FEE_PCT);
  useEffect(() => {
    let active = true;
    supabase.rpc('platform_fee_pct').then(({ data, error }) => {
      if (!active || error || data == null) return;
      setAuthFeePct(Number(data));
    });
    return () => { active = false; };
  }, []);
  const scrollRef = useRef(null);
  // Keep the status message visible without forcing the user to scroll up
  useEffect(() => {
    if (message && scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, [message]);
  useEffect(() => { setShowErrors(false); }, [view, open]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email || "");

  // Progressive sign-up: workers register with just email + password;
  // everything else (name, phone, identity, DOB, address, KYC uploads, T&C)
  // is collected after sign-up by the TnCGateModal → DetailsGateModal
  // sequence, so a new user gets into the app with minimal friction.
  // Employers additionally declare a company name + SSM registration number
  // UP FRONT — deliberately asymmetric, so "Hire workers" isn't a free
  // checkbox anyone ticks on a whim: it demands a real business identity,
  // which then feeds the admin verification queue (a DB trigger auto-queues
  // any submitted SSM as pending_review; only an admin can mark verified).
  const isEmployerSignup = form.accountRole === "employer";
  // SSM number formats: new 12-digit (e.g. 202301012345) or classic
  // registration number (digits + suffix letter, e.g. 1234567-X).
  const ssmFormatOk = /^(\d{12}|\d{1,8}-[A-Za-z])$/.test((form.ssmNumber || "").trim());
  const REGISTER_FIELD_LABELS = {
    email: translate("auth.fieldEmail"),
    password: translate("auth.fieldPassword"),
    confirmPassword: translate("auth.fieldConfirmPassword"),
    companyName: translate("employer.companyNameLabel"),
    ssmNumber: translate("auth.fieldSsmNumber"),
  };
  const registerErrors = {
    email: !emailOk,
    password: !form.password,
    confirmPassword: !form.confirmPassword || form.password !== form.confirmPassword,
    ...(isEmployerSignup ? {
      companyName: !form.companyName?.trim(),
      ssmNumber: !ssmFormatOk,
    } : {}),
  };
  const hasRegisterErrors = Object.values(registerErrors).some(Boolean);
  const fieldError = k => showErrors && registerErrors[k];
  const missingLabels = Object.keys(registerErrors).filter(k => registerErrors[k]).map(k => REGISTER_FIELD_LABELS[k]);

  const handleRegisterSubmit = e => {
    e.preventDefault();
    if (hasRegisterErrors) {
      setShowErrors(true);
      if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    onRegister(e);
  };

  if (!open) return null;

  const copy = {
    signin: {
      title: translate("common.signIn"),
      subtitle: null,
      action: translate("common.signIn"),
    },
    register: {
      title: translate("auth.registerTitle"),
      subtitle: translate("auth.registerSubtitle"),
      action: translate("common.createAccount"),
    },
    reset: {
      title: translate("auth.resetTitle"),
      subtitle: translate("auth.resetSubtitle"),
      action: translate("auth.sendResetEmail"),
    },
  }[view];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div
        {...dialog}
        style={{ width: "100%", maxWidth: view === "register" ? 640 : 440, maxHeight: "90vh", background: BRAND.surface, borderRadius: RADIUS.card, boxShadow: `0 24px 70px ${BRAND.shadow}`, overflow: "hidden", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: `linear-gradient(135deg, ${BRAND.primary}14, ${BRAND.surface})`, flexShrink: 0 }}>
          {/* The header gradient used to run from BRAND.primaryLight -- a FIXED
              near-white, #EFF4FF -- into the theme-aware surface. In dark mode
              that put near-white TITLE text on a near-white left edge, which is
              what "not so visible" was. Both stops are theme-aware now, so the
              gradient stays a subtle lift in either theme.
              The subtitle is dropped on the sign-in view: two labelled fields
              reading "Email address" and "Password" already say everything
              "Use your email and password to access the app" said. Register
              and reset keep theirs, because those genuinely tell you something
              you cannot see -- that a profile and KYC step follows, and that an
              email is about to be sent. */}
          <div>
            <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text }}>{copy.title}</div>
            {copy.subtitle && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4 }}>{copy.subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }} aria-label={translate("common.close")}>{Icons.Close({ size: 20 })}</button>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column" }}>
          {/* chipTone, not a raw hex with BRAND.text on top. This banner is
              where "Invalid login credentials" lands, and it paired a hardcoded
              LIGHT background with theme-aware text: in dark mode that rendered
              pale grey on near-white, which the owner reported as unreadable.
              The tone pairs a fixed-light background with the dark ink meant to
              sit on it, so it reads in both themes. */}
          {message && (
            <div style={{ position: "sticky", top: -20, zIndex: 10, margin: "-20px -4px 16px -4px", padding: "14px 16px", borderRadius: RADIUS.card, ...chipTone("primary"), border: `1.5px solid ${BRAND.primary}`, fontSize: FS.body, fontWeight: 600, lineHeight: 1.5, boxShadow: "0 4px 14px rgba(37,99,235,0.15)" }}>
              {message}
            </div>
          )}
          {/* The offer, on the employer signup path only. A worker seeing
              "two months free" would reasonably wonder what they are being
              charged — nothing, and saying so here would raise the question
              rather than answer it. Gated on a live fee for the same reason
              as everywhere else. */}
          {view === "register" && form.accountRole === "employer" && authFeePct > 0 && (
            <div style={{ margin: "0 -4px 16px -4px", padding: "12px 14px", borderRadius: RADIUS.card, ...chipTone("green"), fontSize: FS.meta, fontWeight: 600, lineHeight: 1.5 }}>
              <InlineIcon icon={Icons.Gift} />{translate("auth.employerFreeTrial")}
            </div>
          )}
          {/* Same defect, same fix: the register-errors banner. */}
          {showErrors && hasRegisterErrors && view === "register" && (
            <div style={{ position: "sticky", top: message ? 52 : -20, zIndex: 9, margin: "0 -4px 16px -4px", padding: "12px 16px", borderRadius: RADIUS.card, ...chipTone("red"), border: `1.5px solid ${BRAND.red}`, fontSize: FS.meta, lineHeight: 1.6 }}>
              <strong>{translate("auth.pleaseCompleteFields")}</strong> {missingLabels.join(", ")}
            </div>
          )}
          {view === "signin" && (
            <form onSubmit={onSignIn}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <PasswordInput label={translate("auth.password")} placeholder={translate("auth.enterYourPassword")} value={form.password} onChange={e => onChange("password", e.target.value)} />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: -6, marginBottom: 16 }}>
                <button type="button" onClick={() => onViewChange("reset")} style={{ border: "none", background: "transparent", color: BRAND.primaryOnSurface, cursor: "pointer", padding: 0, fontSize: FS.meta, fontWeight: 600 }}>{translate("auth.forgetPassword")}</button>
                <button type="button" onClick={() => onViewChange("register")} style={{ border: "none", background: "transparent", color: BRAND.primaryOnSurface, cursor: "pointer", padding: 0, fontSize: FS.meta, fontWeight: 600 }}>{translate("auth.noAccountYet")}</button>
              </div>
              <Btn type="submit" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>{copy.action}</Btn>
              <SocialAuthButtons onOAuth={onOAuth} label={translate("common.signIn")} />
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={onResetPassword}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>{translate("auth.resetHint")}</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
            </form>
          )}

          {view === "register" && (
            <form onSubmit={handleRegisterSubmit} noValidate>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{translate("auth.iWantTo")}</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { value: "worker", title: translate("auth.roleWorkerTitle"), hint: translate("auth.roleWorkerHint") },
                    { value: "employer", title: translate("auth.roleEmployerTitle"), hint: translate("auth.roleEmployerHint") },
                  ].map(opt => (
                    <label key={opt.value} style={{
                      display: "block", padding: "10px 12px", borderRadius: RADIUS.control, cursor: "pointer",
                      border: `1.5px solid ${form.accountRole === opt.value ? BRAND.primary : BRAND.border}`,
                      // A pale, hardcoded-light background (BRAND.primaryLight) with
                      // BRAND.text was unreadable in dark mode (light text on a pale
                      // band that reads as near-white in both themes). Use a solid
                      // primary fill + white text when selected instead, same fix as
                      // the wage-rate picker's earlier contrast bug.
                      background: form.accountRole === opt.value ? BRAND.primary : BRAND.surface,
                    }}>
                      <input type="radio" name="accountRole" value={opt.value} checked={form.accountRole === opt.value} onChange={() => onChange("accountRole", opt.value)} style={{ marginRight: 6 }} />
                      <span style={{ fontSize: FS.meta, fontWeight: 700, color: form.accountRole === opt.value ? "#fff" : BRAND.text }}>{opt.title}</span>
                      <div style={{ fontSize: FS.meta, color: form.accountRole === opt.value ? "rgba(255,255,255,0.85)" : BRAND.textMuted, marginLeft: 20 }}>{opt.hint}</div>
                    </label>
                  ))}
                </div>
              </div>
              {isEmployerSignup && (
                <>
                  <Input label={translate("employer.companyNameLabel")} placeholder={translate("employer.companyNamePlaceholder")} value={form.companyName || ""} onChange={e => onChange("companyName", e.target.value)} error={fieldError("companyName")} />
                  <Input label={translate("auth.fieldSsmNumber")} placeholder="202301012345 / 1234567-X" value={form.ssmNumber || ""} onChange={e => onChange("ssmNumber", e.target.value)} error={fieldError("ssmNumber")} />
                  {form.ssmNumber?.trim() && !ssmFormatOk && (
                    <div style={{ color: BRAND.red, fontSize: FS.meta, marginTop: -10, marginBottom: 12 }}>{translate("auth.ssmFormatHint")}</div>
                  )}
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -6, marginBottom: 14 }}>
                    {translate("auth.employerVerifyNote")}
                  </div>
                </>
              )}
              <Input label={translate("auth.emailAddressReq")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} error={fieldError("email")} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <PasswordInput label={translate("auth.passwordReq")} placeholder={translate("auth.createPassword")} value={form.password} onChange={e => onChange("password", e.target.value)} error={fieldError("password")} />
                <PasswordInput label={translate("auth.confirmPasswordReq")} placeholder={translate("auth.retypePassword")} value={form.confirmPassword} onChange={e => onChange("confirmPassword", e.target.value)} hideToggle={true} error={fieldError("confirmPassword")} />
              </div>
              {form.confirmPassword !== "" && form.password !== form.confirmPassword && (
                <div style={{ color: BRAND.red, fontSize: FS.meta, marginTop: -8, marginBottom: 12 }}>{translate("auth.passwordsNoMatch")}</div>
              )}
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -4, marginBottom: 16 }}>
                {translate("auth.quickSignupHint")}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
              <SocialAuthButtons onOAuth={onOAuth} label={translate("common.signUp")} />
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginTop: 4, textAlign: "center" }}>
                {translate("auth.socialSignupHint")}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

// ADMIN_KYC used to live here: four invented people ("Muhammad Izzat", "Siti
// Rahmah Binti Ali", ...) with fabricated MyKad submissions and review states.
// It was already dead by the time it was removed on 2026-09-13 -- the admin KYC
// queue reads real rows into `kycQueue` from Supabase and has proper loading and
// empty branches -- but invented identity documents should not sit in the bundle
// waiting for someone to wire them back up to a screen that approves real people
// to work. Deleted rather than left commented out.

// Dispute categories shared by the worker/employer file-a-dispute modals and
// the admin dashboard. v1 is informational only — text-only evidence, no
// payout linkage (see supabase/migrations/20260712_disputes.sql).
export const DISPUTE_CATEGORIES = [
  { value: "hours_disputed", labelKey: "dispute.categoryHoursDisputed" },
  { value: "no_show_claim", labelKey: "dispute.categoryNoShowClaim" },
  { value: "unsafe_conditions", labelKey: "dispute.categoryUnsafeConditions" },
  { value: "payment_issue", labelKey: "dispute.categoryPaymentIssue" },
  { value: "other", labelKey: "dispute.categoryOther" },
];

// Raw DB status values (dispute.status, shift.status) rendered as Badge/Pill
// labels across worker/employer/admin views. Translate through these maps
// instead of printing the raw value — see translation blocks above for the
// per-language copy (disputes.status*, employer.shiftStatus*).
const DISPUTE_STATUS_LABEL_KEYS = {
  open: "disputes.statusOpen",
  under_review: "disputes.statusUnderReview",
  resolved: "disputes.statusResolved",
  dismissed: "disputes.statusDismissed",
};
// Generic lookup-map translator: falls back to the raw status if it's ever
// missing from the map, so an unexpected/future DB value degrades to the
// raw string instead of throwing or rendering blank.
const statusLabel = (status, labelKeys, t) => t(labelKeys[status] ?? status);
export const disputeStatusLabel = (status, t) => statusLabel(status, DISPUTE_STATUS_LABEL_KEYS, t);

// ONE status -> tone map for every worker/employer/admin screen. Owner-approved
// design language:
//   blue  = needs action by the viewer   (offer awaiting the worker; applicants
//           an employer still has to review)
//   amber = in progress, no action       (shortlisted)
//   teal  = in progress, on the clock    (checked in -- deliberately NOT the
//           blue of "Offer sent", which means something else)
//   green = settled / good               (confirmed, accepted, completed, paid)
//   gray  = ended normally               (not selected, expired, withdrawn,
//           cancelled, closed) -- NOT red: nothing went wrong
//   red   = genuine problem              (dispute, no-show)
// Same status -> same colour on every screen. The one viewer-dependent case
// is an application still "pending": work for the employer (blue), just
// waiting for the worker (gray).
// kind: "shift" | "application". Display-only pseudo-statuses:
// application "checked_in" and "shift_cancelled".
// Returns { color, icon } -- spread straight into <Pill {...statusTone(..)} />.
const STATUS_TONES = {
  shift: {
    open: { color: "blue", icon: null },
    filled: { color: "green", icon: null },
    completed: { color: "green", icon: null },
    closed: { color: "gray", icon: null },
    cancelled: { color: "gray", icon: null },
    draft: { color: "gray", icon: null },
  },
  application: {
    offered: { color: "blue", icon: Icons.Clock },
    pending: { color: "gray", icon: null },
    shortlisted: { color: "amber", icon: null },
    checked_in: { color: "teal", icon: Icons.Pin },
    accepted: { color: "green", icon: Icons.Check },
    confirmed: { color: "green", icon: Icons.Check },
    completed: { color: "green", icon: Icons.Check },
    paid: { color: "green", icon: Icons.Check },
    rejected: { color: "gray", icon: null },
    expired: { color: "gray", icon: null },
    withdrawn: { color: "gray", icon: null },
    cancelled: { color: "gray", icon: null },
    shift_cancelled: { color: "gray", icon: null },
    disputed: { color: "red", icon: Icons.Alert },
    no_show: { color: "red", icon: Icons.Alert },
  },
};
export const statusTone = (kind, status, viewer = "worker") => {
  if (kind === "application" && status === "pending" && viewer === "employer") return { color: "blue", icon: null };
  return STATUS_TONES[kind]?.[status] ?? { color: "gray", icon: null };
};

// Single-series (one worker, one measure: RM earned) bar chart for the
// Earnings tab. Deliberately plain divs, not SVG or a charting library —
// consistent with the rest of this file, and simple enough not to need
// one. One accent color (BRAND.primary) since there's only one series, a
// single flat baseline instead of a gridded axis, and a tap-to-reveal
// value label on one bar at a time rather than labeling every bar.
const MonthlyEarningsBarChart = ({ months, truncated, isMobile, t }) => {
  const [selectedKey, setSelectedKey] = useState(null);
  useEffect(() => {
    // Default to the most recent month so the chart never opens with no
    // value shown at all.
    if (months.length) setSelectedKey(months[months.length - 1].key);
  }, [months]);

  if (!months.length) {
    return (
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, padding: "16px 0" }}>{t("earnings.monthlyChartEmpty")}</div>
    );
  }

  const max = Math.max(...months.map(m => m.total), 1);
  const selected = months.find(m => m.key === selectedKey) || months[months.length - 1];
  const chartHeight = 120;
  const barMinHeight = 3; // keeps a RM0 month visible/tappable instead of invisible

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text }}>{selected.fullLabel}</div>
        <div style={{ fontSize: FS.bodyLg, fontWeight: 800, color: BRAND.primaryOnSurface, fontVariantNumeric: "tabular-nums" }}>{toCurrency(selected.total)}</div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: isMobile ? 6 : 10, height: chartHeight, overflowX: months.length > 8 ? "auto" : "visible", paddingBottom: 2, borderBottom: `1px solid ${BRAND.border}` }}>
        {months.map(m => {
          const isSelected = m.key === selectedKey;
          const barHeight = Math.max(barMinHeight, Math.round((m.total / max) * (chartHeight - 24)));
          return (
            <button
              key={m.key}
              onClick={() => setSelectedKey(m.key)}
              aria-label={`${m.fullLabel}: ${toCurrency(m.total)}`}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                flex: months.length > 8 ? "0 0 28px" : "1 1 0",
                minWidth: months.length > 8 ? 28 : undefined,
                background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit",
              }}
            >
              <div style={{
                width: "100%", maxWidth: 32, height: barHeight, borderRadius: `${RADIUS.control}px ${RADIUS.control}px 0 0`,
                background: isSelected ? BRAND.primary : `${BRAND.primary}55`,
                transition: "background 0.15s",
              }} />
              <div style={{ fontSize: FS.meta, color: isSelected ? BRAND.text : BRAND.textMuted, fontWeight: isSelected ? 700 : 500, whiteSpace: "nowrap" }}>{m.shortLabel}</div>
            </button>
          );
        })}
      </div>
      {truncated && (
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8 }}>{t("earnings.monthlyChartTruncatedNote")}</div>
      )}
    </div>
  );
};

// Pre-signup landing content shown only to anonymous visitors on the
// Discover tab (see WorkerPortal below) — the shift list alone doesn't
// explain what CariGaji is or why the payment side is safe before someone
// signs up. Built around the platform's actual escrow-style payment
// sequence and existing verification tiers (KYC, SSM) rather than
// fabricated stats or testimonials, since those are real, checkable claims
// this early rather than unverifiable social proof.
// One collapsible section on the landing page. The trust and payment content
// is the trust proposition and is not deleted -- a worker who has been stiffed
// before WILL open it -- but showing all of it to someone still deciding
// whether to look is what made this page 638 words before the first tap.
const LandingSection = ({ id, title, subtitle, openId, onToggle, children }) => {
  const open = openId === id;
  return (
    <div style={{ borderTop: `1px solid ${BRAND.border}` }}>
      <button
        onClick={() => onToggle(open ? null : id)}
        aria-expanded={open}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "16px 0", background: "none", border: "none", cursor: "pointer",
          fontFamily: "inherit", textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: FS.bodyLg, fontWeight: 700, color: BRAND.text }}>{title}</span>
          {subtitle && <span style={{ display: "block", fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>{subtitle}</span>}
        </span>
        <span aria-hidden="true" style={{ fontSize: FS.meta, color: BRAND.textMuted, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ paddingBottom: 20 }}>{children}</div>}
    </div>
  );
};

const DiscoverLandingHero = ({ t, isMobile, onRequireAuth }) => {
  const sectionPad = isMobile ? "20px 16px" : "48px 32px";
  // One section open at a time: this sits directly above the real shift list,
  // and several expanded blocks would push the shifts -- the most persuasive
  // thing on the page -- off the screen again.
  const [openSection, setOpenSection] = useState(null);
  // Same read as the employer console. Anonymous visitors can call this: the
  // rate is not a secret, and the promo must not render when it is zero.
  const [landingFeePct, setLandingFeePct] = useState(PLATFORM_FEE_PCT);
  useEffect(() => {
    let active = true;
    supabase.rpc('platform_fee_pct').then(({ data, error }) => {
      if (!active || error || data == null) return;
      setLandingFeePct(Number(data));
    });
    return () => { active = false; };
  }, []);
  // primaryOnSurface, not primary: every landing eyebrow is 11px primary text
  // sitting on the page, which measures 3.43:1 in dark mode. 11px/800 is not
  // WCAG large text, so 4.5 applies.
  const eyebrowStyle = { fontSize: FS.meta, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: BRAND.primaryOnSurface, marginBottom: 10 };

  const trustItems = [
    { icon: <Icons.IdCard size={20} />, color: BRAND.primary, title: t("landing.trustIdTitle"), body: t("landing.trustIdBody") },
    { icon: <Icons.Building size={20} />, color: BRAND.primary, title: t("landing.trustSsmTitle"), body: t("landing.trustSsmBody") },
    { icon: <Icons.Doc size={20} />, color: BRAND.amber, title: t("landing.trustEscrowTitle"), body: t("landing.trustEscrowBody") },
    { icon: <Icons.Scale size={20} />, color: BRAND.green, title: t("landing.trustDisputeTitle"), body: t("landing.trustDisputeBody") },
  ];

  const moneySteps = [
    { title: t("landing.moneyStep1Title"), body: t("landing.moneyStep1Body"), status: t("landing.moneyStep1Status"), tone: "primary" },
    { title: t("landing.moneyStep2Title"), body: t("landing.moneyStep2Body"), status: t("landing.moneyStep2Status"), tone: "amber" },
    { title: t("landing.moneyStep3Title"), body: t("landing.moneyStep3Body"), status: t("landing.moneyStep3Status"), tone: "amber" },
    { title: t("landing.moneyStep4Title"), body: t("landing.moneyStep4Body"), status: t("landing.moneyStep4Status"), tone: "green" },
  ];

  const howSteps = (prefix) => [1, 2, 3, 4].map(n => t(`intro.${prefix}Step${n}`));

  return (
    <div>
      {/* Hero */}
      <div style={{ padding: sectionPad, paddingBottom: isMobile ? 28 : 40, background: `linear-gradient(160deg, ${BRAND.primary}12, transparent)` }}>
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: isMobile ? 24 : 40, alignItems: "center" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div style={eyebrowStyle}>{t("landing.eyebrow")}</div>
            <h1 style={{ fontSize: isMobile ? FS.h1 : FS.display, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.02em", lineHeight: 1.08, margin: "0 0 14px" }}>
              {t("landing.headline1")}<br />
              <span style={{ color: BRAND.primary }}>{t("landing.headline2")}</span>
            </h1>
            <p style={{ fontSize: isMobile ? FS.body : FS.bodyLg, color: BRAND.textMuted, lineHeight: 1.6, maxWidth: 480, margin: "0 0 20px" }}>{t("landing.subhead")}</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
              {/* Scrolls to the feed rather than opening Register: browsing is
                  free (the line right below says so), and an account is only
                  asked for when the visitor actually bids. */}
              <Btn onClick={() => document.getElementById("open-shifts")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("landing.ctaFindShift")}</Btn>
              <Btn variant="secondary" onClick={() => onRequireAuth("register", "employer")}>{t("landing.ctaPostShift")}</Btn>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: FS.meta, color: BRAND.textMuted }}>
              <span>{t("landing.microFree")}</span><span style={{ color: BRAND.border }}>·</span>
              <span>{t("landing.microKyc")}</span><span style={{ color: BRAND.border }}>·</span>
              <span>{t("landing.microSsm")}</span>
            </div>
          </div>

          {/* Payslip-style sample shift card */}
          <div style={{ flex: "0 0 auto", width: isMobile ? "100%" : 340, position: "relative" }}>
            <div style={{ position: "absolute", top: -16, right: 2, width: 76, height: 76, borderRadius: "50%", border: `2px dashed ${BRAND.green}`, background: BRAND.surfaceElevated, display: "flex", alignItems: "center", justifyContent: "center", transform: "rotate(-8deg)", zIndex: 1 }}>
              <div style={{ textAlign: "center", fontSize: FS.micro, fontWeight: 800, letterSpacing: "0.02em", textTransform: "uppercase", color: BRAND.greenOnSurface, lineHeight: 1.2 }}>{t("landing.sampleSealLine1")}<br />{t("landing.sampleSealLine2")}<br />{t("landing.sampleSealLine3")}</div>
            </div>
            <div style={{ background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card, boxShadow: `0 12px 32px ${BRAND.shadow}`, padding: 18 }}>
              {/* paddingRight keeps the "Pay shown" badge out from under the
                  rotated seal, which overhangs this corner of the card. */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, borderBottom: `1px dashed ${BRAND.border}`, paddingBottom: 12, marginBottom: 12, paddingRight: 64 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: FS.body, color: BRAND.text }}>F&amp;B Server — Corporate Dinner</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}><InlineIcon icon={Icons.Pin} size={11} />Bangsar, Kuala Lumpur</div>
                </div>
                <span style={{ background: BRAND.greenLight, color: BRAND.onGreenLight, fontSize: FS.meta, fontWeight: 800, padding: "3px 8px", borderRadius: RADIUS.pill, whiteSpace: "nowrap" }}><InlineIcon icon={Icons.Check} size={10} />{t("landing.sampleFundedBadge")}</span>
              </div>
              {[[t("landing.sampleRateLabel"), `RM 16.00${t("landing.sampleRateUnit")}`], [t("landing.sampleLengthLabel"), `6${t("landing.sampleLengthUnit")}`], [t("landing.samplePayLabel"), "RM 96.00"]].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: FS.meta, color: BRAND.textMuted, padding: "5px 0" }}>
                  <span>{k}</span><b style={{ color: BRAND.text, fontWeight: 700 }}>{v}</b>
                </div>
              ))}
              <div style={{ marginTop: 10, background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "9px 11px", fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5 }}>
                {t("landing.sampleEscrowNote")}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Everything below the fold is collapsed by default. The page's job is
          to get someone to the shifts; the detail is here for whoever wants it,
          one tap away, rather than in front of everyone who does not. */}
      <div style={{ padding: isMobile ? "0 16px 8px" : "0 32px 16px" }}>
        <LandingSection
          id="pay"
          title={t("landing.sectionPayTitle")}
          subtitle={t("landing.sectionPaySubtitle")}
          openId={openSection}
          onToggle={setOpenSection}
        >
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(4, 1fr)", gap: 16 }}>
          {moneySteps.map((step, i) => (
            <div key={step.title}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: FS.meta, color: BRAND.text, marginBottom: 10 }}>{i + 1}</div>
              <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 5 }}>{step.title}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.55, marginBottom: 10 }}>{step.body}</div>
              <span style={{ fontSize: FS.meta, fontWeight: 700, padding: "4px 9px", borderRadius: RADIUS.control, ...chipTone(step.tone) }}>RM 96.00 · {step.status}</span>
            </div>
          ))}
        </div>
        </LandingSection>

        <LandingSection
          id="trust"
          title={t("landing.sectionTrustTitle")}
          subtitle={t("landing.sectionTrustSubtitle")}
          openId={openSection}
          onToggle={setOpenSection}
        >
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12 }}>
          {trustItems.map(item => (
            <div key={item.title} style={{ background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card, padding: "16px 12px", textAlign: "center" }}>
              <div style={{ width: 42, height: 42, margin: "0 auto 10px", borderRadius: "50%", border: `2px solid ${item.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: FS.lead }}>{item.icon}</div>
              <div style={{ fontWeight: 700, fontSize: FS.meta, color: BRAND.text, marginBottom: 4 }}>{item.title}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5 }}>{item.body}</div>
            </div>
          ))}
        </div>
        </LandingSection>

        <LandingSection
          id="worker"
          title={t("landing.sectionWorkerTitle")}
          subtitle={t("landing.sectionWorkerSubtitle")}
          openId={openSection}
          onToggle={setOpenSection}
        >
          <div>
              {howSteps("worker").map((step, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: i > 0 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontWeight: 800, fontSize: FS.meta, color: BRAND.textMuted, flexShrink: 0, minWidth: 18 }}>{i + 1}</span>
                  <span style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.55 }}>{step}</span>
                </div>
              ))}
            </div>
        </LandingSection>

        {/* Employer content moved out of the default view entirely: 187 words
            addressed to a different reader than the one this page is for. */}
        <LandingSection
          id="employer"
          title={t("landing.sectionEmployerTitle")}
          subtitle={t("landing.sectionEmployerSubtitle")}
          openId={openSection}
          onToggle={setOpenSection}
        >
          <div>
              {howSteps("employer").map((step, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: i > 0 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontWeight: 800, fontSize: FS.meta, color: BRAND.textMuted, flexShrink: 0, minWidth: 18 }}>{i + 1}</span>
                  <span style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.55 }}>{step}</span>
                </div>
              ))}
            </div>
          {/* Gated on a real fee existing. While platform_fee_pct() is 0 this
              says nothing true that isn't already true for everyone, so it
              stays hidden until the rate is switched on. */}
          {landingFeePct > 0 && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: RADIUS.control, ...chipTone("green"), fontSize: FS.meta, fontWeight: 600 }}>
              <InlineIcon icon={Icons.Gift} />{t("landing.employerFreeTrial")}
            </div>
          )}
          <Btn variant="secondary" onClick={() => onRequireAuth("register", "employer")} style={{ marginTop: 14 }}>
            {t("landing.ctaPostShift")}
          </Btn>
        </LandingSection>
      </div>
    </div>
  );
};

// ─── WORKER PORTAL ───────────────────────────────────────────────────────────
const WorkerPortal = ({ onOpenPortal, isMobile = false, user = null, userRole = null, themePreference = "system", setThemePreference = () => {}, onRequireAuth = () => {}, onUserUpdated = () => {}, homeSignal = 0, kycLevel = null, onOpenKycUpload = () => {}, backHandlerRef = null, deepLinkShift = null, linkShiftId = null, onOpenSupportChat = openMailtoSupport, onOpenIssueReport = () => {} }) => {
  const toast = useToast();
  const { t, language, setLanguage } = useLanguage();
  const [avatarUploading, setAvatarUploading] = useState(false);

  // "Return to Worker App" (employer sidebar) / the admin equivalent used to
  // hand the SAME real account straight into a fully-interactive
  // WorkerPortal — user.id was still the employer's own id, and nothing
  // anywhere checked role before writing, so an employer really could place
  // a real bid, sign a real contract, check in/out, rate someone, or file a
  // dispute AS THEMSELVES while just poking around to see what workers see.
  // Preview mode: browsing/viewing stays fully live (that's the point —
  // see the real Discover feed, a real shift's detail, etc.), but every
  // write path below is gated through guardPreview() first.
  // `userRole` is null from mount until the profiles round-trip returns, and
  // the session is restored from localStorage instantly -- so for the first
  // few hundred milliseconds a signed-in WORKER looked exactly like a
  // non-worker. That flashed the amber "Preview only" banner on every cold
  // load, and worse, guardPreview() refused real writes during the gap: tap
  // the avatar or a bid fast enough and you were told to "switch to a worker
  // account" while already signed in as one.
  //
  // So the two questions are now separated. The BANNER asks "do we know this
  // person is not a worker?" -- unknown is not a claim, and we do not make it.
  // The GATE asks "do we know this person IS a worker?" -- and fails closed
  // while unknown, because the whole point of the gate is that an employer
  // must never write as themselves through the worker UI, and a loading
  // window is not a reason to hand that back.
  const roleResolved = userRole !== null;
  const previewMode = Boolean(user) && roleResolved && userRole !== "worker";
  const guardPreview = () => {
    if (!user) return false;              // signed out: the auth prompt handles it
    if (previewMode) { toast(t("worker.previewModeBlocked"), "info"); return true; }
    if (!roleResolved) { toast(t("worker.roleLoading"), "info"); return true; }
    return false;
  };

  // Shared element rather than inline JSX: WorkerPortal has several
  // early-return full-screen views (shift detail, checkout, QR check-in,
  // Sedcard, personal details) that bypass the main layout entirely, so
  // the banner has to be rendered inside each of them or it silently
  // disappears the moment an employer opens a shift — exactly the gap
  // reported after the first pass.
  const previewBanner = previewMode ? (
    <div style={{
      flexShrink: 0, background: BRAND.amberLight, borderBottom: `1px solid ${BRAND.amber}`,
      padding: isMobile ? "8px 12px" : "10px 20px", display: "flex", alignItems: "center",
      justifyContent: "center", gap: 10, flexWrap: "wrap",
    }}>
      {/* onAmberLight, not amber: amberLight is a fixed light surface, and
          BRAND.amber on it measures 2.86:1. Same pairing rule as every other
          *Light surface in this file. */}
      <span style={{ fontSize: FS.meta, color: BRAND.onAmberLight, fontWeight: 600, textAlign: "center" }}>
        <InlineIcon icon={Icons.Eye} />{t("worker.previewModeBanner")}
      </span>
      <Btn size="xs" variant="secondary" onClick={() => onOpenPortal?.(userRole === "employer" ? "employer" : "admin")} style={{ padding: "3px 10px" }}>
        {t("worker.previewModeExitBtn")}
      </Btn>
    </div>
  ) : null;

  // Same referral-share logic as the header's ProfileMenu (account.referFriends)
  // — duplicated locally rather than lifted, since ProfileMenu's copy is a
  // small self-contained closure and this is the only other call site.
  const shareWorkerReferralLink = async () => {
    // The app's front door, never window.location.pathname: now that opening a
    // shift rewrites the address bar, reading the live path would turn a
    // "join CariGaji" referral into a link to whatever shift happened to be
    // open, with the referral wording still attached.
    const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${withLang(language, [])}` : (SITE.siteUrl || "/");
    const shareText = t("account.referShareText");
    if (navigator.share) {
      try { await navigator.share({ title: SITE.name, text: shareText, url: shareUrl }); } catch {} // user cancelled share sheet
      return;
    }
    if (navigator.clipboard) {
      // writeText can reject (e.g. permission explicitly denied by the
      // browser/OS, or a restrictive in-app webview) rather than just being
      // unsupported -- defend against that instead of letting an unhandled
      // rejection silently kill the whole function with zero user feedback.
      try {
        await navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
        toast(t("toast.inviteLinkCopied"), "success");
        return;
      } catch { /* fall through to plain-text fallback below */ }
    }
    toast(shareUrl, "info", 8000);
  };

  const handleAvatarUpload = async (file) => {
    if (!file || !user) return;
    if (guardPreview()) return;
    setAvatarUploading(true);
    try {
      const path = await uploadAvatarFile(user.id, file);
      const { error } = await supabase.auth.updateUser({
        data: { ...user.user_metadata, avatar_url: path },
      });
      if (error) throw error;
      // Mirror to the public profiles table so employers can see the photo.
      // Use the same full_name/name fallback chain used everywhere else in
      // this file — using only .full_name here would null out a name that
      // was backfilled from .name.
      await supabase.from("profiles").upsert(
        { id: user.id, avatar_url: path, full_name: user.user_metadata?.full_name || user.user_metadata?.name || null },
        { onConflict: "id" }
      );
      await onUserUpdated();
      toast(t("toast.avatarUpdated"), "success");
    } catch (err) {
      toast(`${t("toast.avatarUpdateFailed")}${err.message}`, "error");
    }
    setAvatarUploading(false);
  };
  const [profileStats, setProfileStats] = useState({ reliability_score: 0, rating: 0 });
  const [showSedcard, setShowSedcard] = useState(false);
  const [sedcardForm, setSedcardForm] = useState({ bio: "", languagesSpoken: [], qualifications: [], qualificationsOther: "" });
  const [sedcardSaving, setSedcardSaving] = useState(false);

  // Personal Details editor: phone/identity/DOB/address are captured once
  // at signup (DetailsGateModal) with no way to revisit them afterward — a
  // worker with a mistyped phone number had no self-service fix.
  const [showPersonalDetails, setShowPersonalDetails] = useState(false);
  const [personalDetailsForm, setPersonalDetailsForm] = useState({ phone: "", identityType: "MyKad", idNumber: "", dateOfBirth: "", address: "" });
  const [personalDetailsLoaded, setPersonalDetailsLoaded] = useState(false);
  const [personalDetailsSaving, setPersonalDetailsSaving] = useState(false);
  useEffect(() => {
    if (!showPersonalDetails || !user) return;
    let active = true;
    setPersonalDetailsLoaded(false);
    supabase.from('user_private').select('phone, identity_type, id_number, date_of_birth, address').eq('id', user.id).maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        setPersonalDetailsForm({
          phone: data?.phone ?? "",
          identityType: data?.identity_type ?? "MyKad",
          idNumber: data?.id_number ?? "",
          dateOfBirth: data?.date_of_birth ?? "",
          address: data?.address ?? "",
        });
        setPersonalDetailsLoaded(true);
      });
    return () => { active = false; };
  }, [showPersonalDetails, user]);
  const [settingsHelpOpen, setSettingsHelpOpen] = useState(false);
  const settingsHelpDialog = useDialog(settingsHelpOpen, () => setSettingsHelpOpen(false), { label: t("help.title") });
  const [settingsOpenFaq, setSettingsOpenFaq] = useState(null);
  const [workerShiftsDone, setWorkerShiftsDone] = useState(null);
  const [tab, setTab] = useState(() => parseWorkerRoute(initialRouteSegments("worker")).tab ?? "discover");
  // Profile is now two sub-tabs rather than two bottom-nav tabs. Everything that
  // used to live under `tab === "settings"` renders under the Account sub-tab;
  // nothing was deleted, it is one tap deeper.
  const [profileTab, setProfileTab] = useState(() => parseWorkerRoute(initialRouteSegments("worker")).profileTab);

  // "unsupported" | "denied" | "on" | "off". Read from the browser rather than
  // stored: the user can revoke permission in site settings at any time, and a
  // remembered value would go stale without anything noticing. Resolved in an
  // effect because checking for a live subscription is async.
  const [pushState, setPushState] = useState("unsupported");
  useEffect(() => {
    let active = true;
    readPushStatus().then(status => { if (active) setPushState(status); });
    return () => { active = false; };
  }, [user?.id]);
  const [showTnC, setShowTnC] = useState(false);
  const [selectedShift, setSelectedShift] = useState(null);


  const shareShift = async () => {
    if (!selectedShift?.id || typeof window === "undefined") return;
    const url = `${window.location.origin}${shiftToPath(selectedShift.id, language)}`;
    const wage = `RM${selectedShift.wageMin}\u2013${selectedShift.wageMax}/${t("discover.perHour").replace("/", "")}`;
    const text = `${selectedShift.title} \u00b7 ${wage} \u00b7 ${selectedShift.location}`;
    if (navigator.share) {
      try { await navigator.share({ title: selectedShift.title, text, url }); return; } catch { /* share sheet dismissed */ }
    }
    if (navigator.clipboard) {
      try { await navigator.clipboard.writeText(`${text} ${url}`); toast(t("toast.shiftLinkCopied"), "success"); return; } catch { /* clipboard refused */ }
    }
    toast(url, "info", 8000);
  };

  const [showBidModal, setShowBidModal] = useState(false);
  const bidModalDialog = useDialog(showBidModal, () => setShowBidModal(false), { label: t("shiftDetail.placeBidTitle") });
  const [bidAmount, setBidAmount] = useState("");
  const [bidSuccess, setBidSuccess] = useState(false);
  const bidSuccessDialog = useDialog(bidSuccess, () => setBidSuccess(false), { label: t("shiftDetail.bidSubmitted") });
  // Resume the bid flow after sign-in: "Place Bid" while logged out sends the
  // user through the sign-in modal (an overlay, doesn't navigate away), so
  // selectedShift is still intact — this just reopens the bid modal once
  // `user` transitions from null to signed-in, instead of silently dropping
  // the worker's original intent.
  const [pendingBidAfterAuth, setPendingBidAfterAuth] = useState(false);
  useEffect(() => {
    if (user && pendingBidAfterAuth && selectedShift) {
      setBidAmount(String(selectedShift.wageMin));
      setShowBidModal(true);
      setPendingBidAfterAuth(false);
    }
  }, [user, pendingBidAfterAuth, selectedShift]);
  const [filterCat, setFilterCat] = useState("All");
  const [showQR, setShowQR] = useState(false);
  useEffect(() => {
    if (selectedShift?.employerId) loadEmployerAbout([selectedShift.employerId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShift?.employerId]);
  // Which application the check-in screen is acting on — the rotating-code
  // check-in (owner decision 2026-07-25) needs to know which shift/contract
  // to validate against, unlike the old fake camera-simulation modal.
  const [checkinTarget, setCheckinTarget] = useState(null); // { applicationId, shiftTitle }
  const [checkinCode, setCheckinCode] = useState("");
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);
  const [checkinResult, setCheckinResult] = useState(null); // { ok: true } | { ok: false, message }
  // End-of-shift checkout (owner go-ahead 2026-07-26): worker reports actual
  // hours worked after checking in, so payout can reflect real time instead
  // of always the full contracted duration.
  const [checkoutTarget, setCheckoutTarget] = useState(null); // { applicationId, shiftTitle, defaultHours }
  const [respondingHoursModification, setRespondingHoursModification] = useState(null); // applicationId currently accepting/rejecting

  const acceptHoursModification = async (applicationId) => {
    setRespondingHoursModification(applicationId);
    const { error } = await supabase.rpc('worker_accept_modification', { p_application_id: applicationId });
    setRespondingHoursModification(null);
    if (error) { toast(t('toast.acceptModificationFailed') + error.message, 'error'); return; }
    setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? {
      ...a,
      workerReportedHours: a.employerProposedHours,
      employerHoursConfirmedAt: new Date().toISOString(),
      employerHoursDisputed: false,
      employerProposedHours: null,
      employerProposedNote: null,
    } : a));
    toast(t('toast.acceptModificationSuccess'), 'success');
  };

  // "Reject" on an employer proposal is a two-part act -- decline their number
  // AND give your own -- so it opens the hours form straight away instead of
  // rejecting silently and leaving a bare Check Out button. The reject RPC only
  // runs when the worker actually submits, so cancelling leaves the proposal
  // untouched.
  const openResubmitAfterProposal = (a) => {
    setCheckoutTarget({
      applicationId: a.id,
      shiftTitle: a.shiftTitle,
      defaultHours: a.workerReportedHours ?? totalOccurrenceHours(a.shiftOccurrences),
      rejectFirst: true,
      proposal: { hours: a.employerProposedHours, note: a.employerProposedNote },
    });
    setCheckoutHours(""); setCheckoutBreakMinutes(""); setCheckoutNote(""); setCheckoutResult(null);
  };
  const [checkoutHours, setCheckoutHours] = useState("");
  const [checkoutBreakMinutes, setCheckoutBreakMinutes] = useState("");
  const [checkoutNote, setCheckoutNote] = useState("");
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState(null); // { ok: false, message }
  // Lets a worker preview the binding contract terms on the offer-decision
  // screen itself (owner-shared Instaff reference, 2026-07-25) instead of
  // only seeing them after already confirming — set of expanded application
  // ids so multiple offer cards can each toggle independently.
  const [contractPreviewOpenIds, setContractPreviewOpenIds] = useState(() => new Set());
  const [liveApplications, setLiveApplications] = useState(null);
  // My Bids keeps finished bids folded away by default: they are history, and
  // left open they push the bids that still need something below the fold.
  const [showPastBids, setShowPastBids] = useState(false);
  // Worker's own display name, for the contract's "Worker:" party line (was
  // just a generic "You" before — mirrors the employer's own-profile fetch).
  const [workerOwnName, setWorkerOwnName] = useState(null);
  useEffect(() => {
    if (!user) { setWorkerOwnName(null); return; }
    let active = true;
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (active) setWorkerOwnName(data?.full_name || null); });
    return () => { active = false; };
  }, [user]);
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [cancellingBid, setCancellingBid] = useState(false);
  const [workerBanking, setWorkerBanking] = useState(null);
  const [workerBankForm, setWorkerBankForm] = useState({
    bankName: MALAYSIAN_BANK_OPTIONS[0],
    accountHolderName: "",
    accountNumber: "",
  });
  const [bankingLoading, setBankingLoading] = useState(false);
  const [bankingMessage, setBankingMessage] = useState("");
  const [livePayouts, setLivePayouts] = useState(null);
  // Separate from livePayouts (which is capped to the 10 most recent rows
  // for the "Recent Payouts" list — see loadWorkerPayoutData below): a
  // worker who has done more than 10 paid shifts would otherwise see their
  // "Total Internal Payouts" figure quietly undercount real lifetime
  // earnings, since it used to be summed from that same capped list. This
  // unlimited, lightweight (amount + status only) query feeds the total
  // and the stat tiles instead, so they stay correct no matter how much
  // history a worker has.
  const [workerPayoutSummary, setWorkerPayoutSummary] = useState(null);
  const [payoutShiftTitles, setPayoutShiftTitles] = useState({}); // shift_id -> title, for the Earnings list
  const PAYOUT_PAGE_SIZE = 10;
  const [payoutsHasMore, setPayoutsHasMore] = useState(false);
  const [payoutsLoadingMore, setPayoutsLoadingMore] = useState(false);
  const [liveShifts, setLiveShifts] = useState(null);
  // Set by the "View shift" shortcut in a chat room; cleared once the detail
  // view is open so the same shift can be reopened later.
  const [openShiftId, setOpenShiftId] = useState(null);
  const [slipPayout, setSlipPayout] = useState(null);   // payout row shown as a slip
  const slipDialog = useDialog(Boolean(slipPayout), () => setSlipPayout(null), { label: t("slip.title") });
  const [anonEmployerTrust, setAnonEmployerTrust] = useState(null); // employer_id -> {full_name, reliability_score, rating, employer_verification_status}
  const [filterCity, setFilterCity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterPayMin, setFilterPayMin] = useState('');
  const [filterPayMax, setFilterPayMax] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filterDuration, setFilterDuration] = useState('');
  const [filterHighBooking, setFilterHighBooking] = useState(false);
  const [filterWeekend, setFilterWeekend] = useState(false);
  const [filterTimeStart, setFilterTimeStart] = useState('');
  const [filterTimeEnd, setFilterTimeEnd] = useState('');
  const [chatConversations, setChatConversations] = useState([]);
  const [activeChatShift, setActiveChatShift] = useState(null);
  // Who is in the room. Loaded from shift_chat_members (20260823c), not derived
  // client-side: a worker can only see their OWN application row, so co-workers
  // are invisible to them by design -- applications carries wage_ask, which
  // competing bidders must not be able to read.
  const [chatMembers, setChatMembers] = useState(null);
  const [chatMembersOpen, setChatMembersOpen] = useState(false);
  useEffect(() => {
    if (!activeChatShift?.shiftId) { setChatMembers(null); setChatMembersOpen(false); return undefined; }
    let active = true;
    setChatMembers(null);
    supabase.rpc('shift_chat_members', { p_shift: activeChatShift.shiftId })
      .then(({ data, error }) => { if (active) setChatMembers(error ? [] : (data || [])); });
    return () => { active = false; };
  }, [activeChatShift?.shiftId]);
  const { unreadRooms, refreshUnreadChat, roomPreviews, previewSenderNames, unreadRoomIds } = useUnreadChatRooms(user);
  const [chatMessages, setChatMessages] = useState([]);
  // Where the "new messages" divider goes: the read-marker as it stood the
  // instant this room was opened, captured BEFORE the mark-seen effect below
  // moves it forward. Read once per room rather than derived from state, so
  // the line stays put while the room is open instead of sliding down as each
  // arriving message marks itself read.
  //
  // Reopening a room with nothing new gives a marker at or past the newest
  // message, so no divider is drawn -- which is the behaviour asked for: it
  // must not reappear once the messages have been read.
  const [chatUnreadFrom, setChatUnreadFrom] = useState(null);
  useEffect(() => {
    if (!user?.id || !activeChatShift?.shiftId) { setChatUnreadFrom(null); return; }
    setChatUnreadFrom(readChatSeen(user.id)[activeChatShift.shiftId] || null);
  }, [user?.id, activeChatShift?.shiftId]);

  // Opening a room marks it seen, up to its newest message. Runs on
  // chatMessages so a message that arrives while the room is on screen counts
  // as read too -- otherwise the badge would light up for a conversation the
  // user is actively looking at.
  useEffect(() => {
    // `activeChatShift` alone is not "the user is looking at this room":
    // navigating to another tab leaves it set, and its realtime subscription
    // keeps running. Without the visible-tab check, a message arriving while
    // the user is on Discover was marked seen and never raised the badge.
    if (tab !== "chat") return;
    if (!user?.id || !activeChatShift?.shiftId || !chatMessages.length) return;
    const newest = chatMessages[chatMessages.length - 1]?.created_at;
    if (!newest) return;
    writeChatSeen(user.id, activeChatShift.shiftId, newest);
    refreshUnreadChat();
  }, [tab, user?.id, activeChatShift?.shiftId, chatMessages, refreshUnreadChat]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  // sender_id -> full_name for group-chat bubbles (ref mirrors state so the
  // realtime handler can check membership without re-subscribing).
  const [chatSenderNames, setChatSenderNames] = useState({});
  const chatSenderNamesRef = useRef({});
  useEffect(() => { chatSenderNamesRef.current = chatSenderNames; }, [chatSenderNames]);
  const chatEndRef = useRef(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [chatMessages]);
  const [workerContractModal, setWorkerContractModal] = useState(null); // { applicationId, shiftTitle, shiftDate, wageAsk, employerName }
  const workerContractDialog = useDialog(Boolean(workerContractModal), () => setWorkerContractModal(null), { label: t("contract.workerTitle") });
  const [cancellationContractModal, setCancellationContractModal] = useState(null); // { applicationId, shiftTitle, shiftDate, wageAsk }
  const cancellationDialog = useDialog(Boolean(cancellationContractModal), () => setCancellationContractModal(null), { label: t("contract.cancellationTitle") });
  const [cancellationProofUploading, setCancellationProofUploading] = useState(null); // applicationId currently uploading, or null
  const [disputeModal, setDisputeModal] = useState(null); // { applicationId, shiftTitle }
  const workerDisputeDialog = useDialog(Boolean(disputeModal), () => setDisputeModal(null), { label: t("myBids.fileDisputeTitle") });
  const [disputeForm, setDisputeForm] = useState({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  const [filingDispute, setFilingDispute] = useState(false);
  const [myDisputes, setMyDisputes] = useState(null);
  // application_ids this worker has already filed a dispute for — hides the
  // File a Dispute button once filed. Separate from myDisputes above (which
  // only loads on the Settings tab, so it's never available on My Bids where
  // this button lives): confirmed live that without this, a worker could
  // click "File a Dispute" repeatedly and create unlimited duplicate
  // disputes for the same shift, with no client or DB-level guard.
  const [myDisputedApplicationIds, setMyDisputedApplicationIds] = useState(new Set());
  const [ratingModal, setRatingModal] = useState(null); // { applicationId, shiftTitle, rateeId, direction }
  const workerRatingDialog = useDialog(Boolean(ratingModal), () => setRatingModal(null), { label: t("rating.modalTitle") });
  const [ratingForm, setRatingForm] = useState({});
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingComment, setRatingComment] = useState("");   // optional private feedback to the rated person
  // application_ids the signed-in worker has already rated (worker_to_employer
  // direction) — hides the Rate button once filed, mirrors the immutable-once-
  // filed convention already used for disputes.
  const [myRatedApplicationIds, setMyRatedApplicationIds] = useState(new Set());
  // Employers' own "about us" text (get_employer_about), keyed by employer id.
  // Public on purpose -- it is what the employer wrote for workers to read --
  // and fetched through an RPC that returns only that field.
  const [employerAbout, setEmployerAbout] = useState({});
  const loadEmployerAbout = useCallback(async (ids) => {
    const wanted = [...new Set((ids ?? []).filter(Boolean))].filter(id => !(id in employerAbout));
    if (wanted.length === 0) return;
    const { data, error } = await supabase.rpc('get_employer_about', { p_employer_ids: wanted });
    if (error) return;
    setEmployerAbout(prev => {
      const next = { ...prev };
      wanted.forEach(id => { next[id] = null; });
      (data ?? []).forEach(r => { next[r.id] = r.company_description ?? null; });
      return next;
    });
  }, [employerAbout]);
  const [ratingDetailsModal, setRatingDetailsModal] = useState(null); // { rateeId, direction, label, list }
  // Ratings this worker has received from employers — null (not loaded yet)
  // | [] (none) | array of { aspects, overall }. Powers the Profile tab's
  // "Recent Ratings" card, which previously always rendered an empty state
  // regardless of real data (never wired to get_ratee_ratings at all).
  const [myReceivedRatings, setMyReceivedRatings] = useState(null);
  const [myReceivedFeedback, setMyReceivedFeedback] = useState([]);   // comments, private to the rated person
  useEffect(() => {
    if (tab !== "profile" || !user) return;
    let cancelled = false;
    supabase.from('ratings').select('comment, overall, created_at')
      .eq('ratee_id', user.id).eq('direction', 'employer_to_worker').not('comment', 'is', null)
      .order('created_at', { ascending: false }).limit(20)
      .then(({ data, error }) => { if (!cancelled) setMyReceivedFeedback(error ? [] : (data ?? [])); });
    return () => { cancelled = true; };
  }, [tab, user]);

  useEffect(() => {
    if (tab !== "profile" || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_ratee_ratings', { p_ratee_id: user.id, p_direction: 'employer_to_worker' });
        if (!cancelled) setMyReceivedRatings(error ? [] : (data ?? []));
      } catch {
        if (!cancelled) setMyReceivedRatings([]);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, user]);

  // The `ratings` table (20260725b) may not be migrated in prod yet — any
  // query failure (including 42P01 relation-does-not-exist) degrades to an
  // empty/graceful state rather than a crash, same convention as
  // loadApplications/workerHistory falling back to [] on error below.
  useEffect(() => {
    let active = true;
    const loadMyRatings = async () => {
      if (!user) { setMyRatedApplicationIds(new Set()); return; }
      try {
        const { data, error } = await supabase
          .from('ratings')
          .select('application_id')
          .eq('rater_id', user.id)
          .eq('direction', 'worker_to_employer');
        if (!active) return;
        setMyRatedApplicationIds(error ? new Set() : new Set((data ?? []).map(r => r.application_id)));
      } catch {
        if (active) setMyRatedApplicationIds(new Set());
      }
    };
    loadMyRatings();
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    let active = true;
    const loadMyDisputedIds = async () => {
      if (!user) { setMyDisputedApplicationIds(new Set()); return; }
      try {
        const { data, error } = await supabase
          .from('disputes')
          .select('application_id')
          .eq('filed_by', user.id);
        if (!active) return;
        setMyDisputedApplicationIds(error ? new Set() : new Set((data ?? []).map(d => d.application_id)));
      } catch {
        if (active) setMyDisputedApplicationIds(new Set());
      }
    };
    loadMyDisputedIds();
    return () => { active = false; };
  }, [user]);

  // Self-service dispute status view (settings tab) — RLS's disputes_owner_read
  // policy already scopes this to disputes where the signed-in worker is the
  // worker_id or employer_id on the linked application/shift, so no extra
  // .eq() filter is needed here (a worker should also see disputes an
  // employer filed against them, not just ones they filed themselves).
  useEffect(() => {
    // Was `tab !== "settings"`. Settings is now the Account sub-tab of Profile;
    // without this the disputes list would silently never load again.
    if (!supabase || !user || !(tab === "profile" && profileTab === "account")) return;
    let active = true;
    (async () => {
      setMyDisputes(null);
      const { data, error } = await supabase
        .from("disputes")
        .select("id, category, description, status, created_at, resolved_at, filed_by, filed_by_role, application:applications(id, worker_id, shift_id, shift:shifts(id, title, employer_id))")
        .order("created_at", { ascending: false });
      if (!active) return;
      setMyDisputes(error ? [] : (data || []));
    })();
    return () => { active = false; };
  }, [user, tab, profileTab]);

  // Fetch aggregated ratings for the clicked ratee (any StarRating display) —
  // same 42P01-graceful degradation as above.
  const openRatingDetails = (rateeId, direction, label) => {
    if (!rateeId) return;
    setRatingDetailsModal({ rateeId, direction, label, list: null });
    if (direction === 'worker_to_employer') loadEmployerAbout([rateeId]);
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_ratee_ratings', { p_ratee_id: rateeId, p_direction: direction });
        setRatingDetailsModal(m => (m && m.rateeId === rateeId && m.direction === direction) ? { ...m, list: error ? [] : (data ?? []) } : m);
      } catch {
        setRatingDetailsModal(m => (m && m.rateeId === rateeId && m.direction === direction) ? { ...m, list: [] } : m);
      }
    })();
  };

  const submitRating = async () => {
    if (guardPreview()) return;
    if (!ratingModal || !user) return;
    const aspects = RATING_ASPECTS[ratingModal.direction];
    if (aspects.some(a => !ratingForm[a.value])) return;
    const overall = Math.round((aspects.reduce((sum, a) => sum + (ratingForm[a.value] || 0), 0) / aspects.length) * 10) / 10;
    setSubmittingRating(true);
    try {
      const { error } = await supabase.from('ratings').insert({
        application_id: ratingModal.applicationId,
        rater_id: user.id,
        ratee_id: ratingModal.rateeId,
        direction: ratingModal.direction,
        aspects: ratingForm,
        overall,
        comment: ratingComment.trim() || null,
      });
      setSubmittingRating(false);
      if (error) { toast(t('toast.ratingFailed') + error.message, 'error'); return; }
      toast(t('toast.ratingSubmitted'), 'success');
      setMyRatedApplicationIds(prev => new Set(prev).add(ratingModal.applicationId));
      setRatingModal(null);
      setRatingForm({});
      setRatingComment("");
    } catch (err) {
      setSubmittingRating(false);
      toast(t('toast.ratingFailed') + (err?.message ?? ''), 'error');
    }
  };

  // ── Addresses for every page (see usePortalRoute). Ids that arrive in the
  // address (an application, a chat room) resolve once their lists have loaded.
  const [routeShift, setRouteShift] = useState(null);   // { id, n } -- n so the same shift can be re-requested
  const [pendingApplicationId, setPendingApplicationId] = useState(() => parseWorkerRoute(initialRouteSegments("worker")).applicationId);
  const [pendingChatShiftId, setPendingChatShiftId] = useState(() => parseWorkerRoute(initialRouteSegments("worker")).chatShiftId);
  useEffect(() => {
    if (!pendingApplicationId || !liveApplications) return;
    const found = liveApplications.find(a => a.id === pendingApplicationId);
    if (found) setSelectedApplication(found);
    setPendingApplicationId(null);
  }, [pendingApplicationId, liveApplications]);
  useEffect(() => {
    if (!pendingChatShiftId) return undefined;
    const conv = chatConversations.find(c => c.shiftId === pendingChatShiftId);
    if (conv) { setActiveChatShift(conv); setPendingChatShiftId(null); return undefined; }
    const timer = setTimeout(() => setPendingChatShiftId(null), 8000);
    return () => clearTimeout(timer);
  }, [pendingChatShiftId, chatConversations]);
  // A shift page is only offered to search engines when its employer is a real
  // one. Starts false, so a demo shift is never indexable even for an instant.
  const [indexableEmployers, setIndexableEmployers] = useState({});
  useEffect(() => {
    const id = selectedShift?.employerId;
    if (!id || id in indexableEmployers) return;
    supabase.rpc('is_demo_account', { p_user_id: id }).then(({ data, error }) => {
      setIndexableEmployers(prev => ({ ...prev, [id]: !error && data === false }));
    });
  }, [selectedShift?.employerId, indexableEmployers]);
  const workerTabKeys = { applications: "nav.myBids", chat: "nav.chat", earnings: "nav.earnings", profile: "nav.profile" };
  const workerHead = selectedShift?.id
    ? {
        title: `${selectedShift.title} \u2013 ${selectedShift.employer} | ${SITE.name}`,
        description: `${selectedShift.title} \u00b7 RM${selectedShift.wageMin}\u2013${selectedShift.wageMax}/${t("discover.perHour").replace("/", "")} \u00b7 ${selectedShift.location}`,
        index: indexableEmployers[selectedShift.employerId] === true,
      }
    : tab === "discover"
      ? { title: t("seo.homeTitle"), description: t("seo.homeDescription"), index: true }
      : { title: `${t(workerTabKeys[tab] ?? "nav.discover")} | ${SITE.name}`, description: t("seo.homeDescription"), index: false };
  usePortalRoute({
    portal: "worker",
    head: workerHead,
    segments: buildWorkerSegments({ tab, profileTab, shiftId: selectedShift?.id ?? null, applicationId: selectedApplication?.id ?? null, chatShiftId: activeChatShift?.shiftId ?? null }),
    parse: parseWorkerRoute,
    apply: (r) => {
      if (r.shiftId) {
        setSelectedApplication(null);
        if (selectedShift?.id !== r.shiftId) setRouteShift({ id: r.shiftId, n: Date.now() });
        return;
      }
      setSelectedShift(null); setRouteShift(null); setOpenShiftId(null);
      setTab(r.tab);
      if (r.tab === "profile") setProfileTab(r.profileTab);
      setPendingApplicationId(r.applicationId);
      if (!r.applicationId) setSelectedApplication(null);
      setPendingChatShiftId(r.chatShiftId);
      if (!r.chatShiftId) { setActiveChatShift(null); setChatMessages([]); }
    },
  });

  // Mobile back-gesture support: register a handler that closes the topmost
  // open thing and reports whether it handled the gesture. Reassigned every
  // render (no dep array) so the closure always sees current state; consumed
  // by BackGestureManager's popstate listener at the root.
  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => {
      if (showQR) { setShowQR(false); return true; }
      if (checkoutTarget) { setCheckoutTarget(null); return true; }
      if (showSedcard) { setShowSedcard(false); return true; }
      if (showPersonalDetails) { setShowPersonalDetails(false); return true; }
      if (showBidModal) { setShowBidModal(false); return true; }
      if (workerContractModal) { setWorkerContractModal(null); return true; }
      if (cancellationContractModal) { setCancellationContractModal(null); return true; }
      if (disputeModal) { setDisputeModal(null); return true; }
      if (ratingModal) { setRatingModal(null); return true; }
      if (ratingDetailsModal) { setRatingDetailsModal(null); return true; }
      if (activeChatShift) { setActiveChatShift(null); setChatMessages([]); return true; }
      if (selectedApplication) { setSelectedApplication(null); return true; }
      if (selectedShift) { setSelectedShift(null); return true; }
      return false;
    };
    return () => { if (backHandlerRef) backHandlerRef.current = null; };
  });

  // Tell BackGestureManager the user navigated in-app, so it re-arms the
  // history sentinel and the browser's swipe-back preview screenshot stays
  // close to the view back will actually reveal (kills the stale-page ghost).
  // Must cover every piece of state backHandlerRef (above) knows how to
  // close, not just tab/shift/application/chat — any of those left out
  // meant opening it (e.g. the rating or bid modal, a contract view,
  // checkout, Sedcard) never re-armed the sentinel, so swiping back while
  // it was open showed a stale preview of whatever was on screen before it
  // opened instead of the modal itself. That mismatch is exactly the
  // flicker/wrong-page-flash a swipe-back would produce.
  useEffect(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("carigaji:nav"));
  }, [tab, selectedShift, selectedApplication, activeChatShift, showQR, checkoutTarget, showSedcard, showPersonalDetails, showBidModal, workerContractModal, cancellationContractModal, disputeModal, ratingModal, ratingDetailsModal]);

  const navBaseHeight = isMobile ? 60 : 72;
  const navSafeAreaInset = "env(safe-area-inset-bottom, 0px)";
  const navHeight = `calc(${navBaseHeight}px + ${navSafeAreaInset})`;
  const navPadding = `calc(16px + ${navSafeAreaInset})`;

  useEffect(() => {
    if (!user || tab !== 'profile') return;
    let active = true;
    supabase.from('profiles').select('reliability_score, rating, bio, languages_spoken, qualifications, qualifications_other')
      .eq('id', user.id).single()
      .then(({ data }) => {
        if (active && data) {
          setProfileStats({
            reliability_score: data.reliability_score ?? 0,
            rating: data.rating ?? 0
          });
          setSedcardForm({
            bio: data.bio ?? "",
            languagesSpoken: data.languages_spoken ?? [],
            qualifications: data.qualifications ?? [],
            qualificationsOther: data.qualifications_other ?? "",
          });
        }
      });
    return () => { active = false; };
  }, [user, tab]);

  useEffect(() => {
    if (!user || tab !== 'profile') return;
    let active = true;
    setWorkerShiftsDone(null);
    // A shift counts as "done" once the worker's application was accepted
    // and the linked shift itself has moved to 'completed'. Filtered
    // client-side (matches the existing shift-join + client-filter
    // convention used elsewhere in this file).
    supabase
      .from('applications')
      .select('id, shift:shifts(status)')
      .eq('worker_id', user.id)
      .eq('status', 'accepted')
      .then(({ data, error }) => {
        if (!active) return;
        if (error) { setWorkerShiftsDone(null); return; }
        const done = (data || []).filter(a => a.shift?.status === 'completed').length;
        setWorkerShiftsDone(done);
      });
    return () => { active = false; };
  }, [user, tab]);

  useEffect(() => {
    if (!user || tab !== 'chat') return;
    let active = true;
    supabase
      .from('applications')
      .select('shift_id, shift:shifts(id, title, start_at, employer_id, employer:profiles(full_name, avatar_url))')
      .eq('worker_id', user.id)
      .eq('status', 'accepted')
      .then(({ data }) => {
        if (!active) return;
        setChatConversations((data ?? []).map(a => ({
          shiftId: a.shift_id,
          title: displayProtectedText(a.shift?.title ?? 'Shift'),
          date: formatShiftDate(a.shift?.start_at),
          otherUserId: a.shift?.employer_id,
          otherUserLabel: a.shift?.employer?.full_name ? `${a.shift.employer.full_name} (Employer)` : 'Employer',
          // Bare name and photo, kept separate from otherUserLabel: the inbox row
          // now leads with the employer's avatar the way the reference app does,
          // and Avatar needs the name WITHOUT the " (Employer)" suffix to derive
          // sensible initials when there is no photo.
          otherUserName: a.shift?.employer?.full_name ?? null,
          otherUserAvatar: a.shift?.employer?.avatar_url ?? null,
        })));
      });
    return () => { active = false; };
  }, [user, tab]);

  useEffect(() => {
    if (!activeChatShift || !user) return;
    setChatLoading(true);
    let active = true;
    // Group chat (20260719d): one room per shift — every message with a null
    // recipient_id is visible to the employer + all accepted workers.
    const loadSenderNames = (ids) => {
      const missing = [...new Set(ids)].filter(id => id && id !== user.id && !(id in chatSenderNamesRef.current));
      if (!missing.length) return;
      supabase.from('profiles').select('id, full_name').in('id', missing).then(({ data: ps }) => {
        if (!active || !ps) return;
        setChatSenderNames(prev => ({ ...prev, ...Object.fromEntries(ps.map(p => [p.id, p.full_name || null])) }));
      });
    };
    supabase
      .from('messages')
      .select('id, sender_id, content, created_at, read_at')
      .eq('shift_id', activeChatShift.shiftId)
      .is('recipient_id', null)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setChatMessages(data ?? []);
        setChatLoading(false);
        loadSenderNames((data ?? []).map(m => m.sender_id));
      });
    const channel = supabase
      .channel(`chat-${activeChatShift.shiftId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `shift_id=eq.${activeChatShift.shiftId}`,
      }, payload => {
        if (!active || payload.new.recipient_id !== null) return;
        loadSenderNames([payload.new.sender_id]);
        // De-dupe against the sender's own optimistic insert below.
        setChatMessages(prev => prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new]);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [activeChatShift, user]);

  const sendMessage = async () => {
    if (guardPreview()) return;
    if (!chatInput.trim() || !activeChatShift || !user) return;
    const content = chatInput.trim();
    setChatInput('');
    // Insert-then-select so the sender sees their own message immediately,
    // instead of waiting on the Realtime round-trip (which was the cause of
    // messages only appearing after a page refresh).
    const { data, error } = await supabase.from('messages').insert({
      shift_id:     activeChatShift.shiftId,
      sender_id:    user.id,
      recipient_id: null, // group message — visible to the whole shift room
      content,
    }).select('id, sender_id, content, created_at, read_at').single();
    if (error) {
      toast(t('toast.sendFailed') + error.message, 'error');
      setChatInput(content); // restore on failure
      return;
    }
    setChatMessages(prev => prev.some(m => m.id === data.id) ? prev : [...prev, data]);
  };

  useEffect(() => {
    let active = true;
    const loadApplications = async () => {
      if (!user) return setLiveApplications(null);
      // Complete any shift whose last occurrence has ended, BEFORE reading.
      // Ratings, disputes and "shifts done" all key off status = 'completed',
      // and nothing else ever set it (20260911). No pg_cron here, so this is
      // the sweep. Best-effort on purpose: until that migration is applied the
      // RPC does not exist, and loading must not depend on it.
      try { await supabase.rpc('complete_ended_shifts'); } catch { /* sweep is best-effort */ }
      const { data, error } = await supabase
        .from('applications')
        .select('id, shift_id, wage_ask, status, applied_at, offer_expires_at, worker_signed_at, employer_signed_at, checked_in_at, checked_out_at, worker_reported_hours, worker_checkout_note, employer_hours_confirmed_at, employer_hours_disputed, employer_hours_dispute_note, employer_proposed_hours, employer_proposed_note, hours_resubmitted, cancellation_choice, cancellation_choice_deadline, cancellation_proof_path, terms_changed_at, terms_reconfirmed_at, terms_change_summary, no_show_at, no_show_note, shift:shifts(id, title, description, category, location, start_at, end_at, occurrences, wage_min, wage_max, headcount, dress_code, employer_id, transport_allowance, status, language_requirements, employer:profiles(full_name))')
        .eq('worker_id', user.id)
        .order('applied_at', { ascending: false });
      if (!active) return;
      // Fall back to an empty (not null) list on error, so a real query
      // failure shows "No bids yet" rather than an infinite "Loading…" —
      // `null` is reserved for the genuine initial-load state.
      if (error) { console.error('loadApplications failed:', error.message); setLiveApplications([]); return; }
      setLiveApplications((data ?? []).map(a => ({
        id: a.id,
        shiftTitle: displayProtectedText(a.shift?.title ?? 'Shift'),
        employer: a.shift?.employer?.full_name ?? '',
        date: formatShiftDate(a.shift?.start_at) || 'TBA',
        wageBid: Number(a.wage_ask ?? 0),
        status: a.status,
        appliedAt: a.applied_at,
        offerExpiresAt: a.offer_expires_at,
        workerSignedAt: a.worker_signed_at ?? null,
        employerSignedAt: a.employer_signed_at ?? null,
        termsChangedAt: a.terms_changed_at ?? null,
        termsReconfirmedAt: a.terms_reconfirmed_at ?? null,
        termsChangeSummary: a.terms_change_summary ?? null,
        noShowAt: a.no_show_at ?? null,
        noShowNote: a.no_show_note ?? null,
        checkedInAt: a.checked_in_at ?? null,
        checkedOutAt: a.checked_out_at ?? null,
        workerReportedHours: a.worker_reported_hours ?? null,
        workerCheckoutNote: a.worker_checkout_note ?? null,
        employerHoursConfirmedAt: a.employer_hours_confirmed_at ?? null,
        employerHoursDisputed: a.employer_hours_disputed ?? false,
        employerHoursDisputeNote: a.employer_hours_dispute_note ?? null,
        employerProposedHours: a.employer_proposed_hours ?? null,
        employerProposedNote: a.employer_proposed_note ?? null,
        hoursResubmitted: a.hours_resubmitted ?? false,
        cancellationChoice: a.cancellation_choice ?? null,
        cancellationChoiceDeadline: a.cancellation_choice_deadline ?? null,
        cancellationProofPath: a.cancellation_proof_path ?? null,
        shiftId: a.shift_id ?? a.shift?.id ?? null,
        employerId: a.shift?.employer_id ?? null,
        shiftStartAt: a.shift?.start_at ?? null,
        shiftEndAt: a.shift?.end_at ?? null,
        shiftOccurrences: a.shift?.occurrences ?? [],
        isMultiDay: (a.shift?.occurrences ?? []).length > 1,
        shiftLocation: displayProtectedText(a.shift?.location ?? ''),
        shiftCategory: a.shift?.category ?? '',
        shiftWageMin: Number(a.shift?.wage_min ?? 0),
        shiftWageMax: Number(a.shift?.wage_max ?? 0),
        shiftHeadcount: a.shift?.headcount ?? 1,
        shiftDress: displayProtectedText(a.shift?.dress_code ?? ''),
        shiftLanguages: a.shift?.language_requirements ?? [],
        shiftDescription: displayProtectedText(a.shift?.description ?? ''),
        shiftStipend: Number(a.shift?.transport_allowance ?? 0),
        shiftStatus: a.shift?.status ?? null,
      })));
    };
    loadApplications();
    return () => { active = false; };
  }, [user]);

  // ── Attendance recovery: a worker who missed check-in or check-out asks the
  // employer to fix it (worker_request_attendance); the employer checks them in
  // or submits their hours; failing that the worker can raise a dispute.
  const [attendanceRequests, setAttendanceRequests] = useState({});   // `${applicationId}:${kind}` -> latest request
  const attendanceAppIds = (liveApplications ?? []).filter(a => a.status === 'accepted').map(a => a.id).join(',');
  const loadAttendanceRequests = useCallback(async () => {
    if (!attendanceAppIds) { setAttendanceRequests({}); return; }
    const { data, error } = await supabase
      .from('attendance_requests')
      .select('id, application_id, kind, status, note, response_note, created_at')
      .in('application_id', attendanceAppIds.split(','))
      .order('created_at', { ascending: false });
    if (error) return;
    const map = {};
    (data ?? []).forEach(r => { const k = `${r.application_id}:${r.kind}`; if (!map[k]) map[k] = r; });
    setAttendanceRequests(map);
  }, [attendanceAppIds]);
  useEffect(() => { loadAttendanceRequests(); }, [loadAttendanceRequests]);

  const [attendanceRequestTarget, setAttendanceRequestTarget] = useState(null); // { applicationId, kind, shiftTitle }
  const [attendanceRequestNote, setAttendanceRequestNote] = useState("");
  const [sendingAttendanceRequest, setSendingAttendanceRequest] = useState(false);
  const attendanceRequestDialog = useDialog(Boolean(attendanceRequestTarget), () => setAttendanceRequestTarget(null), { label: t("attendance.requestTitle") });
  const sendAttendanceRequest = async () => {
    if (!attendanceRequestTarget) return;
    setSendingAttendanceRequest(true);
    const { error } = await supabase.rpc('worker_request_attendance', {
      p_application_id: attendanceRequestTarget.applicationId,
      p_kind: attendanceRequestTarget.kind,
      p_note: attendanceRequestNote.trim() || null,
    });
    setSendingAttendanceRequest(false);
    if (error) { toast(error.message, 'error'); return; }
    setAttendanceRequestTarget(null);
    setAttendanceRequestNote("");
    toast(t('attendance.requestSent'), 'success');
    loadAttendanceRequests();
  };

  // Best-effort expiry sweep: flip any of the worker's own offers whose
  // deadline has passed to 'expired' (permitted by applications_expire_offer).
  useEffect(() => {
    const stale = (liveApplications ?? []).filter(a => a.status === 'offered' && a.offerExpiresAt && new Date(a.offerExpiresAt) < new Date());
    if (stale.length === 0) return;
    stale.forEach(a => {
      supabase.from('applications').update({ status: 'expired' }).eq('id', a.id).then(({ error }) => {
        if (!error) setLiveApplications(prev => (prev ?? []).map(x => x.id === a.id ? { ...x, status: 'expired' } : x));
      });
    });
  }, [liveApplications]);

  // Same lazy-expiry pattern for the late-cancellation choice: default any
  // unanswered choice to the 50% contract once the deadline has passed
  // (permitted by applications_cancellation_choice_expire).
  useEffect(() => {
    const stale = (liveApplications ?? []).filter(a => a.cancellationChoiceDeadline && !a.cancellationChoice && new Date(a.cancellationChoiceDeadline) < new Date());
    if (stale.length === 0) return;
    stale.forEach(a => {
      supabase.from('applications').update({ cancellation_choice: 'contract_50' }).eq('id', a.id).then(({ error }) => {
        if (!error) setLiveApplications(prev => (prev ?? []).map(x => x.id === a.id ? { ...x, cancellationChoice: 'contract_50' } : x));
      });
    });
  }, [liveApplications]);

  const [respondingOffer, setRespondingOffer] = useState(false);
  const [reconfirming, setReconfirming] = useState(false);
  // Worker confirms a shift offer -> status becomes 'accepted', which then
  // unlocks the existing digital-contract signing step (Sign Contract button).
  const confirmOffer = async (applicationId) => {
    if (guardPreview()) return;
    setRespondingOffer(true);
    const { error } = await supabase.from('applications').update({ status: 'accepted' }).eq('id', applicationId);
    setRespondingOffer(false);
    if (error) { toast(t('toast.confirmOfferFailed') + error.message, 'error'); return; }
    toast(t('toast.shiftConfirmed'), 'success');
    setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, status: 'accepted' } : a));
    setSelectedApplication(prev => prev && prev.id === applicationId ? { ...prev, status: 'accepted' } : prev);
  };
  // Withdrawal tiers, read from the DB so the penalty a worker is warned about
  // is the one the server will actually apply.
  const [withdrawTiers, setWithdrawTiers] = useState(null);
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    supabase.from('cancellation_tiers')
      .select('min_notice_hours, reliability_penalty')
      .eq('party', 'worker')
      .then(({ data, error }) => {
        if (!active || error || !data) return;
        setWithdrawTiers(data.map(r => ({
          minNoticeHours: Number(r.min_notice_hours),
          penalty: Number(r.reliability_penalty ?? 0),
        })));
      });
    return () => { active = false; };
  }, [user]);

  const [withdrawTarget, setWithdrawTarget] = useState(null); // application, or null
  const withdrawDialog = useDialog(Boolean(withdrawTarget), () => setWithdrawTarget(null), { label: t("withdraw.title") });
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  // Withdraw from a booking already accepted. Always permitted -- see the
  // migration notes on why an employer-approval gate would produce no-shows
  // rather than attendance -- but the cost is shown plainly first.
  const confirmWithdraw = async () => {
    if (guardPreview() || !withdrawTarget) return;
    setWithdrawing(true);
    const { error } = await supabase.rpc('worker_withdraw_from_shift', {
      p_application_id: withdrawTarget.id,
      p_reason: withdrawReason.trim() || null,
    });
    setWithdrawing(false);
    if (error) { toast(t('withdraw.failed') + error.message, 'error'); return; }
    toast(t('withdraw.done'), 'success');
    setLiveApplications(prev => (prev ?? []).map(a => a.id === withdrawTarget.id ? { ...a, status: 'withdrawn' } : a));
    setSelectedApplication(prev => prev && prev.id === withdrawTarget.id ? { ...prev, status: 'withdrawn' } : prev);
    setWithdrawTarget(null);
    setWithdrawReason("");
  };

  // Worker re-confirms terms the employer changed after they signed. Goes
  // through the RPC rather than a direct UPDATE: terms_reconfirmed_at is
  // guarded, so a plain PATCH is silently reverted -- deliberately, since
  // otherwise a worker could clear the hold without ever seeing the change.
  const reconfirmTerms = async (applicationId) => {
    if (guardPreview()) return;
    setReconfirming(true);
    const { error } = await supabase.rpc('worker_reconfirm_terms', { p_application_id: applicationId });
    setReconfirming(false);
    if (error) { toast(t('reconfirm.failed'), 'error'); return; }
    toast(t('reconfirm.done'), 'success');
    const now = new Date().toISOString();
    setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, termsReconfirmedAt: now } : a));
    setSelectedApplication(prev => prev && prev.id === applicationId ? { ...prev, termsReconfirmedAt: now } : prev);
  };

  // Worker declines an offer -> employer is notified (via DB trigger) to pick a substitute.
  const declineOffer = async (applicationId) => {
    if (guardPreview()) return;
    setRespondingOffer(true);
    const { error } = await supabase.from('applications').update({ status: 'rejected' }).eq('id', applicationId);
    setRespondingOffer(false);
    if (error) { toast(t('toast.declineOfferFailed') + error.message, 'error'); return; }
    toast(t('toast.offerDeclined'), 'success');
    setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, status: 'rejected' } : a));
    setSelectedApplication(prev => prev && prev.id === applicationId ? { ...prev, status: 'rejected' } : prev);
  };

  // Cancel (withdraw) a pending bid. Matches the RLS policy: worker may
  // update their own application from 'pending' to 'withdrawn' only.
  const cancelBid = async (applicationId) => {
    if (guardPreview()) return;
    setCancellingBid(true);
    const { error } = await supabase.from('applications').update({ status: 'withdrawn' }).eq('id', applicationId);
    setCancellingBid(false);
    if (error) { toast(t('toast.cancelBidFailed') + error.message, 'error'); return; }
    toast(t('toast.bidCancelled'), 'success');
    setLiveApplications(prev => (prev ?? []).filter(a => a.id !== applicationId));
    setSelectedApplication(null);
  };

  // Worker chooses to show up for full pay: sets cancellation_choice first
  // (RLS: applications_worker_cancellation_choice, only while a deadline is
  // stamped and no choice made yet), then uploads the proof photo and sets
  // cancellation_proof_path (RLS: applications_worker_cancellation_proof).
  // The payout itself is created server-side by trg_create_cancellation_payout
  // once the proof path lands — never trust a client-computed amount.
  const submitShowUpProof = async (applicationId, file) => {
    if (guardPreview()) return;
    if (!file) return;
    setCancellationProofUploading(applicationId);
    try {
      const { error: choiceError } = await supabase
        .from('applications')
        .update({ cancellation_choice: 'show_up_100' })
        .eq('id', applicationId);
      if (choiceError) throw choiceError;

      const path = await uploadCancellationProof(applicationId, file);
      const { error: proofError } = await supabase
        .from('applications')
        .update({ cancellation_proof_path: path })
        .eq('id', applicationId);
      if (proofError) throw proofError;

      toast(t('toast.showUpProofSubmitted'), 'success');
      setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, cancellationChoice: 'show_up_100', cancellationProofPath: path } : a));
      setSelectedApplication(prev => prev && prev.id === applicationId ? { ...prev, cancellationChoice: 'show_up_100', cancellationProofPath: path } : prev);
    } catch (err) {
      toast(t('toast.showUpProofFailed') + (err?.message || ''), 'error');
    } finally {
      setCancellationProofUploading(null);
    }
  };

  // File a dispute on a completed shift. Text-only evidence (category +
  // description); disputes don't touch payouts in v1 — see
  // supabase/migrations/20260712_disputes.sql for the RLS that scopes
  // inserts to completed shifts only.
  const submitDispute = async () => {
    if (guardPreview()) return;
    if (!disputeModal || !user || !disputeForm.description.trim()) return;
    setFilingDispute(true);
    const { error } = await supabase.from('disputes').insert({
      application_id: disputeModal.applicationId,
      filed_by: user.id,
      filed_by_role: 'worker',
      category: disputeForm.category,
      description: disputeForm.description.trim(),
    });
    setFilingDispute(false);
    if (error) { toast(t('toast.disputeFiledFailed') + error.message, 'error'); return; }
    toast(t('toast.disputeFiled'), 'success');
    setMyDisputedApplicationIds(prev => new Set(prev).add(disputeModal.applicationId));
    setDisputeModal(null);
    setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  };

  useEffect(() => {
    // Open shifts are publicly browsable (anon RLS policy) so visitors can
    // see listings before signing up. Runs for both anon and signed-in users.
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, filled_count, applicant_count, status, address_visibility, transport_allowance, language_requirements, requirements, employer_id, applications_close_at, employer:profiles(full_name, reliability_score, rating, avatar_url)')
      .eq('status', 'open')
      .order('start_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        setLiveShifts((data ?? []).map(s => ({
          id: s.id,
          title: displayProtectedText(s.title),
          description: displayProtectedText(s.description || ''),
          category: s.category,
          employer: s.employer?.full_name || 'Employer',
          employerId: s.employer_id ?? null,
          // null (not 0) when the employer embed didn't resolve — e.g. an
          // anonymous visitor (profiles has no `to anon` RLS policy) or an
          // employer mid-KYC-review — so the UI can distinguish "unknown"
          // from "verified 0/100" rather than showing a misleading red badge.
          reliabilityScore: s.employer ? (s.employer.reliability_score ?? 0) : null,
          rating: s.employer ? (s.employer.rating ?? 0) : null,
          employerAvatarUrl: s.employer?.avatar_url ?? null,
          location: displayProtectedText(s.location),
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          time: formatShiftTime(s.start_at) && formatShiftTime(s.end_at) ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          hours: totalOccurrenceHours(s.occurrences) || (s.start_at && s.end_at ? Math.round((new Date(s.end_at) - new Date(s.start_at)) / 3600000) : 0),
          applicationsCloseAt: s.applications_close_at,
          wageMin: Number(s.wage_min),
          wageMax: Number(s.wage_max),
          headcount: s.headcount,
          filled: s.filled_count,
          status: s.status,
          addressVisibility: s.address_visibility || 'public',
          totalApplicants: s.applicant_count ?? 0,
          dress: displayProtectedText(s.dress_code || ''),
          languageRequirements: s.language_requirements || [],
          specialRequirements: displayProtectedText(s.requirements?.special || ''),
          requiredDocuments: shiftRequiredDocuments(s.requirements),
          stipend: Number(s.transport_allowance) || 0,
          startTime: shiftHHMM(s.start_at),
          endTime: shiftHHMM(s.end_at),
          // Raw, for shiftLastEndsAt's fallback. Everything above is a
          // display string and cannot be compared against the clock.
          endAt: s.end_at ?? null,
          date: formatShiftDate(s.start_at),
        })));
      })
      .catch(() => { if (active) setLiveShifts([]); });
    return () => { active = false; };
  }, [user]);

  // Anonymous visitors get every employer shown as the literal word
  // "Employer" above -- profiles has no `to anon` RLS policy (correctly, it
  // holds KYC/banking-adjacent data), so the embedded join silently resolves
  // to null. That undermines the one thing a public marketplace feed most
  // needs before someone signs up: looking like it has real, vetted
  // employers. Backfill via a narrow security-definer RPC that returns only
  // the four fields already safe to show anyone (see
  // 20260810_public_employer_trust_signals.sql) -- never the full profiles
  // row. Runs only for anon visitors; signed-in users already got real data
  // from the RLS-permitted embed above.
  useEffect(() => {
    if (user || !liveShifts || liveShifts.length === 0) return undefined;
    const employerIds = [...new Set(liveShifts.map(s => s.employerId).filter(Boolean))];
    if (employerIds.length === 0) return undefined;
    let active = true;
    supabase.rpc('get_public_employer_trust_signals', { p_employer_ids: employerIds })
      .then(({ data, error }) => {
        if (!active || error) return;
        setAnonEmployerTrust(Object.fromEntries((data ?? []).map(e => [e.id, e])));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [user, liveShifts]);

  // Deep link from a clicked notification (e.g. "bid accepted") — the target
  // shift may no longer be status 'open', so it can't be found in liveShifts
  // and needs its own by-id fetch.
  useEffect(() => {
    // "/worker/applications/{id}" links (cancellation-choice notifications):
    // the choice UI lives inline on the My Bids card, so just land there.
    if (deepLinkShift?.applicationId) {
      setSelectedShift(null);
      setTab('applications');
      return undefined;
    }
    // Either a tapped notification or the "View shift" shortcut in a chat
    // room. Both need the same thing -- an id turned into the detail view --
    // so they share one loader rather than each carrying its own copy of this
    // query and its 30-line row mapping.
    const wantedShiftId = deepLinkShift?.shiftId || openShiftId || routeShift?.id || linkShiftId;
    if (!wantedShiftId) return undefined;
    // Where the user lands when they CLOSE the detail. A tapped notification or
    // a chat shortcut is about a shift they already bid on, so My Bids is
    // right. A shared link is usually a stranger -- possibly signed out, for
    // whom My Bids is an empty room -- so send them to Discover instead.
    const closeTab = (deepLinkShift?.shiftId || openShiftId) ? 'applications' : 'discover';
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, filled_count, applicant_count, status, address_visibility, transport_allowance, language_requirements, requirements, employer_id, applications_close_at, employer:profiles(full_name, reliability_score, rating, avatar_url)')
      .eq('id', wantedShiftId)
      .maybeSingle()
      .then(({ data: s }) => {
        if (!active) return;
        // A shift that has been deleted, or one RLS will not show this viewer.
        // This used to return silently, so tapping a job name on a payout --
        // or a notification for a removed shift -- was a dead click with no
        // explanation. Say so, and let go of the id, or the effect re-runs and
        // swallows the next tap too.
        if (!s) { toast(t("toast.shiftUnavailable"), "error"); setOpenShiftId(null); return; }
        setSelectedShift({
          id: s.id,
          title: displayProtectedText(s.title),
          description: displayProtectedText(s.description || ''),
          category: s.category,
          employer: s.employer?.full_name || 'Employer',
          employerId: s.employer_id ?? null,
          reliabilityScore: s.employer ? (s.employer.reliability_score ?? 0) : null,
          rating: s.employer ? (s.employer.rating ?? 0) : null,
          employerAvatarUrl: s.employer?.avatar_url ?? null,
          location: displayProtectedText(s.location),
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          time: formatShiftTime(s.start_at) && formatShiftTime(s.end_at) ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          hours: totalOccurrenceHours(s.occurrences) || (s.start_at && s.end_at ? Math.round((new Date(s.end_at) - new Date(s.start_at)) / 3600000) : 0),
          applicationsCloseAt: s.applications_close_at,
          wageMin: Number(s.wage_min),
          wageMax: Number(s.wage_max),
          headcount: s.headcount,
          filled: s.filled_count,
          status: s.status,
          addressVisibility: s.address_visibility || 'public',
          totalApplicants: s.applicant_count ?? 0,
          dress: displayProtectedText(s.dress_code || ''),
          languageRequirements: s.language_requirements || [],
          specialRequirements: displayProtectedText(s.requirements?.special || ''),
          requiredDocuments: shiftRequiredDocuments(s.requirements),
          stipend: Number(s.transport_allowance) || 0,
          startTime: shiftHHMM(s.start_at),
          endTime: shiftHHMM(s.end_at),
          date: formatShiftDate(s.start_at),
        });
        setTab(closeTab);
      });
    return () => { active = false; };
  }, [deepLinkShift, openShiftId, routeShift, linkShiftId]);

  useEffect(() => {
    let active = true;
    const loadWorkerPayoutData = async () => {
      if (!user) {
        setWorkerBanking(null);
        setLivePayouts(null);
        setWorkerPayoutSummary(null);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }, { data: summaryData, error: summaryError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
          .eq("user_id", user.id)
          .eq("role", "worker")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, scheduled_date, status, source_refs, error_message, created_at")
          .eq("worker_id", user.id)
          .order("created_at", { ascending: false })
          .range(0, PAYOUT_PAGE_SIZE - 1),
        // Unlimited but light (no source_refs/error_message) — feeds the
        // total, stat tiles, and the monthly bar chart, none of which
        // should be capped to whatever page of "Recent Payouts" is loaded.
        supabase
          .from("payout_item")
          .select("amount, status, scheduled_date, created_at")
          .eq("worker_id", user.id),
      ]);

      if (!active) return;

      if (!summaryError) setWorkerPayoutSummary(summaryData ?? []);

      if (!bankError) {
        setWorkerBanking(bankData ?? null);
        if (bankData) {
          setWorkerBankForm({
            bankName: bankData.bank_name || MALAYSIAN_BANK_OPTIONS[0],
            accountHolderName: bankData.account_holder_name || "",
            accountNumber: "",
          });
        }
      }

      if (!payoutError) {
        setLivePayouts(payoutData ?? []);
        setPayoutsHasMore((payoutData ?? []).length === PAYOUT_PAGE_SIZE);
        // source_refs only carries the raw shift_id (jsonb, not a real FK
        // PostgREST can embed) — without this, the Earnings list rendered
        // "Shift #<uuid>" to the worker instead of the shift's actual title.
        const shiftIds = [...new Set((payoutData ?? []).map(p => p.source_refs?.shift_id).filter(Boolean))];
        if (shiftIds.length) {
          // Widened from (id, title): the payment slip and the shift shortcut
          // both hang off this one lookup rather than adding a second query.
          const { data: shiftRows } = await supabase.from("shifts").select("id, title, location, start_at, end_at, occurrences, employer:profiles(full_name)").in("id", shiftIds);
          if (active) setPayoutShiftTitles(Object.fromEntries((shiftRows ?? []).map(s => [s.id, s])));
        }
      }
    };

    loadWorkerPayoutData();
    return () => {
      active = false;
    };
  }, [user]);

  // Fetches the next page of "Recent Payouts" and appends it — the list
  // used to hard-stop at the 10 most recent rows with no way to see
  // anything older, which is exactly the "multiple months" gap this and
  // the total-undercount fix (see workerPayoutSummary above) were both
  // found from the same dogfooding pass.
  const loadMorePayouts = async () => {
    if (!user || payoutsLoadingMore) return;
    setPayoutsLoadingMore(true);
    const offset = (livePayouts || []).length;
    const { data: moreRows, error } = await supabase
      .from("payout_item")
      .select("id, amount, scheduled_date, status, source_refs, error_message, created_at")
      .eq("worker_id", user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAYOUT_PAGE_SIZE - 1);
    if (!error) {
      setLivePayouts(prev => [...(prev || []), ...(moreRows ?? [])]);
      setPayoutsHasMore((moreRows ?? []).length === PAYOUT_PAGE_SIZE);
      const newShiftIds = [...new Set((moreRows ?? []).map(p => p.source_refs?.shift_id).filter(Boolean))]
        .filter(id => !(id in payoutShiftTitles));
      if (newShiftIds.length) {
        const { data: shiftRows } = await supabase.from("shifts").select("id, title, location, start_at, end_at, occurrences, employer:profiles(full_name)").in("id", newShiftIds);
        setPayoutShiftTitles(prev => ({ ...prev, ...Object.fromEntries((shiftRows ?? []).map(s => [s.id, s])) }));
      }
    }
    setPayoutsLoadingMore(false);
  };

  const saveWorkerBankingDetails = async () => {
    if (guardPreview()) return;
    if (!user) {
      setBankingMessage("Sign in to save banking details.");
      return;
    }
    if (!workerBankForm.accountHolderName.trim() || !workerBankForm.accountNumber.trim()) {
      setBankingMessage("Account holder name and account number are required.");
      return;
    }
    const workerAcctValidation = validateMalaysianBankAccount(workerBankForm.bankName, workerBankForm.accountNumber);
    if (!workerAcctValidation.valid) {
      toast(workerAcctValidation.message, "error");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const accountDigits = workerBankForm.accountNumber.replace(/\D/g, "");
    const last4 = accountDigits.slice(-4);
    const payload = {
      user_id: user.id,
      role: "worker",
      bank_name: workerBankForm.bankName,
      bank_code: workerBankForm.bankName.toUpperCase().replace(/\s+/g, "_"),
      account_holder_name: workerBankForm.accountHolderName.trim(),
      account_number_last4: last4,
      // Full account number must be encrypted server-side before go-live.
      // Storing masked placeholder here until a backend encryption flow is wired up.
      account_number_encrypted: `MASKED-${last4}`,
      verification_status: workerBanking?.verification_status || "pending",
    };

    const { data, error } = await supabase
      .from("banking_details")
      .upsert(payload, { onConflict: "user_id,role" })
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Unable to save banking details: ${error.message}`);
      return;
    }
    setWorkerBanking(data);
    setBankingMessage("Banking details saved. Please verify with SecureSign.");
  };

  const verifyWorkerBankingDetails = async () => {
    if (!workerBanking?.id) {
      setBankingMessage("Save banking details before starting verification.");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const { data, error } = await supabase
      .from("banking_details")
      .update({
        verification_status: "verified",
        verification_provider: "secure_sign_sim",
        verification_reference: `SEC-${Date.now()}`,
        verified_at: new Date().toISOString(),
      })
      .eq("id", workerBanking.id)
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Verification failed: ${error.message}`);
      return;
    }
    setWorkerBanking(data);
    setBankingMessage("SecureSign verification completed.");
  };

  const cats = ["All", ...SHIFT_CATEGORIES];
  // Shared style objects for the Discover-tab site footer below — kept out
  // of the JSX to avoid repeating the same object literal per link/chip.
  // padding: 0 measured at 154x15px live -- fails even the WCAG 2.2 AA target
  // size floor (2.5.8, 24x24), not just the AAA 44x44 one. Vertical padding
  // added to clear 24px without changing the footer's visual density.
  const footerLinkStyle = { border: "none", background: "transparent", padding: "6px 0", textAlign: "left", cursor: "pointer", fontFamily: "inherit", fontSize: FS.meta, color: BRAND.textMuted };
  // Not live-measured like footerLinkStyle above, but the same arithmetic
  // (12px font, ~14.4px line box + 4px+4px padding = ~22px) lands just under
  // the 24px floor -- bumped defensively alongside the button that was measured.
  const footerCategoryChipStyle = { border: `1px solid ${BRAND.border}`, background: BRAND.surface, borderRadius: RADIUS.pill, padding: "6px 10px", cursor: "pointer", fontFamily: "inherit", fontSize: FS.meta, color: BRAND.textMuted };
  const shiftsSource = useMemo(() => {
    const base = liveShifts ?? [];
    if (!anonEmployerTrust) return base;
    return base.map(s => {
      const trust = s.employerId ? anonEmployerTrust[s.employerId] : null;
      if (!trust) return s;
      return {
        ...s,
        employer: trust.full_name || s.employer,
        reliabilityScore: trust.reliability_score ?? s.reliabilityScore,
        rating: trust.rating ?? s.rating,
        employerVerified: trust.employer_verification_status === 'verified',
      };
    });
  }, [liveShifts, anonEmployerTrust]);
  // Shifts hidden from Discover: the ones with a live bid, plus the ones the
  // employer has already said no to.
  //
  // A withdrawn or expired application is NOT hidden -- 20260823b lets the
  // worker reopen it, so the shift is genuinely available to them again. A
  // rejected one stays hidden permanently, because that decision was the
  // employer's and re-bidding would override it by persistence.
  //
  // Re-applying reuses the existing row rather than inserting a second one:
  // `unique (shift_id, worker_id)` still holds, and payouts, chat participants
  // and several maybeSingle() lookups all depend on it holding.
  const hiddenShiftIds = useMemo(
    () => new Set((liveApplications ?? [])
      .filter(a => ['pending', 'shortlisted', 'offered', 'accepted', 'rejected'].includes(a.status))
      .map(a => a.shiftId)),
    [liveApplications]
  );
  // Shift id -> the lapsed application to reopen, for shifts the worker can bid
  // on again. Drives the "you bid before" note and the update-instead-of-insert
  // path in the bid modal.
  const reopenableApplications = useMemo(
    () => new Map((liveApplications ?? [])
      .filter(a => ['withdrawn', 'expired'].includes(a.status))
      .map(a => [a.shiftId, a])),
    [liveApplications]
  );
  const filtered = useMemo(() => {
    let s = shiftsSource.filter(x => !hiddenShiftIds.has(x.id));
    // A shift that has already finished is not browsable, whatever its status
    // still says. It normally leaves the feed when complete_ended_shifts()
    // flips it to 'completed' -- but that sweep only runs when a SIGNED-IN user
    // loads a portal (no pg_cron, and anon's EXECUTE was revoked 2026-09-12),
    // so a signed-out visitor could see a finished shift listed as open until
    // somebody signed in. Checking the clock here makes the feed right
    // regardless of who has visited, instead of depending on it.
    // null means the dates could not be read: leave it visible rather than
    // hide a shift on a guess.
    s = s.filter(x => {
      const ended = shiftLastEndsAt(x.occurrences, x.endAt);
      return !ended || ended > new Date();
    });
    if (filterCat !== 'All') s = s.filter(x => x.category === filterCat);
    if (filterCity) s = s.filter(x => resolveCity(x.location) === filterCity);
    if (filterArea) s = s.filter(x => x.location.toLowerCase().includes(filterArea.toLowerCase()));
    if (filterDate) s = s.filter(x => x.date === filterDate);
    if (filterDuration) s = s.filter(x => x.hours <= Number(filterDuration));
    if (filterPayMin) s = s.filter(x => x.wageMin >= Number(filterPayMin));
    if (filterPayMax) s = s.filter(x => x.wageMax <= Number(filterPayMax));
    if (filterHighBooking) s = s.filter(x => x.headcount > 0 && (x.headcount - (x.filled || 0)) / x.headcount > 0.5);
    if (filterWeekend) s = s.filter(x => x.date && [0, 6].includes(new Date(x.date + 'T00:00:00').getDay()));
    if (filterTimeStart) s = s.filter(x => x.startTime && x.startTime >= filterTimeStart);
    if (filterTimeEnd) s = s.filter(x => x.endTime && x.endTime <= filterTimeEnd);
    return s;
  }, [shiftsSource, hiddenShiftIds, filterCat, filterCity, filterArea, filterDate, filterDuration, filterPayMin, filterPayMax, filterHighBooking, filterWeekend, filterTimeStart, filterTimeEnd]);
  const payoutsLoading = Boolean(user) && livePayouts === null;
  const payoutRows = useMemo(
    () => (livePayouts || []).map((p) => {
      const rawDate = p.scheduled_date || p.created_at || null;
      return {
        id: p.id,
        // The slip and the shift shortcut need more than a title, so the row
        // carries the record. shiftId stays separate: it is all that is needed
        // to open the shift, and it exists before the record has loaded.
        shiftId: p.source_refs?.shift_id ?? null,
        shiftInfo: p.source_refs?.shift_id ? (payoutShiftTitles[p.source_refs.shift_id] || null) : null,
        hours: p.source_refs?.hours ?? null,
        shift: p.source_refs?.shift_id ? (payoutShiftTitles[p.source_refs.shift_id]?.title || "Completed shift") : "Completed shift",
        amount: Number(p.amount || 0),
        date: p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA",
        // YYYY-MM in the worker's own reading of the date, used only to
        // group the list under month headers below — not shown as-is.
        monthKey: rawDate ? rawDate.slice(0, 7) : null,
        status: p.status,
        errorMessage: p.error_message ?? null,
        travel: 0,
      };
    }),
    [livePayouts, payoutShiftTitles]
  );

  // Month headers for the "Recent Payouts" list — groups consecutive rows
  // sharing a monthKey under one label, formatted from the first row of
  // each group so it's a real localized month name, not the raw "YYYY-MM".
  const payoutMonthLabels = useMemo(() => {
    const labels = {};
    payoutRows.forEach(row => {
      if (!row.monthKey || labels[row.monthKey]) return;
      const [y, m] = row.monthKey.split("-").map(Number);
      labels[row.monthKey] = new Date(y, m - 1, 1).toLocaleDateString("en-MY", { month: "long", year: "numeric" });
    });
    return labels;
  }, [payoutRows]);

  // Deliberately sourced from workerPayoutSummary (unlimited), not the
  // paginated payoutRows list — see workerPayoutSummary's declaration for
  // why summing a capped list would silently undercount a worker with a
  // long payout history. Same reasoning applies here: the monthly chart
  // needs every payout, not just whatever page of the list is loaded.
  const totalEarned = useMemo(
    () => (workerPayoutSummary || []).reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [workerPayoutSummary]
  );

  // Monthly bar chart data — sums workerPayoutSummary by calendar month
  // (worker's local reading of scheduled_date, falling back to created_at
  // for payouts not yet scheduled), sorted chronologically, capped to the
  // most recent 12 months so the chart stays readable on a phone screen.
  // The cap is surfaced (not silent) via monthlyEarningsTruncated below.
  const MONTHLY_CHART_MAX_MONTHS = 12;
  const monthlyEarningsAll = useMemo(() => {
    const byMonth = new Map();
    (workerPayoutSummary || []).forEach(row => {
      const rawDate = row.scheduled_date || row.created_at;
      if (!rawDate) return;
      const key = rawDate.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) || 0) + Number(row.amount || 0));
    });
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, total]) => {
        const [y, m] = key.split("-").map(Number);
        return {
          key,
          total,
          shortLabel: new Date(y, m - 1, 1).toLocaleDateString("en-MY", { month: "short" }),
          fullLabel: new Date(y, m - 1, 1).toLocaleDateString("en-MY", { month: "long", year: "numeric" }),
        };
      });
  }, [workerPayoutSummary]);
  const monthlyEarningsTruncated = monthlyEarningsAll.length > MONTHLY_CHART_MAX_MONTHS;
  const monthlyEarnings = monthlyEarningsTruncated
    ? monthlyEarningsAll.slice(monthlyEarningsAll.length - MONTHLY_CHART_MAX_MONTHS)
    : monthlyEarningsAll;
  const payoutEligibility = workerBanking?.verification_status === "verified";
  const profileName = user
    ? (user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "Your account")
    : "";

  // What (if anything) has gone wrong with this worker's attendance, judged from
  // the shift's real end time. null = the ordinary check-in / check-out flow.
  // Declared above navItems (not beside renderCheckState) because bidSection
  // below needs it, and the nav badge is computed from bidSection at render.
  const attendanceIssue = (a) => {
    if (a.status !== "accepted" || !a.workerSignedAt || a.shiftStatus === "cancelled") return null;
    if (a.noShowAt) return "noShow";
    const endsAt = shiftLastEndsAt(a.shiftOccurrences, a.shiftEndAt);
    if (!endsAt) return null;
    const now = Date.now();
    if (!a.checkedInAt) return now > endsAt.getTime() ? "missedCheckIn" : null;
    if (!a.checkedOutAt && a.employerProposedHours == null && !a.hoursResubmitted && now > endsAt.getTime() + CHECKOUT_WINDOW_MS) return "checkoutClosed";
    return null;
  };

  // Which My Bids section a bid belongs in, and the moment that orders it
  // within that section. One function rather than four separate filters, so a
  // bid can never land in two sections (or in none), and so the nav badge
  // counts exactly what the "Needs you" section shows.
  //
  // "needs" mirrors every place the card or the bid detail renders an action
  // the WORKER owes, usually against a deadline: confirm/decline an offer,
  // re-accept changed terms, sign the contract, pick a late-cancellation
  // option, check in once the shift is under way, check out once it is over,
  // answer an employer's hours proposal or dispute, or chase a missed
  // attendance. If one of those render conditions changes, change this too.
  // `due` is that deadline where one exists, otherwise the shift start/end.
  const bidSection = (a) => {
    const now = Date.now();
    const ms = (v) => (v ? new Date(v).getTime() : null);
    const start = ms(a.shiftStartAt);
    const endsAt = shiftLastEndsAt(a.shiftOccurrences, a.shiftEndAt)?.getTime() ?? null;
    const at = (key, due) => ({ key, due: due ?? start ?? Infinity });
    const live = a.shiftStatus !== "cancelled";
    if (!live && a.cancellationChoiceDeadline && !a.cancellationChoice) return at("needs", ms(a.cancellationChoiceDeadline));
    if (live && a.status === "offered") return at("needs", ms(a.offerExpiresAt));
    if (live && a.status === "accepted") {
      const reconfirm = reconfirmState(a);
      if (reconfirm && !reconfirm.expired) return at("needs", reconfirm.deadline);
      // Unsigned and already over: there is nothing left to sign or attend,
      // so it is history, not a to-do (it used to sit in Needs you forever).
      if (!a.workerSignedAt) return endsAt != null && now > endsAt ? at("past", start) : at("needs", start);
      const issue = attendanceIssue(a);
      if (issue) {
        // Once the worker has asked the employer to fix it, the next move is
        // the employer's -- it stops being something this worker owes.
        const kind = issue === "checkoutClosed" ? "check_out" : "check_in";
        return attendanceRequests[`${a.id}:${kind}`]?.status === "pending" ? at("waiting", start) : at("needs", endsAt);
      }
      if (a.checkedInAt && a.employerProposedHours != null) return at("needs", endsAt);
      if (a.employerHoursDisputed) return at("needs", endsAt);
      // Only while the shift is running: once it has ended, attendanceIssue
      // above owns the recovery path, and an old missed shift must not sit
      // in Needs you forever.
      if (!a.checkedInAt && start != null && now >= start && (endsAt == null || now <= endsAt)) return at("needs", endsAt);
      if (a.checkedInAt && !a.checkedOutAt && endsAt != null && now > endsAt) return at("needs", endsAt + CHECKOUT_WINDOW_MS);
      // Checked out, hours not yet confirmed: the employer owes the next step.
      if (a.checkedOutAt && !a.employerHoursConfirmedAt) return at("waiting", start);
      if (a.shiftStatus !== "completed" && (endsAt == null || now <= endsAt)) return at("upcoming", start);
      return at("past", start);
    }
    if (live && a.shiftStatus !== "completed" && (a.status === "pending" || a.status === "shortlisted")) return at("waiting", start);
    return at("past", start);
  };
  const needsYouBidCount = (liveApplications ?? []).filter(a => bidSection(a).key === "needs").length;

  // Five tabs, not six. Settings folded into Profile as a Profile | Account
  // pair -- the same split the reference app uses -- which buys every remaining
  // tab enough width for a legible label instead of six 9px ones.
  // Signed out, the other four tabs only lead to a sign-in wall, so the bar
  // offers just what a visitor can do: browse, or sign in.
  const navItems = !user ? [
    { id: "discover", label: t("nav.discover"), icon: <Icons.Search size={20} /> },
    { id: "signin", label: t("common.signIn"), icon: <Icons.User size={20} /> },
  ] : [
    { id: "discover", label: t("nav.discover"), icon: <Icons.Search size={20} /> },
    { id: "applications", label: t("nav.myBids"), icon: <Icons.List size={20} />, badge: needsYouBidCount },
    { id: "chat", label: t("nav.chat"), icon: <Icons.Chat size={20} />, badge: unreadRooms },
    { id: "earnings", label: t("nav.earnings"), icon: <Icons.Money size={20} /> },
    {
      id: "profile", label: t("nav.profile"),
      icon: (active) => (user ? (
        <span style={{
          display: "inline-flex", borderRadius: "50%", padding: 1,
          border: `2px solid ${active ? BRAND.primaryOnSurface : "transparent"}`,
        }}>
          <Avatar name={profileName} size={active ? 18 : 20} src={getAvatarUrl(user?.user_metadata?.avatar_url)} />
        </span>
      ) : <Icons.User size={20} />),
    },
  ];

  const handleWorkerNavClick = (nextTab) => {
    if (nextTab === "signin") { onRequireAuth("signin"); return; }
    setShowQR(false);
    setShowBidModal(false);
    setSelectedShift(null);
    setTab(nextTab);
  };

  // Logo click in the header bumps homeSignal → return to Discover.
  // Compared against the last value seen, not a "skip the first run" flag:
  // StrictMode runs mount effects twice, and a flag flipped by the first run
  // let the second one send every deep link (/en/my-shifts) to Discover.
  const lastHomeSignal = useRef(homeSignal);
  useEffect(() => {
    if (lastHomeSignal.current === homeSignal) return;
    lastHomeSignal.current = homeSignal;
    handleWorkerNavClick("discover");
  }, [homeSignal]);

  // An open chat thread takes the whole screen on mobile, tab bar included.
  //
  // Why: the shell is pinned to visualViewport height so the composer stays
  // above the on-screen keyboard. That works, but the tab bar was riding up
  // with it -- so with the keyboard open the message list was squeezed between
  // a header, a shift strip, a composer AND a 60px tab bar, leaving almost
  // nothing readable while typing. You cannot re-read what someone asked you
  // while you are answering it.
  //
  // Hiding the bar whenever the thread is open (not only when the keyboard is
  // up) is deliberate: it matches the reference app, whose thread screen has no
  // tab bar either, and it keeps the layout from jumping every time the input
  // gains or loses focus. The thread has its own back button, so no route out
  // is lost.
  const chatThreadFullscreen = isMobile && tab === "chat" && Boolean(activeChatShift);

  const navBarStyle = isMobile
    ? {
        position: "sticky",
        bottom: 0,
        width: "100%",
        zIndex: 20,
        boxShadow: `0 -6px 20px ${BRAND.shadow}`,
        borderTop: `1px solid ${BRAND.border}`,
        background: BRAND.surface,
        display: "flex",
        flexShrink: 0,
        height: navHeight,
        paddingBottom: navSafeAreaInset,
        marginTop: "auto",
      }
    : {
        // Desktop: top navigation row. order:-1 floats it above the
        // content without changing DOM order across the worker screens.
        order: -1,
        position: "sticky",
        top: 0,
        width: "100%",
        zIndex: 20,
        boxShadow: `0 2px 12px ${BRAND.shadow}`,
        borderBottom: `1px solid ${BRAND.border}`,
        background: BRAND.surface,
        display: "flex",
        justifyContent: "center",
        gap: 8,
        flexShrink: 0,
        height: 56,
      };

  // Attendance/checkout status for an accepted application, from "not yet
  // checked in" through the full worker-report → employer-confirm/dispute
  // cycle. Shared by the My Bids list card and the shift-detail view so the
  // two don't drift.
  const checkoutDeadlineHint = (a, align) => {
    if (a.checkedOutAt || a.hoursResubmitted) return null;
    const endsAt = shiftLastEndsAt(a.shiftOccurrences, a.shiftEndAt);
    if (!endsAt || Date.now() <= endsAt.getTime()) return null;
    const iso = new Date(endsAt.getTime() + CHECKOUT_WINDOW_MS).toISOString();
    const when = `${formatShiftDate(iso, { day: "numeric", month: "short" })}, ${formatShiftTime(iso)}`;
    return <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4, textAlign: align }}>{t("attendance.checkoutBy").replace("{when}", when)}</div>;
  };

  const renderAttendanceIssue = (a, issue, align, stopClick) => {
    const kind = issue === "checkoutClosed" ? "check_out" : "check_in";
    const req = attendanceRequests[`${a.id}:${kind}`];
    const pending = req?.status === "pending";
    const declined = req?.status === "declined";
    const tone = issue === "noShow" ? BRAND.red : BRAND.onAmberLight;
    const askLabel = issue === "checkoutClosed" ? t("attendance.askCheckoutBtn") : issue === "noShow" ? t("attendance.askReviewBtn") : t("attendance.askCheckInBtn");
    const hint = issue === "noShow" ? (a.noShowNote ? a.noShowNote : t("attendance.noShowHint")) : issue === "checkoutClosed" ? t("attendance.checkoutClosedHint") : t("attendance.missedCheckInHint");
    const title = issue === "noShow" ? t("attendance.noShowTitle") : issue === "checkoutClosed" ? t("attendance.checkoutClosedTitle") : t("attendance.missedCheckInTitle");
    const justify = align === "right" ? "flex-end" : "center";
    return (
      <div style={{ textAlign: align, maxWidth: 260, marginLeft: align === "right" ? "auto" : undefined, marginRight: align === "center" ? "auto" : undefined }}>
        <div style={{ fontSize: FS.meta, fontWeight: 700, color: tone }}>{title}</div>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>{hint}</div>
        {pending && <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginTop: 6 }}>{t("attendance.requestPending")}</div>}
        {declined && (
          <>
            <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.red, marginTop: 6 }}>{t("attendance.requestDeclined")}</div>
            <HoursNote label={t("hours.employerNoteLabel")} text={req.response_note} tone="them" align={align} />
          </>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", justifyContent: justify }}>
          {!pending && (
            <Btn size="xs" variant="success" onClick={(e) => { stopClick?.(e); setAttendanceRequestNote(""); setAttendanceRequestTarget({ applicationId: a.id, kind, shiftTitle: a.shiftTitle }); }}>{askLabel}</Btn>
          )}
          {(issue === "noShow" || pending || declined) && (
            <Btn size="xs" variant="secondary" onClick={(e) => { stopClick?.(e); setDisputeModal({ applicationId: a.id, shiftTitle: a.shiftTitle }); }}>{t("myBids.fileDisputeBtn")}</Btn>
          )}
        </div>
      </div>
    );
  };

  // The hours conversation, one line per message. Both notes are stored on the
  // application; they only help if the other side can actually read them.
  const renderHoursNote = (label, text, align, tone = "them") => <HoursNote label={label} text={text} tone={tone} align={align} />;

  const renderCheckState = (a, stopClick) => {
    const issue = attendanceIssue(a);
    if (issue) return renderAttendanceIssue(a, issue, "right", stopClick);
    // Check-in only opens 2h before the start (record_check_in, 20260915). A
    // button weeks early just led to an error; say when it opens instead.
    const opensAt = a.shiftStartAt ? new Date(a.shiftStartAt).getTime() - 2 * 60 * 60 * 1000 : null;
    if (!a.checkedInAt && opensAt != null && Date.now() < opensAt) {
      const when = new Date(opensAt).toLocaleString(language === "bm" ? "ms-MY" : language === "ch" ? "zh-CN" : "en-MY", {
        timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
      });
      return <span style={{ fontSize: FS.meta, color: BRAND.textMuted, textAlign: "right" }}>{t("worker.checkInOpensAt", { when })}</span>;
    }
    if (!a.checkedInAt) {
      return <Btn size="sm" variant="success" onClick={(e) => { stopClick?.(e); setCheckinTarget({ applicationId: a.id, shiftTitle: a.shiftTitle }); setCheckinCode(""); setCheckinResult(null); setShowQR(true); }}>{t("worker.checkInBtn")}</Btn>;
    }
    if (a.employerProposedHours != null) {
      return (
        <div style={{ textAlign: "right", maxWidth: 220 }}>
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.onAmberLight, background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "6px 8px", marginBottom: 6 }}>
            {t(a.checkedOutAt ? "worker.employerProposedLabel" : "worker.employerSubmittedLabel").replace("{hours}", a.employerProposedHours)}
            <HoursNote label={t("hours.employerNoteLabel")} text={a.employerProposedNote} tone="them" />
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Btn size="xs" variant="secondary" disabled={respondingHoursModification === a.id} onClick={(e) => { stopClick?.(e); openResubmitAfterProposal(a); }}>{t("worker.rejectModificationBtn")}</Btn>
            <Btn size="xs" variant="success" disabled={respondingHoursModification === a.id} onClick={(e) => { stopClick?.(e); acceptHoursModification(a.id); }}>{t("worker.acceptModificationBtn")}</Btn>
          </div>
        </div>
      );
    }
    if (a.employerHoursDisputed) {
      return (
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.red, marginBottom: 4 }}>{t("worker.hoursDisputedBadge")}</div>
          {renderHoursNote(t("hours.employerNoteLabel"), a.employerHoursDisputeNote, "right")}
          <Btn size="sm" variant="success" style={{ marginTop: 6 }} onClick={(e) => {
            stopClick?.(e);
            setCheckoutTarget({ applicationId: a.id, shiftTitle: a.shiftTitle, defaultHours: a.workerReportedHours ?? totalOccurrenceHours(a.shiftOccurrences) });
            setCheckoutHours(""); setCheckoutBreakMinutes(""); setCheckoutNote(""); setCheckoutResult(null);
          }}>{t("worker.resubmitCheckout")}</Btn>
        </div>
      );
    }
    if (a.checkedOutAt && a.employerHoursConfirmedAt) {
      return <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.greenOnSurface }}><InlineIcon icon={Icons.Check} />{t("worker.hoursConfirmedBadge")}</span>;
    }
    if (a.checkedOutAt) {
      return (
        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted }}>{t("worker.checkoutPendingBadge")}</span>
          {renderHoursNote(t("hours.yourNoteLabel"), a.workerCheckoutNote, "right", "me")}
        </div>
      );
    }
    return (
      <div style={{ textAlign: "right" }}>
        <Btn size="sm" variant="success" onClick={(e) => {
          stopClick?.(e);
          setCheckoutTarget({ applicationId: a.id, shiftTitle: a.shiftTitle, defaultHours: totalOccurrenceHours(a.shiftOccurrences) });
          setCheckoutHours(""); setCheckoutBreakMinutes(""); setCheckoutNote(""); setCheckoutResult(null);
        }}>{t("worker.checkOutBtn")}</Btn>
        {checkoutDeadlineHint(a, "right")}
      </div>
    );
  };

  // Modal content - rendered on top of main content
  if (showQR) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <div style={{ fontSize: FS.h2, fontWeight: 800, color: BRAND.text, marginBottom: 8 }}>{t("worker.checkinTitle")}</div>
        <div style={{ color: BRAND.textMuted, fontSize: FS.body, marginBottom: 8, textAlign: "center" }}>{checkinTarget?.shiftTitle}</div>
        <div style={{ color: BRAND.textMuted, fontSize: FS.body, marginBottom: 28, textAlign: "center", maxWidth: 320 }}>{t("worker.checkinCodeSubtitle")}</div>
        <input
          value={checkinCode}
          onChange={e => setCheckinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          placeholder="000000"
          maxLength={6}
          style={{ width: 220, textAlign: "center", fontSize: FS.display, fontWeight: 800, letterSpacing: 8, padding: "16px 12px", borderRadius: RADIUS.card, border: `2px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, marginBottom: 16, fontFamily: "monospace" }}
        />
        {checkinResult?.ok === false && (
          <div style={{ color: BRAND.red, fontSize: FS.meta, fontWeight: 600, marginBottom: 16, textAlign: "center" }}>{checkinResult.message}</div>
        )}
        <Btn
          disabled={checkinSubmitting || checkinCode.length !== 6}
          onClick={async () => {
            if (guardPreview()) return;
            setCheckinSubmitting(true);
            setCheckinResult(null);
            const { error } = await supabase.rpc("worker_check_in", {
              p_application_id: checkinTarget.applicationId,
              p_code: checkinCode,
            });
            setCheckinSubmitting(false);
            if (error) {
              setCheckinResult({ ok: false, message: error.message });
              return;
            }
            setLiveApplications(prev => (prev ?? []).map(x => x.id === checkinTarget.applicationId ? { ...x, checkedInAt: new Date().toISOString() } : x));
            setShowQR(false);
            toast(t("toast.checkinSuccess"), "success");
          }}
        >
          {checkinSubmitting ? "…" : t("worker.submitCheckin")}
        </Btn>
        <Btn variant="secondary" onClick={() => setShowQR(false)} style={{ marginTop: 8 }}>{t("common.back")}</Btn>
      </div>
      <WorkerBottomNav items={navItems} activeId={tab} onSelect={handleWorkerNavClick} isMobile={isMobile} style={navBarStyle} />
    </div>
  );

  if (checkoutTarget) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <div style={{ fontSize: FS.h2, fontWeight: 800, color: BRAND.text, marginBottom: 8, textAlign: "center" }}>{checkoutTarget.proposal ? t("worker.resubmitTitle") : t("worker.checkoutTitle")}</div>
        <div style={{ color: BRAND.textMuted, fontSize: FS.body, marginBottom: 8, textAlign: "center" }}>{checkoutTarget.shiftTitle}</div>
        {checkoutTarget.proposal ? (
          <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "10px 12px", marginBottom: 20, maxWidth: 320, textAlign: "center" }}>
            <div style={{ fontWeight: 700 }}>{t("worker.employerProposedLabel").replace("{hours}", checkoutTarget.proposal.hours)}</div>
            {checkoutTarget.proposal.note && <div style={{ marginTop: 2, overflowWrap: "anywhere" }}>{checkoutTarget.proposal.note}</div>}
            <div style={{ marginTop: 6 }}>{t("worker.resubmitProposalHint")}</div>
          </div>
        ) : (
          <div style={{ color: BRAND.textMuted, fontSize: FS.body, marginBottom: 24, textAlign: "center", maxWidth: 320 }}>{t("worker.checkoutSubtitle")}</div>
        )}
        <div style={{ width: "100%", maxWidth: 320 }}>
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginBottom: 4 }}>{t("worker.checkoutHoursLabel")}</div>
          <input
            value={checkoutHours}
            onChange={e => setCheckoutHours(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder={checkoutTarget.defaultHours != null ? String(Math.round(checkoutTarget.defaultHours * 100) / 100) : ""}
            style={{ width: "100%", boxSizing: "border-box", fontSize: FS.lead, fontWeight: 700, padding: "12px 14px", borderRadius: RADIUS.card, border: `2px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, marginBottom: 14 }}
          />
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginBottom: 4 }}>{t("worker.checkoutBreakLabel")}</div>
          <input
            value={checkoutBreakMinutes}
            onChange={e => setCheckoutBreakMinutes(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="0"
            style={{ width: "100%", boxSizing: "border-box", fontSize: FS.card, padding: "10px 14px", borderRadius: RADIUS.card, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, marginBottom: 14 }}
          />
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginBottom: 4 }}>{t("worker.checkoutNoteLabel")}</div>
          <textarea
            value={checkoutNote}
            onChange={e => setCheckoutNote(e.target.value)}
            rows={2}
            style={{ width: "100%", boxSizing: "border-box", fontSize: FS.body, padding: "10px 14px", borderRadius: RADIUS.card, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: BRAND.text, marginBottom: 16, fontFamily: "inherit", resize: "vertical" }}
          />
        </div>
        {checkoutResult?.ok === false && (
          <div style={{ color: BRAND.red, fontSize: FS.meta, fontWeight: 600, marginBottom: 16, textAlign: "center" }}>{checkoutResult.message}</div>
        )}
        <Btn
          disabled={checkoutSubmitting || !checkoutHours || Number(checkoutHours) <= 0}
          onClick={async () => {
            if (guardPreview()) return;
            setCheckoutSubmitting(true);
            setCheckoutResult(null);
            if (checkoutTarget.rejectFirst) {
              const { error: rejectError } = await supabase.rpc("worker_reject_modification", { p_application_id: checkoutTarget.applicationId });
              if (rejectError) {
                setCheckoutSubmitting(false);
                setCheckoutResult({ ok: false, message: t("toast.rejectModificationFailed") + rejectError.message });
                return;
              }
              // Rejected server-side. If the resubmission below then fails, a
              // retry must not try to reject a proposal that no longer exists.
              setLiveApplications(prev => (prev ?? []).map(x => x.id === checkoutTarget.applicationId ? {
                ...x, checkedOutAt: null, employerProposedHours: null, employerProposedNote: null, hoursResubmitted: true,
              } : x));
              setCheckoutTarget(prev => prev ? { ...prev, rejectFirst: false } : prev);
            }
            const { error } = await supabase.rpc("worker_submit_checkout", {
              p_application_id: checkoutTarget.applicationId,
              p_hours: Number(checkoutHours),
              p_break_minutes: checkoutBreakMinutes ? Number(checkoutBreakMinutes) : 0,
              p_note: checkoutNote || null,
            });
            setCheckoutSubmitting(false);
            if (error) {
              setCheckoutResult({ ok: false, message: error.message });
              return;
            }
            setLiveApplications(prev => (prev ?? []).map(x => x.id === checkoutTarget.applicationId ? {
              ...x,
              checkedOutAt: new Date().toISOString(),
              workerReportedHours: Number(checkoutHours),
              workerCheckoutNote: checkoutNote || null,
              employerHoursConfirmedAt: null,
              employerHoursDisputed: false,
              employerHoursDisputeNote: null,
            } : x));
            setCheckoutTarget(null);
            toast(checkoutTarget.proposal ? t("toast.rejectModificationSuccess") : t("toast.checkoutSuccess"), "success");
          }}
        >
          {checkoutSubmitting ? "…" : t("worker.submitCheckout")}
        </Btn>
        <Btn variant="secondary" onClick={() => setCheckoutTarget(null)} style={{ marginTop: 8 }}>{t("common.back")}</Btn>
      </div>
    </div>
  );

  if (showSedcard) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", paddingTop: 24, paddingLeft: 24, paddingRight: 24, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <button onClick={() => setShowSedcard(false)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: BRAND.primaryOnSurface, cursor: "pointer", fontSize: FS.meta, fontWeight: 600, padding: 0, marginBottom: 16, fontFamily: "inherit" }} aria-label={t("common.back")}>
          {Icons.ArrowLeft ? Icons.ArrowLeft({ size: 14 }) : "←"} <span style={{ marginLeft: 6 }}>{t("common.back")}</span>
        </button>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <Avatar name={profileName} size={64} color={BRAND.primary} src={getAvatarUrl(user?.user_metadata?.avatar_url)} />
          <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, marginTop: 10 }}>{profileName}</div>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ color: BRAND.accent, fontSize: FS.body }}><InlineIcon icon={Icons.Star} />{(profileStats.rating ?? 0).toFixed(1)}</span>
            <Badge color="teal">{t("profile.shiftsDoneBadge").replace("{count}", workerShiftsDone ?? 0)}</Badge>
          </div>
        </div>
        <div style={{ fontSize: FS.body, color: BRAND.textMuted, textAlign: "center", marginBottom: 20 }}>{t("sedcard.subtitle")}</div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("sedcard.bioLabel")}</label>
          <textarea
            value={sedcardForm.bio}
            onChange={e => setSedcardForm(f => ({ ...f, bio: e.target.value }))}
            placeholder={t("sedcard.bioPlaceholder")}
            rows={4}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical" }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("sedcard.languagesLabel")}</label>
          {SHIFT_LANGUAGES.map(lang => (
            <label key={lang} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: FS.meta, color: BRAND.text }}>
              <input
                type="checkbox"
                checked={sedcardForm.languagesSpoken.includes(lang)}
                onChange={() => setSedcardForm(f => ({ ...f, languagesSpoken: f.languagesSpoken.includes(lang) ? f.languagesSpoken.filter(l => l !== lang) : [...f.languagesSpoken, lang] }))}
              /> {lang}
            </label>
          ))}
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("sedcard.qualificationsLabel")}</label>
          {SEDCARD_QUALIFICATIONS.map(q => (
            <label key={q.value} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: FS.meta, color: BRAND.text }}>
              <input
                type="checkbox"
                checked={sedcardForm.qualifications.includes(q.value)}
                onChange={() => setSedcardForm(f => ({ ...f, qualifications: f.qualifications.includes(q.value) ? f.qualifications.filter(v => v !== q.value) : [...f.qualifications, q.value] }))}
              /> {t(q.labelKey)}
            </label>
          ))}
          <Input
            label={t("sedcard.qualificationsOtherLabel")}
            placeholder={t("sedcard.qualificationsOtherPlaceholder")}
            value={sedcardForm.qualificationsOther}
            onChange={e => setSedcardForm(f => ({ ...f, qualificationsOther: e.target.value }))}
          />
        </div>

        <Btn
          disabled={sedcardSaving}
          onClick={async () => {
            if (guardPreview()) return;
            setSedcardSaving(true);
            const { error } = await supabase.from('profiles').update({
              bio: sedcardForm.bio.trim() ? sanitizeBulkTextValue(sedcardForm.bio.trim()) : null,
              languages_spoken: sedcardForm.languagesSpoken,
              qualifications: sedcardForm.qualifications,
              qualifications_other: sedcardForm.qualificationsOther.trim() ? sanitizeBulkTextValue(sedcardForm.qualificationsOther.trim()) : null,
            }).eq('id', user.id);
            setSedcardSaving(false);
            if (error) { toast(t('toast.sedcardSaveFailed') + error.message, 'error'); return; }
            toast(t('toast.sedcardSaved'), 'success');
          }}
        >
          {sedcardSaving ? "…" : t("sedcard.saveBtn")}
        </Btn>
      </div>
    </div>
  );

  if (showPersonalDetails) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", paddingTop: 24, paddingLeft: 24, paddingRight: 24, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <button onClick={() => setShowPersonalDetails(false)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: BRAND.primaryOnSurface, cursor: "pointer", fontSize: FS.meta, fontWeight: 600, padding: 0, marginBottom: 16, fontFamily: "inherit" }} aria-label={t("common.back")}>
          {Icons.ArrowLeft ? Icons.ArrowLeft({ size: 14 }) : "←"} <span style={{ marginLeft: 6 }}>{t("common.back")}</span>
        </button>
        <div style={{ fontSize: FS.h3, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("personalDetails.title")}</div>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 20 }}>{t("personalDetails.subtitle")}</div>
        {!personalDetailsLoaded && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
        {personalDetailsLoaded && (
          <>
            <Input
              label={t("auth.phoneNumber")}
              placeholder="+60123456789"
              value={personalDetailsForm.phone}
              onChange={e => setPersonalDetailsForm(f => ({ ...f, phone: e.target.value }))}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Select
                label={t("auth.identityType")}
                value={personalDetailsForm.identityType}
                onChange={e => setPersonalDetailsForm(f => ({ ...f, identityType: e.target.value, idNumber: "" }))}
                options={[
                  { value: "MyKad", label: t("auth.icMyKad") },
                  { value: "Passport", label: t("auth.passport") },
                  { value: "MyPR", label: t("auth.myPR") },
                ]}
              />
              <Input
                label={personalDetailsForm.identityType === "MyKad" ? t("auth.myKadNumber") : personalDetailsForm.identityType === "MyPR" ? t("auth.myPRNumber") : t("auth.passportNumber")}
                placeholder={["MyKad", "MyPR"].includes(personalDetailsForm.identityType) ? "XXXXXX-XX-XXXX" : "A1234567"}
                value={personalDetailsForm.idNumber}
                onChange={e => setPersonalDetailsForm(f => ({ ...f, idNumber: formatIdentityNumber(e.target.value, f.identityType) }))}
              />
            </div>
            <Input label={t("auth.dateOfBirth")} type="date" value={personalDetailsForm.dateOfBirth} onChange={e => setPersonalDetailsForm(f => ({ ...f, dateOfBirth: e.target.value }))} />
            <Input label={t("auth.address")} value={personalDetailsForm.address} onChange={e => setPersonalDetailsForm(f => ({ ...f, address: e.target.value }))} />
            <Btn
              disabled={personalDetailsSaving}
              onClick={async () => {
                if (guardPreview()) return;
                setPersonalDetailsSaving(true);
                const { error } = await supabase.from('user_private').upsert({
                  id: user.id,
                  phone: personalDetailsForm.phone.trim(),
                  identity_type: personalDetailsForm.identityType,
                  id_number: personalDetailsForm.idNumber.trim(),
                  date_of_birth: personalDetailsForm.dateOfBirth || null,
                  address: sanitizeBulkTextValue(personalDetailsForm.address.trim()),
                }, { onConflict: 'id' });
                setPersonalDetailsSaving(false);
                if (error) { toast(t('toast.personalDetailsSaveFailed') + error.message, 'error'); return; }
                toast(t('toast.personalDetailsSaved'), 'success');
              }}
            >
              {personalDetailsSaving ? "…" : t("personalDetails.saveBtn")}
            </Btn>
          </>
        )}
      </div>
    </div>
  );

  // Mirrors the applications_worker_insert RLS policy: the shift must be
  // 'open' AND the deadline (if set) must not have passed. Kept as a derived
  // value rather than duplicated at each use so the two conditions cannot
  // drift apart.
  const applicationsClosed = Boolean(selectedShift) && (
    (selectedShift.status && selectedShift.status !== "open") ||
    (selectedShift.applicationsCloseAt && new Date(selectedShift.applicationsCloseAt) <= new Date())
  );

  // Shift detail view with bottom nav
  if (selectedShift) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      {showBidModal && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "flex-end", zIndex: Z.modal, borderRadius: RADIUS.card }}>
          <div {...bidModalDialog} style={{ background: BRAND.surface, borderRadius: `${RADIUS.card}px ${RADIUS.card}px 0 0`, padding: 24, width: "100%" }}>
            <div style={{ fontWeight: 800, fontSize: FS.lead, color: BRAND.text, marginBottom: 4 }}>{t("shiftDetail.placeBidTitle")}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 20 }}>
              {t("shiftDetail.employerRange")}{selectedShift.wageMin}–RM{selectedShift.wageMax}/h{t("shiftDetail.maxBid")}{(selectedShift.wageMax * 1.5).toFixed(2)}/h
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("shiftDetail.wageAskLabel")}</label>
              <WageRatePicker
                min={selectedShift.wageMin}
                max={selectedShift.wageMax * 1.5}
                value={bidAmount || selectedShift.wageMin}
                onChange={v => setBidAmount(String(v))}
              />
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, textAlign: "center", marginTop: 4 }}>{t("shiftDetail.rateHelperText")}</div>
            </div>
            {bidAmount && (
              <div style={{ background: BRAND.grayLight, borderRadius: RADIUS.card, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("shiftDetail.estimatedTotalPay")}</div>
                <div style={{ fontSize: FS.h2, fontWeight: 800, color: BRAND.greenOnSurface }}>RM{(parseFloat(bidAmount || 0) * selectedShift.hours).toFixed(0)}</div>
                {selectedShift.stipend > 0 && (
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>+ RM{selectedShift.stipend}{t("shiftDetail.transportAllowanceSuffix")}</div>
                )}
              </div>
            )}
            {/* The one place the preview actually stops — everything above
                (rate slider, live pay calc) stays fully interactive so the
                employer can see exactly what a worker sees. */}
            {previewMode && (
              <div style={{ background: BRAND.amberLight, border: `1px solid ${BRAND.amber}`, borderRadius: RADIUS.control, padding: "10px 12px", marginBottom: 12, fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5 }}>
                <InlineIcon icon={Icons.Eye} />{t("worker.previewModeBlocked")}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setShowBidModal(false)} style={{ flex: 1 }}>{t("common.cancel")}</Btn>
              <Btn
                disabled={previewMode}
                title={previewMode ? t("worker.previewModeBlocked") : undefined}
                onClick={() => {
                (async () => {
                  if (!bidAmount) return;
                  if (guardPreview()) return;
                  if (parseFloat(bidAmount) > selectedShift.wageMax * 1.5) { toast(`${t("toast.maxBidPrefix")}${(selectedShift.wageMax * 1.5).toFixed(2)}/h`, "error"); return; }
                  if (!user) { setShowBidModal(false); onRequireAuth("signin"); return; }
                  // Guard: mock shifts use numeric ids — require a real UUID id to insert
                  if (typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) {
                    toast(t("toast.sampleShiftBidInfo"), "info");
                    return;
                  }

                  const payload = {
                    shift_id: selectedShift.id,
                    worker_id: user.id,
                    wage_ask: Number(bidAmount),
                  };

                  // A worker who withdrew, or let an offer lapse, may bid again
                  // -- but by REOPENING their existing row, not inserting a
                  // second one. `unique (shift_id, worker_id)` still holds, and
                  // payouts, chat participants and several maybeSingle()
                  // lookups all depend on one row per worker per shift.
                  const reopen = reopenableApplications.get(selectedShift.id);
                  const { data, error } = reopen
                    ? await supabase.from('applications')
                        .update({ status: 'pending', wage_ask: Number(bidAmount) })
                        .eq('id', reopen.id).select()
                    : await supabase.from('applications').insert(payload).select();

                  // The transition guard REVERTS an illegitimate change instead
                  // of raising, so a refused reopen comes back as success with
                  // the old status still in place. Read it back rather than
                  // trusting the absence of an error.
                  if (!error && reopen && data?.[0]?.status !== 'pending') {
                    toast(t("discover.reapplyRefused"), "error");
                    return;
                  }
                  if (error) {
                    // The button is hidden once applications close, but the
                    // shift can close between opening this modal and
                    // submitting -- and RLS answers that with raw Postgres
                    // text ("new row violates row-level security policy"),
                    // which means nothing to a worker. Unique/FK errors still
                    // surface verbatim; only the RLS refusal is translated.
                    const closed = /row.?level security/i.test(error.message || "");
                    // A duplicate key here means this worker has bid on this
                    // shift before. It should be unreachable now that Discover
                    // hides those, but a stale tab or an open modal can still
                    // get here -- and "duplicate key value violates unique
                    // constraint" tells a worker nothing about what to do.
                    const duplicate = error.code === "23505" || /duplicate key/i.test(error.message || "");
                    toast(
                      closed ? t("discover.applicationsClosed")
                        : duplicate ? t("discover.alreadyApplied")
                        : t("toast.applicationFailed") + error.message,
                      "error",
                    );
                    return;
                  }
                  logAnalyticsEvent('bid_placed', { shift_id: selectedShift.id }, user.id);

                  // Update local UI state and liveApplications cache if present
                  setShowBidModal(false);
                  setBidSuccess(true);
                  setLiveApplications(prev => prev ? [{ id: data[0].id, shiftId: selectedShift.id, shiftTitle: selectedShift.title, employer: selectedShift.employer, date: selectedShift.date, wageBid: Number(bidAmount), status: data[0].status || 'pending', appliedAt: data[0].applied_at }, ...prev] : null);
                  setTimeout(() => { setBidSuccess(false); setSelectedShift(null); setTab('applications'); }, 2000);
                })();
              }} style={{ flex: 1 }}>{previewMode ? t("worker.previewModeBidBtn") : t("common.submitBid")}</Btn>
            </div>
          </div>
        </div>
      )}
      {bidSuccess && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: Z.modal, borderRadius: RADIUS.card }}>
          <div {...bidSuccessDialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: isMobile ? 24 : 32, textAlign: "center" }}>
            <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", marginBottom: 12, color: BRAND.greenOnSurface }}><Icons.Check size={40} /></div>
            <div style={{ fontWeight: 800, fontSize: isMobile ? FS.lead : FS.h3, color: BRAND.text }}>{t("shiftDetail.bidSubmitted")}</div>
            <div style={{ color: BRAND.textMuted, fontSize: isMobile ? FS.meta : FS.body, marginTop: 8 }}>RM{bidAmount}/h · {t("shiftDetail.bidSubmittedHint")}</div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: navPadding, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark})`, padding: isMobile ? "32px 16px 16px" : "48px 24px 24px", borderRadius: isMobile ? 0 : `${RADIUS.card}px ${RADIUS.card}px 0 0`, flexShrink: 0 }}>
          <button onClick={() => setSelectedShift(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: BRAND.onSolid, borderRadius: RADIUS.control, padding: "6px 12px", cursor: "pointer", fontSize: FS.meta, marginBottom: 12, fontFamily: "inherit" }} aria-label={t("common.back")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></button>
          {/* Share the SHIFT, not the app. Until this existed the only share
              button handed out the current pathname, which meant a friend
              landed on the Discover feed and had to find the shift again. */}
          <button onClick={shareShift} style={{ background: ON_GRADIENT_CHIP_BG, border: "none", color: ON_GRADIENT_TEXT, borderRadius: RADIUS.control, padding: "6px 12px", cursor: "pointer", fontSize: FS.meta, marginBottom: 12, marginLeft: 8, fontFamily: "inherit" }} aria-label={t("shiftDetail.shareBtn")}>{t("shiftDetail.shareBtn")}</button>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            <Badge color="amber">{shiftCategoryLabel(selectedShift.category, t)}</Badge>
            <Badge color="green">{t("shiftDetail.positions")} {selectedShift.headcount}</Badge>
            <Badge color="blue">{t("shiftDetail.applied")} {selectedShift.totalApplicants}</Badge>
          </div>
          <div style={{ fontSize: isMobile ? FS.lead : FS.h2, fontWeight: 800, color: BRAND.onSolid, lineHeight: 1.2, marginBottom: 8 }}>{selectedShift.title}</div>
          <div style={{ fontSize: isMobile ? FS.meta : FS.body, color: "rgba(255,255,255,0.85)" }}>{selectedShift.employer}</div>
        </div>
        <div style={{ padding: isMobile ? 14 : 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: isMobile ? 8 : 10, marginBottom: 16 }}>
            <Stat label={t("shiftDetail.wageRange")} value={`RM${selectedShift.wageMin}–${selectedShift.wageMax}`} sub={t("shiftDetail.perHour")} color={BRAND.text} />
            <Stat label={t("shiftDetail.shiftDuration")} value={formatDurationHours(selectedShift.hours)} sub={selectedShift.isMultiDay ? t("shiftDetail.daysCount").replace("{count}", selectedShift.occurrences.length) : selectedShift.date} color={BRAND.text} />
            <Stat label={t("shiftDetail.estimatedGross")} value={`RM${(((selectedShift.wageMin + selectedShift.wageMax) / 2) * selectedShift.hours).toFixed(2)}`} sub={t("shiftDetail.atAvgRate")} tooltip={t("shiftDetail.estimatedGrossTooltip").replace("{min}", selectedShift.wageMin).replace("{max}", selectedShift.wageMax)} color={BRAND.green} />
            <Stat label={t("shiftDetail.transportAllowance")} value={selectedShift.stipend > 0 ? `RM${selectedShift.stipend}` : "—"} sub={selectedShift.stipend > 0 ? undefined : t("shiftDetail.notProvided")} color={selectedShift.stipend > 0 ? BRAND.blue : BRAND.textMuted} />
          </div>
          {selectedShift.description && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selectedShift.description}</div>
            </Card>
          )}
          {(() => {
            // Exact address is shown when the employer made it public, or when
            // this worker has been accepted for the shift. Otherwise only the
            // coarse city/region is shown, with a note explaining why.
            //
            // `selectedShift.myStatus` was read here before, but nothing in
            // the codebase ever sets that field -- neither the Discover-card
            // path nor the notification/chat "View shift" deep-link loader
            // construct a selectedShift with myStatus on it, so this was
            // always undefined and acceptedForShift was always false. An
            // accepted worker opening their own accepted_only shift via chat
            // (or, just as broken, via Discover) saw the coarse-area notice
            // instead of the real address. liveApplications is already loaded
            // for My Bids and carries the real accepted/pending status per
            // shift, so look the answer up there instead of a field that was
            // never wired to any data source.
            const acceptedForShift = (liveApplications ?? []).some(a => a.shiftId === selectedShift.id && a.status === "accepted");
            const canSeeExact = selectedShift.addressVisibility !== "accepted_only" || acceptedForShift;
            const detailLocation = canSeeExact ? selectedShift.location : overviewLocation(selectedShift.location);
            const locationNote = canSeeExact ? null : t("shiftDetail.locationNote");
            return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("shiftDetail.title")}</div>
            {[
              [t("shiftDetail.location"), detailLocation, locationNote],
              selectedShift.isMultiDay
                ? [t("employer.labelSchedule"), selectedShift.occurrences.map(o => formatOccurrenceLine(o, { weekday: 'short', day: 'numeric', month: 'short' })).join(' · ')]
                : [t("shiftDetail.date"), selectedShift.date],
              !selectedShift.isMultiDay ? [t("shiftDetail.time"), selectedShift.time] : null,
              [t("shiftDetail.dressCode"), selectedShift.dress],
              selectedShift.languageRequirements && selectedShift.languageRequirements.length > 0 ? [t("shiftDetail.languagesRequired"), selectedShift.languageRequirements.join(", ")] : null,
              [t("shiftDetail.headcount"), `${selectedShift.headcount} ${t("shiftDetail.workersNeeded")}`],
              selectedShift.applicationsCloseAt && new Date(selectedShift.applicationsCloseAt) > new Date()
                ? [t("shiftDetail.applicationDeadline"), new Date(selectedShift.applicationsCloseAt).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' })]
                : null,
              selectedShift.specialRequirements ? [t("employer.specialRequirementsLabel"), selectedShift.specialRequirements] : null,
              selectedShift.requiredDocuments?.length > 0 ? [t("employer.requiredDocumentsLabel"), SHIFT_REQUIRED_DOCUMENTS.filter(d => selectedShift.requiredDocuments.includes(d.value)).map(d => t(d.labelKey)).join(", ")] : null,
              selectedShift.reliabilityScore != null ? [t("shiftDetail.employerScore"), `${selectedShift.reliabilityScore}/100`] : null,
            ].filter(Boolean).map(([k, v, note]) => (
              <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted, flex: "0 0 38%", maxWidth: 150 }}>{k}</span>
                <span style={{ fontSize: FS.meta, color: BRAND.text, fontWeight: 500 }}>
                  {v}
                  {note && <span style={{ display: "block", fontSize: FS.meta, color: BRAND.textMuted, fontWeight: 400, marginTop: 2 }}><InlineIcon icon={Icons.Lock} size={11} />{note}</span>}
                </span>
              </div>
            ))}
          </Card>
            );
          })()}
          <Card style={{ marginBottom: 20, background: BRAND.grayLight, border: "none" }}>
            {/* The employer's photo/logo alongside their name — this is the
                screen where a worker decides whether to bid, so a real face
                or company mark next to the reliability score is the point of
                having an employer profile picture at all. Before this it was
                uploaded but never fetched into any worker-facing view. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <Avatar name={selectedShift.employer || "?"} size={36} color={BRAND.primary} src={getAvatarUrl(selectedShift.employerAvatarUrl)} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, display: "flex", alignItems: "center", gap: 4 }}>
                  {selectedShift.employer}
                  {selectedShift.employerVerified && <span title={t("discover.verifiedEmployerTooltip")} style={{ color: BRAND.greenOnSurface, fontWeight: 700 }}>✓</span>}
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("shiftDetail.employerReliability")}</div>
              </div>
            </div>
            {selectedShift.reliabilityScore != null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <div style={{ flex: 1 }}><Progress value={selectedShift.reliabilityScore} color={selectedShift.reliabilityScore > 90 ? BRAND.green : selectedShift.reliabilityScore > 75 ? BRAND.accent : BRAND.red} /></div>
                <span style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text }}>{selectedShift.reliabilityScore}/100</span>
              </div>
            ) : (
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 8 }}>{t("shiftDetail.employerScoreSignInToView")}</div>
            )}
            <div style={{ display: "flex", gap: 16 }}>
              <StarRating value={selectedShift.rating ?? 0} onClick={(user && selectedShift.employerId) ? () => openRatingDetails(selectedShift.employerId, 'worker_to_employer', selectedShift.employer) : null} />
              <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{selectedShift.totalApplicants} {t("shiftDetail.applicants")}</span>
            </div>
            {employerAbout[selectedShift.employerId] && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BRAND.border}` }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 2 }}>{t("shiftDetail.aboutEmployer")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{employerAbout[selectedShift.employerId]}</div>
              </div>
            )}
          </Card>
          {/* Deliberately NOT disabled in preview — the bid modal (rate
              slider, live gross-pay calc, binding-offer copy) is a big part
              of what an employer came here to see. The block lives on the
              modal's own Submit Bid button instead, so the whole interface
              stays explorable but nothing can actually be written. */}
          {/* The RLS policy is the real gate (shift must be 'open' and the
              deadline unpassed). Mirroring it here is purely so the worker
              learns WHY before tapping -- otherwise the insert is refused and
              they are shown the raw Postgres text
              "new row violates row-level security policy". */}
          {applicationsClosed ? (
            <div style={{
              width: "100%", textAlign: "center", padding: isMobile ? "12px 10px" : "14px 12px",
              marginBottom: 20, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`,
              background: BRAND.grayLight, color: BRAND.textMuted, fontSize: FS.meta, fontWeight: 600,
            }}>
              {t("discover.applicationsClosed")}
            </div>
          ) : (
          <Btn
            onClick={() => {
              if (user) { setBidAmount(String(selectedShift.wageMin)); setShowBidModal(true); }
              else { setPendingBidAfterAuth(true); onRequireAuth("signin"); }
            }}
            style={{ width: "100%", justifyContent: "center", fontSize: isMobile ? FS.body : FS.card, padding: isMobile ? "12px 0" : "14px 0", marginBottom: 20 }}
          >
            {user ? t("common.placeBid") : t("common.signInToBid")}
          </Btn>
          )}
        </div>
      </div>
      <WorkerBottomNav items={navItems} activeId={tab} onSelect={handleWorkerNavClick} isMobile={isMobile} style={navBarStyle} />
    </div>
  );

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {previewBanner}
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", paddingTop: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingLeft: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingRight: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingBottom: chatThreadFullscreen ? 0 : navPadding, width: "100%", maxWidth: isMobile ? "100%" : 1160, margin: isMobile ? 0 : "0 auto", minHeight: 0 }}>
        {tab === "discover" && (
          <div>
            {/* Anonymous visitors land straight on this tab with nothing to
                explain what the product is or why the payment side is safe —
                the shift list alone doesn't build the trust a first-time
                visitor needs before signing up. Signed-in users skip
                straight to the personalized greeting + shift list they
                already know. */}
            {!user && (
              <DiscoverLandingHero t={t} isMobile={isMobile} onRequireAuth={onRequireAuth} />
            )}
            <div id="open-shifts" style={{ scrollMarginTop: 72, padding: isMobile ? "12px 12px 0" : "20px 20px 0", background: `linear-gradient(160deg, ${BRAND.primary}15, transparent)` }}>
              <div style={{ fontSize: isMobile ? FS.lead : FS.h2, fontWeight: 800, color: BRAND.text, marginBottom: 2 }}>
                {user ? t("discover.welcomeBack").replace("{name}", workerOwnName || user.email?.split("@")[0] || "") : t("discover.browseHeading")}
              </div>
              {user && <div style={{ fontSize: isMobile ? FS.meta : FS.body, color: BRAND.textMuted, marginBottom: 12 }}>{t("discover.subtitleLoggedIn")}</div>}
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 12, scrollbarWidth: "none", marginTop: user ? 0 : 12 }}>
                {cats.map(c => (
                  <button key={c} onClick={() => setFilterCat(c)} style={{
                    padding: isMobile ? "6px 12px" : "8px 16px", borderRadius: RADIUS.pill, border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontWeight: 600, fontSize: FS.meta, whiteSpace: "nowrap",
                    background: filterCat === c ? BRAND.primary : BRAND.grayLight,
                    color: filterCat === c ? "#fff" : BRAND.textMuted,
                    transition: "all 0.15s",
                  }}>{c === "All" ? t("category.all") : shiftCategoryLabel(c, t)}</button>
                ))}
              </div>
            </div>
            <div style={{ padding: isMobile ? "0 12px 8px" : "0 20px 8px" }}>
              <FilterToggle
                open={showFilters}
                onToggle={() => setShowFilters(f => !f)}
                activeCount={[filterCity, filterArea, filterDate, filterPayMin, filterPayMax, filterDuration, filterTimeStart, filterTimeEnd].filter(Boolean).length
                  + (filterCat !== 'All' ? 1 : 0)
                  + (filterHighBooking ? 1 : 0)
                  + (filterWeekend ? 1 : 0)}
                t={t}
              />
              {showFilters && (
                <FilterPanel>
                  {/* Row 1: Location, Date, Duration */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <label htmlFor="discover-filter-city" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterCity")}</label>
                      <select id="discover-filter-city" value={filterCity} onChange={e=>{ setFilterCity(e.target.value); setFilterArea(''); }}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, marginBottom:4}}>
                        <option value="">{t("discover.anyCity")}</option>
                        {Object.keys(CITY_REGIONS).map(city => (
                          <option key={city} value={city}>{city}</option>
                        ))}
                      </select>
                      {/* No visible label of its own -- it appears only once a
                          city is picked, narrowing that selection. Reuses its
                          own placeholder string as the accessible name rather
                          than inventing separate text that could drift from it. */}
                      {filterCity && (
                        <input aria-label={t("discover.filterAreaPlaceholder")} placeholder={t("discover.filterAreaPlaceholder")} value={filterArea} onChange={e=>setFilterArea(e.target.value)}
                          style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', color:BRAND.textMuted, background:BRAND.input}} />
                      )}
                    </div>
                    <div>
                      <label htmlFor="discover-filter-date" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterDate")}</label>
                      <input id="discover-filter-date" type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                    <div>
                      <label htmlFor="discover-filter-duration" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterMaxDuration")}</label>
                      <input id="discover-filter-duration" type="number" min="0" placeholder={t("discover.filterMaxDurationPlaceholder")} value={filterDuration} onChange={e=>setFilterDuration(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                  </div>
                  {/* Row 2: Job type, Min pay, Max pay */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <label htmlFor="discover-filter-jobtype" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterJobType")}</label>
                      <select id="discover-filter-jobtype" value={filterCat} onChange={e=>setFilterCat(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input}}>
                        <option value="All">{t("discover.allTypes")}</option>
                        {SHIFT_CATEGORIES.map(c => <option key={c} value={c}>{shiftCategoryLabel(c, t)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="discover-filter-minpay" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterMinPay")}</label>
                      <input id="discover-filter-minpay" type="number" min="0" placeholder={t("discover.filterMinPayPlaceholder")} value={filterPayMin} onChange={e=>setFilterPayMin(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                    <div>
                      <label htmlFor="discover-filter-maxpay" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterMaxPay")}</label>
                      <input id="discover-filter-maxpay" type="number" min="0" placeholder={t("discover.filterMaxPayPlaceholder")} value={filterPayMax} onChange={e=>setFilterPayMax(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                  </div>
                  {/* Row 3: Start time, End time */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <label htmlFor="discover-filter-starts" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterStartsAfter")}</label>
                      <input id="discover-filter-starts" type="time" value={filterTimeStart} onChange={e=>setFilterTimeStart(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                    <div>
                      <label htmlFor="discover-filter-ends" style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginBottom:3}}>{t("discover.filterEndsBy")}</label>
                      <input id="discover-filter-ends" type="time" value={filterTimeEnd} onChange={e=>setFilterTimeEnd(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.meta, boxSizing:'border-box', background:BRAND.input, color:BRAND.text}} />
                    </div>
                  </div>
                  {/* Row 4: Toggles */}
                  <div style={{display:'flex', gap:16, flexWrap:'wrap'}}>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:FS.meta, color:BRAND.text}}>
                      <input type="checkbox" checked={filterHighBooking} onChange={e=>setFilterHighBooking(e.target.checked)}
                        style={{width:15, height:15, accentColor:BRAND.primary}} />
                      {t("discover.highBookingChance")}
                    </label>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:FS.meta, color:BRAND.text}}>
                      <input type="checkbox" checked={filterWeekend} onChange={e=>setFilterWeekend(e.target.checked)}
                        style={{width:15, height:15, accentColor:BRAND.primary}} />
                      {t("discover.weekendsOnly")}
                    </label>
                  </div>
                  <FilterClearAll
                    show={Boolean(filterCity||filterArea||filterDate||filterPayMin||filterPayMax||filterDuration||filterCat!=='All'||filterHighBooking||filterWeekend||filterTimeStart||filterTimeEnd)}
                    onClear={() => {
                      setFilterCity(''); setFilterArea(''); setFilterDate(''); setFilterPayMin(''); setFilterPayMax('');
                      setFilterDuration(''); setFilterCat('All');
                      setFilterHighBooking(false); setFilterWeekend(false);
                      setFilterTimeStart(''); setFilterTimeEnd('');
                    }}
                    t={t}
                  />
                </FilterPanel>
              )}
            </div>
            <div style={{ padding: isMobile ? "8px 12px 12px" : "8px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              {filtered.length === 0 && (
                <EmptyState
                  icon={<Icons.Search size={28} />}
                  // Three different situations, three messages: still loading,
                  // nothing posted at all, or the filters hide everything.
                  title={liveShifts === null ? t("discover.loadingShifts") : liveShifts.length === 0 ? t("discover.noOpenShifts") : t("discover.noShiftsMatch")}
                  hint={liveShifts === null ? t("discover.loadingShiftsHint") : liveShifts.length === 0 ? t("discover.noOpenShiftsHint") : t("discover.noShiftsMatchHint")}
                />
              )}
              {filtered.map(s => (
                <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "12px 12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          <Badge color="amber" size="xs">{shiftCategoryLabel(s.category, t)}</Badge>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: isMobile ? FS.meta : FS.bodyLg, color: BRAND.text, lineHeight: 1.3, marginBottom: 2 }}>{s.title}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation(); // card itself opens the shift; this opens the employer's ratings instead
                              if (!user) { onRequireAuth("signin"); return; }
                              openRatingDetails(s.employerId, "worker_to_employer", s.employer);
                            }}
                            title={t("discover.viewEmployerRatings")}
                            style={{ border: "none", background: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                            onMouseEnter={e => e.currentTarget.style.textDecorationColor = BRAND.textMuted}
                            onMouseLeave={e => e.currentTarget.style.textDecorationColor = "transparent"}
                          >
                            {s.employer}
                          </button>
                          {s.employerVerified && <span title={t("discover.verifiedEmployerTooltip")} style={{ color: BRAND.greenOnSurface, fontWeight: 700 }}>✓</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                        {/* Estimated total for the shift (lower-bound rate × hours) is the
                            headline figure; the hourly range drops to the small muted line. */}
                        <div style={{ fontWeight: 800, fontSize: isMobile ? FS.bodyLg : FS.lead, color: BRAND.primaryOnSurface }}>~RM{Math.round(s.wageMin * s.hours)}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>RM{s.wageMin}–{s.wageMax}{t("discover.perHour")}</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${BRAND.border}`, marginTop: 10 }}>
                    {[
                      [s.isMultiDay ? t("shiftDetail.daysCount").replace("{count}", s.occurrences.length) : s.date, <Icons.Calendar size={15} />],
                      // Listing cards only ever show the city/region, never the exact place.
                      [overviewLocation(s.location), <Icons.Pin size={15} />],
                      [formatDurationHours(s.hours), <Icons.Clock size={15} />],
                      [t("discover.posApplied", { headcount: s.headcount, applied: s.totalApplicants }), <Icons.Users size={15} />],
                    ].map(([v, ico], i) => (
                      <div key={i} style={{ flex: 1, padding: isMobile ? "6px 0" : "8px 0", textAlign: "center", borderRight: i < 3 ? `1px solid ${BRAND.border}` : "none" }}>
                        {/* Line icons rather than 📅📍⏱️👥. currentColor means they
                            take this muted tone in both themes instead of the
                            OS-dependent, always-full-colour emoji glyph. */}
                        <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", color: BRAND.textMuted }}>{ico}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.3, whiteSpace: "pre-line" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>

            {/* Site footer — minimal, scoped to the Discover (home/landing)
                tab only, so it never crowds the functional in-app tabs
                (My Bids/Chat/Earnings/Profile/Settings). Sits at the end of
                the scrollable content, above the sticky bottom nav — see
                Feature Backlog "Add website's footer". */}
            <footer style={{
              marginTop: 16,
              padding: isMobile ? "20px 16px" : "28px 32px",
              borderTop: `1px solid ${BRAND.border}`,
              background: BRAND.grayLight,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: isMobile ? 20 : 40 }}>
                <div style={{ flex: isMobile ? "1 1 100%" : "0 0 auto", minWidth: 160 }}>
                  <div style={{ fontSize: FS.card, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.02em" }}>
                    Cari<span style={{ color: BRAND.primary }}>Gaji</span>
                  </div>
                  <div style={{ fontSize: FS.micro, color: BRAND.textMuted, marginTop: 4 }}>{t("app.tagline")}</div>
                </div>

                <div style={{ flex: "1 1 140px" }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("footer.quickLinks")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button onClick={() => setTab("discover")} style={footerLinkStyle}>{t("nav.discover")}</button>
                    {!user && <button onClick={() => onRequireAuth("signin")} style={footerLinkStyle}>{t("common.signIn")}</button>}
                    {!user && <button onClick={() => onRequireAuth("register")} style={footerLinkStyle}>{t("common.signUp")}</button>}
                    {!user && <button onClick={() => onRequireAuth("register", "employer")} style={footerLinkStyle}>{t("common.postAShift")}</button>}
                    {user && <button onClick={() => setTab("applications")} style={footerLinkStyle}>{t("nav.myBids")}</button>}
                    {user && <button onClick={() => setTab("profile")} style={footerLinkStyle}>{t("nav.profile")}</button>}
                  </div>
                </div>

                <div style={{ flex: "1 1 220px" }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("footer.categories")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {SHIFT_CATEGORIES.map(c => (
                      <button key={c} onClick={() => setFilterCat(c)} style={footerCategoryChipStyle}>{shiftCategoryLabel(c, t)}</button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ borderTop: `1px solid ${BRAND.border}`, paddingTop: 12, fontSize: FS.meta, color: BRAND.textMuted }}>
                © {new Date().getFullYear()} {SITE.name}. {t("footer.rightsReserved")}
              </div>
            </footer>
          </div>
        )}

        {tab === "applications" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon={<Icons.Doc size={28} />}
            title={t("myBids.signInTitle")}
            hint={t("myBids.signInHint")}
          />
        )}

        {tab === "applications" && user && !selectedApplication && (() => {
          // Ratings were previously reachable ONLY through a button inside a
          // bid's detail view, which nobody is ever pointed at -- so almost no
          // shift got rated and profiles.rating could never accumulate. The
          // whole marketplace leans on that number, so it needs asking for,
          // not just allowing.
          const unrated = (liveApplications ?? []).filter(
            a => a.status === "accepted" && a.shiftStatus === "completed" && a.employerId && !myRatedApplicationIds.has(a.id)
          );
          // The card itself is unchanged; only where it sits moved. Needs-you
          // cards get the primary border so the one section that wants
          // something from the worker reads differently at a glance.
          const renderBidCard = (a, needsYou) => (
                <Card key={a.id} onClick={() => setSelectedApplication(a)} hover style={needsYou ? { border: `1.5px solid ${BRAND.primary}` } : undefined}>
                  {/* Surfaced in the list, not just the detail view: a booking
                      on hold is the one thing a worker must act on, and it
                      would otherwise be invisible until they opened the bid. */}
                  {reconfirmState(a) && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: RADIUS.pill, background: BRAND.amberLight, fontSize: FS.meta, fontWeight: 700, color: "#92400E", marginBottom: 8 }}>
                      <InlineIcon icon={Icons.Alert} />{t("reconfirm.cta")}
                    </div>
                  )}
                  {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: RADIUS.pill, background: BRAND.grayLight, fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginBottom: 8 }}>
                      <Icons.Clock size={12} />{t("myBids.employerDecidesByPrefix")}{formatShiftDate(a.shiftStartAt, { day: 'numeric', month: 'short' })}, {formatShiftTime(a.shiftStartAt)}
                    </div>
                  )}
                  {a.status === "offered" && a.offerExpiresAt && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: RADIUS.pill, background: BRAND.blueLight, fontSize: FS.meta, fontWeight: 600, color: BRAND.onBlueLight, marginBottom: 8 }}>
                      <Icons.Clock size={12} />{t("myBids.respondByPrefix")}{formatShiftDate(a.offerExpiresAt, { day: 'numeric', month: 'short' })}, {formatShiftTime(a.offerExpiresAt)}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 2 }}>{a.shiftTitle}</div>
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); openRatingDetails(a.employerId, "worker_to_employer", a.employer); }}
                          title={t("discover.viewEmployerRatings")}
                          style={{ border: "none", background: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                          onMouseEnter={e => e.currentTarget.style.textDecorationColor = BRAND.textMuted}
                          onMouseLeave={e => e.currentTarget.style.textDecorationColor = "transparent"}
                        >
                          {a.employer}
                        </button>
                        {" · "}{a.isMultiDay ? formatOccurrencesSummary(a.shiftOccurrences) : a.date}
                      </div>
                    </div>
                    <Pill
                      label={a.shiftStatus === "cancelled" ? t("myBids.pillShiftCancelled") : a.status === "offered" ? t("myBids.pillConfirmNow") : a.status === "shortlisted" ? t("myBids.pillShortlisted") : a.status === "accepted" ? t("myBids.pillAccepted") : a.status === "expired" ? t("myBids.pillOfferExpired") : a.status === "rejected" ? t("myBids.pillNotSelected") : t("myBids.pillPending")}
                      {...statusTone("application", a.shiftStatus === "cancelled" ? "shift_cancelled" : a.status)}
                    />
                  </div>
                  {/* This was a vertical dotted timeline copied from the
                      reference app's ride card. That was the wrong metaphor: two
                      dots joined by a line means FROM one place TO another, and
                      on a shift -- which has a single location and a time range --
                      it read as a route with a missing destination. Owner flagged
                      it, and they were right.
                      A time span is horizontal. So: one line for when, one for
                      where, using the same icon vocabulary as the Discover card,
                      with no directional implication at all.
                      overviewLocation, not the raw string: these cards can show a
                      bid that has not been accepted, and the exact address is not
                      the bidder's to see yet. */}
                  {(a.shiftStartAt && a.shiftEndAt) || a.shiftLocation ? (
                    <div style={{ margin: "0 0 12px", display: "flex", flexDirection: "column", gap: 5 }}>
                      {a.shiftStartAt && a.shiftEndAt && (
                        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: FS.meta, color: BRAND.text }}>
                          <span aria-hidden="true" style={{ color: BRAND.textMuted, display: "flex", flexShrink: 0 }}>
                            <Icons.Clock size={15} />
                          </span>
                          <span>
                            <span style={{ fontWeight: 700 }}>
                              {formatShiftTime(a.shiftStartAt)}–{formatShiftTime(a.shiftEndAt)}
                            </span>
                            {(() => {
                              // formatDurationHours(0) returns "0m", so a shift whose
                              // occurrences carry no start/end would state a
                              // confident wrong duration. No hours, no duration.
                              const hrs = totalOccurrenceHours(a.shiftOccurrences);
                              return hrs > 0
                                ? <span style={{ color: BRAND.textMuted }}> · {formatDurationHours(hrs)}</span>
                                : null;
                            })()}
                          </span>
                        </div>
                      )}
                      {overviewLocation(a.shiftLocation) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: FS.meta, color: BRAND.text }}>
                          <span aria-hidden="true" style={{ color: BRAND.textMuted, display: "flex", flexShrink: 0 }}>
                            <Icons.Pin size={15} />
                          </span>
                          <span>{overviewLocation(a.shiftLocation)}</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("myBids.yourBidPrefix")}</div>
                      <span style={{ fontSize: FS.h2, fontWeight: 800, color: BRAND.greenOnSurface }}>RM{a.wageBid}<span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted }}>/h</span></span>
                    </div>
                    {a.status === "shortlisted" && (
                      <Btn size="sm" onClick={(e) => { e.stopPropagation(); setTab('chat'); }}>{t("myBids.chatBtn")}</Btn>
                    )}
                    {a.status === "accepted" && a.shiftStatus !== "cancelled" && renderCheckState(a, (e) => e.stopPropagation())}
                  </div>
                  {a.status === "shortlisted" && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: BRAND.amberLight, borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.onAmberLight }}>
                      <InlineIcon icon={Icons.Star} />{t("myBids.shortlistedBanner")}
                    </div>
                  )}
                  {a.status === 'accepted' && !a.workerSignedAt && a.shiftStatus !== 'cancelled' && (
                    <button onClick={(e) => { e.stopPropagation(); setWorkerContractModal({
                        ...a, applicationId: a.id, employerName: a.employer,
                      }); }}
                      style={{marginTop:6, padding:'6px 14px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontSize:FS.meta, fontWeight:600}}>
                      <InlineIcon icon={Icons.Edit} />{t("myBids.signContractBtn")}
                    </button>
                  )}
                  {a.status === 'accepted' && a.workerSignedAt && (
                    <div style={{display:'flex', alignItems:'center', gap:8, marginTop:4}}>
                      <span style={{fontSize:FS.meta, color: BRAND.greenOnSurface}}><InlineIcon icon={Icons.Check} />{t("myBids.contractSignedBadge")}</span>
                      <button onClick={(e) => { e.stopPropagation(); setWorkerContractModal({
                          ...a, applicationId: a.id, employerName: a.employer, readOnly: true,
                        }); }}
                        style={{padding:'4px 10px', borderRadius:RADIUS.control, background:'none', color: BRAND.primaryOnSurface, border:`1px solid ${BRAND.primaryOnSurface}`, cursor:'pointer', fontSize:FS.meta, fontWeight:600}}>
                        {t("contract.viewContractBtn")}
                      </button>
                    </div>
                  )}
                  {canFileDispute(a) && (
                    myDisputedApplicationIds.has(a.id) ? (
                      <span style={{marginTop:8, display:'inline-block', fontSize:FS.meta, fontWeight:600, color: BRAND.textMuted}}>{t("myBids.disputeAlreadyFiledBadge")}</span>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); setDisputeModal({ applicationId: a.id, shiftTitle: a.shiftTitle }); }}
                        style={{marginTop:8, padding:'6px 14px', borderRadius:RADIUS.control, background: BRAND.grayLight, color: BRAND.text, border: `1px solid ${BRAND.border}`, cursor:'pointer', fontSize:FS.meta, fontWeight:600}}>
                        {t("myBids.fileDisputeBtn")}
                      </button>
                    )
                  )}
                </Card>
          );
          return (
          <div>
            <ScreenTitle isMobile={isMobile}>{t("nav.myBids")}</ScreenTitle>
            {unrated.length > 0 && (
              <div style={{ border: `1px solid ${BRAND.amber}`, background: BRAND.amberLight, borderRadius: RADIUS.card, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: FS.body, fontWeight: 800, color: BRAND.onAmberLight, marginBottom: 4 }}>
                  <InlineIcon icon={Icons.Star} />{t("rating.promptTitle", { count: unrated.length })}
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5, marginBottom: 10 }}>
                  {t("rating.promptBody", { shift: unrated[0].shiftTitle })}
                </div>
                <Btn onClick={() => { setRatingForm({}); setRatingModal({ applicationId: unrated[0].id, shiftTitle: unrated[0].shiftTitle, rateeId: unrated[0].employerId, direction: 'worker_to_employer' }); }}
                     style={{ padding: "9px 16px" }}>
                  {t("rating.promptCta")}
                </Btn>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(liveApplications ?? []).length === 0 && (
                <EmptyState
                  icon={<Icons.Doc size={28} />}
                  title={liveApplications === null ? t("myBids.loadingBids") : t("myBids.noBidsYet")}
                  hint={liveApplications === null ? t("myBids.loadingBidsHint") : t("myBids.noBidsHint")}
                />
              )}
              {(() => {
                const groups = { needs: [], upcoming: [], waiting: [], past: [] };
                (liveApplications ?? []).forEach(a => { const s = bidSection(a); groups[s.key].push({ a, due: s.due }); });
                // Soonest first everywhere a date is still ahead; Past is the
                // one place the most recent matters most, so it runs newest first.
                ["needs", "upcoming", "waiting"].forEach(k => groups[k].sort((x, y) => x.due - y.due));
                const pastKey = (x) => (x.due === Infinity ? -Infinity : x.due);
                groups.past.sort((x, y) => pastKey(y) - pastKey(x));
                const heading = (label, count, color) => (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ ...TYPE.section, color: BRAND.text }}>{label}</span>
                    <Badge color={color}>{count}</Badge>
                  </div>
                );
                return (
                  <>
                    {[
                      ["needs", t("myBids.sectionNeedsYou"), "blue"],
                      ["upcoming", t("myBids.sectionUpcoming"), "green"],
                      ["waiting", t("myBids.sectionWaiting"), "gray"],
                    ].map(([key, label, color]) => groups[key].length > 0 && (
                      <Fragment key={key}>
                        {heading(label, groups[key].length, color)}
                        {groups[key].map(({ a }) => renderBidCard(a, key === "needs"))}
                      </Fragment>
                    ))}
                    {groups.past.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowPastBids(v => !v)}
                        aria-expanded={showPastBids}
                        style={{
                          width: "100%", minHeight: 44, marginTop: 6, padding: "10px 16px",
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                          background: BRAND.surface, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card,
                          color: BRAND.text, cursor: "pointer", fontFamily: "inherit", ...TYPE.cardTitle,
                        }}
                      >
                        <span>{t("myBids.pastToggle", { n: groups.past.length })}</span>
                        <span aria-hidden="true" style={{ display: "flex", color: BRAND.textMuted, transform: showPastBids ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                          <Icons.ChevronDown size={16} />
                        </span>
                      </button>
                    )}
                    {showPastBids && groups.past.map(({ a }) => renderBidCard(a, false))}
                  </>
                );
              })()}
            </div>
          </div>
          );
        })()}

        {tab === "applications" && user && selectedApplication && (() => {
          const a = selectedApplication;
          const reconfirm = reconfirmState(a);
          return (
          <div>
            <button onClick={() => setSelectedApplication(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: FS.body, color: BRAND.primaryOnSurface, fontFamily: "inherit", marginBottom: 16 }} aria-label={t("myBids.backToBids")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("myBids.backToBids")}</span></button>
            {/* Terms changed after signing -- the booking is on hold until the
                worker actively re-accepts. Deliberately the first thing in the
                view, above the status pills, because nothing else on this
                screen matters until it's resolved. */}
            {reconfirm && (
              <div style={{
                border: `1px solid ${reconfirm.expired ? BRAND.red : BRAND.amber}`,
                background: reconfirm.expired ? BRAND.redLight : BRAND.amberLight,
                borderRadius: RADIUS.card, padding: 14, marginBottom: 14,
              }}>
                <div style={{ fontSize: FS.body, fontWeight: 800, color: reconfirm.expired ? BRAND.onRedLight : BRAND.onAmberLight, marginBottom: 6 }}>
                  <InlineIcon icon={Icons.Alert} />{t("reconfirm.heading")}
                </div>
                <div style={{ fontSize: FS.meta, color: reconfirm.expired ? BRAND.onRedLight : BRAND.onAmberLight, lineHeight: 1.5, marginBottom: 10 }}>
                  {t("reconfirm.body", {
                    changed: reconfirm.codes.length
                      ? reconfirm.codes.map(c => notificationChangeLabel(c, t)).join(", ")
                      : notificationChangeLabel("datetime", t),
                  })}
                </div>
                {reconfirm.expired ? (
                  <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.red }}>{t("reconfirm.expired")}</div>
                ) : (
                  <>
                    <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, opacity: 0.85, marginBottom: 10 }}>
                      {t("reconfirm.deadline", {
                        deadline: `${formatShiftDate(new Date(reconfirm.deadline).toISOString(), { day: 'numeric', month: 'short' })}, ${formatShiftTime(new Date(reconfirm.deadline).toISOString())}`,
                      })}
                    </div>
                    <Btn onClick={() => reconfirmTerms(a.id)} disabled={reconfirming} style={{ padding: "9px 16px" }}>
                      {reconfirming ? t("reconfirm.confirming") : t("reconfirm.cta")}
                    </Btn>
                  </>
                )}
              </div>
            )}
            {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: RADIUS.pill, background: BRAND.grayLight, fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, marginBottom: 10 }}>
                <Icons.Clock size={12} />{t("myBids.employerDecidesByPrefix")}{formatShiftDate(a.shiftStartAt, { day: 'numeric', month: 'short', year: 'numeric' })}, {formatShiftTime(a.shiftStartAt)}
              </div>
            )}
            {a.status === "offered" && a.offerExpiresAt && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: RADIUS.pill, background: BRAND.blueLight, fontSize: FS.meta, fontWeight: 600, color: BRAND.onBlueLight, marginBottom: 10 }}>
                <Icons.Clock size={12} />{t("myBids.respondByPrefix")}{formatShiftDate(a.offerExpiresAt, { day: 'numeric', month: 'short', year: 'numeric' })}, {formatShiftTime(a.offerExpiresAt)}
              </div>
            )}
            <div style={{ fontSize: FS.h3, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{a.shiftTitle}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill
                label={a.shiftStatus === "cancelled" ? t("myBids.pillShiftCancelled") : a.status === "offered" ? t("myBids.pillConfirmNow") : a.status === "shortlisted" ? t("myBids.pillShortlisted") : a.status === "accepted" ? t("myBids.pillAccepted") : a.status === "expired" ? t("myBids.pillOfferExpired") : a.status === "rejected" ? t("myBids.pillNotSelected") : t("myBids.pillPending")}
                {...statusTone("application", a.shiftStatus === "cancelled" ? "shift_cancelled" : a.status)}
              />
              {a.shiftCategory && <Badge color="amber">{shiftCategoryLabel(a.shiftCategory, t)}</Badge>}
            </div>
            {a.shiftStatus === "cancelled" && !a.cancellationChoiceDeadline && (
              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.red, marginBottom: 16 }}>
                {t("myBids.shiftCancelledNotice")}
              </div>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoiceDeadline && !a.cancellationChoice && (
              <Card style={{ marginBottom: 16, border: `1.5px solid ${BRAND.red}` }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.red, marginBottom: 4 }}>{t("myBids.lateCancellationTitle")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 4 }}>
                  {t("myBids.lateCancellationBody")}
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>
                  <InlineIcon icon={Icons.Clock} />{t("myBids.respondByPrefix")}{new Date(a.cancellationChoiceDeadline).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: MY_TIMEZONE })}, {new Date(a.cancellationChoiceDeadline).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: MY_TIMEZONE })}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <Btn variant="secondary" style={{ flex: 1, justifyContent: "center" }}
                    onClick={() => setCancellationContractModal({ applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid })}>
                    {t("myBids.cancellation50Btn", { amount: `RM${cancellationPayoutAmount(a.wageBid, a.shiftOccurrences, 0.5, a.shiftStartAt, a.shiftEndAt).toFixed(2)}` })}
                  </Btn>
                </div>
                <label style={{ display: "block" }}>
                  <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("myBids.cancellationShowUpLabel", { amount: `RM${cancellationPayoutAmount(a.wageBid, a.shiftOccurrences, 1.0, a.shiftStartAt, a.shiftEndAt).toFixed(2)}` })}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 8 }}>{t("myBids.cancellationShowUpHint")}</div>
                  <input
                    type="file" accept="image/*" capture="environment"
                    disabled={cancellationProofUploading === a.id}
                    onChange={e => { const f = e.target.files?.[0]; if (f) submitShowUpProof(a.id, f); e.target.value = ""; }}
                    style={{ fontSize: FS.meta }}
                  />
                  {cancellationProofUploading === a.id && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>{t("myBids.cancellationProofUploading")}</div>}
                </label>
              </Card>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoice === "contract_50" && (
              <div style={{ padding: "10px 14px", background: BRAND.grayLight, borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.text, marginBottom: 16 }}>
                {t("myBids.cancellationChose50")}
              </div>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoice === "show_up_100" && (
              <div style={{ padding: "10px 14px", background: a.cancellationProofPath ? BRAND.greenLight : BRAND.amberLight, borderRadius: RADIUS.control, fontSize: FS.meta, color: a.cancellationProofPath ? BRAND.green : BRAND.amber, marginBottom: 16 }}>
                {a.cancellationProofPath ? t("myBids.cancellationProofSubmitted") : t("myBids.cancellationAwaitingProof")}
              </div>
            )}
            {a.status === "offered" && a.shiftStatus !== "cancelled" && (
              <div style={{ padding: "10px 14px", background: BRAND.blueLight, borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.onBlueLight, marginBottom: 16 }}>
                <div><InlineIcon icon={Icons.Star} />{t("myBids.selectedNotice")}</div>
                <button
                  onClick={() => setContractPreviewOpenIds(prev => { const next = new Set(prev); next.has(a.id) ? next.delete(a.id) : next.add(a.id); return next; })}
                  style={{ background: "none", border: "none", padding: 0, marginTop: 8, cursor: "pointer", fontSize: FS.meta, fontWeight: 700, color: BRAND.blue, textDecoration: "underline" }}
                >
                  {contractPreviewOpenIds.has(a.id) ? t("myBids.hideContractTermsBtn") : t("myBids.viewContractTermsBtn")}
                </button>
                {contractPreviewOpenIds.has(a.id) && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BRAND.border}`, fontSize: FS.meta, color: BRAND.text, lineHeight: 1.7 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("contract.agreeToTermsHeading")}</div>
                    <div>1. {t("contract.workerClause1")}</div>
                    <div>2. {t("contract.workerClause2")}</div>
                    <div>3. {t("contract.workerClause3")}</div>
                    <div>4. {t("contract.workerClause4")}</div>
                    <div>5. {t("contract.workerClause5")}</div>
                    <div>6. {t("contract.workerClause6")}</div>
                    <div>7. {t("contract.workerClause7")}</div>
                    <div>8. {t("contract.workerClause8")}</div>
                  </div>
                )}
              </div>
            )}
            {a.status === "expired" && (
              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.red, marginBottom: 16 }}>
                {t("myBids.offerExpiredNotice")}
              </div>
            )}
            {a.shiftDescription && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{a.shiftDescription}</div>
              </Card>
            )}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("shiftDetail.title")}</div>
              {[
                [t("myBids.employerLabel"), (
                  <button
                    onClick={() => openRatingDetails(a.employerId, "worker_to_employer", a.employer)}
                    title={t("discover.viewEmployerRatings")}
                    style={{ border: "none", background: "none", padding: 0, margin: 0, font: "inherit", fontWeight: 500, color: BRAND.primaryOnSurface, cursor: "pointer", textDecoration: "underline" }}
                  >
                    {a.employer}
                  </button>
                )],
                [t("shiftDetail.location"), a.shiftLocation || t("shiftDetail.tba")],
                a.isMultiDay
                  ? [t("employer.labelSchedule"), a.shiftOccurrences.map(o => formatOccurrenceLine(o, { weekday: 'short', day: 'numeric', month: 'short' })).join(' · ')]
                  : [t("shiftDetail.date"), a.date],
                !a.isMultiDay ? [t("shiftDetail.time"), a.shiftStartAt && a.shiftEndAt ? `${formatShiftTime(a.shiftStartAt)}–${formatShiftTime(a.shiftEndAt)}` : t("shiftDetail.tba")] : null,
                [t("shiftDetail.dressCode"), a.shiftDress || t("shiftDetail.dressCodeNone")],
                a.shiftLanguages && a.shiftLanguages.length > 0 ? [t("shiftDetail.languagesRequired"), a.shiftLanguages.join(", ")] : null,
                [t("shiftDetail.headcount"), `${a.shiftHeadcount} ${t("shiftDetail.workersNeeded")}`],
                [t("myBids.employerRangeRow"), a.shiftWageMin && a.shiftWageMax ? `RM${a.shiftWageMin}–${a.shiftWageMax}/h` : t("shiftDetail.notApplicable")],
                [t("myBids.transportAllowanceRow"), a.shiftStipend > 0 ? `RM${a.shiftStipend}` : t("shiftDetail.notProvided")],
                [t("shiftDetail.yourBid"), `RM${a.wageBid}/h`],
              ].filter(Boolean).map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: FS.meta, color: BRAND.textMuted, flex: "0 0 38%", maxWidth: 160 }}>{k}</span>
                  <span style={{ fontSize: FS.meta, color: BRAND.text, fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </Card>
            {a.status === "shortlisted" && (
              <div style={{ padding: "10px 14px", background: BRAND.amberLight, borderRadius: RADIUS.control, fontSize: FS.meta, color: BRAND.onAmberLight, marginBottom: 16 }}>
                <InlineIcon icon={Icons.Star} />{t("myBids.shortlistedBanner")}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              {a.status === "pending" && a.shiftStatus !== "cancelled" && (
                <Btn variant="secondary" disabled={cancellingBid} onClick={() => cancelBid(a.id)} style={{ flex: 1, justifyContent: "center", color: BRAND.red }}>
                  {cancellingBid ? t("myBids.cancelling") : t("myBids.cancelBidBtn")}
                </Btn>
              )}
              {a.status === "shortlisted" && a.shiftStatus !== "cancelled" && (
                <Btn onClick={() => setTab('chat')} style={{ flex: 1, justifyContent: "center" }}>{t("myBids.chatBtn")}</Btn>
              )}
              {a.status === "offered" && a.shiftStatus !== "cancelled" && (
                <>
                  <Btn variant="secondary" disabled={respondingOffer} onClick={() => declineOffer(a.id)} style={{ flex: 1, justifyContent: "center", color: BRAND.red }}>
                    {respondingOffer ? "…" : t("myBids.declineBtn")}
                  </Btn>
                  <Btn variant="success" disabled={respondingOffer} onClick={() => confirmOffer(a.id)} style={{ flex: 1, justifyContent: "center" }}>
                    {respondingOffer ? "…" : t("myBids.confirmShiftBtn")}
                  </Btn>
                </>
              )}
              {a.status === "accepted" && !a.workerSignedAt && a.shiftStatus !== "cancelled" && (
                <Btn onClick={() => setWorkerContractModal({ ...a, applicationId: a.id, employerName: a.employer })} style={{ flex: 1, justifyContent: "center" }}><InlineIcon icon={Icons.Edit} />{t("myBids.signContractBtn")}</Btn>
              )}
              {/* Deliberately available whether or not the contract is signed,
                  and never gated on employer approval -- a worker who cannot
                  come needs a route that isn't "just don't turn up". Placed
                  last and styled quietly so it is findable, not inviting. */}
              {a.status === "accepted" && a.shiftStatus !== "cancelled" && !a.checkedInAt && !attendanceIssue(a) && (
                <Btn variant="secondary" onClick={() => { setWithdrawTarget(a); setWithdrawReason(""); }}
                     style={{ flex: 1, justifyContent: "center", color: BRAND.red, borderColor: BRAND.red }}>
                  {t("withdraw.btn")}
                </Btn>
              )}
              {a.status === "accepted" && a.workerSignedAt && a.shiftStatus !== "cancelled" && (
                <>
                  <Btn variant="secondary" onClick={() => setWorkerContractModal({
                      ...a, applicationId: a.id, employerName: a.employer, readOnly: true,
                    })} style={{ flex: 1, justifyContent: "center" }}>{t("contract.viewContractBtn")}</Btn>
                  {!a.checkedInAt && !attendanceIssue(a) && (
                    <Btn variant="success" onClick={() => { setCheckinTarget({ applicationId: a.id, shiftTitle: a.shiftTitle }); setCheckinCode(""); setCheckinResult(null); setShowQR(true); }} style={{ flex: 1, justifyContent: "center" }}>{t("worker.checkInBtn")}</Btn>
                  )}
                  {attendanceIssue(a) && (
                    <div style={{ flex: 1 }}>{renderAttendanceIssue(a, attendanceIssue(a), "center")}</div>
                  )}
                  {a.checkedInAt && !a.checkedOutAt && !attendanceIssue(a) && a.employerProposedHours == null && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "stretch" }}>
                      <Btn variant="success" onClick={() => { setCheckoutTarget({ applicationId: a.id, shiftTitle: a.shiftTitle, defaultHours: totalOccurrenceHours(a.shiftOccurrences) }); setCheckoutHours(""); setCheckoutBreakMinutes(""); setCheckoutNote(""); setCheckoutResult(null); }} style={{ justifyContent: "center" }}>{t("worker.checkOutBtn")}</Btn>
                      {checkoutDeadlineHint(a, "center")}
                    </div>
                  )}
                  {a.checkedInAt && a.employerProposedHours != null && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.onAmberLight, background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "6px 10px", textAlign: "center" }}>
                        {t(a.checkedOutAt ? "worker.employerProposedLabel" : "worker.employerSubmittedLabel").replace("{hours}", a.employerProposedHours)}
                        <HoursNote label={t("hours.employerNoteLabel")} text={a.employerProposedNote} tone="them" />
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn size="xs" variant="secondary" disabled={respondingHoursModification === a.id} onClick={() => openResubmitAfterProposal(a)}>{t("worker.rejectModificationBtn")}</Btn>
                        <Btn size="xs" variant="success" disabled={respondingHoursModification === a.id} onClick={() => acceptHoursModification(a.id)}>{t("worker.acceptModificationBtn")}</Btn>
                      </div>
                    </div>
                  )}
                  {a.checkedInAt && a.checkedOutAt && a.employerHoursDisputed && a.employerProposedHours == null && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.red, marginBottom: 4 }}>{t("worker.hoursDisputedBadge")}</span>
                      {renderHoursNote(t("hours.employerNoteLabel"), a.employerHoursDisputeNote, "center")}
                      <Btn size="sm" variant="success" style={{ marginTop: 6 }} onClick={() => { setCheckoutTarget({ applicationId: a.id, shiftTitle: a.shiftTitle, defaultHours: a.workerReportedHours ?? totalOccurrenceHours(a.shiftOccurrences) }); setCheckoutHours(""); setCheckoutBreakMinutes(""); setCheckoutNote(""); setCheckoutResult(null); }}>{t("worker.resubmitCheckout")}</Btn>
                    </div>
                  )}
                  {a.checkedInAt && a.checkedOutAt && !a.employerHoursDisputed && a.employerProposedHours == null && (
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: FS.meta, fontWeight: 600, color: a.employerHoursConfirmedAt ? BRAND.green : BRAND.textMuted }}>
                      {a.employerHoursConfirmedAt ? <span><InlineIcon icon={Icons.Check} />{t("worker.hoursConfirmedBadge")}</span> : t("worker.checkoutPendingBadge")}
                      {!a.employerHoursConfirmedAt && renderHoursNote(t("hours.yourNoteLabel"), a.workerCheckoutNote, "center", "me")}
                    </div>
                  )}
                </>
              )}
              {a.status === "accepted" && a.shiftStatus === "completed" && a.employerId && !myRatedApplicationIds.has(a.id) && (
                <Btn variant="secondary" onClick={() => { setRatingForm({}); setRatingModal({ applicationId: a.id, shiftTitle: a.shiftTitle, rateeId: a.employerId, direction: 'worker_to_employer' }); }} style={{ flex: 1, justifyContent: "center" }}>{t("rating.rateBtn")}</Btn>
              )}
            </div>
            {/* Deliberately its own small row, separated from the primary
                actions above rather than sharing their flex:1 row -- it used
                to sit directly beside Check In at the same size, and an
                infrequent, hard-to-undo action next to a frequent one invites
                a mis-tap. Kept reachable, not equally weighted. */}
            {canFileDispute(a) && !myDisputedApplicationIds.has(a.id) && (
              <div style={{ marginTop: 10, textAlign: "right" }}>
                <Btn size="xs" variant="secondary" onClick={() => setDisputeModal({ applicationId: a.id, shiftTitle: a.shiftTitle })}>{t("myBids.fileDisputeBtn")}</Btn>
              </div>
            )}
            {a.shiftStatus === "completed" && myDisputedApplicationIds.has(a.id) && (
              <div style={{ marginTop: 10, textAlign: "right", fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted }}>{t("myBids.disputeAlreadyFiledBadge")}</div>
            )}
          </div>
          );
        })()}

        {tab === 'chat' && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon={<Icons.Chat size={28} />}
            title={t("chat.signInTitle")}
            hint={t("chat.signInHint")}
          />
        )}

        {tab === 'chat' && user && (
          // The open-thread view used to set its own `height: calc(100vh - 200px)`
          // while sitting inside an ancestor that's *also* independently
          // scrollable (overflowY:'auto' at the tab-content level) — the two
          // rarely agreed on exact pixels, so both ends up overflowing and
          // showing their own scrollbar. Bounding this wrapper to the
          // ancestor's actual box (height:'100%') and making the open-thread
          // branch a flex:1 child means only the message list scrolls.
          <div style={activeChatShift ? {display:'flex', flexDirection:'column', height:'100%', minHeight:0} : {padding:'0 0 80px'}}>
            {/* Hidden once a thread is open: that view has its own header, and
                a second "Messages" title above it only ate vertical space. */}
            {!activeChatShift && (
              <ScreenTitle isMobile={isMobile} style={{margin:'8px 0 14px'}}>{t("chat.title")}</ScreenTitle>
            )}
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:BRAND.textMuted, marginTop:48}}>
                  <div aria-hidden="true" style={{ display: "flex", justifyContent: "center" }}><Icons.Chat size={34} /></div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleWorker")}</div>
                  <div style={{fontSize:FS.meta, marginTop:4}}>{t("chat.emptyHintWorker")}</div>
                </div>
              ) : (
                sortConversationsByRecent(chatConversations, roomPreviews).map(conv => (
                  <div key={conv.shiftId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:BRAND.surface, borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`,
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', gap:12}}>
                    {/* The reference app leads every inbox row with the other
                        person's photo; this list had none at all, which is what
                        made it read as a list of records rather than of people.
                        The employer console has a verbatim copy of this row and
                        is deliberately left alone -- this pass is worker-only. */}
                    <Avatar
                      name={conv.otherUserName || conv.otherUserLabel}
                      size={44}
                      color={BRAND.primary}
                      src={getAvatarUrl(conv.otherUserAvatar)}
                    />
                    <div style={{minWidth:0, flex:1}}>
                      <div style={{fontWeight: unreadRoomIds.has(conv.shiftId) ? 800 : 600, color:BRAND.text, display:'flex', alignItems:'center', gap:6}}>
                        {/* A dot as well as the weight: bold alone is easy to
                            miss, and is invisible to anyone who cannot compare
                            two rows side by side. */}
                        {unreadRoomIds.has(conv.shiftId) && (
                          <span aria-hidden="true" style={{width:8, height:8, borderRadius:RADIUS.pill, background:BRAND.red, flexShrink:0}} />
                        )}
                        {conv.title}
                      </div>
                      <div style={{fontSize:FS.meta, color:BRAND.textMuted}}>{conv.date} · {conv.otherUserLabel}</div>
                      {/* Who spoke last and what they said, so the list is
                          readable without opening every room. */}
                      {(() => {
                        const preview = chatPreviewLine(roomPreviews.get(conv.shiftId), user, previewSenderNames, t);
                        if (!preview) return null;
                        return (
                          <div style={{
                            fontSize:FS.meta, marginTop:4,
                            color: unreadRoomIds.has(conv.shiftId) ? BRAND.text : BRAND.textMuted,
                            fontWeight: unreadRoomIds.has(conv.shiftId) ? 600 : 400,
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                          }}>
                            <span style={{fontWeight:700, color:BRAND.text}}>{preview.name}:</span>{' '}
                            {displayProtectedText(preview.text)}
                          </div>
                        );
                      })()}
                    </div>
                    <div style={{display:'flex', alignItems:'center', gap:8, flexShrink:0, marginLeft:10}}>
                      {(() => {
                        const preview = chatPreviewLine(roomPreviews.get(conv.shiftId), user, previewSenderNames, t);
                        if (!preview) return null;
                        return <span style={{fontSize:FS.meta, color:BRAND.textMuted, whiteSpace:'nowrap'}}>{chatDayLabel(preview.at, t)}</span>;
                      })()}
                      <span style={{color:BRAND.textMuted}}>›</span>
                    </div>
                  </div>
                ))
              )
            ) : (
              <div style={{display:'flex', flexDirection:'column', flex:1, minHeight:0}}>
                {/* Header leads with the PERSON and the shift moves to its own
                    strip below -- the same split the reference app uses for a ride.
                    The back arrow hardcoded #2563EB, which stays the light-mode
                    blue on a dark surface; primaryOnSurface adapts. The employer
                    console holds a verbatim copy of this header and is left alone:
                    this pass is worker-only. */}
                <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    aria-label={t("common.back")}
                    style={{background:'none', border:'none', cursor:'pointer', color:BRAND.primaryOnSurface, display:'flex', alignItems:'center', padding:0}}>
                    <Icons.ArrowLeft size={20} />
                  </button>
                  <Avatar
                    name={activeChatShift.otherUserName || activeChatShift.otherUserLabel}
                    size={38}
                    color={BRAND.primary}
                    src={getAvatarUrl(activeChatShift.otherUserAvatar)}
                  />
                  <div style={{minWidth:0, flex:1}}>
                    <div style={{fontWeight:700, color:BRAND.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {activeChatShift.otherUserName || activeChatShift.otherUserLabel}
                    </div>
                    {/* The names are the affordance -- tapping them says who is
                        actually in the room. A shift room can hold several
                        workers, and the header only ever showed a truncated
                        join of their names. */}
                    <button
                      onClick={() => setChatMembersOpen(o => !o)}
                      aria-expanded={chatMembersOpen}
                      style={{
                        border:'none', background:'none', padding:0, cursor:'pointer', fontFamily:'inherit',
                        fontSize:FS.meta, color:BRAND.primaryOnSurface, textAlign:'left', maxWidth:'100%',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      }}
                    >
                      {chatMembers === null
                        ? activeChatShift.otherUserLabel
                        : t("chat.membersCount", { n: chatMembers.length })} ▾
                    </button>
                  </div>
                </div>
                {/* Half of what gets asked in the room ("what time again?",
                    "where?") is answered on the shift's page. This was a small xs
                    button in the header row; as a full-width strip it states the
                    shift, its date and that it is confirmed, and gives a far
                    bigger tap target for the same action. */}
                <button
                  onClick={() => setOpenShiftId(activeChatShift.shiftId)}
                  style={{
                    display:'flex', alignItems:'center', gap:10, width:'100%', textAlign:'left',
                    padding:'10px 0', marginBottom:10, border:'none', borderTop:`1px solid ${BRAND.border}`,
                    borderBottom:`1px solid ${BRAND.border}`, background:'none', cursor:'pointer',
                    fontFamily:'inherit', flexShrink:0,
                  }}>
                  <span style={{flex:1, minWidth:0}}>
                    <span style={{display:'block', fontSize:FS.body, fontWeight:700, color:BRAND.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {activeChatShift.title}
                    </span>
                    <span style={{display:'block', fontSize:FS.meta, color:BRAND.textMuted, marginTop:2}}>
                      {/* A room only exists for an accepted application, so this
                          is a fact about the row, not an optimistic label. */}
                      <span style={{color:BRAND.greenOnSurface, fontWeight:700}}>{t("myBids.pillAccepted")}</span>
                      {activeChatShift.date ? ` \u00b7 ${activeChatShift.date}` : ""}
                    </span>
                  </span>
                  <span aria-hidden="true" style={{color:BRAND.textMuted, display:'flex', flexShrink:0}}>
                    <Icons.ChevronRight size={16} />
                  </span>
                </button>
                {chatMembersOpen && (
                  <div style={{
                    border:`1px solid ${BRAND.border}`, borderRadius:RADIUS.control, background:BRAND.surface,
                    padding:'8px 4px', marginBottom:12, boxShadow:`0 6px 20px ${BRAND.shadow}`,
                  }}>
                    <div style={{fontSize:FS.meta, fontWeight:700, color:BRAND.textMuted, padding:'2px 12px 6px'}}>
                      {t("chat.membersTitle")}
                    </div>
                    {chatMembers === null ? (
                      <div style={{fontSize:FS.meta, color:BRAND.textMuted, padding:'4px 12px'}}>{t("chat.loading")}</div>
                    ) : chatMembers.length === 0 ? (
                      <div style={{fontSize:FS.meta, color:BRAND.textMuted, padding:'4px 12px'}}>{t("chat.membersEmpty")}</div>
                    ) : chatMembers.map(m => (
                      <div key={m.user_id} style={{display:'flex', alignItems:'center', gap:10, padding:'6px 12px'}}>
                        <Avatar name={m.full_name} size={26} color={m.role === 'employer' ? BRAND.primary : BRAND.accent} src={getAvatarUrl(m.avatar_url)} />
                        <div style={{minWidth:0, flex:1}}>
                          <div style={{fontSize:FS.meta, color:BRAND.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                            {m.full_name}{m.user_id === user?.id && ` ${t("chat.membersYou")}`}
                          </div>
                        </div>
                        <Pill label={t(m.role === 'employer' ? "chat.roleEmployer" : "chat.roleWorker")} color={m.role === 'employer' ? 'blue' : 'green'} />
                      </div>
                    ))}
                  </div>
                )}
                <div style={{flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingBottom:8}}>
                  {chatLoading && <div style={{textAlign:'center', color:BRAND.textMuted, padding:16}}>{t("chat.loading")}</div>}
                  {chatMessages.map((msg, i) => {
                    const isMe = msg.sender_id === user.id;
                    // A day heading whenever the calendar day changes. Without
                    // it a bare "08:05" following a bare "08:00" reads as a
                    // reply five minutes later even when a night sits between.
                    const prevMsg = i > 0 ? chatMessages[i - 1] : null;
                    const showDay = !prevMsg || chatDayKey(prevMsg.created_at) !== chatDayKey(msg.created_at);
                    // First message this user had not seen when they opened the
                    // room, and not one of their own -- your own message is
                    // never "new" to you.
                    const isFirstUnseen = !isMe
                      && chatUnreadFrom !== null
                      && new Date(msg.created_at) > new Date(chatUnreadFrom)
                      && !(prevMsg && prevMsg.sender_id !== user?.id && new Date(prevMsg.created_at) > new Date(chatUnreadFrom));
                    return (
                      <Fragment key={msg.id}>
                      {showDay && (
                        <div style={{ display: "flex", justifyContent: "center", margin: "6px 0 2px" }}>
                          <span style={{
                            fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted,
                            background: BRAND.grayLight, borderRadius: RADIUS.pill, padding: "3px 10px",
                          }}>{chatDayLabel(msg.created_at, t)}</span>
                        </div>
                      )}
                      {isFirstUnseen && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 4px" }}>
                          <div style={{ flex: 1, height: 1, background: BRAND.red, opacity: 0.35 }} />
                          <span style={{
                            fontSize: FS.meta, fontWeight: 700, color: BRAND.onRedLight,
                            background: BRAND.redLight, borderRadius: RADIUS.pill, padding: "3px 10px", whiteSpace: "nowrap",
                          }}>{t("chat.newMessagesDivider")}</span>
                          <div style={{ flex: 1, height: 1, background: BRAND.red, opacity: 0.35 }} />
                        </div>
                      )}
                      <div style={{display:'flex', flexDirection:'column', alignItems: isMe ? 'flex-end' : 'flex-start'}}>
                        <div style={{fontSize:FS.meta, fontWeight:600, color:BRAND.textMuted, margin: isMe ? '0 2px 2px 0' : '0 0 2px 2px'}}>
                          {isMe ? 'You' : (chatSenderNames[msg.sender_id] || 'Member')}
                        </div>
                        {/* The incoming bubble had a fill and no edge: grayLight is
                            #F9FAFB on a #FFFFFF surface -- 1.05:1, a shape nobody
                            can see. Mine reads because #2563EB is 5.17:1 against
                            the same surface, which is why only one side looked
                            like it had bubbles. Dark mode was the same fault
                            mirrored (#0F172A on #111827).
                            A border is the fix rather than a darker fill: it gives
                            the bubble an edge in both themes without touching the
                            text contrast, which already passes. */}
                        <div style={{maxWidth:'75%', padding:'8px 12px', borderRadius: isMe ? `${RADIUS.card}px ${RADIUS.card}px 2px ${RADIUS.card}px` : `${RADIUS.card}px ${RADIUS.card}px ${RADIUS.card}px 2px`,
                          background: isMe ? BRAND.primary : BRAND.grayLight, color: isMe ? '#fff' : BRAND.text, fontSize:FS.body,
                          border: isMe ? '1px solid transparent' : `1px solid ${BRAND.border}`}}>
                          <div>{msg.content}</div>
                          {/* Hovering gives the unabbreviated date and time, so
                              anyone reconciling a conversation against a shift
                              need not count day headings. */}
                          <div title={chatFullTimestamp(msg.created_at)} style={{fontSize:FS.meta, opacity:0.6, marginTop:2, textAlign:'right'}}>
                            {formatShiftTime(msg.created_at)}
                          </div>
                        </div>
                      </div>
                      </Fragment>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                {/* With the tab bar gone this is the last thing on screen, so it
                    carries the home-indicator inset itself. */}
                <div style={{
                  display:'flex', gap:8, paddingTop:8, borderTop:`1px solid ${BRAND.border}`,
                  paddingBottom: chatThreadFullscreen ? navSafeAreaInset : 0,
                }}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    onFocus={() => {
                      // The keyboard resizes the viewport a beat after focus.
                      // Without this the newest message sits behind it and you
                      // have to scroll to see what you are replying to.
                      setTimeout(() => chatEndRef.current?.scrollIntoView({ block: 'end' }), 250);
                    }}
                    placeholder={t("chat.inputPlaceholder")}
                    style={{flex:1, padding:'10px 12px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, fontSize:FS.body, background:BRAND.input, color:BRAND.text}}
                  />
                  {/* Tapping a button moves focus off the input, and losing focus
                      is what closes the on-screen keyboard — so every send
                      dismissed the keyboard and you had to tap the field again to
                      write the next line. Nothing in sendMessage does this; it is
                      simply what a tap does by default.
                      Blocking the default on mousedown (browsers synthesise one
                      before click on touch) means the button never takes focus, so
                      the field keeps it and the keyboard stays up. Enter was always
                      fine — pressing it never moved focus in the first place. */}
                  <button onClick={sendMessage}
                    onMouseDown={e => e.preventDefault()}
                    style={{padding:'10px 16px', borderRadius:RADIUS.control, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                    {t("chat.send")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "earnings" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon={<Icons.Wallet size={28} />}
            title={t("earnings.signInTitle")}
            hint={t("earnings.signInHint")}
          />
        )}

        {tab === "earnings" && user && (
          <div>
            {/* Was: a title/subtitle pair, a full-width blue gradient hero, and a
                2x2 grid of Stat tiles -- three stacked blocks before any actual
                payout. The reference opens a money screen with one large title
                and a single two-up strip, so that is what this does now.
                "Ready to release" and the banking tile are gone from the grid on
                purpose: ready is surfaced per row by its own status pill, and
                banking status is a thing you ACT on, so it belongs in the note
                below where it can carry a link, not in a read-only tile. */}
            <ScreenTitle isMobile={isMobile} sub={t("earnings.subtitle")}>{t("earnings.title")}</ScreenTitle>
            <StatStrip items={[
              { icon: <Icons.Money size={18} />, value: toCurrency(totalEarned), label: t("earnings.totalPayouts") },
              { icon: <Icons.List size={18} />, value: String((workerPayoutSummary || []).length), label: t("earnings.statRecords") },
            ]} />
            <InfoNote>{payoutEligibility ? t("earnings.verified") : t("earnings.notVerified")}</InfoNote>
            {/* Held payouts get a line only when there ARE any. A permanent
                "Held: 0" tile is noise; a held payout is money the worker was
                expecting and did not get, so when it happens it should read as a
                warning rather than a statistic. */}
            {(workerPayoutSummary || []).filter(p => p.status === "held").length > 0 && (
              <div style={{
                display: "flex", gap: 10, alignItems: "center", marginBottom: 18,
                padding: "10px 12px", borderRadius: RADIUS.control,
                background: BRAND.amberLight, color: BRAND.onAmberLight,
              }}>
                <Icons.Info size={18} />
                <span style={{ fontSize: FS.meta, fontWeight: 600 }}>
                  {t("earnings.statHeld")}: {(workerPayoutSummary || []).filter(p => p.status === "held").length}
                </span>
              </div>
            )}
            {!payoutsLoading && (
              <Card style={{ marginBottom: 20, padding: isMobile ? "16px 14px" : "20px" }}>
                <div style={{ fontSize: isMobile ? FS.meta : FS.bodyLg, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("earnings.monthlyChartTitle")}</div>
                <MonthlyEarningsBarChart months={monthlyEarnings} truncated={monthlyEarningsTruncated} isMobile={isMobile} t={t} />
              </Card>
            )}
            <div style={{ fontSize: isMobile ? FS.meta : FS.bodyLg, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("earnings.recentPayouts")}</div>
            {payoutsLoading ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : payoutRows.length === 0 ? (
              <EmptyState
                icon={<Icons.Wallet size={28} />}
                title={t("earnings.noPayoutsTitle")}
                hint={t("earnings.noPayoutsHint")}
              />
            ) : (
              <>
                {payoutRows.map((p, i) => {
                  // A month header renders once, right before the first row
                  // of that month — payoutRows is already in descending
                  // date order from the query, so consecutive same-month
                  // rows never re-print the header.
                  const showMonthHeader = p.monthKey && p.monthKey !== payoutRows[i - 1]?.monthKey;
                  return (
                    <div key={p.id}>
                      {showMonthHeader && (
                        <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, textTransform: "uppercase", letterSpacing: "0.04em", margin: i === 0 ? "0 0 8px" : "18px 0 8px" }}>
                          {payoutMonthLabels[p.monthKey]}
                        </div>
                      )}
                      {/* The card opens the slip; the job name inside it opens the
                          shift. Two targets in one row, so the inner one stops
                          propagation -- without that, tapping the job name would
                          fire both and the slip would cover the shift you just
                          asked for. */}
                      <Card
                        onClick={() => setSlipPayout(p)}
                        hover
                        style={{ marginBottom: 10, padding: "14px 16px", cursor: "pointer" }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                          <div style={{ minWidth: 0 }}>
                            {p.shiftId ? (
                              <button
                                onClick={e => { e.stopPropagation(); setOpenShiftId(p.shiftId); }}
                                title={t("slip.viewShift")}
                                style={{
                                  border: "none", background: "none", padding: 0, cursor: "pointer",
                                  fontFamily: "inherit", textAlign: "left", fontWeight: 700, fontSize: FS.body,
                                  color: BRAND.primaryOnSurface, textDecoration: "underline", textUnderlineOffset: 2,
                                  maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}
                              >
                                {p.shift}
                              </button>
                            ) : (
                              // No shift_id on the payout -- a cancellation
                              // compensation, or seeded demo data. Nothing to
                              // link to, so it stays plain text rather than a
                              // link that goes nowhere.
                              <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text }}>{p.shift}</div>
                            )}
                            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>{p.date} · {p.travel > 0 ? `+RM${p.travel} travel` : t("earnings.salaryPayout")}</div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            {/* greenOnSurface, not green: this is money AS TEXT, and
                                the flat token is tuned for a fill. */}
                            <Money value={p.amount} size={17} />
                            <div style={{ marginTop: 4 }}>
                              {/* Was the raw enum -- a worker saw "processed internal". */}
                              <Pill label={payoutStatusLabel(t, p.status)} color={mapPayoutPillColor(p.status)} />
                            </div>
                          </div>
                        </div>
                        {p.status === "held" && payoutHoldReasonLabel(t, p.errorMessage) && (
                          <div style={{ fontSize: FS.meta, color: BRAND.redOnSurface, marginTop: 6 }}>{payoutHoldReasonLabel(t, p.errorMessage)}</div>
                        )}
                      </Card>
                    </div>
                  );
                })}
                {payoutsHasMore && (
                  <Btn variant="secondary" onClick={loadMorePayouts} disabled={payoutsLoadingMore} style={{ width: "100%", justifyContent: "center", marginTop: 4 }}>
                    {payoutsLoadingMore ? t("earnings.loadingMoreBtn") : t("earnings.loadMoreBtn")}
                  </Btn>
                )}
              </>
            )}
          </div>
        )}

        {tab === "profile" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon={<Icons.User size={28} />}
            title={t("profile.signInTitle")}
            hint={t("profile.signInHint")}
          />
        )}

        {tab === "profile" && user && (
          <div style={{
            display: "flex", borderBottom: `1px solid ${BRAND.border}`,
            margin: isMobile ? "0 0 4px" : "0 0 8px",
          }}>
            {[
              { id: "profile", label: t("nav.profile") },
              { id: "account", label: t("nav.settings") },
            ].map(p => {
              const on = profileTab === p.id;
              return (
                <button key={p.id} onClick={() => setProfileTab(p.id)} style={{
                  flex: 1, padding: "12px 0", border: "none", background: "none",
                  cursor: "pointer", fontFamily: "inherit", fontSize: FS.bodyLg,
                  fontWeight: on ? 800 : 600,
                  color: on ? BRAND.text : BRAND.textMuted,
                  // The reference app marks the live tab with a rule sitting on
                  // the divider itself, not with a pill or a fill.
                  boxShadow: on ? `inset 0 -2px 0 0 ${BRAND.text}` : "none",
                }}>{p.label}</button>
              );
            })}
          </div>
        )}

        {tab === "profile" && user && profileTab === "profile" && (
          <div>
            <div style={{ textAlign: "center", padding: isMobile ? "12px 0 16px" : "20px 0 24px" }}>
              {/* In preview mode the avatar is a plain image and the
                  edit-photo overlay is gone entirely: an employer edits
                  their own profile and photo in the Employer Console →
                  Account, so offering a second editing entry point here
                  only implies the worker view is where they'd have to do
                  it. Same reason the "View / edit my profile" link and the
                  Personal Details row below are hidden in preview. */}
              <div style={{ display: "inline-block", position: "relative" }}>
                {previewMode ? (
                  <Avatar name={profileName} size={isMobile ? 56 : 72} color={BRAND.primary} src={getAvatarUrl(user.user_metadata?.avatar_url)} />
                ) : (
                  <>
                    <button onClick={() => setShowSedcard(true)} aria-label={t("sedcard.title")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "block", borderRadius: "50%" }}>
                      <Avatar name={profileName} size={isMobile ? 56 : 72} color={BRAND.primary} src={getAvatarUrl(user.user_metadata?.avatar_url)} />
                    </button>
                    <label style={{
                      position: "absolute", right: -2, bottom: -2, width: 26, height: 26,
                      borderRadius: "50%", background: BRAND.primary, color: BRAND.onSolid,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: avatarUploading ? "wait" : "pointer", fontSize: FS.meta,
                      border: `2px solid ${BRAND.surface}`,
                    }} title={t("profile.changePhoto")}>
                      {avatarUploading ? "…" : <Icons.Edit size={13} />}
                      <input type="file" accept="image/*" disabled={avatarUploading}
                        onChange={(e) => handleAvatarUpload(e.target.files?.[0])}
                        style={{ display: "none" }} />
                    </label>
                  </>
                )}
              </div>
              {/* Full name is not user-editable here: it's tied to KYC identity
                  verification and the employment contract, so it may only be
                  set at registration (matched against the uploaded MyKad) or
                  backfilled from an OAuth provider's own asserted name — never
                  freely retyped after the fact. */}
              <div style={{ fontSize: isMobile ? FS.lead : FS.h3, fontWeight: 800, color: BRAND.text, marginTop: isMobile ? 8 : 12 }}>{profileName}</div>
              <div style={{ fontSize: isMobile ? FS.meta : FS.body, color: BRAND.textMuted }}>{user.email}</div>
              {!previewMode && (
                <button onClick={() => setShowSedcard(true)} style={{ background: "none", border: "none", color: BRAND.primaryOnSurface, cursor: "pointer", fontSize: FS.meta, fontWeight: 600, padding: 0, marginTop: 6, fontFamily: "inherit" }}>
                  {t("profile.viewEditSedcard")}
                </button>
              )}
              <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                {/* From the real kyc_level, not a constant: this badge used to
                    say "Standard KYC" for everyone, including workers who had
                    never uploaded anything. */}
                <Badge color={kycLevel === "Standard" || kycLevel === "Advanced" ? "teal" : kycLevel === "pending_review" ? "amber" : "gray"}>
                  {kycLevel === "Advanced" ? t("profile.advancedKycBadge") : kycLevel === "Standard" ? t("profile.standardKyc") : kycLevel === "pending_review" ? t("profile.kycInReview") : t("profile.basicKycBadge")}
                </Badge>
                <Badge color="green"><InlineIcon icon={Icons.Shield} />{profileStats.reliability_score}/100 {t("profile.reliabilitySuffix")}</Badge>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label={t("profile.shiftsDone")} value={workerShiftsDone ?? "—"} color={BRAND.primaryOnSurface} />
              <Stat label={t("profile.rating")} value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span><InlineIcon icon={Icons.Star} />{(profileStats.rating ?? 0).toFixed(1)}</span></span>} color={BRAND.accent} />
            </div>
            {kycLevel === "Basic" && !previewMode && (
              // Worker deferred their KYC document uploads during progressive
              // sign-up (kyc_level never left the default). Nudge them to
              // finish — the button reopens the details modal in kycOnly mode.
              // Hidden in preview: it's an identity-upload prompt aimed at the
              // viewer themselves, which would read as an instruction to the
              // employer rather than a demonstration of the worker experience.
              <Card style={{ marginBottom: 16, border: `1.5px solid ${BRAND.amber}`, background: BRAND.amberLight }}>
                <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.onAmberLight, marginBottom: 4 }}>{t("profile.completeKycTitle")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, marginBottom: 12, lineHeight: 1.5 }}>{t("profile.completeKycHint")}</div>
                <Btn size="sm" onClick={onOpenKycUpload}>{t("profile.completeKycBtn")}</Btn>
              </Card>
            )}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.kycVerification")}</div>
              {[
                { tier: t("profile.kycBasic"), status: "verified" },
                { tier: t("profile.kycStandard"), status: kycLevel === "Standard" || kycLevel === "Advanced" ? "verified" : kycLevel === "pending_review" ? "review" : "none" },
                { tier: t("profile.kycAdvanced"), status: kycLevel === "Advanced" ? "verified" : "none" },
              ].map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontSize: FS.meta, color: BRAND.text }}>{v.tier}</span>
                  <Pill label={v.status === "verified" ? t("profile.verified") : v.status === "review" ? t("profile.kycInReview") : "—"} color={v.status === "verified" ? "green" : v.status === "review" ? "amber" : "gray"} icon={v.status === "verified" ? Icons.Check : null} />
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("profile.reliabilityScoreLabel")}{profileStats.reliability_score}</div>
              <Progress value={Math.min(100, Math.max(0, profileStats.reliability_score))} color={profileStats.reliability_score > 90 ? BRAND.green : profileStats.reliability_score > 75 ? BRAND.accent : BRAND.red} />
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8 }}>{profileStats.reliability_score >= 90 ? t("profile.reliabilityExcellent") :
 profileStats.reliability_score >= 75 ? t("profile.reliabilityGood") :
 profileStats.reliability_score >= 50 ? t("profile.reliabilityBuilding") :
 t("profile.reliabilityLow")}</div>
            </Card>
            <Card>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.recentRatings")}</div>
              {myReceivedRatings === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
              {myReceivedRatings && myReceivedRatings.length === 0 && (
                <EmptyState icon={<Icons.Star size={28} />} title={t("profile.noRatingsTitle")} hint={t("profile.noRatingsHint")} />
              )}
              {myReceivedRatings && myReceivedRatings.length > 0 && (
                <>
                  {RATING_ASPECTS.employer_to_worker.map(asp => {
                    const scores = myReceivedRatings.map(r => r.aspects?.[asp.value]).filter(v => typeof v === "number");
                    const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
                    return (
                      <div key={asp.value} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: FS.meta, color: BRAND.text }}>{t(asp.labelKey)}</span>
                          <span style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.accent }}>{avg != null ? avg.toFixed(1) : "—"}</span>
                        </div>
                        <Progress value={avg != null ? (avg / 5) * 100 : 0} color={BRAND.accent} />
                      </div>
                    );
                  })}
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4 }}>
                    {t("profile.rating")}: {(myReceivedRatings.reduce((s, r) => s + (r.overall || 0), 0) / myReceivedRatings.length).toFixed(1)} ({myReceivedRatings.length})
                  </div>
                </>
              )}
              <ReceivedFeedback items={myReceivedFeedback} />
            </Card>
          </div>
        )}

        {tab === "profile" && user && profileTab === "account" && (
          <div>
            {/* The old "Settings" title/subtitle pair lived here. The sub-tab
                above now names this pane, so repeating it only pushed the first
                real row down the screen. That leaves settings.title/.subtitle
                defined in all three languages but unused -- left in place
                deliberately, since the Account pane is the next thing to gain a
                proper header and they are the right strings for it. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("settings.account")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", rowGap: 8, padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("settings.theme")}</span>
                {/* Swapped with the language switcher (owner, 2026-08-29).
                    Three explicit choices rather than the header's cycling
                    button: in a settings list you want to SEE the options, not
                    discover them by pressing repeatedly. */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                  {[
                    { mode: "system", label: t("theme.system"), icon: <Icons.Monitor size={14} /> },
                    { mode: "light", label: t("theme.light"), icon: <Icons.Sun size={14} /> },
                    { mode: "dark", label: t("theme.dark"), icon: <Icons.Moon size={14} /> },
                  ].map(opt => (
                    <Btn
                      key={opt.mode}
                      size="xs"
                      variant={themePreference === opt.mode ? "primary" : "secondary"}
                      onClick={() => setThemePreference(opt.mode)}
                      aria-pressed={themePreference === opt.mode}
                    >
                      <span aria-hidden="true" style={{ display: "inline-flex" }}>{opt.icon}</span> {opt.label}
                    </Btn>
                  ))}
                </div>
              </div>
              {/* Phone-tray notifications. Only offered where the browser can
                  actually deliver them -- an iPhone in a Safari tab cannot, so
                  it is told why rather than shown a switch that does nothing. */}
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", rowGap: 6, padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("settings.pushTitle")}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.45 }}>
                    {pushState === "unsupported" ? t("settings.pushUnsupported")
                      : pushState === "denied" ? t("settings.pushDenied")
                      : pushState === "on" ? t("settings.pushOn")
                      : t("settings.pushOff")}
                  </div>
                </div>
                {pushState === "off" && (
                  <Btn size="xs" onClick={async () => {
                    const result = await enablePushNotifications(user);
                    setPushState(await readPushStatus());
                    toast(t(result === "enabled" ? "toast.pushEnabled"
                          : result === "denied" ? "toast.pushDenied"
                          : "toast.pushFailed"), result === "enabled" ? "success" : "info");
                  }}>{t("settings.pushEnableBtn")}</Btn>
                )}
                {pushState === "on" && (
                  <Btn size="xs" variant="secondary" onClick={async () => {
                    await disablePushNotifications();
                    setPushState(await readPushStatus());
                    toast(t("toast.pushDisabled"), "info");
                  }}>{t("settings.pushDisableBtn")}</Btn>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("settings.privacy")}</span>
                <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{t("settings.privacyValue")}</span>
              </div>
              {/* Always reachable here regardless of whether the floating
                  bubble (bottom-left, see CookieConsentManager) has been
                  hidden — hiding that bubble only removes the shortcut, not
                  the ability to change the decision. */}
              <button
                onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_PREFS_EVENT))}
                style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 0", border: "none", background: "none", cursor: "pointer",
                  fontFamily: "inherit", fontSize: FS.meta, color: BRAND.textMuted, textAlign: "left",
                }}
              >
                <span>{t("cookie.reopenPreferences")}</span>
                <span aria-hidden="true">›</span>
              </button>
            </Card>
            {user && (
              <Card style={{ marginBottom: 16 }}>
                {[
                  // Personal Details is an editing surface for the viewer's
                  // OWN identity/contact record — an employer manages that in
                  // the Employer Console, so it's hidden in preview rather
                  // than offering a duplicate (and misleading) entry point.
                  // Emoji swapped for the line-icon set. Emoji render differently
                  // on every OS and were the loudest thing making these rows read
                  // as less finished than the rest of the app.
                  previewMode ? null : { label: t("personalDetails.title"), icon: <Icons.IdCard size={20} />, onClick: () => setShowPersonalDetails(true) },
                  { label: t("account.help"), icon: <Icons.LifeBuoy size={20} />, onClick: () => setSettingsHelpOpen(true) },
                  { label: t("account.contactSupport"), icon: <Icons.Chat size={20} />, onClick: onOpenSupportChat },
                  { label: t("issue.menuItem"), icon: <Icons.Bug size={20} />, onClick: onOpenIssueReport },
                  { label: t("account.referFriends"), icon: <Icons.Gift size={20} />, onClick: shareWorkerReferralLink },
                  { label: t("account.signOut"), icon: <Icons.LogOut size={20} />, danger: true, onClick: () => supabase.auth.signOut() },
                ].filter(Boolean).map((it, i, arr) => (
                  <ListRow
                    key={it.label}
                    icon={it.icon}
                    label={it.label}
                    danger={it.danger}
                    onClick={it.onClick}
                    last={i === arr.length - 1}
                  />
                ))}
              </Card>
            )}
            {settingsHelpOpen && (
              <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, paddingTop: "10vh" }} onClick={() => setSettingsHelpOpen(false)}>
                <div {...settingsHelpDialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 480, width: "100%", maxHeight: "70vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h3 style={{ fontSize: FS.lead, fontWeight: 700, color: BRAND.text, margin: 0 }}><InlineIcon icon={Icons.LifeBuoy} size={18} />{t("help.title")}</h3>
                    <button onClick={() => setSettingsHelpOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }}><Icons.Close size={18} /></button>
                  </div>
                  {HELP_FAQS.map((faq, i) => (
                    <div key={faq.qKey} style={{ borderBottom: `1px solid ${BRAND.border}`, padding: "10px 0" }}>
                      <button onClick={() => setSettingsOpenFaq((o) => (o === i ? null : i))} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>
                        <span>{t(faq.qKey)}</span>
                        <span aria-hidden="true">{settingsOpenFaq === i ? "−" : "+"}</span>
                      </button>
                      {settingsOpenFaq === i && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8, lineHeight: 1.6 }}>{t(faq.aKey)}</div>}
                    </div>
                  ))}
                  <div style={{ marginTop: 16, fontSize: FS.meta, color: BRAND.textMuted }}>
                    {t("help.stillNeedHelp")}{" "}
                    <button onClick={() => { setSettingsHelpOpen(false); onOpenSupportChat(); }} style={{ border: "none", background: "none", color: BRAND.primaryOnSurface, cursor: "pointer", fontWeight: 600, padding: 0, textDecoration: "underline", fontFamily: "inherit", fontSize: FS.meta }}>
                      {t("help.contactSupportLink")}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!user && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.salaryBankingTitle")}</div>
                <AuthGate
                  onRequireAuth={onRequireAuth}
                  icon={<Icons.Bank size={28} />}
                  title={t("settings.bankingSignInTitle")}
                  hint={t("settings.bankingSignInHint")}
                />
              </Card>
            )}
            {user && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.salaryBankingTitle")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>
                {t("settings.salaryBankingHint")}
              </div>
              {/* The reference app asks how you want to be paid before showing any
                  form. Worth stating even with one live option, because it makes
                  the absence of the others explicit rather than mysterious.
                  E-wallet is rendered DISABLED rather than hidden: there is no
                  payment rail yet, and a greyed row with the reason on it is
                  honest, where a row that looked tappable would not be. */}
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 2 }}>
                {t("settings.payoutMethodTitle")}
              </div>
              <div style={{ marginBottom: 14 }}>
                <ListRow
                  icon={<Icons.Bank size={20} />}
                  label={t("settings.payoutMethodBank")}
                  sub={workerBanking?.account_number_last4
                    ? `${t("employer.savedAccountPrefix")} ••••${workerBanking.account_number_last4}`
                    : t("settings.payoutMethodBankHint")}
                  chevron={false}
                  value={<Icons.Check size={16} />}
                />
                <ListRow
                  icon={<Icons.Wallet size={20} />}
                  label={t("settings.payoutMethodEwallet")}
                  sub={t("settings.payoutMethodEwalletSoon")}
                  disabled
                  last
                />
              </div>
              <Select
                label={t("settings.bankLabel")}
                value={workerBankForm.bankName}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, bankName: e.target.value }))}
                options={MALAYSIAN_BANK_OPTIONS.map((name) => ({ value: name, label: name }))}
              />
              <Input
                label={t("settings.accountHolderName")}
                placeholder={t("settings.accountHolderPlaceholder")}
                value={workerBankForm.accountHolderName}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, accountHolderName: e.target.value }))}
              />
              <Input
                label={t("settings.accountNumber")}
                placeholder={t("settings.accountNumberPlaceholder")}
                value={workerBankForm.accountNumber}
                onChange={(e) => setWorkerBankForm((prev) => ({ ...prev, accountNumber: e.target.value }))}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("settings.status")}</span>
                <Pill
                  label={workerBanking?.verification_status ? `SecureSign ${bankVerificationLabel(workerBanking.verification_status, t)}` : t("settings.secureSignPending")}
                  color={mapVerificationPillColor(workerBanking?.verification_status)}
                />
              </div>
              {workerBanking?.account_number_last4 && (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>
                  {t("employer.savedAccountPrefix")} {workerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.saveBanking")}</Btn>
                <Btn onClick={verifyWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.verifySecureSign")}</Btn>
              </div>
            </Card>
            )}
            {user && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("disputes.myDisputesTitle")}</div>
              {myDisputes === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>Loading…</div>}
              {myDisputes?.length === 0 && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("disputes.myDisputesEmpty")}</div>}
              {myDisputes?.map(d => {
                const categoryLabel = t(DISPUTE_CATEGORIES.find(c => c.value === d.category)?.labelKey ?? "dispute.categoryOther");
                const filedByYou = d.filed_by === user.id;
                return (
                  <div key={d.id} style={{ padding: "12px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: FS.meta, color: BRAND.text }}>{categoryLabel}</span>
                      <Badge color={d.status === "under_review" ? "amber" : d.status === "resolved" ? "green" : d.status === "dismissed" ? "gray" : "blue"} size="xs">{disputeStatusLabel(d.status, t)}</Badge>
                      <Badge color={filedByYou ? "blue" : "gray"} size="xs">{filedByYou ? t("disputes.filedByYou") : t("disputes.filedAgainstYou")}</Badge>
                    </div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 4 }}>{displayProtectedText(d.application?.shift?.title ?? "—")} · {new Date(d.created_at).toLocaleDateString("en-MY")}</div>
                    <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{d.description}</div>
                    <Btn size="xs" variant="secondary" style={{ marginTop: 6 }} onClick={() => { setActiveChatShift({ shiftId: d.application?.shift_id, title: d.application?.shift?.title ?? "", date: "", otherUserLabel: "" }); setTab("chat"); }}>{t("disputes.viewShiftChat")}</Btn>
                    {d.resolved_at && (
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>
                        {t("disputes.resolvedLabel")} {new Date(d.resolved_at).toLocaleDateString("en-MY")}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
            )}
            {(() => {
              const isAdminAccount = user?.app_metadata?.role === "admin";
              const canSeeEmployer = userRole === "employer" || isAdminAccount;
              if (!canSeeEmployer && !isAdminAccount) return null;
              return (
                <Card style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("settings.accessOtherConsoles")}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 14 }}>{t("settings.accessOtherConsolesHint")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {canSeeEmployer && <Btn variant="secondary" onClick={() => onOpenPortal?.("employer")}>{t("settings.openEmployerConsole")}</Btn>}
                    {isAdminAccount && <Btn variant="secondary" onClick={() => onOpenPortal?.("admin")}>{t("settings.openAdminDashboard")}</Btn>}
                  </div>
                </Card>
              );
            })()}

            {/* Terms & Conditions — Malaysian Labor Law */}
            <div style={{marginTop:24, borderTop:`1px solid ${BRAND.border}`, paddingTop:16}}>
              <button
                onClick={() => setShowTnC(v => !v)}
                style={{display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%',
                  background:'none', border:'none', cursor:'pointer', padding:0, textAlign:'left'}}
              >
                <span style={{fontSize:FS.body, fontWeight:600, color:BRAND.text}}>
                  📋 Terms & Conditions — Malaysian Labor Law
                </span>
                <span style={{fontSize:FS.meta, color:BRAND.textMuted}}>{showTnC ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {showTnC && (
                <div style={{marginTop:12, fontSize:FS.meta, color:BRAND.text, lineHeight:1.7}}>
                  <p style={{color:BRAND.textMuted, fontSize:FS.meta, marginBottom:12}}>
                    ⚠️ This is a summary for general guidance only. Consult a Malaysian employment lawyer before making decisions. Last updated: June 2026.
                  </p>

                  {[
                    {
                      title: '1. Employment Act Coverage',
                      body: 'Since the 2022 amendments (in force 1 Jan 2023), ALL employees in Peninsular Malaysia are covered regardless of salary. Workers earning below RM4,000/month are entitled to overtime pay (1.5×), rest day premiums (2×), and public holiday premiums (3×). Casual/single-shift workers are covered from their first day of work, though annual leave and sick leave require at least 1 month of continuous service with the same employer.'
                    },
                    {
                      title: '2. EPF (KWSP) — Employees Provident Fund',
                      body: 'EPF contributions are mandatory for any employee under a contract of service, from their very first day — there is no minimum hours or days threshold. Rates (2025–2026): Employer 13% + Employee 11% for wages ≤ RM5,000/month. Employer 12% + Employee 11% for wages > RM5,000/month. Foreign workers: Employer 2% + Employee 2% (from Oct 2025). EPF obligations belong to the hiring business, not to ' + SITE.name + ' as a marketplace platform.'
                    },
                    {
                      title: '3. SOCSO (PERKESO) — Social Security',
                      body: 'SOCSO is mandatory from an employee\'s first day of work. Wage ceiling is RM6,000/month (from Oct 2024). Rates: Employer 1.75% + Employee 0.5% (below age 60). SOCSO covers workplace injuries under the Employment Injury Scheme from Day 1, and invalidity from non-work causes for workers below age 60. The hiring business on ' + SITE.name + ' is responsible for registering and contributing SOCSO for their workers.'
                    },
                    {
                      title: '4. EIS — Employment Insurance System',
                      body: 'EIS applies to Malaysian/PR employees aged 18–60. Rate: 0.2% employer + 0.2% employee (wage ceiling RM6,000). EIS provides income replacement of up to 80% of wages for up to 6 months if a worker is retrenched. Contributions are legally required for casual workers, though practical EIS benefits are limited for workers on single-shift engagements who are simply not re-engaged. EIS does not apply to foreign workers.'
                    },
                    {
                      title: '5. Income Tax',
                      body: 'Workers must file a tax return if annual income exceeds RM34,000 after EPF deductions (approximately RM2,833/month gross). The first RM5,000 of chargeable income is taxed at 0%. After standard personal reliefs (RM9,000 automatic + up to RM4,000 EPF relief), most shift workers earning below RM3,500/month will pay zero or minimal income tax. Workers with income from multiple employers or gig jobs must declare all income on a single combined return via MyTax (mytax.hasil.gov.my). Non-residents (present in Malaysia fewer than 182 days/year) are taxed at a flat 30% rate.'
                    },
                    {
                      title: '6. Gig Workers Act 2025 (Act 872) ⭐ New Law',
                      body: 'The Gig Workers Act 2025 (Act 872) came into force on 31 March 2026, creating a new legal category between employee and independent contractor. Under Act 872, platform providers (digital intermediaries connecting gig workers to service users — which may include ' + SITE.name + ') must: register gig workers with PERKESO; deduct and remit 1.25% of each transaction to PERKESO under the self-employment social security scheme; provide written service agreements; and integrate payment systems with PERKESO. EPF is not required for gig workers under Act 872. Non-compliance penalties: up to 2 years imprisonment or RM10,000 fine. ' + SITE.name + ' is currently seeking legal advice on its classification under this Act.'
                    },
                    {
                      title: '7. Minimum Wage (2025)',
                      body: 'The minimum wage in Malaysia is RM1,700/month or RM8.72/hour (effective August 2025 for all employers). This applies to all workers including casual and short-term shift workers. No exceptions exist for gig or platform workers. Employers on ' + SITE.name + ' must not post shifts with a wage below RM8.72/hour.'
                    },
                    {
                      title: '8. Working Hours & Overtime',
                      body: 'Maximum working hours are 8 hours per day and 45 hours per week. No single day may exceed 12 hours including overtime. Maximum overtime is 104 hours per month. For employees earning below RM4,000/month, overtime on a normal day is paid at 1.5× the hourly rate; work on a rest day at 2× the daily rate; work on a public holiday at 3× the hourly rate. These protections apply to shift workers from their first day of employment.'
                    },
                    {
                      title: '9. What Short-Term Workers May Not Receive',
                      body: 'Annual leave (8–16 days/year), sick leave (14–22 days/year), and hospitalisation leave (60 days/year) require at least 1 month of continuous service with the same employer — a one-off or infrequent shift engagement may not qualify. Maternity leave (98 days) requires an ongoing employment relationship. Paternity leave (7 days) requires at least 12 months of continuous service. EPF and SOCSO contributions are legally due from Day 1 regardless of how short the engagement is.'
                    },
                    {
                      title: `10. Platform Liability — ${SITE.name}'s Role`,
                      body: SITE.name + ' operates as a technology marketplace connecting employers and workers. The legal employment relationship — and the resulting EPF, SOCSO, EIS, minimum wage, and Employment Act obligations — is between the worker and the hiring business, not between the worker and ' + SITE.name + '. ' + SITE.name + ' does not set hours, direct how work is performed, or pay wages directly. Employers using ' + SITE.name + ' are responsible for complying with all applicable Malaysian employment laws. ' + SITE.name + ' is separately assessing its obligations as a potential platform provider under the Gig Workers Act 2025 (Act 872). This summary does not constitute legal advice.'
                    },
                  ].map(({ title, body }) => (
                    <div key={title} style={{marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${BRAND.border}`}}>
                      <div style={{fontWeight:600, marginBottom:4, color:BRAND.text}}>{title}</div>
                      <div style={{color:BRAND.textMuted}}>{body}</div>
                    </div>
                  ))}

                  <p style={{fontSize:FS.meta, color:BRAND.textMuted, marginTop:8}}>
                    References: Employment Act 1955 (Act 265) · EPF Act 1991 (Act 452) · SOCSO Act 1969 (Act 4) · EIS Act 2017 (Act 800) · Gig Workers Act 2025 (Act 872) · Minimum Wages Act 2012 (Act 732) · Income Tax Act 1967 (Act 53)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav — hidden while a chat thread is open on mobile, so the
          message list keeps that height when the keyboard is up. */}
      {!chatThreadFullscreen && (
        <WorkerBottomNav items={navItems} activeId={tab} onSelect={handleWorkerNavClick} isMobile={isMobile} style={navBarStyle} />
      )}
    </div>

    {withdrawTarget && (() => {
      const { hours, penalty } = withdrawalPenaltyFor(withdrawTarget.shiftStartAt, withdrawTiers);
      return (
      <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setWithdrawTarget(null)}>
        <div {...withdrawDialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 22, maxWidth: 430, width: "100%", maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ fontSize: FS.card, fontWeight: 800, color: BRAND.text, margin: "0 0 8px" }}>{t("withdraw.title")}</h3>
          <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
            {t("withdraw.body", { shift: withdrawTarget.shiftTitle })}
          </div>

          {/* The cost, stated before the decision rather than after it. */}
          <div style={{ border: `1px solid ${penalty > 0 ? BRAND.amber : BRAND.border}`, background: penalty > 0 ? BRAND.amberLight : BRAND.grayLight, borderRadius: RADIUS.control, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: FS.meta, fontWeight: 700, color: penalty > 0 ? BRAND.onAmberLight : BRAND.text, marginBottom: 4 }}>
              {t("withdraw.noticeLabel", { hours: Math.round(hours) })}
            </div>
            <div style={{ fontSize: FS.meta, color: penalty > 0 ? BRAND.onAmberLight : BRAND.text }}>
              {penalty > 0
                ? t("withdraw.penaltyWarning", { points: penalty })
                : t("withdraw.noPenalty")}
            </div>
          </div>

          <label style={{ display: "block", fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 6 }}>
            {t("withdraw.reasonLabel")}
          </label>
          <textarea
            value={withdrawReason}
            onChange={(e) => setWithdrawReason(e.target.value)}
            rows={3}
            placeholder={t("withdraw.reasonPlaceholder")}
            style={{ width: "100%", padding: 10, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.bg, color: BRAND.text, fontFamily: "inherit", fontSize: FS.meta, resize: "vertical", marginBottom: 16 }}
          />

          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="secondary" onClick={() => setWithdrawTarget(null)} style={{ flex: 1, justifyContent: "center" }}>
              {t("withdraw.keepBtn")}
            </Btn>
            <Btn onClick={confirmWithdraw} disabled={withdrawing}
                 style={{ flex: 1, justifyContent: "center", background: BRAND.red, borderColor: BRAND.red }}>
              {withdrawing ? t("withdraw.withdrawing") : t("withdraw.confirmBtn")}
            </Btn>
          </div>
        </div>
      </div>
      );
    })()}

    {workerContractModal && (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div {...workerContractDialog} style={{background: BRAND.surfaceElevated, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto'}}>
          <h3 style={{fontSize:FS.lead, fontWeight:700, color: BRAND.text, marginBottom:4}}><InlineIcon icon={Icons.Doc} size={16} />{t("contract.workerTitle")}</h3>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:16}}>{t("contract.readCarefully")}</p>

          {(() => {
            const contractRows = buildContractRows(t, {
              contractRef: (workerContractModal.applicationId || "").slice(0, 8).toUpperCase(),
              generatedAt: new Date().toISOString(),
              employerName: workerContractModal.employerName,
              workerName: workerOwnName || t("contract.youLabel"),
              shiftTitle: workerContractModal.shiftTitle,
              shiftCategory: workerContractModal.shiftCategory,
              shiftLocation: workerContractModal.shiftLocation,
              scheduleText: workerContractModal.isMultiDay ? formatOccurrencesSummary(workerContractModal.shiftOccurrences) : workerContractModal.date,
              totalHours: totalOccurrenceHours(workerContractModal.shiftOccurrences),
              wageAsk: workerContractModal.wageBid,
              transportAllowance: workerContractModal.shiftStipend,
              dressCode: workerContractModal.shiftDress,
              languages: (workerContractModal.shiftLanguages || []).join(', '),
              description: workerContractModal.shiftDescription,
              termClauses: [1, 2, 3, 4, 5, 8].map(n => t(`contract.workerClause${n}`)),
              platformRoleClause: t("contract.workerClause6"),
              governingLawClause: t("contract.workerClause7"),
              employerSignedAt: workerContractModal.employerSignedAt,
              workerSignedAt: workerContractModal.workerSignedAt,
            });
            return (
          <div style={{background: BRAND.grayLight, borderRadius:RADIUS.control, padding:16, fontSize:FS.meta, lineHeight:1.8, color: BRAND.text, marginBottom:16}}>
            <p><strong>{t("contract.agreementHeading")}</strong></p>
            {renderContractRowsJSX(contractRows)}
          </div>
          );
          })()}

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => setWorkerContractModal(null)}
              style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
              {workerContractModal.readOnly ? t("common.close") : t("common.cancel")}
            </button>
            <button onClick={() => {
              const ok = openContractPrintWindow({
                heading: t("contract.agreementHeading"),
                subheading: workerContractModal.shiftTitle,
                rows: buildContractRows(t, {
                  contractRef: (workerContractModal.applicationId || "").slice(0, 8).toUpperCase(),
                  generatedAt: new Date().toISOString(),
                  employerName: workerContractModal.employerName,
                  workerName: workerOwnName || t("contract.youLabel"),
                  shiftTitle: workerContractModal.shiftTitle,
                  shiftCategory: workerContractModal.shiftCategory,
                  shiftLocation: workerContractModal.shiftLocation,
                  scheduleText: workerContractModal.isMultiDay ? formatOccurrencesSummary(workerContractModal.shiftOccurrences) : workerContractModal.date,
                  totalHours: totalOccurrenceHours(workerContractModal.shiftOccurrences),
                  wageAsk: workerContractModal.wageBid,
                  transportAllowance: workerContractModal.shiftStipend,
                  dressCode: workerContractModal.shiftDress,
                  languages: (workerContractModal.shiftLanguages || []).join(', '),
                  description: workerContractModal.shiftDescription,
                  termClauses: [1, 2, 3, 4, 5, 8].map(n => t(`contract.workerClause${n}`)),
                  platformRoleClause: t("contract.workerClause6"),
                  governingLawClause: t("contract.workerClause7"),
                  employerSignedAt: workerContractModal.employerSignedAt,
                  workerSignedAt: workerContractModal.workerSignedAt,
                }),
              });
              if (!ok) toast(t("toast.popupBlocked"), "error");
            }}
              style={{flex: 1, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
              {t("contract.printBtn")}
            </button>
            {!workerContractModal.readOnly && (
              <button onClick={async () => {
                const { error } = await supabase
                  .from('applications')
                  .update({ worker_signed_at: new Date().toISOString() })
                  .eq('id', workerContractModal.applicationId);
                if (error) { toast(t('toast.signFailed') + error.message, 'error'); return; }
                toast(t('toast.contractSigned'), 'success');
                const signedAt = new Date().toISOString();
                setLiveApplications(prev => prev.map(a =>
                  a.id === workerContractModal.applicationId ? { ...a, workerSignedAt: signedAt } : a
                ));
                // selectedApplication is a separate snapshot (not derived from
                // liveApplications), so it must be updated too — otherwise the
                // detail view keeps showing the "Sign Contract" button until
                // the page is refreshed and re-fetches fresh data.
                setSelectedApplication(prev =>
                  prev && prev.id === workerContractModal.applicationId ? { ...prev, workerSignedAt: signedAt } : prev
                );
                setWorkerContractModal(null);
              }}
                style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                <InlineIcon icon={Icons.Edit} />{t("contract.signBtn")}
              </button>
            )}
          </div>
        </div>
      </div>
    )}

    {attendanceRequestTarget && (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div {...attendanceRequestDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:460, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
          <h3 style={{fontSize:FS.lead, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("attendance.requestTitle")}</h3>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:12}}>{attendanceRequestTarget.shiftTitle}</p>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:12}}>
            {attendanceRequestTarget.kind === "check_out" ? t("attendance.requestCheckOutIntro") : t("attendance.requestCheckInIntro")}
          </p>
          <textarea
            value={attendanceRequestNote}
            onChange={e => setAttendanceRequestNote(e.target.value)}
            placeholder={t("attendance.requestNotePlaceholder")}
            rows={3}
            style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical", boxSizing: "border-box", marginBottom: 16 }}
          />
          <div style={{display:'flex', gap:8}}>
            <button onClick={() => setAttendanceRequestTarget(null)}
              style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
              {t("common.cancel")}
            </button>
            <button onClick={sendAttendanceRequest} disabled={sendingAttendanceRequest}
              style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color: BRAND.onPrimary, border:'none', cursor: sendingAttendanceRequest ? 'not-allowed' : 'pointer', fontWeight:600, opacity: sendingAttendanceRequest ? 0.6 : 1}}>
              {sendingAttendanceRequest ? "…" : t("attendance.requestSendBtn")}
            </button>
          </div>
        </div>
      </div>
    )}

    {disputeModal && (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div {...workerDisputeDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
          <h3 style={{fontSize:FS.lead, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("myBids.fileDisputeTitle")}</h3>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:16}}>{disputeModal.shiftTitle}</p>

          <Select
            label={t("myBids.disputeCategoryLabel")}
            value={disputeForm.category}
            onChange={e => setDisputeForm(f => ({ ...f, category: e.target.value }))}
            options={DISPUTE_CATEGORIES.map(c => ({ value: c.value, label: t(c.labelKey) }))}
          />

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("myBids.disputeDescriptionLabel")}</label>
            <textarea
              value={disputeForm.description}
              onChange={e => setDisputeForm(f => ({ ...f, description: e.target.value }))}
              style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 100, resize: "none", boxSizing: "border-box" }}
            />
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => { setDisputeModal(null); setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" }); }}
              style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
              {t("common.cancel")}
            </button>
            <button onClick={submitDispute} disabled={filingDispute || !disputeForm.description.trim()}
              style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor: filingDispute || !disputeForm.description.trim() ? 'not-allowed' : 'pointer', fontWeight:600, opacity: filingDispute || !disputeForm.description.trim() ? 0.6 : 1}}>
              {filingDispute ? "…" : t("myBids.disputeSubmitBtn")}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Payment slip. Everything on it is derived -- the shift record already
        fetched for the list, the hours the payout was created from, and the
        payout's own amount and status. No new query, and nothing here is a
        number the slip invented. */}
    {slipPayout && (() => {
      const info = slipPayout.shiftInfo;
      const when = info?.start_at
        ? `${formatShiftDate(info.start_at)} · ${formatShiftTime(info.start_at)}–${formatShiftTime(info.end_at)}`
        : slipPayout.date;
      const rows = [
        [t("slip.job"), slipPayout.shift],
        [t("slip.employer"), info?.employer?.full_name || "—"],
        [t("slip.when"), when],
        [t("slip.where"), info?.location ? overviewLocation(info.location) : "—"],
        [t("slip.hoursWorked"), slipPayout.hours != null ? formatDurationHours(Number(slipPayout.hours)) : "—"],
      ];
      return (
      <div
        onClick={() => setSlipPayout(null)}
        style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}
      >
        <div {...slipDialog} onClick={e => e.stopPropagation()} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:460, width:'100%', maxHeight:'85vh', overflowY:'auto', border:`1px solid ${BRAND.border}`}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, marginBottom:4}}>
            <h3 style={{fontSize:FS.lead, fontWeight:800, color: BRAND.text, margin:0}}>{t("slip.title")}</h3>
            <button onClick={() => setSlipPayout(null)} aria-label={t("common.close")}
              style={{border:'none', background:'none', cursor:'pointer', color: BRAND.textMuted, fontFamily:'inherit', fontSize:FS.lead, lineHeight:1, padding:0}}><Icons.Close size={18} /></button>
          </div>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, margin:'0 0 16px', lineHeight:1.5}}>{t("slip.subtitle")}</p>

          {rows.map(([label, value]) => (
            <div key={label} style={{display:'flex', justifyContent:'space-between', gap:14, padding:'7px 0', fontSize:FS.meta}}>
              <span style={{color: BRAND.textMuted, flexShrink:0}}>{label}</span>
              <span style={{color: BRAND.text, fontWeight:600, textAlign:'right', minWidth:0, overflowWrap:'anywhere'}}>{value}</span>
            </div>
          ))}

          {slipPayout.shiftId && (
            <button
              onClick={() => { const id = slipPayout.shiftId; setSlipPayout(null); setOpenShiftId(id); }}
              style={{border:'none', background:'none', padding:0, marginTop:6, cursor:'pointer', fontFamily:'inherit', fontSize:FS.meta, fontWeight:600, color: BRAND.primaryOnSurface}}
            >
              {t("slip.viewShift")}
            </button>
          )}

          <div style={{borderTop:`1px solid ${BRAND.border}`, marginTop:14, paddingTop:14}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12}}>
              <span style={{fontSize:FS.meta, color: BRAND.textMuted}}>{t("slip.amount")}</span>
              <Money value={slipPayout.amount} size={20} />
            </div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginTop:10}}>
              <span style={{fontSize:FS.meta, color: BRAND.textMuted}}>{t("slip.status")}</span>
              <Pill label={payoutStatusLabel(t, slipPayout.status)} color={mapPayoutPillColor(slipPayout.status)} />
            </div>
            <div style={{display:'flex', justifyContent:'space-between', gap:12, marginTop:10, fontSize:FS.meta}}>
              <span style={{color: BRAND.textMuted}}>{t("slip.payoutDate")}</span>
              <span style={{color: BRAND.text, fontWeight:600}}>{slipPayout.date}</span>
            </div>
            {slipPayout.status === "held" && payoutHoldReasonLabel(t, slipPayout.errorMessage) && (
              <div style={{fontSize:FS.meta, color: BRAND.redOnSurface, marginTop:10}}>{payoutHoldReasonLabel(t, slipPayout.errorMessage)}</div>
            )}
            <div style={{display:'flex', justifyContent:'space-between', gap:12, marginTop:10, fontSize:FS.meta}}>
              <span style={{color: BRAND.textMuted}}>{t("slip.reference")}</span>
              <span style={{color: BRAND.textMuted, fontFamily:'monospace'}}>{String(slipPayout.id).slice(0, 8)}</span>
            </div>
          </div>

          {/* Says plainly what this document is. Calling it a receipt would
              claim the platform moved the money, and it has no rail to move it
              with -- the same overclaim the landing page was making. */}
          <div style={{marginTop:14, padding:'10px 12px', borderRadius:RADIUS.control, background: BRAND.amberLight, color: BRAND.onAmberLight, fontSize:FS.meta, lineHeight:1.5}}>
            {t("slip.notYetPaid")}
          </div>
        </div>
      </div>
      );
    })()}

    {ratingModal && (() => {
      const aspects = RATING_ASPECTS[ratingModal.direction];
      const allSet = !aspects.some(a => !ratingForm[a.value]);
      const overall = allSet ? (aspects.reduce((sum, a) => sum + (ratingForm[a.value] || 0), 0) / aspects.length).toFixed(1) : null;
      return (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div {...workerRatingDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
          <h3 style={{fontSize:FS.lead, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("rating.modalTitle")}</h3>
          <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:16}}>{ratingModal.shiftTitle}</p>

          {aspects.map(asp => (
            <div key={asp.value} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
              <span style={{fontSize:FS.meta, color: BRAND.text}}>{t(asp.labelKey)}</span>
              <StarInput value={ratingForm[asp.value] || 0} onChange={v => setRatingForm(f => ({ ...f, [asp.value]: v }))} />
            </div>
          ))}

          <div style={{ marginBottom: 14 }}>
            <textarea
              value={ratingComment}
              onChange={e => setRatingComment(e.target.value.slice(0, 500))}
              placeholder={t("rating.commentPlaceholder")}
              aria-label={t("rating.commentPlaceholder")}
              rows={3}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical" }}
            />
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4 }}>{t("rating.commentPrivacyHint")}</div>
          </div>

          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0', borderTop:`1px solid ${BRAND.border}`, marginBottom:16 }}>
            <span style={{fontSize:FS.meta, fontWeight:700, color: BRAND.text}}>{t("rating.overallPreview")}</span>
            <span style={{fontSize:FS.card, fontWeight:800, color: BRAND.accent}}>{overall ?? "—"}</span>
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => { setRatingModal(null); setRatingForm({}); setRatingComment(""); }}
              style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
              {t("common.cancel")}
            </button>
            <button onClick={submitRating} disabled={submittingRating || !allSet}
              style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor: submittingRating || !allSet ? 'not-allowed' : 'pointer', fontWeight:600, opacity: submittingRating || !allSet ? 0.6 : 1}}>
              {submittingRating ? "…" : t("rating.submitBtn")}
            </button>
          </div>
        </div>
      </div>
      );
    })()}

    <RatingDetailsModal modal={ratingDetailsModal} onClose={() => setRatingDetailsModal(null)} about={ratingDetailsModal?.direction === 'worker_to_employer' ? employerAbout[ratingDetailsModal.rateeId] : null} />

    {cancellationContractModal && (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div {...cancellationDialog} style={{background:BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto'}}>
          <h3 style={{fontSize:FS.lead, fontWeight:700, color:BRAND.text, marginBottom:4}}><InlineIcon icon={Icons.Doc} size={16} />{t("contract.cancellationTitle")}</h3>
          <p style={{fontSize:FS.meta, color:BRAND.textMuted, marginBottom:16}}>{t("contract.readCarefully")}</p>

          <div style={{background:BRAND.grayLight, borderRadius:RADIUS.control, padding:16, fontSize:FS.meta, lineHeight:1.8, color:BRAND.text, marginBottom:16}}>
            <p><strong>{t("contract.cancellationHeading")}</strong></p>
            <p>• <strong>{t("contract.roleLabel")}</strong> {cancellationContractModal.shiftTitle}</p>
            <p>• <strong>{t("contract.dateLabel")}</strong> {cancellationContractModal.shiftDate}</p>
            <p>• <strong>{t("contract.agreedWageLabel")}</strong> RM {cancellationContractModal.wageAsk}/hr</p>
            <br/>
            <p><strong>{t("contract.agreeToTermsHeading")}</strong></p>
            <p>1. {t("contract.cancellationClause1")}</p>
            <p>2. {t("contract.cancellationClause2")}</p>
            <p>3. {t("contract.cancellationClause3")}</p>
            <p>4. {t("contract.cancellationClause4")}</p>
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => setCancellationContractModal(null)}
              style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, cursor:'pointer', color:BRAND.textMuted}}>
              {t("common.cancel")}
            </button>
            <button onClick={async () => {
              const { error } = await supabase
                .from('applications')
                .update({ cancellation_choice: 'contract_50' })
                .eq('id', cancellationContractModal.applicationId);
              if (error) { toast(t('toast.signFailed') + error.message, 'error'); return; }
              toast(t('toast.cancellationContractSigned'), 'success');
              setLiveApplications(prev => prev.map(a =>
                a.id === cancellationContractModal.applicationId ? { ...a, cancellationChoice: 'contract_50' } : a
              ));
              setSelectedApplication(prev =>
                prev && prev.id === cancellationContractModal.applicationId ? { ...prev, cancellationChoice: 'contract_50' } : prev
              );
              setCancellationContractModal(null);
            }}
              style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background:BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
              <InlineIcon icon={Icons.Edit} />{t("contract.signBtn")}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

const EmployerPortal = lazyPortal(() => import("./src/portals/EmployerPortal.jsx"));


  const AdminPortal = lazyPortal(() => import("./src/portals/AdminPortal.jsx"));


// Minimal inline on/off switch styled with BRAND tokens — there's no
// reusable Switch/Toggle component elsewhere in this file (only unrelated
// hits for "toggle": PasswordInput's show/hide eye and a settings button
// labelled "Toggles"), so this is built fresh for the cookie categories tab.
const CookieToggleRow = ({ label, description, checked, disabled = false, onChange }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text }}>{label}</div>
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>{description}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled && onChange) onChange(!checked); }}
      style={{
        flexShrink: 0, width: 40, height: 24, borderRadius: RADIUS.card, border: "none",
        background: checked ? BRAND.primary : BRAND.grayLight,
        position: "relative", cursor: disabled ? "not-allowed" : "pointer",
        padding: 0, opacity: disabled ? 0.7 : 1,
        transition: "background 0.15s",
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: checked ? 18 : 2,
        width: 20, height: 20, borderRadius: "50%", background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)", transition: "left 0.15s",
      }} />
    </button>
  </div>
);

// Customer-support chat widget. Mounted once at the root (same pattern as
// CookieConsentManager below) so it survives navigation across portals.
// State machine: 'closed' -> 'open' -> 'minimized' -> 'open' | 'closed'.
// Conversation history lives in this component's own state (not persisted
// to a DB) — lost on page reload by design for this first version; see
// support-chat/index.ts for why (keeps the MVP small; revisit if abuse
// monitoring needs a durable transcript later).
//
// Desktop: 'open' is a fixed bottom-right card; 'minimized' collapses to a
// small pill/tab in the same corner. Mobile: 'open' is a full-screen
// overlay; 'minimized' collapses to a round bubble (bottom-right, mirroring
// the cookie-consent bubble which sits bottom-left so the two never
// collide). Both render via createPortal(..., document.body) for the same
// backdropFilter-containing-block reason as the Help modal and cookie
// banner above.
const SupportChatWidget = ({ isMobile, open, onOpenChange }) => {
  const { t } = useLanguage();
  const [mode, setMode] = useState("closed"); // 'closed' | 'open' | 'minimized'
  const [messages, setMessages] = useState([]); // [{role:'user'|'assistant', content}]
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [escalate, setEscalate] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) setMode("open");
  }, [open]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending, mode]);

  const closeWidget = () => {
    setMode("closed");
    onOpenChange(false);
  };

  const sendMessage = async () => {
    const content = input.trim();
    if (!content || sending) return;
    const nextMessages = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("support-chat", {
        body: { messages: nextMessages },
      });
      if (error) throw error;
      setMessages(prev => [...prev, { role: "assistant", content: data.reply }]);
      if (data.escalate) setEscalate(true);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: t("supportChat.errorMessage") }]);
      setEscalate(true);
    } finally {
      setSending(false);
    }
  };

  if (mode === "closed") return null;

  const bubbleBottom = isMobile ? "calc(60px + env(safe-area-inset-bottom, 0px) + 16px)" : "24px";

  // ── Minimized states ────────────────────────────────────────────────────
  if (mode === "minimized") {
    if (isMobile) {
      return createPortal(
        <button
          onClick={() => setMode("open")}
          aria-label={t("supportChat.restore")}
          title={t("supportChat.restore")}
          style={{
            position: "fixed", right: 20, bottom: bubbleBottom, zIndex: Z.sticky,
            width: 48, height: 48, borderRadius: "50%",
            background: BRAND.primary, border: "none",
            boxShadow: `0 6px 18px ${BRAND.shadow}`, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: FS.h3, padding: 0, color: BRAND.onSolid,
          }}
        >
          <span aria-hidden="true" style={{ display: "inline-flex" }}><Icons.Chat size={18} /></span>
        </button>,
        document.body
      );
    }
    return createPortal(
      <button
        onClick={() => setMode("open")}
        style={{
          position: "fixed", right: 24, bottom: 24, zIndex: Z.sticky,
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", borderRadius: RADIUS.pill,
          background: BRAND.primary, border: "none", color: BRAND.onSolid,
          boxShadow: `0 6px 18px ${BRAND.shadow}`, cursor: "pointer",
          fontSize: FS.meta, fontWeight: 700, fontFamily: "inherit",
        }}
      >
        <span aria-hidden="true" style={{ display: "inline-flex" }}><Icons.Chat size={18} /></span>
        <span>{t("supportChat.title")}</span>
      </button>,
      document.body
    );
  }

  // ── Open state ───────────────────────────────────────────────────────────
  const containerStyle = isMobile
    ? { position: "fixed", inset: 0, zIndex: Z.toast, background: BRAND.surface, display: "flex", flexDirection: "column" }
    : {
        position: "fixed", right: 24, bottom: 24, zIndex: Z.toast,
        width: 360, height: 500, maxHeight: "80vh",
        background: BRAND.surface, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card,
        boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        display: "flex", flexDirection: "column",
      };

  return createPortal(
    <div style={containerStyle}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 16px", borderBottom: `1px solid ${BRAND.border}`, flexShrink: 0,
        background: BRAND.panel,
      }}>
        <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden="true" style={{ display: "inline-flex" }}><Icons.Chat size={18} /></span> {t("supportChat.title")}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setMode("minimized")}
            aria-label={t("supportChat.minimize")}
            title={t("supportChat.minimize")}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.card, color: BRAND.textMuted, width: 28, height: 28, borderRadius: RADIUS.control, lineHeight: 1 }}
          >−</button>
          <button
            onClick={closeWidget}
            aria-label={t("supportChat.close")}
            title={t("supportChat.close")}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.lead, color: BRAND.textMuted, width: 28, height: 28, borderRadius: RADIUS.control, lineHeight: 1 }}
          ><Icons.Close size={18} /></button>
        </div>
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ maxWidth: "85%", padding: "10px 12px", borderRadius: `${RADIUS.card}px ${RADIUS.card}px ${RADIUS.card}px 2px`, background: BRAND.grayLight, color: BRAND.text, fontSize: FS.body, lineHeight: 1.5 }}>
            {t("supportChat.greeting")}
          </div>
        </div>
        {messages.map((m, i) => {
          const isMe = m.role === "user";
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
              <div style={{
                maxWidth: "85%", padding: "10px 12px", fontSize: FS.body, lineHeight: 1.5,
                borderRadius: isMe ? `${RADIUS.card}px ${RADIUS.card}px 2px ${RADIUS.card}px` : `${RADIUS.card}px ${RADIUS.card}px ${RADIUS.card}px 2px`,
                background: isMe ? BRAND.primary : BRAND.grayLight,
                color: isMe ? "#fff" : BRAND.text,
                // Same invisible-bubble fix as the shift chat above.
                border: isMe ? "1px solid transparent" : `1px solid ${BRAND.border}`,
                whiteSpace: "pre-wrap",
              }}>
                {m.content}
              </div>
            </div>
          );
        })}
        {sending && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "10px 12px", borderRadius: `${RADIUS.card}px ${RADIUS.card}px ${RADIUS.card}px 2px`, background: BRAND.grayLight, color: BRAND.textMuted, fontSize: FS.meta }}>
              {t("supportChat.thinking")}
            </div>
          </div>
        )}
        {escalate && (
          <div style={{ marginTop: 4, padding: "10px 12px", borderRadius: RADIUS.control, background: BRAND.amberLight, color: BRAND.onAmberLight, fontSize: FS.meta, display: "flex", flexDirection: "column", gap: 8 }}>
            <span>{t("supportChat.escalateText")}</span>
            <button
              onClick={openMailtoSupport}
              style={{
                alignSelf: "flex-start", border: "none", borderRadius: RADIUS.control, padding: "6px 12px",
                background: BRAND.onAmberLight, color: BRAND.onSolid, fontSize: FS.meta, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {t("supportChat.emailSupport")}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${BRAND.border}`, flexShrink: 0 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder={t("supportChat.inputPlaceholder")}
          disabled={sending}
          style={{ flex: 1, padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.body, background: BRAND.input, color: BRAND.text, fontFamily: "inherit" }}
        />
        {/* Same reason as the shift-chat composer: keep focus on the field so
            sending does not dismiss the keyboard. */}
        <button
          onClick={sendMessage}
          onMouseDown={e => e.preventDefault()}
          disabled={sending || !input.trim()}
          style={{
            padding: "10px 16px", borderRadius: RADIUS.control, border: "none", fontFamily: "inherit",
            background: BRAND.primary, color: BRAND.onSolid, fontWeight: 700, fontSize: FS.meta,
            cursor: sending || !input.trim() ? "not-allowed" : "pointer",
            opacity: sending || !input.trim() ? 0.6 : 1,
          }}
        >
          {t("supportChat.send")}
        </button>
      </div>
    </div>,
    document.body
  );
};

// Cookie consent banner + configurator. Mounted once at the root, inside
// LanguageProvider/ToastProvider, so it persists across the worker/employer/
// admin portals and isn't tied to any specific view. Renders through
// createPortal(..., document.body) — same fix as the Help modal above: a
// fixed-position descendant inside a backdropFilter ancestor (the app header)
// gets clipped to that ancestor's box instead of the viewport, so this has
// to escape via a body portal too.
//
// Scope note: this is UI + local persistence, plus a real consumer —
// logAnalyticsEvent (see near the top of this file) calls hasAnalyticsConsent
// and only inserts into analytics_events (page_view/sign_up/bid_placed) when
// the "Analytics & Marketing" category below is switched on. It's off by
// default; toggling it here directly turns that logging on/off.
const DEFAULT_COOKIE_DRAFT = { functional: true, analytics: false };

const CookieConsentManager = ({ isMobile }) => {
  const { t } = useLanguage();
  const [consent, setConsent] = useState(() => readCookieConsent());
  const [panelOpen, setPanelOpen] = useState(false);
  // The cookie panel is the single most-seen modal on the site -- every
  // first-time visitor meets it -- and it had no Escape, no dialog role and no
  // focus management. It is also the overlay implicated in WCAG 2.2 AA
  // "Focus Not Obscured", since it sits over the hero at every scroll position.
  const panelDialog = useDialog(panelOpen, () => setPanelOpen(false), { label: t("cookie.panelTitle") });
  const [activeTab, setActiveTab] = useState("categories");
  const [bubbleHidden, setBubbleHidden] = useState(() => readCookieBubbleHidden());
  const [draft, setDraft] = useState(() => {
    const stored = readCookieConsent();
    return stored ? { functional: !!stored.functional, analytics: !!stored.analytics } : DEFAULT_COOKIE_DRAFT;
  });

  // Settings and the footer can't reach into this component's local state
  // directly (they're mounted elsewhere in the tree), so they ask for the
  // panel via a plain DOM event instead — same trick already used for
  // opening the panel from the footer without prop-drilling it through
  // every screen between App and here.
  useEffect(() => {
    const handler = () => openPanel("categories");
    window.addEventListener(OPEN_COOKIE_PREFS_EVENT, handler);
    return () => window.removeEventListener(OPEN_COOKIE_PREFS_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent]);

  const hideBubble = () => {
    writeCookieBubbleHidden(true);
    setBubbleHidden(true);
  };

  const openPanel = (tab) => {
    const base = consent || DEFAULT_COOKIE_DRAFT;
    setDraft({ functional: !!base.functional, analytics: !!base.analytics });
    setActiveTab(tab || "categories");
    setPanelOpen(true);
  };

  const persist = (decision) => {
    const payload = {
      essential: true,
      functional: !!decision.functional,
      analytics: !!decision.analytics,
      version: COOKIE_CONSENT_VERSION,
      decidedAt: new Date().toISOString(),
    };
    writeCookieConsent(payload);
    setConsent(payload);
    setPanelOpen(false);
  };

  const handleAcceptAll = () => persist({ functional: true, analytics: true });
  const handleDeclineAll = () => persist({ functional: false, analytics: false });
  const handleSavePreferences = () => persist(draft);

  const bannerVisible = consent === null && !panelOpen;
  const reopenVisible = consent !== null && !panelOpen && !bubbleHidden;

  // The mobile bottom nav is a *sticky* (not fixed) bar, but it still ends up
  // pinned to the physical bottom of the viewport on mobile (navBaseHeight
  // 60px + safe-area inset — see navHeight above in WorkerPortal). Clear it
  // with extra offset on mobile so the banner/bubble never collides with it;
  // desktop just needs a modest edge buffer.
  const edgeBottom = isMobile
    ? "calc(60px + env(safe-area-inset-bottom, 0px) + 16px)"
    : "24px";

  const tabs = ["categories", "services", "about"];

  return (
    <>
      {bannerVisible && createPortal(
        <div style={{ position: "fixed", left: 16, right: 16, bottom: edgeBottom, zIndex: Z.toast, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{
            pointerEvents: "auto",
            background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, borderRadius: RADIUS.card,
            boxShadow: `0 12px 32px ${BRAND.shadow}`, padding: 20, maxWidth: 560, width: "100%",
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ fontSize: FS.body, color: BRAND.text, lineHeight: 1.5 }}>
              <strong style={{ display: "block", marginBottom: 4, fontSize: FS.bodyLg }}>{t("cookie.bannerTitle")}</strong>
              {t("cookie.bannerBody")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Btn variant="secondary" size="sm" onClick={() => openPanel("categories")}>{t("cookie.configure")}</Btn>
              <Btn variant="ghost" size="sm" onClick={handleDeclineAll}>{t("cookie.declineAll")}</Btn>
              <Btn variant="primary" size="sm" onClick={handleAcceptAll}>{t("cookie.acceptAll")}</Btn>
            </div>
          </div>
        </div>,
        document.body
      )}

      {reopenVisible && createPortal(
        <div style={{ position: "fixed", left: 16, bottom: edgeBottom, zIndex: Z.sticky, display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={() => openPanel("categories")}
            aria-label={t("cookie.reopenPreferences")}
            title={t("cookie.reopenPreferences")}
            style={{
              width: 40, height: 40, borderRadius: "50%",
              background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`,
              boxShadow: `0 6px 18px ${BRAND.shadow}`, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: FS.lead, padding: 0,
            }}
          >
            <span aria-hidden="true">🍪</span>
          </button>
          {/* Dismisses just this shortcut bubble, not the consent decision —
              it can look like it's blocking content on some screens/sizes.
              Cookie preferences stay reachable via Settings (and the
              Discover-tab footer) even after this is hidden. */}
          <button
            onClick={hideBubble}
            aria-label={t("cookie.hideBubble")}
            title={t("cookie.hideBubble")}
            style={{
              width: 22, height: 22, borderRadius: "50%",
              background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`,
              boxShadow: `0 4px 10px ${BRAND.shadow}`, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: FS.meta, padding: 0, color: BRAND.textMuted, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>,
        document.body
      )}

      {panelOpen && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.panel, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setPanelOpen(false)}
        >
          <div
            {...panelDialog}
            style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: FS.lead, fontWeight: 700, color: BRAND.text, margin: 0 }}>🍪 {t("cookie.panelTitle")}</h3>
              <button onClick={() => setPanelOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: `1px solid ${BRAND.border}` }}>
              {tabs.map((tabKey) => (
                <button
                  key={tabKey}
                  onClick={() => setActiveTab(tabKey)}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer",
                    padding: "8px 12px", fontSize: FS.meta, fontWeight: 700, fontFamily: "inherit",
                    color: activeTab === tabKey ? BRAND.primary : BRAND.textMuted,
                    borderBottom: activeTab === tabKey ? `2px solid ${BRAND.primary}` : "2px solid transparent",
                    marginBottom: -1,
                  }}
                >
                  {t(`cookie.tab.${tabKey}`)}
                </button>
              ))}
            </div>

            {activeTab === "categories" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <CookieToggleRow
                  label={t("cookie.essentialTitle")}
                  description={t("cookie.essentialDesc")}
                  checked={true}
                  disabled={true}
                />
                <CookieToggleRow
                  label={t("cookie.functionalTitle")}
                  description={t("cookie.functionalDesc")}
                  checked={draft.functional}
                  onChange={(next) => setDraft((d) => ({ ...d, functional: next }))}
                />
                <CookieToggleRow
                  label={t("cookie.analyticsTitle")}
                  description={t("cookie.analyticsDesc")}
                  checked={draft.analytics}
                  onChange={(next) => setDraft((d) => ({ ...d, analytics: next }))}
                />
              </div>
            )}

            {activeTab === "services" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5 }}>
                <div>
                  <strong>{t("cookie.essentialTitle")}</strong>
                  <div style={{ color: BRAND.textMuted, marginTop: 2 }}>{t("cookie.servicesEssential")}</div>
                </div>
                <div>
                  <strong>{t("cookie.functionalTitle")}</strong>
                  <div style={{ color: BRAND.textMuted, marginTop: 2 }}>{t("cookie.servicesFunctional")}</div>
                </div>
                <div>
                  <strong>{t("cookie.analyticsTitle")}</strong>
                  <div style={{ color: BRAND.textMuted, marginTop: 2 }}>{t("cookie.servicesAnalytics")}</div>
                </div>
              </div>
            )}

            {activeTab === "about" && (
              <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.6 }}>
                {t("cookie.aboutBody")}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20, flexWrap: "wrap" }}>
              <Btn variant="ghost" size="sm" onClick={handleDeclineAll}>{t("cookie.declineAll")}</Btn>
              <Btn variant="secondary" size="sm" onClick={handleAcceptAll}>{t("cookie.acceptAll")}</Btn>
              <Btn variant="primary" size="sm" onClick={handleSavePreferences}>{t("cookie.savePreferences")}</Btn>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

// Small header-level component so it can read the language context — the
// root CariGaji component below is the one that *creates* LanguageProvider,
// so it can't consume its own provider's value; this child can.
const HeaderSignInButton = ({ onClick }) => {
  const { t } = useLanguage();
  return <Btn size="sm" variant="primary" onClick={onClick}>{t("common.signIn")}</Btn>;
};

// Same reasoning as HeaderSignInButton above — these need to read the
// language context that the root CariGaji component itself creates.
const AppBrandHeader = ({ onClick, isMobile }) => {
  const { t } = useLanguage();
  return (
    <button
      onClick={onClick}
      aria-label={t("app.homeAriaLabel")}
      style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
    >
      <div style={{ fontSize: isMobile ? FS.lead : FS.h2, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.03em" }}>
        Cari<span style={{ color: BRAND.primary }}>Gaji</span>
      </div>
      <div style={{ fontSize: FS.micro, color: BRAND.textMuted }}>{t("app.tagline")}</div>
    </button>
  );
};

// Each language is listed in ITS OWN script, not translated into the current
// one. A picker that says "Chinese" to an English reader and "Bahasa Cina" to a
// Malay one is useless to the Chinese speaker it is actually for -- endonyms
// are the convention for exactly this reason, and they make the menu identical
// in every language.
const LANGUAGE_OPTIONS = [
  { code: "en", short: "EN", label: "English" },
  { code: "bm", short: "BM", label: "Bahasa Melayu" },
  { code: "ch", short: "中文", label: "中文" },
];

// Header language control: shows only the CURRENT language's short form, and
// opens the list on click. Sits where the theme toggle used to, because
// language is the setting a first-time visitor is most likely to need before
// they can read anything else -- burying it in Settings assumed they could
// already read the path to get there.
const LanguagePicker = ({ isMobile = false }) => {
  // Context, not props: the root component renders the header but sits outside
  // the LanguageProvider it creates, so it has no `language` to hand down.
  // ThemeToggleButton solves the same problem the same way.
  const { t, language, setLanguage } = useLanguage();
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const current = LANGUAGE_OPTIONS.find(o => o.code === language) || LANGUAGE_OPTIONS[0];

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div ref={boxRef} style={{ position: "relative", flexShrink: 0 }}>
      <Btn
        size="sm"
        variant="secondary"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("settings.language")}
        title={t("settings.language")}
        style={isMobile ? { minWidth: 40, height: 36, padding: "0 8px", gap: 0, flexShrink: 0 } : { minWidth: 58, justifyContent: "center", gap: 5 }}
      >
        <span aria-hidden="true">🌐</span>
        <span style={{ fontWeight: 700 }}>{current.short}</span>
      </Btn>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60,
            background: BRAND.surface, border: `1px solid ${BRAND.border}`,
            borderRadius: RADIUS.control, boxShadow: `0 10px 30px ${BRAND.shadow}`,
            padding: 4, minWidth: 170,
          }}
        >
          {LANGUAGE_OPTIONS.map(opt => (
            <button
              key={opt.code}
              role="option"
              aria-selected={opt.code === language}
              onClick={() => { setLanguage(opt.code); setOpen(false); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                width: "100%", padding: "9px 10px", borderRadius: RADIUS.control, border: "none", cursor: "pointer",
                fontFamily: "inherit", fontSize: FS.meta, textAlign: "left",
                background: opt.code === language ? BRAND.primaryLight : "transparent",
                color: opt.code === language ? BRAND.onPrimaryLight : BRAND.text,
                fontWeight: opt.code === language ? 700 : 500,
              }}
            >
              <span>{opt.label}</span>
              <span style={{ fontSize: FS.meta, opacity: 0.75 }}>{opt.short}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const ThemeToggleButton = ({ themePreference, onClick, isMobile = false }) => {
  const { t } = useLanguage();
  const label = themePreference === "system" ? t("theme.system") : themePreference === "light" ? t("theme.light") : t("theme.dark");
  return (
    <Btn
      size="sm"
      variant="secondary"
      onClick={onClick}
      aria-label={t("theme.ariaLabel").replace("{mode}", themePreference)}
      title={t("theme.title").replace("{mode}", themePreference)}
      // Icon-only on mobile — the fixed-width text button was a major
      // contributor to the header overflowing/cramping on narrow screens
      // once the notification bell + account menu are also on the row.
      style={isMobile ? { width: 36, height: 36, padding: 0, gap: 0, flexShrink: 0 } : { width: 112, justifyContent: "center", gap: 7 }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex" }}>{themePreference === "system" ? <Icons.Monitor size={16} /> : themePreference === "light" ? <Icons.Sun size={16} /> : <Icons.Moon size={16} />}</span>
      {!isMobile && <span>{label}</span>}
    </Btn>
  );
};

const AdminAccessRequired = ({ user, onBack }) => {
  const { t } = useLanguage();
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32, textAlign: "center" }}>
      <div style={{ display: "flex", color: BRAND.textMuted }} aria-hidden="true"><Icons.Ban size={40} /></div>
      <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text }}>{t("admin.accessRequiredTitle")}</div>
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, maxWidth: 320 }}>
        {user ? t("admin.notAdminHint") : t("admin.signInHint")}
      </div>
      <Btn variant="secondary" onClick={onBack}>{t("admin.backToWorkerApp")}</Btn>
    </div>
  );
};

// Mandatory, non-dismissible T&C acceptance — shown to any signed-in user
// who hasn't accepted yet, regardless of how they authenticated. Exists
// because OAuth (Google/Apple/Facebook) sign-up never goes through the
// registration form's TnCConsent checkbox at all, so consent has to be
// enforced here at the app-shell level instead. zIndex 1500 — above
// CookieConsentManager's full-screen preference panel (1400), the highest
// existing overlay in this file.
const TnCGateModal = ({ open, accepting, onAccept, onSignOut }) => {
  const { t } = useLanguage();
  const { hasScrolledToEnd, boxRef, onScroll } = useTnCScrollGate();
  if (!open) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: Z.gate, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 520, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("auth.tncGateTitle")}</div>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16 }}>{t("auth.tncGateSubtitle")}</div>
        <div
          ref={boxRef}
          onScroll={onScroll}
          style={{ padding: "12px 14px", background: BRAND.grayLight, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.7, overflowY: "auto", flex: 1, marginBottom: 12 }}
        >
          <TnCLegalText />
        </div>
        {!hasScrolledToEnd && (
          <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12, textAlign: "center" }}>{t("auth.tncScrollHint")}</div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="secondary" onClick={onSignOut} style={{ flex: 1, justifyContent: "center" }}>{t("account.signOut")}</Btn>
          <Btn disabled={!hasScrolledToEnd || accepting} onClick={onAccept} style={{ flex: 1, justifyContent: "center" }}>
            {accepting ? "…" : t("auth.tncGateAcceptBtn")}
          </Btn>
        </div>
      </div>
    </div>,
    document.body
  );
};

// Mandatory "complete your details" step — the second gate of the
// progressive sign-up flow (T&C gate → this → one-time intro). Registration
// now collects only role+email+password, so the name/phone/identity/address
// details that used to live in the register form are collected here, after
// the account exists. Text details are required (owner decision); KYC
// document uploads are deferrable — a worker can skip them and complete
// verification later via the Profile-tab banner, which reopens this same
// modal with kycOnly. zIndex 1500, same layer as TnCGateModal (they can
// never be open simultaneously — the gate conditions are sequential).
// Optional profile-photo picker with a circular crop guide and written
// guidance (owner request 2026-07-20: bad avatars — memes, cartoons,
// covered/group selfies — hurt a worker's chance of being picked by an
// employer, so guide people toward a real, clear, forward-facing photo at
// the moment they'd naturally set one, not bury it in Settings).
const AvatarGuidePicker = ({ file, existingUrl, onChange, role, disabled }) => {
  const { t } = useLanguage();
  const [previewUrl, setPreviewUrl] = useState(null);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const displayUrl = previewUrl || existingUrl || null;
  const isWorker = role !== "employer";
  const guideLines = isWorker
    ? [t("details.avatarGuide1Worker"), t("details.avatarGuide2Worker"), t("details.avatarGuide3Worker"), t("details.avatarGuide4Worker")]
    : [t("details.avatarGuide1Employer"), t("details.avatarGuide2Employer")];
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 2 }}>{t("details.avatarTitle")}</div>
      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{t("details.avatarOptionalHint")}</div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 108, height: 108, flexShrink: 0 }}>
          <div style={{
            width: "100%", height: "100%", borderRadius: "50%", overflow: "hidden",
            background: displayUrl ? `center/cover no-repeat url(${displayUrl})` : BRAND.grayLight,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: `1px solid ${BRAND.border}`,
          }}>
            {!displayUrl && <span aria-hidden="true" style={{ display: "inline-flex", color: BRAND.textMuted }}><Icons.User size={34} /></span>}
          </div>
          {/* Dashed circular crop guide — the app renders avatars as circles
              everywhere else, so this previews exactly what gets cut off. */}
          <div style={{ position: "absolute", inset: -4, borderRadius: "50%", border: `2px dashed ${BRAND.primary}`, pointerEvents: "none" }} aria-hidden="true" />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={{
            display: "inline-block", padding: "8px 14px", borderRadius: RADIUS.control,
            border: `1px solid ${BRAND.border}`, background: BRAND.surface,
            cursor: disabled ? "wait" : "pointer", fontSize: FS.meta, fontWeight: 600, color: BRAND.primaryOnSurface,
          }}>
            {displayUrl ? t("details.avatarChangeBtn") : t("details.avatarChooseBtn")}
            <input type="file" accept="image/*" disabled={disabled} style={{ display: "none" }}
              onChange={e => onChange(e.target.files?.[0] || null)} />
          </label>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.6 }}>
            {guideLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
};

const DetailsGateModal = ({ open, user, role, kycOnly = false, onCompleted, onClose, onSignOut }) => {
  const { t } = useLanguage();
  const toast = useToast();
  const [form, setForm] = useState({ fullName: "", countryCode: "MY", phone: "", identityType: "MyKad", idNumber: "", dateOfBirth: "", address: "", ssmNumber: "", avatar: null, kycFront: null, kycBack: null, selfie: null, supportingDoc: null });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  // Advisory OCR check that the ID on the uploaded photo matches what was
  // typed (moved here from the old all-in-one register form).
  const [idOcr, setIdOcr] = useState({ status: "idle" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Employers already declared company name + SSM at sign-up (they're
  // required fields on the register form); seed them here so the details
  // step doesn't ask twice. Metadata is the fallback that survives the
  // email-confirmation flow, where no profiles row exists yet.
  useEffect(() => {
    if (!open || !user) return;
    setForm(f => ({
      ...f,
      fullName: f.fullName || user.user_metadata?.company_name || "",
      ssmNumber: f.ssmNumber || user.user_metadata?.ssm_number || "",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  // Legal working age gate — Malaysia; platform T&C requires 18+.
  const LEGAL_WORKING_AGE = 18;
  const ageFromDob = dob => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d)) return null;
    const now = new Date();
    let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a;
  };
  const applicantAge = ageFromDob(form.dateOfBirth);
  const dobUnderage = form.dateOfBirth && applicantAge !== null && applicantAge < LEGAL_WORKING_AGE;
  const maxDob = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - LEGAL_WORKING_AGE);
    return d.toISOString().slice(0, 10);
  })();

  const DOC_LABELS = {
    MyKad: { front: t("auth.docMyKadFront"), back: t("auth.docMyKadBack") },
    MyPR: { front: t("auth.docMyPRFront"), back: t("auth.docMyPRBack") },
    Passport: { front: t("auth.docPassportFront"), back: t("auth.docPassportBack") },
  }[form.identityType] || { front: t("auth.docIdFront"), back: t("auth.docIdBack") };

  const normalizeId = s => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const verifyIdOnImage = async file => {
    const entered = normalizeId(form.idNumber);
    if (!file || !file.type?.startsWith("image/") || entered.length < 6) {
      setIdOcr({ status: "idle" });
      return;
    }
    setIdOcr({ status: "checking" });
    try {
      const T = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js");
      const recognize = T.recognize || T.default?.recognize;
      const { data } = await recognize(file, "eng");
      const ocr = normalizeId(data?.text);
      const enteredDigits = entered.replace(/[^0-9]/g, "");
      const ocrDigits = ocr.replace(/[^0-9]/g, "");
      const matched = form.identityType === "Passport"
        ? ocr.includes(entered)
        : (enteredDigits.length >= 6 && ocrDigits.includes(enteredDigits));
      setIdOcr({ status: matched ? "match" : "mismatch" });
    } catch (e) {
      setIdOcr({ status: "idle" });
    }
  };

  const isEmployer = role === "employer";
  const errors = kycOnly
    ? { kycFront: !form.kycFront, kycBack: !form.kycBack, selfie: !form.selfie }
    : isEmployer
      ? { fullName: !form.fullName.trim(), phone: !form.phone.trim() }
      : {
          fullName: !form.fullName.trim(),
          phone: !form.phone.trim(),
          idNumber: !form.idNumber.trim(),
          dateOfBirth: !form.dateOfBirth || dobUnderage,
          address: !form.address.trim(),
        };
  const hasErrors = Object.values(errors).some(Boolean);
  const fieldError = k => showErrors && errors[k];

  const handleSave = async () => {
    if (!user) return;
    if (hasErrors) { setShowErrors(true); return; }
    setSaving(true);
    try {
      // The photo is explicitly optional — a failed upload (network blip,
      // storage hiccup) must not block saving the legally-required fields
      // below, so this failure is swallowed with just a warning toast
      // rather than aborting the whole save.
      let avatarPath = null;
      if (form.avatar) {
        try {
          avatarPath = await uploadAvatarFile(user.id, form.avatar);
          await supabase.auth.updateUser({ data: { ...user.user_metadata, avatar_url: avatarPath } });
        } catch (avatarErr) {
          avatarPath = null;
          toast(`${t("details.avatarUploadFailed")}${avatarErr.message}`, "error");
        }
      }
      const anyDoc = form.kycFront || form.kycBack || form.selfie || form.supportingDoc;
      let kycLevel = null;
      if (anyDoc) {
        const uploadTasks = [
          ["kyc_front", form.kycFront],
          ["kyc_back", form.kycBack],
          ["selfie", form.selfie],
          ["supporting_doc", form.supportingDoc],
        ]
          .filter(([, file]) => file)
          .map(async ([label, file]) => [label, await uploadKycFile(user.id, file, label)]);
        const kycRefs = Object.fromEntries(await Promise.all(uploadTasks));
        await supabase.auth.updateUser({ data: { ...user.user_metadata, ...kycRefs } });
        kycLevel = assignKYCLevel(Boolean(form.kycFront), Boolean(form.kycBack), Boolean(form.selfie), Boolean(form.supportingDoc));
      }

      if (kycOnly) {
        if (kycLevel) await supabase.from("profiles").upsert({ id: user.id, kyc_level: kycLevel }, { onConflict: "id" });
        toast(t("details.kycUploadedToast"), "success");
        onClose?.();
      } else {
        const fullPhone = `${COUNTRIES.find(c => c.code === form.countryCode)?.dialCode || "+60"}${form.phone.trim()}`;
        await supabase.from("user_private").upsert(
          {
            id: user.id,
            phone: fullPhone,
            ...(isEmployer ? {} : {
              identity_type: form.identityType,
              id_number: form.idNumber.trim(),
              date_of_birth: form.dateOfBirth || null,
              address: form.address.trim(),
            }),
          },
          { onConflict: "id" }
        );
        const completedAt = new Date().toISOString();
        // Also (re)assert role here: in the email-confirmation signup flow
        // there was no session at registration time, so the profiles row may
        // not exist yet — the chosen role rides in auth metadata.
        const { error } = await supabase.from("profiles").upsert(
          {
            id: user.id,
            full_name: form.fullName.trim(),
            role: role || user.user_metadata?.account_role || "worker",
            details_completed_at: completedAt,
            ...(kycLevel ? { kyc_level: kycLevel } : {}),
            ...(avatarPath ? { avatar_url: avatarPath } : {}),
            ...(isEmployer && form.ssmNumber.trim() ? { ssm_number: form.ssmNumber.trim() } : {}),
          },
          { onConflict: "id" }
        );
        if (error) throw error;
        // Keep the display-name fallback chain working immediately.
        await supabase.auth.updateUser({ data: { ...user.user_metadata, full_name: form.fullName.trim() } });
        onCompleted?.(completedAt);
      }
    } catch (err) {
      toast(`${t("details.saveFailed")}${err.message}`, "error");
    }
    setSaving(false);
  };

  if (!open) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: Z.gate, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 560, width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{kycOnly ? t("details.kycOnlyTitle") : t("details.title")}</div>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16 }}>{kycOnly ? t("details.kycOnlySubtitle") : (isEmployer ? t("details.subtitleEmployer") : t("details.subtitleWorker"))}</div>
        {showErrors && hasErrors && (
          <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: RADIUS.control, background: "#FEF2F2", border: `1.5px solid ${BRAND.red}`, color: BRAND.red, fontSize: FS.meta }}>
            {t("auth.pleaseCompleteFields")}
          </div>
        )}
        <div style={{ overflowY: "auto", flex: 1, paddingRight: 4 }}>
          {!kycOnly && (
            <>
              <AvatarGuidePicker
                file={form.avatar}
                existingUrl={getAvatarUrl(user?.user_metadata?.avatar_url)}
                onChange={f => set("avatar", f)}
                role={role}
                disabled={saving}
              />
              <Input label={isEmployer ? t("details.companyContactName") : t("auth.fullName")} placeholder={isEmployer ? t("employer.companyNamePlaceholder") : t("auth.fullNamePlaceholder")} value={form.fullName} onChange={e => set("fullName", e.target.value)} error={fieldError("fullName")} style={{ marginBottom: 4 }} />
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
                {isEmployer ? t("details.companyNameFinalHint") : t("details.fullNameFinalHint")}
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("auth.phoneNumber")}</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  <div style={{ flex: "0 0 auto" }}>
                    <SearchableCountrySelect value={form.countryCode} onChange={e => set("countryCode", e.target.value)} compact showDial />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Input placeholder={COUNTRIES.find(c => c.code === form.countryCode)?.placeholder || "Enter phone number"} value={form.phone} onChange={e => set("phone", e.target.value)} style={{ marginBottom: 0 }} error={fieldError("phone")} />
                  </div>
                </div>
              </div>
              {isEmployer && (
                <Input label={t("details.ssmOptional")} placeholder={t("employer.ssmNumberPlaceholder")} value={form.ssmNumber} onChange={e => set("ssmNumber", e.target.value)} />
              )}
              {!isEmployer && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Select
                      label={t("auth.identityType")}
                      value={form.identityType}
                      onChange={e => { set("identityType", e.target.value); set("idNumber", ""); }}
                      options={[
                        { value: "MyKad", label: t("auth.icMyKad") },
                        { value: "Passport", label: t("auth.passport") },
                        { value: "MyPR", label: t("auth.myPR") },
                      ]}
                    />
                    <Input
                      label={form.identityType === "MyKad" ? t("auth.myKadNumber") : form.identityType === "MyPR" ? t("auth.myPRNumber") : t("auth.passportNumber")}
                      placeholder={["MyKad", "MyPR"].includes(form.identityType) ? "XXXXXX-XX-XXXX" : "A1234567"}
                      value={form.idNumber}
                      onChange={e => {
                        const formatted = formatIdentityNumber(e.target.value, form.identityType);
                        set("idNumber", formatted);
                        if (form.identityType === "MyKad") {
                          const extractedDate = extractDateFromIC(formatted);
                          if (extractedDate) set("dateOfBirth", extractedDate);
                        }
                      }}
                      error={fieldError("idNumber")}
                    />
                  </div>
                  <Input label={t("auth.dateOfBirth")} type="date" value={form.dateOfBirth} onChange={e => set("dateOfBirth", e.target.value)} error={fieldError("dateOfBirth")} max={maxDob} style={{ marginBottom: dobUnderage ? 4 : 16 }} />
                  {dobUnderage && (
                    <div style={{ fontSize: FS.meta, color: BRAND.red, fontWeight: 600, lineHeight: 1.5, marginBottom: 12 }}>
                      {t("auth.underageWarning").replace("{age}", LEGAL_WORKING_AGE)}
                    </div>
                  )}
                  <Input label={t("auth.address")} placeholder={t("auth.addressPlaceholder")} value={form.address} onChange={e => set("address", e.target.value)} error={fieldError("address")} />
                </>
              )}
            </>
          )}
          {(kycOnly || !isEmployer) && (
            <>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("auth.uploadDocuments")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
                {kycOnly ? t("details.kycOnlyHint") : t("details.kycDeferHint")}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label={DOC_LABELS.front} accept="image/*,application/pdf" onChange={e => { const f = e.target.files?.[0] || null; set("kycFront", f); verifyIdOnImage(f); }} fileName={form.kycFront?.name} helper={t("auth.uploadFrontHelper")} error={fieldError("kycFront")} />
                <FileInput label={DOC_LABELS.back} accept="image/*,application/pdf" onChange={e => set("kycBack", e.target.files?.[0] || null)} fileName={form.kycBack?.name} helper={t("auth.uploadBackHelper")} error={fieldError("kycBack")} />
              </div>
              {idOcr.status === "checking" && (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>{t("auth.ocrChecking")}</div>
              )}
              {idOcr.status === "match" && (
                <div style={{ fontSize: FS.meta, color: BRAND.greenOnSurface, fontWeight: 600, marginBottom: 12 }}><InlineIcon icon={Icons.Check} />{t("auth.ocrMatch")}</div>
              )}
              {idOcr.status === "mismatch" && (
                <div style={{ fontSize: FS.meta, color: "#B45309", marginBottom: 12 }}>
                  <strong>{t("auth.ocrMismatchTitle")}</strong> {t("auth.ocrMismatchAction")}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label={t("auth.selfie")} accept="image/*" onChange={e => set("selfie", e.target.files?.[0] || null)} fileName={form.selfie?.name} helper={t("auth.selfieHelper")} error={fieldError("selfie")} />
                <FileInput label={t("auth.certification")} accept="image/*,application/pdf" onChange={e => set("supportingDoc", e.target.files?.[0] || null)} fileName={form.supportingDoc?.name} helper={t("auth.certificationHelper")} />
              </div>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {kycOnly ? (
            <Btn variant="secondary" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>{t("common.cancel")}</Btn>
          ) : (
            <Btn variant="secondary" onClick={onSignOut} style={{ flex: 1, justifyContent: "center" }}>{t("account.signOut")}</Btn>
          )}
          <Btn disabled={saving} onClick={handleSave} style={{ flex: 1, justifyContent: "center" }}>
            {saving ? "…" : t("details.saveBtn")}
          </Btn>
        </div>
      </div>
    </div>,
    document.body
  );
};

// One-time first-sign-in intro: a brief, dismissible "what is this app and
// how do I use it" walkthrough shown once after the T&C + details gates are
// both done. Guidance, not consent — so unlike the two gates it has a
// single friendly dismiss action that stamps profiles.intro_seen_at.
const WelcomeIntroModal = ({ open, role, saving, onDone }) => {
  const { t } = useLanguage();
  if (!open) return null;
  // Step 5 carries the payment-safety point that used to be a 129-word block on
  // the landing page. It belongs here: it is the thing a new worker most needs
  // and is least able to take in before they have seen a single shift.
  const steps = role === "employer"
    ? [t("intro.employerStep1"), t("intro.employerStep2"), t("intro.employerStep3"), t("intro.employerStep4"), t("intro.employerStep5")]
    : [t("intro.workerStep1"), t("intro.workerStep2"), t("intro.workerStep3"), t("intro.workerStep4"), t("intro.workerStep5")];
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: Z.gate, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 24, maxWidth: 480, width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" }}>
        <div style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text, textAlign: "center", marginBottom: 4 }}>{t("intro.title")}</div>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, textAlign: "center", marginBottom: 18 }}>{t("intro.subtitle")}</div>
        {steps.map((step, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: BRAND.primary, color: BRAND.onSolid, display: "flex", alignItems: "center", justifyContent: "center", fontSize: FS.meta, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
            <div style={{ fontSize: FS.body, color: BRAND.text, lineHeight: 1.6 }}>{step}</div>
          </div>
        ))}
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 4, marginBottom: 16 }}>{t("intro.helpHint")}</div>
        <Btn disabled={saving} onClick={onDone} style={{ width: "100%", justifyContent: "center" }}>{saving ? "…" : t("intro.getStartedBtn")}</Btn>
      </div>
    </div>,
    document.body
  );
};

// Mobile back-gesture handling. The app is a routerless SPA, so a phone
// back-swipe pops the only history entry and exits the app — even when the
// user just meant to close an open job-ad detail view. On mobile we push one
// sentinel history entry and intercept popstate: if the active portal has
// something open (detail view / modal), close that and stay; on a bare main
// page, first back shows a "press back again to exit" hint, second back
// within the window really exits. Desktop is left completely alone —
// hijacking the browser back button there would be hostile.
// Rendered as a child (not inline in the root component) because it needs
// useToast/useLanguage, whose providers the root itself renders.
const BackGestureManager = ({ enabled, backHandlerRef, authOpen, onCloseAuth }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const lastExitAttemptRef = useRef(0);
  // Refs so the single popstate listener always sees fresh values without
  // re-subscribing (re-pushing sentinels mid-flight gets racy).
  const authOpenRef = useRef(authOpen);
  authOpenRef.current = authOpen;
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    // Number of sentinel entries currently stacked above the app's base
    // history entry — needed so "really exit" can jump past all of them in
    // one traversal instead of assuming a single sentinel.
    let depth = 0;
    const pushSentinel = () => {
      if (depth >= 25) return; // safety cap; the trap still holds via the rest
      window.history.pushState({ carigajiTrap: true }, "");
      depth += 1;
    };
    pushSentinel();
    // Re-arming the sentinel synchronously inside popstate mutates history
    // while the browser's swipe-back animation is still settling, which is a
    // known cause of a ghost "shadow of the page" flicker (worst on iOS
    // Safari). Defer the re-push until the gesture animation is over; the
    // deferred push is coalesced so rapid swipes don't stack sentinels.
    let rearmTimer = null;
    const rearmSentinel = () => {
      if (rearmTimer) clearTimeout(rearmTimer);
      rearmTimer = setTimeout(() => { rearmTimer = null; pushSentinel(); }, 350);
    };
    const onPop = () => {
      depth = Math.max(0, depth - 1);
      if (rearmTimer) {
        // A second pop arrived before the deferred sentinel was re-armed
        // (very fast double-swipe): re-arm immediately so the trap can't be
        // walked past by accident.
        clearTimeout(rearmTimer);
        rearmTimer = null;
        pushSentinel();
        return;
      }
      if (authOpenRef.current) {
        onCloseAuth();
        rearmSentinel();
        return;
      }
      if (backHandlerRef.current && backHandlerRef.current()) {
        rearmSentinel();
        return;
      }
      const now = Date.now();
      if (now - lastExitAttemptRef.current < 2000) {
        // Second back within the window: really leave — jump past every
        // remaining sentinel AND the app's base entry in one traversal.
        window.history.go(-(depth + 1));
        return;
      }
      lastExitAttemptRef.current = now;
      toast(t("toast.backAgainToExit"), "info", 2000);
      rearmSentinel();
    };
    // The swipe-preview "ghost" is the browser's screenshot of the history
    // entry UNDER the sentinel, captured whenever the sentinel was pushed.
    // Without refreshing it, that screenshot can be an old page (e.g. My
    // Bids) even though back will actually land on the current view — so
    // every in-app navigation (tab change, opening a detail/chat) re-arms a
    // fresh sentinel via this event, keeping the preview close to reality.
    const onNav = () => rearmSentinel();
    window.addEventListener("popstate", onPop);
    window.addEventListener("carigaji:nav", onNav);
    return () => {
      if (rearmTimer) clearTimeout(rearmTimer);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("carigaji:nav", onNav);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return null;
};

// Single source of truth for "is this a phone-sized viewport". Shared by the
// isMobile viewport check and by backTrapActive() below, which has to agree
// with it exactly — they select between two different navigation models.
const MOBILE_BREAKPOINT = 768;

// ─── PORTAL ROUTING ───────────────────────────────────────────────────────────
// Top-level portals get real addresses so links, refresh, bookmarks and the
// browser's own Back button work natively:
//   /CariGaji/          -> worker
//   /CariGaji/employer  -> employer console
//   /CariGaji/admin     -> admin dashboard
//
// Deliberately NOT a router library: three routes don't justify the dependency
// in an app whose only deps are React + Supabase, and a handful of helpers
// matches this file's existing style. Tabs, sub-views and modals stay as
// component state — routing those too would multiply the regression surface
// for a fraction of the benefit.
//
// All path math is relative to Vite's `base` (/CariGaji/), never the domain
// root — getting that wrong is the classic GitHub Pages project-site bug.
const APP_BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, ""); // "/CariGaji"
const PORTAL_PATHS = { worker: "", employer: "employer", admin: "admin" };

// The portal this tab is currently in.
//
// Needed because the worker portal's path is "" (see PORTAL_PATHS above), so an
// admin sitting in worker view and an admin who has just opened the app have
// the SAME address -- /en either way. The URL cannot distinguish "I chose
// worker" from "I have not chosen yet", so on every refresh the role default
// won and an admin was thrown back to /admin mid-task.
//
// sessionStorage rather than localStorage is the whole point of the fix: it
// survives a refresh and dies with the tab, which is exactly the intended
// lifetime. Refreshing resumes where you were; a brand-new tab still starts you
// at your role's home. Wrapped because Safari private mode throws on access.
const PORTAL_SESSION_KEY = "carigaji-portal";
const rememberPortal = (portal) => {
  try { window.sessionStorage.setItem(PORTAL_SESSION_KEY, portal); } catch { /* private mode */ }
};
const readRememberedPortal = () => {
  try {
    const v = window.sessionStorage.getItem(PORTAL_SESSION_KEY);
    return Object.prototype.hasOwnProperty.call(PORTAL_PATHS, v) ? v : null;
  } catch { return null; }
};
// A signed-out visitor who follows a link to an employer page is sent to the
// public landing page (there is nothing to show them). Remember where they were
// going so that signing in as the right kind of account takes them there
// instead of to the console's front door. Short-lived on purpose.
const RETURN_TO_KEY = "carigaji-return-to";
const stashReturnTo = (path) => {
  try { window.sessionStorage.setItem(RETURN_TO_KEY, `${Date.now()}|${path}`); } catch { /* private mode */ }
};
const takeReturnTo = () => {
  try {
    const raw = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    if (!raw) return null;
    const [at, ...rest] = raw.split("|");
    return Date.now() - Number(at) < 30 * 60 * 1000 ? rest.join("|") : null;
  } catch { return null; }
};
const forgetRememberedPortal = () => {
  try { window.sessionStorage.removeItem(PORTAL_SESSION_KEY); } catch { /* private mode */ }
};

// Every address carries its language: /CariGaji/en, /CariGaji/bm/employer,
// /CariGaji/ch/shift/<id>. Owner's call, 2026-08-29.
//
// This is what lets each language be indexed separately -- one URL per
// language is the precondition for hreflang and for Google treating the Malay
// and Chinese versions as pages in their own right rather than as a
// JavaScript state of the English one. It also makes a shared link carry the
// sender's language, which matters when the whole point is sharing shifts into
// Malay- and Chinese-speaking WhatsApp groups.
//
// The prefix is OPTIONAL on the way in and CANONICAL on the way out: a URL
// without one still resolves (every link shared before today keeps working),
// and the app then rewrites the address to include it.
const LANG_CODES = ["en", "bm", "ch"];
const DEFAULT_LANG = "en";

// Split a pathname into { lang, rest } where rest is the route with the base
// and any language prefix removed. One parser, so the language segment cannot
// be handled correctly in one place and forgotten in another.
const splitLangPath = (pathname = "") => {
  let rest = pathname;
  if (APP_BASE && rest.startsWith(APP_BASE)) rest = rest.slice(APP_BASE.length);
  const parts = rest.replace(/^\/+/, "").split("/");
  if (LANG_CODES.includes(parts[0])) {
    return { lang: parts[0], rest: parts.slice(1) };
  }
  return { lang: null, rest: parts };
};

const langFromPath = (pathname = "") => splitLangPath(pathname).lang;

const withLang = (lang, segments) => {
  const path = [lang || DEFAULT_LANG, ...segments.filter(Boolean)].join("/");
  return `${APP_BASE}/${path}`.replace(/\/{2,}/g, "/");
};

const portalToPath = (portal, lang) =>
  withLang(lang, [PORTAL_PATHS[portal] ?? ""]);

// One shift, one address. Deliberately a SEPARATE concept from the portal
// paths above rather than a fourth portal -- a shift URL is an entry point
// into the worker app, not a place the app lives, and conflating them would
// put shift ids through portalToPath's round trip.
const SHIFT_PATH_SEG = "shift";
const shiftToPath = (id, lang) =>
  withLang(lang, [SHIFT_PATH_SEG, encodeURIComponent(id)]);

const shiftIdFromPath = (pathname = "") => {
  const { rest } = splitLangPath(pathname);
  if (rest[0] !== SHIFT_PATH_SEG || !rest[1]) return null;
  try { return decodeURIComponent(rest[1]); } catch { return rest[1]; }
};

const portalFromPath = (pathname = "") => {
  // Unknown segments fall back to the worker app rather than rendering nothing.
  const { rest } = splitLangPath(pathname);
  const seg = rest[0];
  if (seg === "employer") return "employer";
  if (seg === "admin") return "admin";
  // A shared shift link opens inside the worker app.
  if (seg === SHIFT_PATH_SEG) return "worker";
  return "worker";
};

const samePath = (a, b) => (a.replace(/\/+$/, "") || "/") === (b.replace(/\/+$/, "") || "/");

// Is BackGestureManager's history trap currently armed? It mounts on
// `isMobile` (viewport width), so the same test answers it here without
// threading state through — see the two navigation models it selects between
// in the setPortal comment below.
const backTrapActive = () =>
  typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;

// ─── IN-PORTAL ROUTES ─────────────────────────────────────────────────────────
// Every page has its own address, not just every portal:
//   /en                       Discover            /en/employer/shifts/<id>   one shift
//   /en/shift/<id>            one shift           /en/employer/post-shift    post a shift
//   /en/my-shifts[/<id>]      My shifts           /en/admin/disputes         admin disputes
//   /en/chat[/<shiftId>]      Chat                ... and so on, per the tables below
//   /en/profile[/account]     Profile
// The app's own state stays the source of truth; the address FOLLOWS it. On the
// way in the address seeds that state (refresh, bookmark, shared link). On
// desktop, Back/Forward walk between pages. On mobile the address is only ever
// replaced, never pushed, because BackGestureManager owns the history stack
// there -- see setPortal above for why pushing would fight its sentinels.
const WORKER_ROUTES = { discover: [], applications: ["my-shifts"], chat: ["chat"], earnings: ["earnings"], profile: ["profile"] };
// Retired worker segments, read as their current name so old links, emails and
// notifications (/en/my-bids/<id>) still land on the right page. Reading them
// as the new name also lets usePortalRoute's arrival hold match the loaded
// state, so the address is then replaced with the current URL.
const LEGACY_WORKER_SEGMENTS = { "my-bids": "my-shifts" };

export const decodeSeg = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

// The segments AFTER base, language and portal prefix.
const portalRouteSegments = (pathname, portal) => {
  const segs = splitLangPath(pathname).rest.filter(Boolean);
  if (portal === "employer" || portal === "admin") return segs[0] === portal ? segs.slice(1) : [];
  if (LEGACY_WORKER_SEGMENTS[segs[0]]) return [LEGACY_WORKER_SEGMENTS[segs[0]], ...segs.slice(1)];
  return segs;
};
export const initialRouteSegments = (portal) =>
  typeof window === "undefined" ? [] : portalRouteSegments(window.location.pathname, portal);
export const routeKeyFromSegment = (table, seg) =>
  seg ? (Object.keys(table).find(k => table[k][0] === seg) ?? null) : null;

const parseWorkerRoute = (segs) => {
  if (segs[0] === SHIFT_PATH_SEG && segs[1]) return { tab: null, shiftId: decodeSeg(segs[1]), profileTab: "profile", applicationId: null, chatShiftId: null };
  const tab = routeKeyFromSegment(WORKER_ROUTES, segs[0]) ?? "discover";
  return {
    tab, shiftId: null,
    profileTab: tab === "profile" && segs[1] === "account" ? "account" : "profile",
    applicationId: tab === "applications" && segs[1] ? decodeSeg(segs[1]) : null,
    chatShiftId: tab === "chat" && segs[1] ? decodeSeg(segs[1]) : null,
  };
};
const buildWorkerSegments = ({ tab, profileTab, shiftId, applicationId, chatShiftId }) => {
  if (shiftId) return [SHIFT_PATH_SEG, encodeURIComponent(shiftId)];
  const base = WORKER_ROUTES[tab] ?? [tab];
  if (tab === "applications" && applicationId) return [...base, encodeURIComponent(applicationId)];
  if (tab === "chat" && chatShiftId) return [...base, encodeURIComponent(chatShiftId)];
  if (tab === "profile" && profileTab === "account") return [...base, "account"];
  return base;
};



// ─── PAGE HEAD (title, description, robots, canonical) ───────────────────────
// A search engine reads these per page, so they follow the page the same way
// the address does. Two rules keep this safe:
//   * robots is "index" only when the BUILD is indexable (SITE.indexable: a real
//     site address was configured) AND this page is a public one. Private pages
//     (my shifts, chat, profile, earnings, the employer and admin consoles) are
//     always noindex.
//   * the product name appears only through SITE.name / {brand}.
const setHeadTag = (selector, tag, attrs) => {
  let el = document.head.querySelector(selector);
  if (!el) { el = document.createElement(tag); document.head.appendChild(el); }
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
};
const applyPageHead = ({ title, description, index = false, path = null }) => {
  if (typeof document === "undefined") return;
  document.title = title;
  setHeadTag('meta[name="description"]', "meta", { name: "description", content: description });
  const robots = SITE.indexable && index ? "index, follow, max-image-preview:large" : "noindex, nofollow";
  setHeadTag('meta[name="robots"]', "meta", { name: "robots", content: robots });
  setHeadTag('meta[property="og:title"]', "meta", { property: "og:title", content: title });
  setHeadTag('meta[property="og:description"]', "meta", { property: "og:description", content: description });
  const link = document.head.querySelector('link[rel="canonical"]');
  if (SITE.indexable && index && path) {
    const href = `${SITE.siteUrl}${path}`;
    setHeadTag('link[rel="canonical"]', "link", { rel: "canonical", href });
    setHeadTag('meta[property="og:url"]', "meta", { property: "og:url", content: href });
  } else if (link) {
    link.remove();
    document.head.querySelector('meta[property="og:url"]')?.remove();
  }
};

// History bookkeeping. `carigajiIdx` marks entries this layer created, and
// routePaths remembers the path at each index, so that navigating back to the
// page you just came from (an in-app "Back" button) can be a real history.back()
// instead of pushing a duplicate entry that makes the browser's Back button
// appear to do nothing.
const routePaths = [];
const routeNavigate = (target, replace) => {
  const st = window.history.state || {};
  const idx = Number.isInteger(st.carigajiIdx) ? st.carigajiIdx : 0;
  if (replace) {
    routePaths[idx] = target;
    window.history.replaceState({ ...st, carigajiIdx: idx }, "", target);
    return;
  }
  if (idx > 0 && routePaths[idx - 1] && samePath(routePaths[idx - 1], target)) {
    window.history.back();
    return;
  }
  routePaths[idx] = window.location.pathname;
  routePaths[idx + 1] = target;
  window.history.pushState({ carigajiIdx: idx + 1 }, "", target);
};

// Keep the address bar in step with a portal's navigation state, and apply the
// address back onto that state on Back/Forward.
//   segments  where the state says we are (array, after the portal prefix)
//   parse     address segments -> a route object
//   apply     route object -> the portal's setters
export const usePortalRoute = ({ portal, segments, parse, apply, head = null }) => {
  const key = segments.join("/");
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const fromPop = useRef(false);
  const initialKey = useRef(key);
  // Until the user has touched the page, any address write is the app settling
  // the address they arrived on (adding the language prefix, redirecting a
  // signed-out visitor off a members-only page) -- a replacement, never a new
  // history entry the user did not ask for.
  const userActed = useRef(false);
  useEffect(() => {
    const mark = () => { userActed.current = true; };
    window.addEventListener("pointerdown", mark, { capture: true, once: true });
    window.addEventListener("keydown", mark, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", mark, { capture: true });
      window.removeEventListener("keydown", mark, { capture: true });
    };
  }, []);
  // Arriving ON an address whose page still has to load (a shift, an
  // application, a chat room) means state does not match it yet. Writing the
  // address from that not-yet-caught-up state would erase the very link the
  // visitor followed, so hold until state catches up -- or the user navigates
  // elsewhere, or a few seconds pass (a page that will never load, e.g. a
  // deleted shift, then settles on the address for what is actually shown).
  const hold = useRef(null);
  if (hold.current === null) hold.current = { key: initialRouteSegments(portal).join("/"), released: false };
  const [tick, setTick] = useState(0);
  const headSig = head ? JSON.stringify(head) : "";
  useEffect(() => {
    if (head) applyPageHead({ ...head, path: window.location.pathname });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSig, key]);
  useEffect(() => {
    const timer = setTimeout(() => { hold.current.released = true; setTick(n => n + 1); }, 6000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hold.current.released) {
      if (key === hold.current.key || key !== initialKey.current) hold.current.released = true;
      else return;
    }
    const lang = langFromPath(window.location.pathname) || readLanguagePreference();
    const target = withLang(lang, [portal === "worker" ? null : portal, ...segments]);
    if (samePath(target, window.location.pathname)) return;
    const replace = backTrapActive() || fromPop.current || !userActed.current;
    fromPop.current = false;
    routeNavigate(target, replace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  useEffect(() => {
    const onPop = () => {
      if (portalFromPath(window.location.pathname) !== portal) return;   // root is swapping portals
      if (backTrapActive()) {
        // Mobile: BackGestureManager owns Back and decides what it closes; the
        // history entry a back gesture lands on carries whatever address was
        // current when it was pushed, so put back the address of the page the
        // screen is actually showing.
        const lang = langFromPath(window.location.pathname) || readLanguagePreference();
        const target = withLang(lang, [portal === "worker" ? null : portal, ...segmentsRef.current]);
        if (!samePath(target, window.location.pathname)) window.history.replaceState(window.history.state, "", target);
        return;
      }
      fromPop.current = true;
      hold.current.released = true;
      applyRef.current(parseRef.current(portalRouteSegments(window.location.pathname, portal)));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [portal]);
};

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
const PortalLoading = () => {
  const { t } = useLanguage();
  return <div role="status" style={{ padding: 24, color: BRAND.textMuted, fontSize: FS.bodyLg }}>{t("chat.loading")}</div>;
};

export default function App() {
  const [portal, setPortalState] = useState(() =>
    typeof window === "undefined" ? "worker" : portalFromPath(window.location.pathname)
  );
  const portalRef = useRef(portal);
  portalRef.current = portal;

  // Drop-in replacement for the old setPortal: every existing call site keeps
  // working unchanged, but navigation now also moves the URL.
  //
  // Two navigation models, because BackGestureManager makes mobile genuinely
  // different — it traps Back with sentinel history entries so back never
  // leaves the app:
  //
  //   Desktop (trap off) — URL drives portal. Push a real entry, and let
  //     popstate sync `portal` back. Browser Back moves between portals,
  //     which is the whole point of the addresses.
  //   Mobile (trap on) — portal drives URL. Push would be actively harmful:
  //     the entry sits above the sentinel, so a back gesture pops OUR entry
  //     instead of the sentinel, and BackGestureManager's `depth` counter
  //     decrements for a sentinel that was never consumed (its "really exit"
  //     history.go(-(depth+1)) then jumps to the wrong place). Replace keeps
  //     the URL shareable/refreshable without touching the stack it owns.
  //
  // `replace` is also forced for automatic redirects (landing on the portal
  // for your role at sign-in) so they don't litter history with entries the
  // user never chose to visit.
  const setPortal = useCallback((next, { replace = false } = {}) => {
    if (typeof window !== "undefined") {
      // Outside the provider, so read the same two sources it does: the URL
      // first, then the stored preference.
      const target = portalToPath(next, langFromPath(window.location.pathname) || readLanguagePreference());
      // An address already inside the target portal (/en/my-shifts for worker,
      // /en/employer/shifts/<id> for employer) is more specific than the
      // portal root and must survive: the role-based landing below runs on
      // every session restore, so rewriting it here would send a refresh on any
      // inner page back to the portal's front door.
      if (portalFromPath(window.location.pathname) !== next && !samePath(target, window.location.pathname)) {
        // state marker lets popstate tell OUR entries apart from the
        // BackGestureManager sentinels that share this history stack.
        const method = replace || backTrapActive() ? "replaceState" : "pushState";
        window.history[method]({ carigajiPortal: next }, "", target);
      }
    }
    rememberPortal(next);
    setPortalState(next);
  }, []);

  // Which account the role-based landing redirect has already run for — see
  // its use in the profile-load effect below.
  // Captured once, at mount: the shift id a shared link arrived with. Not kept
  // in sync with the address bar afterwards -- WorkerPortal owns the URL from
  // that point, and re-deriving this on every navigation would reopen the
  // detail every time the user closed it.
  const [linkShiftId] = useState(() =>
    typeof window === "undefined" ? null : shiftIdFromPath(window.location.pathname)
  );

  const lastRoutedUserIdRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPop = () => {
      if (backTrapActive()) {
        // Mobile: BackGestureManager owns Back entirely, and the entries it
        // pops are its own sentinels — whose URLs are whatever was current
        // when they were pushed, i.e. stale. Reading `portal` off them would
        // spuriously switch portals mid-gesture. Re-assert the URL from the
        // portal we're actually showing instead.
        // Only when the address belongs to a DIFFERENT portal (a stale sentinel).
        // An address inside the portal we are showing -- /en/my-shifts -- is the
        // page we are on, and rewriting it to the portal root would leave the
        // address bar wrong after every back gesture.
        if (portalFromPath(window.location.pathname) !== portalRef.current) {
          const target = portalToPath(portalRef.current, langFromPath(window.location.pathname) || readLanguagePreference());
          window.history.replaceState({ carigajiPortal: portalRef.current }, "", target);
        }
        return;
      }
      // Desktop: this is a real Back/Forward between portal addresses.
      setPortalState(portalFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [userRole, setUserRole] = useState(null);
  const [homeSignal, setHomeSignal] = useState(0);
  // Set when a notification with a "/worker/shifts/{id}",
  // "/employer/shifts/{id}" or "/worker/applications/{id}" link (the
  // cancellation-choice notifications use the latter) is clicked. nonce
  // always increments so the target portal's effect re-fires even on a
  // repeat click of the same link.
  const [notifDeepLink, setNotifDeepLink] = useState(null);
  // A tapped push focuses an existing tab rather than opening a new one, and
  // the service worker posts the link through so the SPA can route to it --
  // a full navigation would reload the app and lose whatever the user was
  // part-way through.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
    const onMessage = (event) => {
      if (event.data?.type === "notification-click" && event.data.link) {
        handleNotificationNavigate(event.data.link);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  });

  const handleNotificationNavigate = (link) => {
    const match = /^\/?(worker|employer)\/(shifts|applications)\/([^/]+)$/.exec(link || "");
    if (!match) return;
    const [, targetPortal, kind, id] = match;
    setPortal(targetPortal);
    setNotifDeepLink(prev => ({
      shiftId: kind === "shifts" ? id : null,
      applicationId: kind === "applications" ? id : null,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  };
  const [themePreference, setThemePreference] = useState(() => readThemePreference());
  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());
  const [user, setUser] = useState(null);
  // false until the initial session restore settles -- distinguishes
  // "signed out" from "not known yet", which are both `user === null`.
  const [authResolved, setAuthResolved] = useState(false);
  // Tri-state: undefined = not fetched yet (avoid flashing the T&C gate
  // before we know), null = signed in but hasn't accepted, timestamp string
  // = accepted. See the profile-role fetch effect below for how it's loaded.
  const [tncAcceptedAt, setTncAcceptedAt] = useState(undefined);
  const [tncAccepting, setTncAccepting] = useState(false);
  // Same tri-state convention as tncAcceptedAt, for the two follow-up
  // progressive-signup gates (details step, one-time intro).
  const [detailsCompletedAt, setDetailsCompletedAt] = useState(undefined);
  const [introSeenAt, setIntroSeenAt] = useState(undefined);
  const [introSaving, setIntroSaving] = useState(false);
  const [profileKycLevel, setProfileKycLevel] = useState(null);
  // Worker reopening just the KYC-upload part of the details modal later,
  // via the Profile-tab "complete verification" banner.
  const [kycUploadOpen, setKycUploadOpen] = useState(false);
  // The currently-mounted portal assigns a function here that closes its
  // topmost open detail view/modal (returns true if it handled the back
  // gesture) — consumed by BackGestureManager's popstate listener.
  const backHandlerRef = useRef(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [supportChatOpen, setSupportChatOpen] = useState(false);
  const [issueReportOpen, setIssueReportOpen] = useState(false);
  const [authView, setAuthView] = useState("signin");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authForm, setAuthForm] = useState({
    fullName: "",
      countryCode: "MY",
    countryOfOrigin: "MY",
    phone: "",
    email: "",
    password: "",
    confirmPassword: "",
    accountRole: "worker",
    companyName: "",
    ssmNumber: "",
    identityType: "MyKad",
    idNumber: "",
    dateOfBirth: "",
    kycLevel: "Basic",
    address: "",
    kycFront: null,
    kycBack: null,
    selfie: null,
    supportingDoc: null,
    agreedToTnC: false,
  });
  const [viewport, setViewport] = useState({ width: typeof window !== "undefined" ? window.innerWidth : 0, height: typeof window !== "undefined" ? window.innerHeight : 0 });

  const openAuthModal = (view = "signin", accountRole = null) => {
    setAuthView(view);
    setAuthMessage("");
    if (accountRole) setAuthForm(prev => ({ ...prev, accountRole }));
    setAuthOpen(true);
  };

  const updateAuthField = (field, value) => {
    setAuthForm(prev => ({ ...prev, [field]: value }));
  };

  const authRedirectUrl = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : undefined;

  const handleSignIn = async (event) => {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email: authForm.email,
      password: authForm.password,
    });
    setAuthLoading(false);
    if (error) {
      setAuthMessage(error.message);
      return;
    }
    setAuthOpen(false);
    setAuthForm(prev => ({ ...prev, password: "" }));
  };

  const handleOAuth = async (provider) => {
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider, // 'google' | 'apple' | 'facebook'
      options: {
        redirectTo: authRedirectUrl,
        // Google silently reuses its own SSO cookie + prior consent and skips
        // the account picker, which reads as "sign-out did nothing" even
        // though the Supabase session was fully revoked. Force the picker so
        // sign-in visibly requires a fresh choice every time.
        ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : {}),
      },
    });
    // On success the browser is redirected to the provider; only errors return here.
    if (error) setAuthMessage(`${provider} sign-in unavailable: ${error.message}`);
  };

  const handleResetPassword = async (event) => {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(authForm.email, { redirectTo: authRedirectUrl });
    setAuthLoading(false);
    if (error) {
      setAuthMessage(error.message);
      return;
    }
    setAuthMessage("Password reset email sent. Check your inbox to continue.");
  };

  const handleRegister = async (event) => {
    event.preventDefault();
    if (authForm.password !== authForm.confirmPassword) {
      setAuthMessage("Passwords do not match.");
      return;
    }
    setAuthLoading(true);
    setAuthMessage("");
    const role = authForm.accountRole === "employer" ? "employer" : "worker";
    const isEmployer = role === "employer";
    // Progressive sign-up: workers give only email + password here; the rest
    // is collected post-signup by the DetailsGateModal (after the T&C gate).
    // Employers additionally declare company name + SSM number up front —
    // submitting an SSM auto-queues the profile as pending_review via the DB
    // trigger in 20260712b_employer_verification.sql (only an admin can set
    // 'verified'), and posting shifts is hard-gated on that verification.
    // Everything also rides in auth metadata so it survives the
    // email-confirmation flow, where no session exists yet and the profiles
    // upsert below never runs — the DetailsGateModal falls back to metadata
    // when it creates the profile row.
    const { data, error } = await supabase.auth.signUp({
      email: authForm.email,
      password: authForm.password,
      options: {
        emailRedirectTo: authRedirectUrl,
        data: {
          account_role: role,
          ...(isEmployer ? { company_name: authForm.companyName.trim(), ssm_number: authForm.ssmNumber.trim() } : {}),
        },
      },
    });
    if (error) {
      setAuthLoading(false);
      setAuthMessage(error.message);
      return;
    }
    logAnalyticsEvent('sign_up', { role }, data?.user?.id ?? null);

    const registeredUserId = data?.user?.id;
    const hasSession = Boolean(data?.session);
    if (registeredUserId && hasSession) {
      const { error: profileError } = await supabase.from("profiles").upsert(
        {
          id: registeredUserId,
          role,
          ...(isEmployer ? { full_name: authForm.companyName.trim(), ssm_number: authForm.ssmNumber.trim() } : {}),
        },
        { onConflict: "id" }
      );
      if (profileError) setAuthMessage(profileError.message);
    } else {
      setAuthMessage("Registration submitted. Check your email to confirm your account, then sign in.");
    }

    setAuthLoading(false);
    setAuthForm(prev => ({ ...prev, password: "", confirmPassword: "" }));
    if (hasSession) setAuthOpen(false);
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;
      setUser(data?.user ?? null);
      setAuthResolved(true);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthResolved(true);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  // Portal addresses are now typeable, so a signed-out visitor can land
  // straight on /CariGaji/employer -- which renders an Employer Console whose
  // every query short-circuits on !user, i.e. a convincing but permanently
  // empty dashboard with no way in. Send them to the worker landing page,
  // which has the actual sign-in / "Post a shift" entry points.
  //
  // Gated on authResolved because `user` is null during session restore too:
  // firing on that would bounce a signed-in employer off their own console on
  // every refresh. /admin needs no equivalent -- AdminAccessRequired already
  // covers both the signed-out and wrong-role cases.
  useEffect(() => {
    if (authResolved && !user && portal === "employer") {
      stashReturnTo(window.location.pathname);
      setPortal("worker", { replace: true });
    }
  }, [authResolved, user, portal, setPortal]);

  // Basic analytics: one page_view per app mount.
  useEffect(() => {
    logAnalyticsEvent('page_view');
  }, []);

  const refreshUser = async () => {
    const { data } = await supabase.auth.getUser();
    setUser(data?.user ?? null);
  };

  // Fetch the account's stored role and default the portal accordingly on
  // sign-in: employer accounts land in the Employer Console, admins in the
  // Admin Dashboard, everyone else in the Worker app. Console access below
  // (Settings buttons) is gated on this same role.
  useEffect(() => {
    if (!user) { setUserRole(null); setTncAcceptedAt(undefined); setDetailsCompletedAt(undefined); setIntroSeenAt(undefined); setProfileKycLevel(null); return; }
    let active = true;
    supabase.from('profiles').select('role, tnc_accepted_at, full_name, details_completed_at, intro_seen_at, kyc_level, avatar_url').eq('id', user.id).maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        // Email-confirmation signups have no profiles row until the details
        // gate creates one — the role chosen at registration rides along in
        // auth metadata as the fallback.
        const role = data?.role ?? user.user_metadata?.account_role ?? 'worker';
        setUserRole(role);
        // No profiles row at all (fresh OAuth signup, which never creates
        // one) counts the same as "hasn't accepted" — null, not undefined —
        // so the mandatory T&C gate below still fires for them.
        setTncAcceptedAt(data?.tnc_accepted_at ?? null);
        setDetailsCompletedAt(data?.details_completed_at ?? null);
        setIntroSeenAt(data?.intro_seen_at ?? null);
        setProfileKycLevel(data?.kyc_level ?? null);
        // Role-based landing portal. Guarded on "which account was last
        // routed" rather than firing on every profile load: without this it
        // re-ran on each fetch and would now yank the URL back, fighting the
        // browser's own Back/Forward. Keyed on user id (not a one-shot flag)
        // so signing out and back in as a different role still redirects.
        // replace:true — an automatic redirect the user never chose shouldn't
        // leave a history entry that Back bounces off.
        const isAdminAccount = user?.app_metadata?.role === 'admin';
        if (lastRoutedUserIdRef.current !== user.id) {
          lastRoutedUserIdRef.current = user.id;
          // Do NOT clobber a deep link. Someone arriving on /bm/shift/<id> was
          // sent that exact shift; rewriting them to the portal root loses it
          // and they land on a feed wondering what they were shown. The portal
          // is still selected below -- only the ADDRESS is left alone, and
          // WorkerPortal re-asserts it once the shift loads.
          const onShiftLink = Boolean(shiftIdFromPath(window.location.pathname));

          // Where to land, in order of authority:
          //   1. an explicit portal in the URL  -- /en/admin, /en/employer,
          //      or any worker page past the front door (/en/my-shifts,
          //      /en/shift/<id>)
          //   2. the portal this tab was last in -- survives a refresh
          //   3. the account's role default      -- first visit in a new tab
          //
          // Rule 2 is the fix. This block runs on EVERY session restore, not
          // only on sign-in, so it used to fire on refresh too and send an
          // admin straight back to /admin however deep into worker view they
          // were. The role default is right for someone arriving fresh and
          // wrong for someone resuming; the remembered portal is what tells
          // those two apart, since the bare worker address (/en) cannot.
          //
          // An inner worker page CAN: an admin who follows /en/my-shifts and
          // signs in (which comes back to that same address) asked for that
          // page, and a signed-out visit has no remembered portal to say so.
          const urlPortal = portalFromPath(window.location.pathname);
          const workerRoute = parseWorkerRoute(portalRouteSegments(window.location.pathname, 'worker'));
          const explicitInUrl = urlPortal === 'admin' || urlPortal === 'employer'
            || (urlPortal === 'worker' && (Boolean(workerRoute.shiftId) || workerRoute.tab !== 'discover'));
          const roleDefault = isAdminAccount ? 'admin' : role === 'employer' ? 'employer' : 'worker';
          const target = explicitInUrl ? urlPortal : (readRememberedPortal() || roleDefault);

          // Unchanged from before: a shift deep link keeps its address, so the
          // link someone shared still points at the shift after it opens.
          const returnTo = takeReturnTo();
          if (returnTo && target !== 'worker' && portalFromPath(returnTo) === target) {
            // Signed in as the right kind of account after following a deep
            // link: restore the address BEFORE the portal mounts, because the
            // portal seeds its page from the address at mount.
            window.history.replaceState(window.history.state, "", returnTo);
            rememberPortal(target);
            setPortalState(target);
          } else if (target === 'worker' && onShiftLink) setPortalState('worker');
          else setPortal(target, { replace: true });
        }

        // Self-heal missing names: OAuth sign-up (Google/Apple/Facebook)
        // never writes to `profiles` at all — the only place a profiles row
        // has ever gotten `full_name` is the email/password registration
        // form's upsert. Any account that signed up via OAuth (or otherwise
        // ended up with a bare row) shows as generic "Worker" everywhere,
        // including the employer's applicant pool. Backfill it here from
        // the auth-provider metadata, using the same fallback chain already
        // used elsewhere in this file for the user's own display name.
        if (!data?.full_name) {
          const metaName = user.user_metadata?.full_name || user.user_metadata?.name;
          if (metaName) {
            supabase.from('profiles').upsert({ id: user.id, full_name: metaName }, { onConflict: 'id' });
          }
        }

        // Same story for the photo, and the same blast radius: Google and
        // Facebook hand us a picture URL at sign-in, but it lands only in
        // auth metadata, which no other user can read. `profiles.avatar_url`
        // is the ONLY avatar source anyone else sees, so an OAuth account
        // shows its photo to itself and initials to everybody else until
        // this mirrors it across. (Google puts it in avatar_url, Facebook in
        // picture; both are absolute https URLs, which getAvatarUrl passes
        // through untouched rather than treating as a storage path.)
        if (!data?.avatar_url) {
          const metaAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture;
          if (metaAvatar) {
            supabase.from('profiles').upsert({ id: user.id, avatar_url: metaAvatar }, { onConflict: 'id' });
          }
        }
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Upsert (not update) — a fresh OAuth signup may not have a profiles row
  // at all yet, since nothing currently creates one for OAuth users.
  const acceptTnC = async () => {
    if (!user) return;
    setTncAccepting(true);
    const acceptedAt = new Date().toISOString();
    const { error } = await supabase.from('profiles').upsert({ id: user.id, tnc_accepted_at: acceptedAt });
    setTncAccepting(false);
    if (!error) setTncAcceptedAt(acceptedAt);
  };

  const markIntroSeen = async () => {
    if (!user) return;
    setIntroSaving(true);
    const seenAt = new Date().toISOString();
    const { error } = await supabase.from('profiles').upsert({ id: user.id, intro_seen_at: seenAt });
    setIntroSaving(false);
    if (!error) setIntroSeenAt(seenAt);
  };

  useEffect(() => {
    const handleResize = () => {
      // Prefer visualViewport when available: in an installed iOS standalone
      // PWA, dismissing the on-screen keyboard (e.g. right after login)
      // does not reliably fire a plain `window` resize event, and 100dvh
      // has a known WebKit bug where it stays pinned to the keyboard-open
      // height afterwards — leaving the bottom nav pushed off-screen until
      // something else forces a relayout (hence "restart the app" fixing it).
      const vv = window.visualViewport;
      setViewport({
        width: vv ? vv.width : window.innerWidth,
        height: vv ? vv.height : window.innerHeight,
      });
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }
    return () => {
      window.removeEventListener("resize", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
    };
  }, []);

  const isMobile = viewport.width < MOBILE_BREAKPOINT;

  const portalConfig = {
    worker: { label: "Worker", color: BRAND.primary, width: 390, height: 780 },
    employer: { label: "Employer", color: BRAND.blue, width: 960, height: 640 },
    admin: { label: "Admin", color: BRAND.accent, width: 960, height: 640 },
  };
  const cfg = portalConfig[portal];
  const isAdmin = user?.app_metadata?.role === "admin";
  const resolvedTheme = resolveThemeMode(themePreference, systemTheme);
  const themeVars = buildThemeVars(resolvedTheme);

  useEffect(() => {
    writeThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    applyThemeToDocument(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    handleChange(mediaQuery);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return (
    <LanguageProvider>
    <ToastProvider>
    <div style={{
      // Use dynamic viewport height so the shell exactly fills the visible
      // area on mobile. Mixing minHeight:100vh here made the container taller
      // than the screen (100vh counts space behind the browser/system bars),
      // pushing the sticky bottom nav below the fold. On mobile we pin to the
      // JS-measured visualViewport height instead of trusting 100dvh alone —
      // installed iOS standalone PWAs have a WebKit bug where 100dvh can get
      // stuck at the on-screen-keyboard-open height after the keyboard closes
      // (e.g. right after a login form submit), leaving the bottom nav
      // pushed off-screen until the app is force-restarted.
      height: isMobile && viewport.height ? `${viewport.height}px` : "100dvh",
      minHeight: isMobile && viewport.height ? `${viewport.height}px` : "100dvh",
      width: "100%",
      ...themeVars,
      background: isMobile
        ? `linear-gradient(180deg, ${BRAND.primary}08 0%, ${BRAND.page} 18%, ${BRAND.page} 100%)`
        : `radial-gradient(circle at top, ${BRAND.primary}20 0%, ${resolvedTheme === "dark" ? "#09111d" : "#f8fafc"} 42%, ${resolvedTheme === "dark" ? BRAND.dark : BRAND.page} 100%)`,
      display: "flex",
      alignItems: "stretch",
      justifyContent: "stretch",
      padding: 0,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        width: "100%",
        height: "100%",
        minHeight: isMobile && viewport.height ? `${viewport.height}px` : "100dvh",
        background: isMobile ? BRAND.surface : BRAND.panel,
        borderRadius: 0,
        overflow: "hidden",
        border: "none",
        boxShadow: "none",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flex: 1,
      }}>
        <div style={{
          height: isMobile ? 56 : 68,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "0 16px" : "0 24px",
          borderBottom: `1px solid ${BRAND.border}`,
          background: BRAND.panel,
          backdropFilter: "blur(16px)",
          flexShrink: 0,
          // backdropFilter creates its own stacking context, which traps the
          // NotificationBell dropdown's z-index inside the header — without
          // an explicit position + z-index here, the desktop top nav bar
          // (WorkerPortal, z-index 20, a sibling stacking context) always
          // paints on top of it, partially covering the dropdown.
          position: "relative",
          zIndex: 30,
        }}>
          <AppBrandHeader onClick={() => { setPortal("worker"); setHomeSignal(s => s + 1); }} isMobile={isMobile} />
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 12, minWidth: 0 }}>
            {!isMobile && user && (
              <Badge color={portal === "worker" ? "green" : portal === "employer" ? "blue" : "amber"}>
                {cfg.label}
              </Badge>
            )}
            {/* Swapped with the theme toggle (owner, 2026-08-29): language is the
                control a first-time visitor needs BEFORE they can read their way to
                Settings, so it belongs on the header. Theme is a preference you set
                once, so it moved into Settings > Account. */}
            <LanguagePicker isMobile={isMobile} />
            {user && <NotificationBell user={user} onNavigate={handleNotificationNavigate} />}
            {user ? (
              <ProfileMenu
                user={user}
                onSignOut={async () => { await disablePushNotifications(); await supabase.auth.signOut(); setUser(null); lastRoutedUserIdRef.current = null; forgetRememberedPortal(); setPortal("worker"); }}
                onOpenIssueReport={() => setIssueReportOpen(true)}
                onOpenSupportChat={() => setSupportChatOpen(true)}
                isMobile={isMobile}
              />
            ) : (
              <HeaderSignInButton onClick={() => openAuthModal("signin")} />
            )}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {portal === "worker" && <WorkerPortal onOpenPortal={setPortal} isMobile={isMobile} user={user} userRole={userRole} themePreference={themePreference} setThemePreference={setThemePreference} onRequireAuth={openAuthModal} onUserUpdated={refreshUser} homeSignal={homeSignal} kycLevel={profileKycLevel} onOpenKycUpload={() => setKycUploadOpen(true)} backHandlerRef={backHandlerRef} deepLinkShift={portal === "worker" ? notifDeepLink : null} linkShiftId={portal === "worker" ? linkShiftId : null} onOpenSupportChat={() => setSupportChatOpen(true)} onOpenIssueReport={() => setIssueReportOpen(true)} />}
          {portal === "employer" && <Suspense fallback={<PortalLoading />}><EmployerPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} onUserUpdated={refreshUser} backHandlerRef={backHandlerRef} deepLinkShift={portal === "employer" ? notifDeepLink : null} onOpenSupportChat={() => setSupportChatOpen(true)} onOpenIssueReport={() => setIssueReportOpen(true)} /></Suspense>}
          {portal === "admin" && (
            isAdmin
              ? <Suspense fallback={<PortalLoading />}><AdminPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} /></Suspense>
              // While the session is still being restored `user` is null, so
              // a signed-in admin reloading /admin briefly saw "Admin access
              // required" and a Sign in button. Wait for auth to settle first.
              : !authResolved
                ? <PortalLoading />
                : <AdminAccessRequired user={user} onBack={() => setPortal("worker")} />
          )}
        </div>
      </div>
      <AuthModal
        open={authOpen}
        view={authView}
        form={authForm}
        loading={authLoading}
        message={authMessage}
        onClose={() => setAuthOpen(false)}
        onViewChange={view => {
          setAuthView(view);
          setAuthMessage("");
        }}
        onChange={updateAuthField}
        onSignIn={handleSignIn}
        onRegister={handleRegister}
        onResetPassword={handleResetPassword}
        onOAuth={handleOAuth}
      />
      <SupportChatWidget isMobile={isMobile} open={supportChatOpen} onOpenChange={setSupportChatOpen} />
      <IssueReportModal
        open={issueReportOpen}
        onClose={() => setIssueReportOpen(false)}
        user={user}
        userRole={userRole}
        /* Which portal + address they were on when it broke -- the single most
           useful thing for reproducing a report, and the thing a reporter is
           least likely to think to mention. */
        pageContext={`${portal} · ${typeof window !== "undefined" ? window.location.pathname : ""}`}
      />
      <CookieConsentManager isMobile={isMobile} />
      <TnCGateModal
        open={Boolean(user) && tncAcceptedAt === null}
        accepting={tncAccepting}
        onAccept={acceptTnC}
        onSignOut={async () => { await disablePushNotifications(); await supabase.auth.signOut(); setUser(null); lastRoutedUserIdRef.current = null; forgetRememberedPortal(); setPortal("worker"); }}
                onOpenIssueReport={() => setIssueReportOpen(true)}
      />
      {/* Progressive-signup sequence: T&C gate above, then required details,
          then the one-time intro. The gate conditions are mutually exclusive
          by construction (each requires the previous timestamp to be set). */}
      <DetailsGateModal
        open={Boolean(user) && typeof tncAcceptedAt === "string" && detailsCompletedAt === null}
        user={user}
        role={userRole}
        onCompleted={ts => setDetailsCompletedAt(ts)}
        onSignOut={async () => { await disablePushNotifications(); await supabase.auth.signOut(); setUser(null); lastRoutedUserIdRef.current = null; forgetRememberedPortal(); setPortal("worker"); }}
                onOpenIssueReport={() => setIssueReportOpen(true)}
      />
      <DetailsGateModal
        open={kycUploadOpen && Boolean(user)}
        user={user}
        role={userRole}
        kycOnly
        onClose={() => { setKycUploadOpen(false); setProfileKycLevel("pending_review"); }}
      />
      <WelcomeIntroModal
        open={Boolean(user) && typeof tncAcceptedAt === "string" && typeof detailsCompletedAt === "string" && introSeenAt === null}
        role={userRole}
        saving={introSaving}
        onDone={markIntroSeen}
      />
      <BackGestureManager
        enabled={isMobile}
        backHandlerRef={backHandlerRef}
        authOpen={authOpen}
        onCloseAuth={() => setAuthOpen(false)}
      />
    </div>
    </ToastProvider>
    </LanguageProvider>
  );
}

// Last statement on purpose: initialLanguage() reads route helpers declared far above,
// so it can only run once the whole module has been evaluated. Starting the request
// here, not when the provider mounts, overlaps it with the rest of app start-up.
if (typeof window !== "undefined") loadLanguage(initialLanguage());

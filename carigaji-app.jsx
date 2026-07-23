import { useState, useEffect, useRef, useMemo, useCallback, useContext, createContext, memo } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./src/lib/supabase.js";
import { runInternalPayoutScheduling } from "./src/lib/payouts/scheduler.js";
import { applyThemeToDocument, buildThemeVars, cycleThemePreference, getSystemTheme, readThemePreference, resolveThemeMode, writeThemePreference } from "./src/lib/theme.js";

// ─── Malaysia-pinned date/time formatting ────────────────────────────────────
// Shifts happen at a physical location in Malaysia, so their start/end times
// and offer deadlines must always read in Malaysia time regardless of the
// viewer's device timezone — otherwise a worker or employer outside MYT sees
// the wrong shift time. Chat timestamps etc. are intentionally left on the
// viewer's local timezone (that's the correct behavior for "when did I see
// this"), so only shift-time-critical call sites use these.
const MY_TIMEZONE = "Asia/Kuala_Lumpur";
const formatShiftTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", timeZone: MY_TIMEZONE }) : "";
const formatShiftDate = (iso, opts = {}) => iso ? new Date(iso).toLocaleDateString("en-MY", { ...opts, timeZone: MY_TIMEZONE }) : "";
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
const totalOccurrenceHours = (occurrences) => (occurrences ?? []).reduce((sum, occ) => sum + occurrenceHours(occ), 0);

// Formats a date+time-range for a single day, in the same style as the
// existing formatShiftTime/formatShiftDate helpers, but from plain
// "YYYY-MM-DD"/"HH:MM" strings (no timezone conversion needed — these are
// already the Malaysia-local wall-clock values entered/stored).
const formatOccurrenceLine = (occ, opts = { day: 'numeric', month: 'short' }) => {
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
const formatOccurrencesSummary = (occurrences) => {
  const list = occurrences ?? [];
  if (list.length === 0) return '';
  if (list.length === 1) return formatOccurrenceLine(list[0]);
  return `${list.length} days: ${list.map(o => formatOccurrenceLine(o, { day: 'numeric', month: 'short' })).join(', ')}`;
};

// Validates the Post Shift wizard's occurrence rows before advancing past
// step 1. Returns a reason code (mapped to a translated toast message by the
// caller) or null when everything checks out.
const validateOccurrences = (occurrences) => {
  if (!occurrences || occurrences.length === 0) return 'empty';
  const todayStr = new Date().toISOString().slice(0, 10);
  const seenDates = new Set();
  for (const occ of occurrences) {
    if (!occ.date || !occ.start || !occ.end) return 'incomplete';
    if (occ.date < todayStr) return 'pastDate';
    if (seenDates.has(occ.date)) return 'duplicateDate';
    seenDates.add(occ.date);
  }
  return null;
};

// ─── Basic analytics ─────────────────────────────────────────────────────────
// Fire-and-forget event logging (see supabase/migrations/20260720_analytics_events.sql).
// Never awaited by callers and never throws — a missing migration, RLS
// denial, or network blip must not block or break any UI flow.
const logAnalyticsEvent = (eventType, metadata = {}, userId = null) => {
  try {
    supabase.from('analytics_events').insert({ event_type: eventType, metadata, user_id: userId }).then(() => {}, () => {});
  } catch {
    // Swallow — analytics must never break the app.
  }
};

// ─── Shift categories ────────────────────────────────────────────────────────
// Kept in sync with the shifts_category_check DB constraint (see
// supabase/migrations/20260705g_widen_shift_categories.sql).
const SHIFT_CATEGORIES = ["F&B", "Retail", "Event", "Promotion", "Warehouse", "Office", "Security", "Production", "Market Research", "Student", "Logistics", "Other"];

// ─── Shift language requirements ─────────────────────────────────────────────
// Kept in sync with the shifts_language_requirements_check DB constraint (see
// supabase/migrations/20260711_shift_language_requirements.sql).
const SHIFT_LANGUAGES = ["Bahasa Melayu", "English", "Mandarin", "Tamil", "Other"];

// ─── Bulk shift upload (CSV) ─────────────────────────────────────────────────
// Normalized header (lowercase, trimmed, stripped to [a-z0-9]) → form field.
// Used to fuzzy-match whatever column names an employer's spreadsheet has.
const BULK_UPLOAD_FIELD_SYNONYMS = {
  title: "title", jobtitle: "title", shifttitle: "title",
  description: "description", jobdescription: "description", desc: "description",
  category: "category",
  location: "location", address: "location",
  dresscode: "dress", dress: "dress",
  date: "date",
  starttime: "timeStart", start: "timeStart",
  endtime: "timeEnd", end: "timeEnd",
  minwage: "wageMin", wagemin: "wageMin",
  maxwage: "wageMax", wagemax: "wageMax",
  headcount: "headcount", positions: "headcount", numberofworkers: "headcount",
  transportallowance: "transportAllowance",
};
const BULK_UPLOAD_MANDATORY_FIELDS = ["title", "date", "timeStart", "timeEnd"];
const BULK_UPLOAD_MAX_ROWS = 200;
const BULK_UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB cap

const normalizeBulkHeader = (h) => String(h ?? "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");

// Minimal RFC4180-ish CSV parser: handles quoted fields containing commas,
// newlines, and escaped ("") quotes. Returns an array of string-cell rows.
const parseCSVText = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") { continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
};

// Quotes a CSV field only when needed, doubling embedded quotes.
const csvEscapeField = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const serializeCSV = (rows) => rows.map(r => r.map(csvEscapeField).join(",")).join("\r\n");

// Anti-CSV-injection: if a free-text value starts with a character a
// spreadsheet app would interpret as a formula trigger, prefix it with an
// apostrophe so it's stored/re-exported as inert text.
const sanitizeBulkTextValue = (v) => {
  const trimmed = String(v ?? "").trim();
  return /^[=+\-@\t\r]/.test(trimmed) ? `'${trimmed}` : trimmed;
};

// Reverses sanitizeBulkTextValue's protective apostrophe for display purposes.
const displayProtectedText = (v) => {
  const s = String(v ?? "");
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
};

// Row-level readiness check, shared between initial parse and inline edits.
const evaluateBulkRowStatus = (row) => {
  const problems = [];
  if (!row.title || !row.title.trim()) problems.push("title");
  if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date.trim())) problems.push("date");
  if (!row.timeStart || !/^\d{2}:\d{2}$/.test(row.timeStart.trim())) problems.push("timeStart");
  if (!row.timeEnd || !/^\d{2}:\d{2}$/.test(row.timeEnd.trim())) problems.push("timeEnd");
  if (!row.category) problems.push("category");
  const wageMinNum = parseFloat(row.wageMin);
  const wageMaxNum = parseFloat(row.wageMax);
  if (row.wageMin !== "" && row.wageMax !== "" && !isNaN(wageMinNum) && !isNaN(wageMaxNum) && wageMaxNum < wageMinNum) {
    problems.push("wage");
  }
  return problems.length > 0 ? "needs_fix" : "ready";
};

// Parses an uploaded bulk-shift CSV into draft row objects, or returns
// { fatalError } if the file can't be used at all (missing mandatory
// columns, too many rows, no data rows).
const parseBulkShiftCSV = (text) => {
  const rows = parseCSVText(text).filter(r => r.some(c => c.trim() !== ""));
  if (rows.length === 0) return { fatalError: "The file is empty." };
  const [headerRow, ...dataRows] = rows;
  const normalizedHeaders = headerRow.map(normalizeBulkHeader);
  const fieldToCol = {};
  normalizedHeaders.forEach((h, i) => {
    const field = BULK_UPLOAD_FIELD_SYNONYMS[h];
    if (field && fieldToCol[field] === undefined) fieldToCol[field] = i;
  });
  const missingCols = BULK_UPLOAD_MANDATORY_FIELDS.filter(f => fieldToCol[f] === undefined);
  if (missingCols.length > 0) {
    return { fatalError: `Missing required column(s): ${missingCols.join(", ")}. Download the template for the exact format.` };
  }
  if (dataRows.length === 0) return { fatalError: "No data rows found in the file." };
  if (dataRows.length > BULK_UPLOAD_MAX_ROWS) {
    return { fatalError: `Too many rows (${dataRows.length}). The bulk uploader supports up to ${BULK_UPLOAD_MAX_ROWS} shifts per file.` };
  }
  const draftRows = dataRows.map((cells, idx) => {
    const get = (field) => { const c = fieldToCol[field]; return c !== undefined ? (cells[c] ?? "") : ""; };
    const rawCategory = get("category").trim();
    const matchedCategory = SHIFT_CATEGORIES.find(c => c.toLowerCase() === rawCategory.toLowerCase()) || "";
    const row = {
      _rowNum: idx + 1,
      _error: null,
      title: sanitizeBulkTextValue(get("title")),
      description: sanitizeBulkTextValue(get("description")),
      category: matchedCategory,
      location: sanitizeBulkTextValue(get("location")),
      dress: sanitizeBulkTextValue(get("dress")),
      date: get("date").trim(),
      timeStart: get("timeStart").trim(),
      timeEnd: get("timeEnd").trim(),
      wageMin: get("wageMin").trim(),
      wageMax: get("wageMax").trim(),
      headcount: get("headcount").trim() || "1",
      transportAllowance: get("transportAllowance").trim(),
    };
    row._status = evaluateBulkRowStatus(row);
    return row;
  });
  return { rows: draftRows };
};

const BULK_UPLOAD_TEMPLATE_HEADER = ["Title", "Description", "Category", "Location", "Dress Code", "Date", "Start Time", "End Time", "Min Wage", "Max Wage", "Headcount", "Transport Allowance"];
const BULK_UPLOAD_TEMPLATE_EXAMPLE = ["F&B Server – Corporate Dinner", "Serve drinks and canapés at a corporate dinner event.", "F&B", "KLCC, KL City Centre", "All black formal", "2026-08-15", "18:00", "23:00", "12", "16", "3", "10"];

const downloadBulkUploadTemplate = () => {
  const csv = serializeCSV([BULK_UPLOAD_TEMPLATE_HEADER, BULK_UPLOAD_TEMPLATE_EXAMPLE]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "carigaji-bulk-shift-template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ─── Design tokens ─────────────────────────────────────────────────────────
const BRAND = {
  primary: "#2563EB",
  primaryDark: "#1D4ED8",
  primaryLight: "#EFF4FF",
  primaryMid: "#BBD0FF",
  dark: "#0A1428",
  accent: "#0891B2",
  accentLight: "#E0F7FB",
  green: "#1A9E5C",
  greenLight: "#E8F7EF",
  blue: "#0284C7",
  blueLight: "#E0F2FE",
  amber: "#D97706",
  amberLight: "#FEF3C7",
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
  shadow: "var(--cg-shadow)",
  overlay: "var(--cg-overlay)",
};

// ─── i18n dictionary (v1 foundation — core strings only, not exhaustive) ────
const TRANSLATIONS = {
  en: {
    "nav.discover": "Discover",
    "nav.myBids": "My Bids",
    "nav.chat": "Chat",
    "nav.earnings": "Earnings",
    "nav.profile": "Profile",
    "nav.settings": "Settings",
    "settings.title": "Settings",
    "settings.subtitle": "Manage your account and access hidden consoles",
    "settings.account": "Account",
    "settings.language": "Language",
    "settings.languageEnglish": "English",
    "settings.languageBM": "Bahasa Melayu",
    "settings.notifications": "Notifications",
    "settings.notificationsValue": "Enabled",
    "settings.privacy": "Privacy",
    "settings.privacyValue": "Standard worker mode",
    "common.signIn": "Sign in",
    "common.signUp": "Sign up",
    "common.createAccount": "Create account",
    "common.postAShift": "Post a Shift",
    "common.accept": "Accept",
    "common.reject": "Reject",
    "common.submitBid": "Submit Bid →",
    "common.placeBid": "Place Bid →",
    "common.signInToBid": "Sign in to bid →",
    "toast.avatarUpdated": "Profile picture updated.",
    "toast.avatarUpdateFailed": "Could not update photo: ",
    "toast.sendFailed": "Failed to send: ",
    "toast.checkinSimulated": "Checked in at 18:02 · Reliability maintained (on time)",
    "toast.maxBidPrefix": "Max bid is RM",
    "toast.sampleShiftBidInfo": "This is a sample shift. Apply to a live shift to submit a bid.",
    "toast.applicationFailed": "Failed to submit application: ",
    "toast.signFailed": "Failed to sign: ",
    "toast.contractSigned": "✅ Contract signed! You can now chat with your employer.",
    "toast.cancellationContractSigned": "✅ Cancellation contract signed — your 50% payout is on its way.",
    "toast.showUpProofSubmitted": "✅ Proof submitted — your full payout is on its way.",
    "toast.showUpProofFailed": "Failed to submit proof: ",
    "toast.updateFailed": "Update failed: ",
    "toast.escrowTopupUnavailable": "Adding funds isn’t available yet — coming with FPX/DuitNow integration.",
    "toast.signInToPostShift": "Sign in to post a shift.",
    "toast.shiftFieldsRequired": "Title, date, and start/end times are required.",
    "toast.scheduleDatePast": "Every scheduled day must be today or later.",
    "toast.scheduleDuplicateDate": "Each day can only be added once — remove the duplicate date.",
    "toast.maxPayGteMinPay": "Max pay must be ≥ min pay.",
    "toast.postShiftFailed": "Failed to post shift: ",
    "toast.shiftPublished": "Shift published! Workers will start applying shortly.",
    "toast.contractSent": "✅ Contract sent to worker for signature!",
    "chat.signInTitle": "Sign in to view messages",
    "chat.signInHint": "Messages with employers appear here once you're signed in and have an accepted bid.",
    "chat.title": "Messages",
    "chat.emptyTitleWorker": "No accepted shifts yet.",
    "chat.emptyHintWorker": "Messages appear here once an employer accepts your bid.",
    "chat.emptyTitleEmployer": "No accepted applications yet.",
    "chat.emptyHintEmployer": "Chats appear here once you accept a worker's bid.",
    "chat.employerSubtitle": "Chat with workers on accepted shifts",
    "chat.loading": "Loading...",
    "chat.inputPlaceholder": "Type a message…",
    "chat.send": "Send",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.pluralSuffix": "s",
    "shiftDetail.placeBidTitle": "Place Your Bid",
    "shiftDetail.employerRange": "Employer range: RM",
    "shiftDetail.maxBid": " · Max bid: RM",
    "shiftDetail.wageAskLabel": "Your wage ask (RM/hour)",
    "shiftDetail.estimatedTotalPay": "Estimated total pay",
    "shiftDetail.transportAllowanceSuffix": " transport allowance",
    "shiftDetail.bidSubmitted": "Bid Submitted!",
    "shiftDetail.bidSubmittedHint": "You'll be notified when shortlisted",
    "shiftDetail.positions": "Positions",
    "shiftDetail.applied": "Applied",
    "shiftDetail.wageRange": "Wage Range",
    "shiftDetail.perHour": "per hour",
    "shiftDetail.shiftDuration": "Shift Duration",
    "shiftDetail.daysCount": "{count} days",
    "shiftDetail.estimatedGross": "Estimated Gross",
    "shiftDetail.atMaxRate": "at max rate",
    "shiftDetail.transportAllowance": "Transport Allowance",
    "shiftDetail.title": "Shift Details",
    "shiftDetail.aboutRole": "About this role",
    "shiftDetail.location": "📍 Location",
    "shiftDetail.date": "🗓 Date",
    "shiftDetail.time": "⏰ Time",
    "shiftDetail.dressCode": "👗 Dress Code",
    "shiftDetail.languagesRequired": "🗣️ Languages Required",
    "shiftDetail.headcount": "👥 Headcount",
    "shiftDetail.workersNeeded": "workers needed",
    "shiftDetail.employerScore": "🏢 Employer Score",
    "shiftDetail.employerScoreSignInToView": "Sign in to view this employer's reliability score.",
    "shiftDetail.locationNote": "Exact address revealed once your application is accepted.",
    "shiftDetail.employerReliability": "Employer Reliability",
    "shiftDetail.applicants": "applicants",
    "shiftDetail.notProvided": "Not provided",
    "shiftDetail.tba": "TBA",
    "shiftDetail.dressCodeNone": "None specified",
    "shiftDetail.notApplicable": "N/A",
    "shiftDetail.yourBid": "Your bid",
    "myBids.transportAllowanceRow": "🚌 Transport allowance",
    "myBids.employerRangeRow": "💰 Employer range",
    "myBids.shortlistedBanner": "🎉 You've been shortlisted! Open chat to discuss and receive your offer.",
    "myBids.loadingBids": "Loading your bids…",
    "myBids.noBidsYet": "No bids yet",
    "myBids.loadingBidsHint": "Hang tight while we fetch your bids.",
    "myBids.noBidsHint": "Head to Discover and place a bid on a shift to see it here.",
    "myBids.employerDecidesByPrefix": "⏳ Employer decides by ",
    "myBids.respondByPrefix": "🎉 Respond by ",
    "myBids.pillShiftCancelled": "Shift Cancelled",
    "myBids.pillConfirmNow": "Confirm now",
    "myBids.pillShortlisted": "Shortlisted",
    "myBids.pillAccepted": "Accepted",
    "myBids.pillOfferExpired": "Offer expired",
    "myBids.pillNotSelected": "Not selected",
    "myBids.pillPending": "Pending",
    "myBids.yourBidPrefix": "Your bid: ",
    "myBids.chatBtn": "Chat →",
    "worker.checkInBtn": "Check In",
    "myBids.signContractBtn": "✍️ Sign Contract",
    "myBids.contractSignedBadge": "✅ Contract signed",
    "myBids.shiftCancelledNotice": "This shift was cancelled by the employer. No further action is needed.",
    "myBids.lateCancellationTitle": "This shift was cancelled less than 24 hours before it started",
    "myBids.lateCancellationBody": "Choose to sign a 50% cancellation payout now, or show up in person and submit a photo for 100% of your agreed wage.",
    "myBids.cancellation50Btn": "Sign cancellation contract (50%)",
    "myBids.cancellationShowUpLabel": "Show up for full pay (100%)",
    "myBids.cancellationShowUpHint": "Take a photo of yourself at the shift location to claim full payout.",
    "myBids.cancellationProofUploading": "Uploading proof…",
    "myBids.cancellationChose50": "You chose the 50% cancellation payout. It's on its way.",
    "myBids.cancellationProofSubmitted": "Proof submitted — your full payout is on its way.",
    "myBids.cancellationAwaitingProof": "You chose to show up — take a photo at the location to claim your full payout.",
    "myBids.selectedNotice": "🎉 You've been selected! Confirm or decline before the deadline above — if you don't respond in time, the offer is automatically released back to the employer.",
    "myBids.offerExpiredNotice": "This offer expired because it wasn't confirmed in time.",
    "myBids.cancelling": "Cancelling…",
    "myBids.cancelBidBtn": "Cancel Bid",
    "myBids.declineBtn": "Decline",
    "myBids.confirmShiftBtn": "Confirm Shift",
    "myBids.fileDisputeBtn": "File a Dispute",
    "myBids.fileDisputeTitle": "File a Dispute",
    "myBids.disputeCategoryLabel": "What's the issue?",
    "myBids.disputeDescriptionLabel": "Describe what happened",
    "myBids.disputeSubmitBtn": "Submit Dispute",
    "dispute.categoryHoursDisputed": "Hours disputed",
    "dispute.categoryNoShowClaim": "No-show claim",
    "dispute.categoryUnsafeConditions": "Unsafe working conditions",
    "dispute.categoryPaymentIssue": "Payment issue",
    "dispute.categoryOther": "Other",
    "admin.disputesEmptyState": "No disputes filed yet.",
    "admin.disputeResolve": "Resolve",
    "admin.disputeDismiss": "Dismiss",
    "admin.disputeResolved": "Dispute resolved.",
    "admin.disputeDismissed": "Dispute dismissed.",
    "admin.disputeResolveFailed": "Failed to resolve dispute: ",
    "admin.disputeDismissFailed": "Failed to dismiss dispute: ",
    "profile.signInTitle": "Sign in to view your profile",
    "profile.signInHint": "Your KYC status, reliability score, ratings, and shift history live here once you sign in.",
    "profile.changePhoto": "Change profile picture",
    "profile.standardKyc": "Standard KYC",
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
    "profile.verified": "✓ Verified",
    "profile.reliabilityScoreLabel": "Reliability Score: ",
    "profile.reliabilityExcellent": "Excellent — top 15% of workers 🏆",
    "profile.reliabilityGood": "Good standing — keep it up 👍",
    "profile.reliabilityBuilding": "Building your reputation 📈",
    "profile.reliabilityLow": "Complete more shifts to improve your score",
    "profile.recentRatings": "Recent Ratings",
    "profile.noRatingsTitle": "No ratings yet",
    "profile.noRatingsHint": "Ratings from employers will appear here after you complete shifts.",
    "auth.signinSubtitle": "Use your email and password to access CariGaji.",
    "auth.registerTitle": "Register",
    "auth.registerSubtitle": "Create your account and complete your profile and KYC details.",
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
    "auth.underageWarning": "You must be at least {age} years old to register and work on CariGaji.",
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
    "auth.ocrMatch": "✓ The identity number on your photo matches what you entered.",
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
    "employer.shiftsTitle": "Your Shifts",
    "employer.postShiftBtn": "+ Post Shift",
    "employer.listCardChatBtn": "Chat",
    "employer.editShift": "Edit shift",
    "employer.cancelShift": "Cancel shift",
    "employer.cancellingShift": "Cancelling…",
    "employer.applicantPool": "Applicant pool",
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
    "earnings.salaryPayout": "salary payout",
    "settings.salaryBankingTitle": "Salary Banking Details",
    "settings.salaryBankingHint": "Mid-month payouts require verified bank details via SecureSign.",
    "settings.bankLabel": "Bank",
    "settings.accountHolderName": "Account holder name",
    "settings.accountNumber": "Account number",
    "settings.status": "Status",
    "settings.saveBanking": "Save banking",
    "settings.verifySecureSign": "Verify via SecureSign (Demo)",
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
    "cookie.analyticsDesc": "Would help us understand usage and improve the app. Not currently active — off by default.",
    "cookie.servicesEssential": "Keeps you signed in via your Supabase authentication session, and stores basic session state needed for the app to function. These can't be switched off.",
    "cookie.servicesFunctional": "Stores your language choice (English/Bahasa Melayu, key \"carigaji_lang\") and your light/dark theme preference in your browser's local storage.",
    "cookie.servicesAnalytics": "No analytics or marketing tools are currently active in CariGaji. This category is reserved for future use (e.g. usage analytics) and will stay off until we actually add one — turning it on today has no effect.",
    "cookie.aboutBody": "CariGaji uses browser local storage — not third-party tracking cookies — to keep you signed in and to remember your preferences on this device. We don't use this data for tracking, and nothing here is shared with advertisers. See our Privacy Policy for the full details on what we collect and why, and our Terms of Service for how the platform works.",
    "cookie.savePreferences": "Save Preferences",
    "supportChat.title": "CariGaji Support",
    "supportChat.greeting": "Hi! I'm the CariGaji support assistant. Ask me anything about shifts, bidding, KYC, payments, or your account.",
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
    "account.referShareText": "Find or post flexible shift work in Malaysia with CariGaji:",
    "toast.inviteLinkCopied": "Invite link copied! Share it with friends.",
    "help.title": "Help Centre",
    "help.faqWorkQ": "How does CariGaji work?",
    "help.faqWorkA": "Employers post short shifts with a wage range. Workers browse open shifts and place a bid within the allowed range. If the employer accepts your bid, you both sign a contract in-app and the shift is confirmed.",
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
    "notification.markAllRead": "Mark all as read",
    "notification.empty": "No notifications yet",
    "notification.justNow": "Just now",
    "notification.minAgo": "{n}m ago",
    "notification.hourAgo": "{n}h ago",
    "notification.dayAgo": "{n}d ago",
    "discover.filtersLabel": "Filters",
    "discover.hideFiltersLabel": "Hide Filters",
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
    "discover.highBookingChance": "🔥 High booking chance",
    "discover.weekendsOnly": "📅 Weekends only",
    "discover.clearAll": "Clear all",
    "discover.loadingShifts": "Loading shifts…",
    "discover.loadingShiftsHint": "Hang tight while we fetch open shifts.",
    "discover.noShiftsMatch": "No shifts match right now",
    "discover.noShiftsMatchHint": "Try widening your filters, or check back soon — new shifts are posted regularly.",
    "worker.checkinTitle": "Check-in QR Scanner",
    "worker.checkinSubtitle": "Point your camera at the QR code at the venue entrance",
    "worker.cameraViewfinder": "Camera viewfinder",
    "worker.simulateCheckin": "Simulate Successful Check-in",
    "shiftDetail.rateHelperText": "Scroll to choose your rate",
    "myBids.signInTitle": "Sign in to view your bids",
    "myBids.signInHint": "Track the shifts you've applied to and their status once you're signed in.",
    "myBids.backToBids": "Back to My Bids",
    "earnings.signInTitle": "Sign in to view earnings",
    "earnings.signInHint": "Track your payouts, internal settlement status, and bank verification once you're signed in.",
    "toast.confirmOfferFailed": "Failed to confirm: ",
    "toast.shiftConfirmed": "Shift confirmed! Sign the contract to finish.",
    "toast.declineOfferFailed": "Failed to decline: ",
    "toast.offerDeclined": "Offer declined.",
    "toast.cancelBidFailed": "Failed to cancel bid: ",
    "toast.bidCancelled": "Bid cancelled.",
    "toast.disputeFiled": "Dispute filed. Our team will review it shortly.",
    "toast.disputeFiledFailed": "Failed to file dispute: ",
    "employer.fieldShiftTitle": "Shift title",
    "employer.shiftTitlePlaceholder": "e.g. F&B Server – Corporate Dinner",
    "employer.fieldJobDescription": "Job description",
    "employer.jobDescriptionPlaceholder": "Describe the role, responsibilities, and what a good day looks like…",
    "employer.labelCategory": "Category",
    "employer.labelLocation": "Location",
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
    "employer.bidCapHint": "Workers can bid up to RM{amount}/h (150% of max)",
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
    "employer.estimatedReserveFormula": "wage_max × headcount × shift hours + 15% platform fee",
    "employer.tagline": "Employer Console",
    "employer.openMenu": "Open menu",
    "employer.paidToWorkers": "Paid to Workers",
    "employer.topUpSoon": "Top Up (soon)",
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
    "employer.lateCancelWarningTitle": "⚠️ Late cancellation",
    "employer.lateCancelWarningBody": "This shift starts in less than 24 hours and has {count} confirmed worker(s). Cancelling now will offer each of them a choice: a 50% payout with no show-up, or the option to show up in person for 100% of their agreed wage.",
    "employer.lateCancelWarningConfirmBtn": "Cancel shift anyway",
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
    "employer.listCardEstBudget": "RM{amount} est. budget",
    "employer.statAvgBid": "Avg bid",
    "employer.positionsOpenHint": "{open} of {total} position{plural} still open.",
    "employer.appliedBadge": "{count} applied",
    "employer.selectMultiple": "Select multiple",
    "employer.selectedOfTotal": "{selected} / {total} selected",
    "employer.sendingOffer": "Sending…",
    "employer.offerToWorkers": "Offer to {count} worker{plural}",
    "employer.loadingApplicants": "Loading applicants…",
    "employer.loadingApplicantsHint": "Hang tight while we fetch applicants.",
    "employer.noApplicantsYet": "No applicants yet",
    "employer.noApplicantsHint": "Applicants will appear here once workers bid on this shift.",
    "employer.colWorker": "Worker",
    "employer.colKYC": "KYC",
    "employer.colReliability": "Reliability",
    "employer.colRating": "Rating",
    "employer.colBidRate": "Bid (RM/h)",
    "employer.colStatus": "Status",
    "employer.colAction": "Action",
    "employer.shiftsDoneSuffix": "shifts done",
    "employer.awaitingResponse": "Awaiting response",
    "employer.shortlistBtn": "Shortlist",
    "employer.selectBtn": "Select",
    "employer.waitingOnWorker": "⏳ Waiting on worker",
    "employer.confirmedStatus": "✓ Confirmed",
    "employer.notSelected": "✗ Not selected",
    "employer.offerExpiredStatus": "⏱ Offer expired",
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
    "employer.viewContractBtn": "View contract",
    "employer.viewWorkerProfileHint": "View worker profile",
    "employer.contractSignaturesHeading": "Signatures",
    "employer.contractSignedOnPrefix": "signed on ",
    "employer.contractNotSignedYet": "not signed yet",
    "employer.contractAwaitingWorker": "The worker has not signed this contract yet.",
    "employer.profileHistoryTitle": "History with your company",
    "employer.profileNoHistory": "No previous applications to your shifts.",
    "employer.historyCompleted": "completed",
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
    "employer.ssmCertOnFile": "✓ Certificate on file — uploading a new one replaces it for review.",
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
    "employer.verificationLabel": "Verification",
    "employer.outgoingObligationsTitle": "Outgoing Salary Obligations",
    "employer.noPayoutObligations": "No payout obligations yet for this employer account.",
    "employer.savedAccountPrefix": "Saved account: ••••",
    "employer.tbaShort": "TBA",
    "employer.pendingPayout": "Pending payout",
    "employer.totalPaidOut": "Total paid out",
    "employer.escrowUnavailableNote": "Adding funds isn't available yet — this is a preview until a real payment gateway (FPX/DuitNow) is integrated.",
    "employer.addFundsSoon": "+ Add Funds (soon)",
    "employer.payoutLedgerTitle": "Payout Ledger",
    "employer.colDateShort": "Date",
    "employer.colAmount": "Amount",
    "auth.oauthDivider": "or",
    "auth.oauthConnector": "{label} with {provider}",
    "auth.iWantTo": "I want to…",
    "auth.roleWorkerTitle": "Find shift work",
    "auth.roleWorkerHint": "Browse and bid on shifts",
    "auth.roleEmployerTitle": "Hire workers",
    "auth.roleEmployerHint": "Post shifts and manage applicants",
    "auth.socialSignupHint": "Signing up with Google, Apple, or Facebook creates your account instantly. You'll be asked to complete identity (KYC) verification afterwards to start working.",
    "auth.tncAgreeText": "I have read and agree to the",
    "auth.tncLinkText": "Terms & Conditions and Privacy Notice",
    "auth.tncSuffixText": ", including the collection and use of my identity document (MyKad/passport) for employment verification purposes.",
    "auth.tncScrollHint": "Open and scroll the Terms & Conditions to the end to enable this checkbox.",
    "auth.tncGateTitle": "Before you continue",
    "auth.tncGateSubtitle": "Please read and accept our Terms & Conditions and Privacy Notice to keep using CariGaji.",
    "auth.tncGateAcceptBtn": "I agree — Continue",
    "auth.quickSignupHint": "That's all we need to get started — we'll ask for your name and other details right after you sign up.",
    "details.title": "Complete your details",
    "details.subtitleWorker": "Just a few details before you can start bidding on shifts. This is required to work legally under Malaysian law.",
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
    "intro.title": "Welcome to CariGaji!",
    "intro.subtitle": "Here's how it works:",
    "intro.workerStep1": "Browse open shifts on the Discover tab — filter by category, date, and pay.",
    "intro.workerStep2": "Place a bid with your hourly rate on shifts you want.",
    "intro.workerStep3": "If the employer selects you, confirm the offer and sign the digital contract.",
    "intro.workerStep4": "Show up, work the shift, and track your earnings in the Earnings tab.",
    "intro.employerStep1": "Post a shift with the role, schedule, and wage range.",
    "intro.employerStep2": "Review the applicant pool as workers bid — see their ratings and reliability.",
    "intro.employerStep3": "Select your workers; they confirm and sign the digital contract.",
    "intro.employerStep4": "Chat with confirmed workers and manage everything from your dashboard.",
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
    "contract.workerTitle": "📄 Your Employment Contract",
    "contract.readCarefully": "Please read carefully before signing.",
    "contract.agreementHeading": "CariGaji Platform — Shift Work Agreement",
    "contract.printBtn": "Print / Save as PDF",
    "contract.viewContractBtn": "View contract",
    "toast.popupBlocked": "Pop-up blocked — please allow pop-ups for CariGaji to print the contract.",
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
    "contract.workerClause6": "CariGaji acts as a marketplace intermediary and is not your employer.",
    "contract.workerClause7": "Governed by Malaysian law including the Employment Act 1955.",
    "contract.cancellationTitle": "📄 Cancellation Payout Contract",
    "contract.cancellationHeading": "CariGaji Platform — Shift Cancellation Agreement",
    "contract.cancellationClause1": "The employer cancelled this shift less than 24 hours before it was due to start.",
    "contract.cancellationClause2": "By signing, you accept a one-time payout of 50% of your agreed wage for this shift, and release the employer from any further obligation for it.",
    "contract.cancellationClause3": "You will not attend the shift location for this engagement.",
    "contract.cancellationClause4": "This payout is processed the same way as your other CariGaji earnings — see your Earnings tab for status.",
    "contract.signBtn": "✍️ I have read and agree — Sign",
    "contract.employerTitle": "📄 Employment Contract",
    "contract.employerSubtitle": "Auto-generated upon bid acceptance. Both parties must sign.",
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
    "contract.employerClause6": "CariGaji acts as a marketplace intermediary and is not the employer in this arrangement.",
    "contract.employerClause7": "This agreement is governed by Malaysian law including the Employment Act 1955 and Gig Workers Act 2025.",
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
    "app.homeAriaLabel": "CariGaji home — go to Discover",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.ariaLabel": "Theme: {mode}. Click to change.",
    "theme.title": "Theme: {mode}",
    "admin.accessRequiredTitle": "Admin access required",
    "admin.notAdminHint": "Your account is not an administrator.",
    "admin.signInHint": "Sign in with an administrator account to continue.",
    "admin.backToWorkerApp": "Back to Worker App",
  },
  bm: {
    "nav.discover": "Terokai",
    "nav.myBids": "Tawaran Saya",
    "nav.chat": "Sembang",
    "nav.earnings": "Pendapatan",
    "nav.profile": "Profil",
    "nav.settings": "Tetapan",
    "settings.title": "Tetapan",
    "settings.subtitle": "Urus akaun anda dan akses konsol tersembunyi",
    "settings.account": "Akaun",
    "settings.language": "Bahasa",
    "settings.languageEnglish": "Bahasa Inggeris",
    "settings.languageBM": "Bahasa Melayu",
    "settings.notifications": "Pemberitahuan",
    "settings.notificationsValue": "Diaktifkan",
    "settings.privacy": "Privasi",
    "settings.privacyValue": "Mod pekerja standard",
    "common.signIn": "Log Masuk",
    "common.signUp": "Daftar",
    "common.createAccount": "Daftar Akaun",
    "common.postAShift": "Siarkan Syif",
    "common.accept": "Terima",
    "common.reject": "Tolak",
    "common.submitBid": "Hantar Tawaran →",
    "common.placeBid": "Buat Tawaran →",
    "common.signInToBid": "Log Masuk untuk Menawar →",
    "toast.avatarUpdated": "Gambar profil dikemas kini.",
    "toast.avatarUpdateFailed": "Gagal kemas kini gambar: ",
    "toast.sendFailed": "Gagal hantar: ",
    "toast.checkinSimulated": "Daftar masuk pada 18:02 · Kebolehpercayaan dikekalkan (tepat masa)",
    "toast.maxBidPrefix": "Tawaran maksimum ialah RM",
    "toast.sampleShiftBidInfo": "Ini syif contoh sahaja. Mohon syif sebenar untuk hantar tawaran.",
    "toast.applicationFailed": "Gagal hantar permohonan: ",
    "toast.signFailed": "Gagal tandatangan: ",
    "toast.contractSigned": "✅ Kontrak ditandatangani! Anda kini boleh berbual dengan majikan.",
    "toast.cancellationContractSigned": "✅ Kontrak pembatalan ditandatangani — bayaran 50% anda sedang diproses.",
    "toast.showUpProofSubmitted": "✅ Bukti dihantar — bayaran penuh anda sedang diproses.",
    "toast.showUpProofFailed": "Gagal menghantar bukti: ",
    "toast.updateFailed": "Gagal kemas kini: ",
    "toast.escrowTopupUnavailable": "Tambah dana belum tersedia — akan datang dengan integrasi FPX/DuitNow.",
    "toast.signInToPostShift": "Log masuk untuk siarkan syif.",
    "toast.shiftFieldsRequired": "Tajuk, tarikh, dan masa mula/tamat diperlukan.",
    "toast.scheduleDatePast": "Setiap hari yang dijadualkan mestilah hari ini atau lebih lewat.",
    "toast.scheduleDuplicateDate": "Setiap hari hanya boleh ditambah sekali — buang tarikh berulang.",
    "toast.maxPayGteMinPay": "Gaji maksimum mesti ≥ gaji minimum.",
    "toast.postShiftFailed": "Gagal siarkan syif: ",
    "toast.shiftPublished": "Syif disiarkan! Pekerja akan mula memohon tidak lama lagi.",
    "toast.contractSent": "✅ Kontrak dihantar kepada pekerja untuk tandatangan!",
    "chat.signInTitle": "Log masuk untuk lihat mesej",
    "chat.signInHint": "Mesej dengan majikan akan muncul di sini setelah anda log masuk dan tawaran anda diterima.",
    "chat.title": "Mesej",
    "chat.emptyTitleWorker": "Belum ada syif diterima.",
    "chat.emptyHintWorker": "Mesej akan muncul di sini setelah majikan menerima tawaran anda.",
    "chat.emptyTitleEmployer": "Belum ada permohonan diterima.",
    "chat.emptyHintEmployer": "Sembang akan muncul di sini setelah anda terima tawaran pekerja.",
    "chat.employerSubtitle": "Berbual dengan pekerja untuk syif yang diterima",
    "chat.loading": "Memuatkan...",
    "chat.inputPlaceholder": "Taip mesej…",
    "chat.send": "Hantar",
    "common.back": "Kembali",
    "common.cancel": "Batal",
    "common.pluralSuffix": "",
    "shiftDetail.placeBidTitle": "Buat Tawaran Anda",
    "shiftDetail.employerRange": "Julat majikan: RM",
    "shiftDetail.maxBid": " · Tawaran maksimum: RM",
    "shiftDetail.wageAskLabel": "Kadar gaji yang anda mahu (RM/jam)",
    "shiftDetail.estimatedTotalPay": "Anggaran jumlah gaji",
    "shiftDetail.transportAllowanceSuffix": " elaun pengangkutan",
    "shiftDetail.bidSubmitted": "Tawaran Dihantar!",
    "shiftDetail.bidSubmittedHint": "Anda akan diberitahu apabila disenarai pendek",
    "shiftDetail.positions": "Kekosongan",
    "shiftDetail.applied": "Memohon",
    "shiftDetail.wageRange": "Julat Gaji",
    "shiftDetail.perHour": "sejam",
    "shiftDetail.shiftDuration": "Tempoh Syif",
    "shiftDetail.daysCount": "{count} hari",
    "shiftDetail.estimatedGross": "Anggaran Kasar",
    "shiftDetail.atMaxRate": "pada kadar maksimum",
    "shiftDetail.transportAllowance": "Elaun Pengangkutan",
    "shiftDetail.title": "Butiran Syif",
    "shiftDetail.aboutRole": "Tentang peranan ini",
    "shiftDetail.location": "📍 Lokasi",
    "shiftDetail.date": "🗓 Tarikh",
    "shiftDetail.time": "⏰ Masa",
    "shiftDetail.dressCode": "👗 Kod Pakaian",
    "shiftDetail.languagesRequired": "🗣️ Bahasa Diperlukan",
    "shiftDetail.headcount": "👥 Bilangan Pekerja",
    "shiftDetail.workersNeeded": "pekerja diperlukan",
    "shiftDetail.employerScore": "🏢 Skor Majikan",
    "shiftDetail.employerScoreSignInToView": "Log masuk untuk melihat skor kebolehpercayaan majikan ini.",
    "shiftDetail.locationNote": "Alamat sebenar akan didedahkan setelah permohonan anda diterima.",
    "shiftDetail.employerReliability": "Kebolehpercayaan Majikan",
    "shiftDetail.applicants": "pemohon",
    "shiftDetail.notProvided": "Tidak disediakan",
    "shiftDetail.tba": "Belum Ditetapkan",
    "shiftDetail.dressCodeNone": "Tiada dinyatakan",
    "shiftDetail.notApplicable": "T/B",
    "shiftDetail.yourBid": "Tawaran anda",
    "myBids.transportAllowanceRow": "🚌 Elaun pengangkutan",
    "myBids.employerRangeRow": "💰 Julat majikan",
    "myBids.shortlistedBanner": "🎉 Anda telah disenarai pendek! Buka sembang untuk berbincang dan terima tawaran anda.",
    "myBids.loadingBids": "Memuatkan tawaran anda…",
    "myBids.noBidsYet": "Belum ada tawaran",
    "myBids.loadingBidsHint": "Tunggu sebentar semasa kami dapatkan tawaran anda.",
    "myBids.noBidsHint": "Pergi ke Terokai dan buat tawaran pada syif untuk lihat di sini.",
    "myBids.employerDecidesByPrefix": "⏳ Majikan membuat keputusan menjelang ",
    "myBids.respondByPrefix": "🎉 Respons menjelang ",
    "myBids.pillShiftCancelled": "Syif Dibatalkan",
    "myBids.pillConfirmNow": "Sahkan sekarang",
    "myBids.pillShortlisted": "Disenarai pendek",
    "myBids.pillAccepted": "Diterima",
    "myBids.pillOfferExpired": "Tawaran tamat tempoh",
    "myBids.pillNotSelected": "Tidak dipilih",
    "myBids.pillPending": "Tertunda",
    "myBids.yourBidPrefix": "Tawaran anda: ",
    "myBids.chatBtn": "Sembang →",
    "worker.checkInBtn": "Daftar Masuk",
    "myBids.signContractBtn": "✍️ Tandatangan Kontrak",
    "myBids.contractSignedBadge": "✅ Kontrak ditandatangani",
    "myBids.shiftCancelledNotice": "Syif ini telah dibatalkan oleh majikan. Tiada tindakan lanjut diperlukan.",
    "myBids.lateCancellationTitle": "Syif ini dibatalkan kurang daripada 24 jam sebelum ia bermula",
    "myBids.lateCancellationBody": "Pilih untuk menandatangani bayaran pembatalan 50% sekarang, atau hadir secara peribadi dan hantar foto untuk 100% daripada gaji yang dipersetujui.",
    "myBids.cancellation50Btn": "Tandatangan kontrak pembatalan (50%)",
    "myBids.cancellationShowUpLabel": "Hadir untuk bayaran penuh (100%)",
    "myBids.cancellationShowUpHint": "Ambil foto diri anda di lokasi syif untuk menuntut bayaran penuh.",
    "myBids.cancellationProofUploading": "Memuat naik bukti…",
    "myBids.cancellationChose50": "Anda memilih bayaran pembatalan 50%. Ia sedang diproses.",
    "myBids.cancellationProofSubmitted": "Bukti dihantar — bayaran penuh anda sedang diproses.",
    "myBids.cancellationAwaitingProof": "Anda memilih untuk hadir — ambil foto di lokasi untuk menuntut bayaran penuh anda.",
    "myBids.selectedNotice": "🎉 Anda telah dipilih! Sahkan atau tolak sebelum tarikh akhir di atas — jika anda tidak bertindak balas tepat pada masanya, tawaran akan dilepaskan secara automatik kembali kepada majikan.",
    "myBids.offerExpiredNotice": "Tawaran ini telah tamat tempoh kerana tidak disahkan tepat pada masanya.",
    "myBids.cancelling": "Membatalkan…",
    "myBids.cancelBidBtn": "Batalkan Tawaran",
    "myBids.declineBtn": "Tolak",
    "myBids.confirmShiftBtn": "Sahkan Syif",
    "myBids.fileDisputeBtn": "Fail Pertikaian",
    "myBids.fileDisputeTitle": "Fail Pertikaian",
    "myBids.disputeCategoryLabel": "Apakah isunya?",
    "myBids.disputeDescriptionLabel": "Terangkan apa yang berlaku",
    "myBids.disputeSubmitBtn": "Hantar Pertikaian",
    "dispute.categoryHoursDisputed": "Jam kerja dipertikaikan",
    "dispute.categoryNoShowClaim": "Dakwaan tidak hadir",
    "dispute.categoryUnsafeConditions": "Keadaan kerja tidak selamat",
    "dispute.categoryPaymentIssue": "Isu pembayaran",
    "dispute.categoryOther": "Lain-lain",
    "admin.disputesEmptyState": "Tiada pertikaian difailkan lagi.",
    "admin.disputeResolve": "Selesaikan",
    "admin.disputeDismiss": "Tolak",
    "admin.disputeResolved": "Pertikaian diselesaikan.",
    "admin.disputeDismissed": "Pertikaian ditolak.",
    "admin.disputeResolveFailed": "Gagal menyelesaikan pertikaian: ",
    "admin.disputeDismissFailed": "Gagal menolak pertikaian: ",
    "profile.signInTitle": "Log masuk untuk lihat profil anda",
    "profile.signInHint": "Status KYC, skor kebolehpercayaan, penilaian, dan sejarah syif anda akan dipaparkan di sini setelah anda log masuk.",
    "profile.changePhoto": "Tukar gambar profil",
    "profile.standardKyc": "KYC Standard",
    "profile.reliabilitySuffix": "Kebolehpercayaan",
    "profile.shiftsDone": "Syif selesai",
    "profile.rating": "Penilaian",
    "profile.strikes": "Amaran",
    "profile.cleanRecord": "Rekod bersih",
    "profile.onTimeRate": "Kadar tepat masa",
    "profile.notTrackedYet": "Belum dijejak",
    "common.comingSoon": "Akan datang",
    "profile.kycVerification": "Pengesahan KYC",
    "profile.kycBasic": "Asas (Telefon/E-mel)",
    "profile.kycStandard": "Standard (MyKad + Selfie)",
    "profile.kycAdvanced": "Lanjutan (Sijil)",
    "profile.verified": "✓ Disahkan",
    "profile.reliabilityScoreLabel": "Skor Kebolehpercayaan: ",
    "profile.reliabilityExcellent": "Cemerlang — 15% teratas pekerja 🏆",
    "profile.reliabilityGood": "Kedudukan baik — teruskan begini 👍",
    "profile.reliabilityBuilding": "Membina reputasi anda 📈",
    "profile.reliabilityLow": "Selesaikan lebih banyak syif untuk tingkatkan skor anda",
    "profile.recentRatings": "Penilaian Terkini",
    "profile.noRatingsTitle": "Belum ada penilaian",
    "profile.noRatingsHint": "Penilaian daripada majikan akan dipaparkan di sini selepas anda menyelesaikan syif.",
    "auth.signinSubtitle": "Gunakan e-mel dan kata laluan anda untuk mengakses CariGaji.",
    "auth.registerTitle": "Daftar",
    "auth.registerSubtitle": "Cipta akaun anda dan lengkapkan profil serta butiran KYC anda.",
    "auth.resetTitle": "Tetapkan semula kata laluan",
    "auth.resetSubtitle": "Kami akan menghantar e-mel tetapan semula kata laluan ke peti masuk anda.",
    "auth.sendResetEmail": "Hantar e-mel tetapan semula",
    "auth.emailAddress": "Alamat e-mel",
    "auth.password": "Kata laluan",
    "auth.forgetPassword": "Lupa kata laluan?",
    "auth.noAccountYet": "Belum ada akaun? Daftar Di Sini",
    "auth.resetHint": "Kami akan e-mel pautan selamat untuk tetapkan semula kata laluan anda.",
    "auth.fullName": "Nama penuh *",
    "auth.country": "Negara *",
    "auth.phoneNumber": "Nombor telefon *",
    "auth.emailAddressReq": "Alamat e-mel *",
    "auth.passwordReq": "Kata laluan *",
    "auth.createPassword": "Cipta kata laluan",
    "auth.confirmPasswordReq": "Sahkan kata laluan *",
    "auth.retypePassword": "Taip semula kata laluan anda",
    "auth.passwordsNoMatch": "Kata laluan tidak sepadan.",
    "auth.identityType": "Jenis identiti *",
    "auth.icMyKad": "IC (MyKad)",
    "auth.passport": "Pasport",
    "auth.myPR": "MyPR",
    "auth.myKadNumber": "Nombor MyKad *",
    "auth.myPRNumber": "Nombor MyPR *",
    "auth.passportNumber": "Nombor Pasport *",
    "auth.dateOfBirth": "Tarikh lahir *",
    "auth.underageWarning": "Anda mesti berumur sekurang-kurangnya {age} tahun untuk mendaftar dan bekerja di CariGaji.",
    "auth.kycLevelNote": "Tahap KYC anda akan ditetapkan berdasarkan dokumen yang dimuat naik.",
    "auth.address": "Alamat *",
    "auth.addressPlaceholder": "Jalan, bandar, negeri",
    "auth.uploadDocuments": "Muat naik dokumen",
    "auth.uploadDocumentsHint": "Muat naik gambar {doc} anda yang jelas. Nombor identiti mesti boleh dibaca dan sepadan dengan yang anda masukkan di atas.",
    "auth.passportDoc": "pasport",
    "auth.myPRCardDoc": "kad MyPR",
    "auth.myKadDoc": "MyKad",
    "auth.uploadFrontHelper": "Muat naik gambar atau PDF bahagian hadapan.",
    "auth.uploadBackHelper": "Muat naik gambar atau PDF bahagian belakang.",
    "auth.ocrChecking": "Menyemak nombor ID pada gambar anda…",
    "auth.ocrMatch": "✓ Nombor identiti pada gambar anda sepadan dengan yang anda masukkan.",
    "auth.ocrMismatchTitle": "Kami tidak dapat memadankan nombor ID pada gambar anda dengan yang anda taip.",
    "auth.ocrMismatchHint": "Ini biasanya bermaksud salah satu daripada:",
    "auth.ocrMismatchReason1": "gambar kabur atau nombor tidak kelihatan sepenuhnya,",
    "auth.ocrMismatchReason2": "nombor identiti yang anda masukkan mempunyai kesilapan taip, atau",
    "auth.ocrMismatchReason3": "gambar dokumen yang salah telah dimuat naik.",
    "auth.ocrMismatchAction": "Sila semak semula kedua-duanya. Anda masih boleh hantar — pasukan kami akan sahkan secara manual.",
    "auth.selfie": "Selfie",
    "auth.selfieHelper": "Muat naik selfie yang jelas untuk pengesahan identiti.",
    "auth.certification": "Sijil",
    "auth.certificationHelper": "Pilihan: sijil pengendali makanan, bantuan kecemasan, atau sijil lain.",
    "auth.finalRegisterHint": "Tambah butiran peribadi dan KYC anda sekarang. Fail yang dipilih akan dimuat naik ke Supabase Storage semasa pendaftaran.",
    "auth.pleaseCompleteFields": "Sila lengkapkan medan yang ditanda:",
    "auth.docMyKadFront": "MyKad (hadapan)",
    "auth.docMyKadBack": "MyKad (belakang)",
    "auth.docMyPRFront": "Kad MyPR (hadapan)",
    "auth.docMyPRBack": "Kad MyPR (belakang)",
    "auth.docPassportFront": "Muka surat gambar pasport",
    "auth.docPassportBack": "Muka surat belakang pasport",
    "auth.docIdFront": "Dokumen identiti (hadapan)",
    "auth.docIdBack": "Dokumen identiti (belakang)",
    "auth.fieldFullName": "Nama penuh",
    "auth.fieldPhone": "Nombor telefon",
    "auth.fieldEmail": "Alamat e-mel",
    "auth.fieldPassword": "Kata laluan",
    "auth.fieldConfirmPassword": "Sahkan kata laluan",
    "auth.fieldIdNumber": "Nombor identiti",
    "auth.fieldDateOfBirth": "Tarikh lahir",
    "auth.fieldDateOfBirthAge": "Tarikh lahir (mesti {age}+)",
    "auth.fieldAddress": "Alamat",
    "auth.fieldSelfie": "Selfie",
    "auth.fieldTnC": "Persetujuan Terma & Syarat",
    "employerNav.dashboard": "Papan Pemuka",
    "employerNav.shifts": "Syif",
    "employerNav.postShift": "Siar Syif",
    "employerNav.bulkUpload": "Muat Naik Pukal",
    "employerNav.chat": "Sembang",
    "employerNav.billing": "Bil",
    "employerNav.account": "Akaun",
    "employer.dashboardTitle": "Papan Pemuka",
    "employer.goodMorning": "Selamat pagi, ",
    "employer.statActiveShifts": "Syif aktif",
    "employer.statTotalApplicants": "Jumlah pemohon",
    "employer.statFilledSlots": "Slot terisi",
    "employer.statReliability": "Skor kebolehpercayaan",
    "employer.activeShiftsHeading": "Syif Aktif",
    "employer.quickActions": "Tindakan Pantas",
    "employer.postNewShift": "+ Siar Syif Baharu",
    "employer.recentActivity": "Aktiviti Terkini",
    "employer.noActivity": "Belum ada aktiviti — siarkan syif untuk mula mengambil pekerja.",
    "employer.shiftsTitle": "Syif Anda",
    "employer.postShiftBtn": "+ Siar Syif",
    "employer.listCardChatBtn": "Sembang",
    "employer.editShift": "Sunting syif",
    "employer.cancelShift": "Batalkan syif",
    "employer.cancellingShift": "Membatalkan…",
    "employer.applicantPool": "Kumpulan Pemohon",
    "employer.postAShiftTitle": "Siar Syif",
    "employer.editShiftTitle": "Sunting Syif",
    "employer.postAShiftSubtitle": "Isikan butiran syif dan keperluan pekerja",
    "employer.editShiftSubtitle": "Kemas kini butiran syif yang telah disiarkan",
    "employer.stepShiftDetails": "Butiran Syif",
    "employer.stepRequirements": "Keperluan",
    "employer.stepReview": "Semak & Siar",
    "employer.saveChanges": "Simpan Perubahan",
    "employer.publishShift": "Siar Syif",
    "employer.bulkUploadBtn": "Muat Naik Pukal",
    "employer.bulkUploadTitle": "Muat Naik Syif Secara Pukal",
    "employer.bulkUploadSubtitle": "Muat naik fail CSV untuk siarkan beberapa syif sekali gus",
    "employer.bulkStepUpload": "Muat Naik",
    "employer.bulkStepReview": "Semak & Betulkan",
    "employer.bulkStepPublish": "Siar",
    "employer.bulkChooseFile": "Fail CSV syif",
    "employer.bulkChooseFileHelper": "CSV sahaja, sehingga 2MB, sehingga 200 syif setiap fail.",
    "employer.bulkDownloadTemplate": "Muat turun templat CSV",
    "employer.bulkFileTooLarge": "Fail itu melebihi 2MB. Sila bahagikan kepada kelompok yang lebih kecil.",
    "employer.bulkInvalidFileType": "Sila pilih fail .csv.",
    "employer.bulkParseFailed": "Gagal membaca fail CSV itu: ",
    "employer.bulkRowsSummary": "{ready} daripada {total} baris sedia disiarkan, {needsFix} perlu dibetulkan",
    "employer.bulkBackToUpload": "← Kembali ke muat naik",
    "employer.bulkContinueToPublish": "Teruskan: Siar →",
    "employer.bulkPublishReady": "Siarkan baris yang sedia",
    "employer.bulkPublishing": "Menyiarkan {done} daripada {total}…",
    "employer.bulkPublishSummary": "{published} disiarkan, {failed} gagal",
    "employer.bulkBackToFix": "← Kembali betulkan baris",
    "employer.bulkDone": "Selesai",
    "employer.bulkColRow": "Baris",
    "employer.bulkColStatus": "Status",
    "employer.billingTitle": "Bil & Bayaran",
    "employer.accountTitle": "Akaun",
    "earnings.title": "Pendapatan",
    "earnings.subtitle": "Jadual bayaran langsung dan status penyelesaian dalaman",
    "earnings.totalPayouts": "Jumlah Bayaran Dalaman",
    "earnings.verified": "Perbankan disahkan untuk bayaran gaji",
    "earnings.notVerified": "Lengkapkan pengesahan bank SecureSign untuk menerima bayaran",
    "earnings.statRecords": "Rekod bayaran",
    "earnings.statReady": "Sedia dikeluarkan",
    "earnings.statHeld": "Bayaran ditahan",
    "earnings.statBanking": "Status perbankan",
    "earnings.recentPayouts": "Bayaran Terkini",
    "earnings.noPayoutsTitle": "Belum ada bayaran",
    "earnings.noPayoutsHint": "Lengkapkan satu syif dan sahkan butiran bank anda untuk menerima bayaran pertama anda di sini.",
    "earnings.salaryPayout": "bayaran gaji",
    "settings.salaryBankingTitle": "Butiran Perbankan Gaji",
    "settings.salaryBankingHint": "Bayaran pertengahan bulan memerlukan butiran bank yang disahkan melalui SecureSign.",
    "settings.bankLabel": "Bank",
    "settings.accountHolderName": "Nama pemegang akaun",
    "settings.accountNumber": "Nombor akaun",
    "settings.status": "Status",
    "settings.saveBanking": "Simpan perbankan",
    "settings.verifySecureSign": "Sahkan melalui SecureSign (Demo)",
    "cookie.bannerTitle": "Kami menggunakan kuki",
    "cookie.bannerBody": "Kami menggunakan kuki penting untuk mengekalkan sesi log masuk anda, serta kuki pilihan untuk mengingati keutamaan anda. Pilih apa yang anda selesa dengan — anda boleh menukarnya bila-bila masa.",
    "cookie.acceptAll": "Terima Semua",
    "cookie.declineAll": "Tolak Semua",
    "cookie.configure": "Konfigurasi",
    "cookie.panelTitle": "Keutamaan Kuki",
    "cookie.tab.categories": "Kategori",
    "cookie.tab.services": "Perkhidmatan",
    "cookie.tab.about": "Tentang",
    "cookie.essentialTitle": "Penting",
    "cookie.essentialDesc": "Diperlukan untuk mengekalkan sesi log masuk anda dan memastikan aplikasi berfungsi. Sentiasa aktif.",
    "cookie.functionalTitle": "Fungsian",
    "cookie.functionalDesc": "Mengingati bahasa dan tema paparan anda supaya anda tidak perlu menetapkannya semula setiap kali melawat.",
    "cookie.analyticsTitle": "Analitik & Pemasaran",
    "cookie.analyticsDesc": "Akan membantu kami memahami penggunaan dan menambah baik aplikasi. Belum aktif — dimatikan secara lalai.",
    "cookie.servicesEssential": "Mengekalkan log masuk anda melalui sesi pengesahan Supabase, dan menyimpan status sesi asas yang diperlukan untuk aplikasi berfungsi. Ini tidak boleh dimatikan.",
    "cookie.servicesFunctional": "Menyimpan pilihan bahasa anda (Bahasa Inggeris/Bahasa Melayu, kunci \"carigaji_lang\") dan keutamaan tema terang/gelap anda dalam storan tempatan pelayar anda.",
    "cookie.servicesAnalytics": "Tiada alat analitik atau pemasaran aktif buat masa ini dalam CariGaji. Kategori ini disediakan untuk kegunaan masa hadapan (contohnya analitik penggunaan) dan akan kekal dimatikan sehingga kami benar-benar menambahnya — mengaktifkannya hari ini tidak memberi apa-apa kesan.",
    "cookie.aboutBody": "CariGaji menggunakan storan tempatan pelayar — bukan kuki penjejakan pihak ketiga — untuk mengekalkan log masuk anda dan mengingati keutamaan anda pada peranti ini. Kami tidak menggunakan data ini untuk penjejakan, dan tiada apa-apa di sini dikongsi dengan pengiklan. Lihat Dasar Privasi kami untuk butiran penuh tentang apa yang kami kumpul dan sebabnya, serta Terma Perkhidmatan kami untuk cara platform ini berfungsi.",
    "cookie.savePreferences": "Simpan Keutamaan",
    "supportChat.title": "Sokongan CariGaji",
    "supportChat.greeting": "Hai! Saya pembantu sokongan CariGaji. Tanya saya apa-apa tentang syif, bidaan, KYC, pembayaran, atau akaun anda.",
    "supportChat.inputPlaceholder": "Taip soalan anda…",
    "supportChat.send": "Hantar",
    "supportChat.minimize": "Kecilkan",
    "supportChat.close": "Tutup sembang",
    "supportChat.restore": "Buka sembang sokongan",
    "supportChat.thinking": "Menaip…",
    "supportChat.escalateText": "Masih perlukan bantuan? Pasukan kami boleh bantu dari sini.",
    "supportChat.emailSupport": "E-mel sokongan",
    "supportChat.errorMessage": "Sesuatu tidak kena. Sila cuba lagi atau e-mel pasukan sokongan kami.",
    "common.close": "Tutup",
    "account.menuLabel": "Menu akaun",
    "account.help": "Bantuan",
    "account.contactSupport": "Hubungi khidmat pelanggan",
    "account.referFriends": "Rujuk rakan",
    "account.signOut": "Log keluar",
    "account.referShareText": "Cari atau siarkan kerja syif fleksibel di Malaysia dengan CariGaji:",
    "toast.inviteLinkCopied": "Pautan jemputan disalin! Kongsi dengan rakan-rakan.",
    "help.title": "Pusat Bantuan",
    "help.faqWorkQ": "Bagaimana CariGaji berfungsi?",
    "help.faqWorkA": "Majikan menyiarkan syif pendek dengan julat gaji. Pekerja menyemak imbas syif terbuka dan membuat tawaran dalam julat yang dibenarkan. Jika majikan menerima tawaran anda, kedua-dua pihak menandatangani kontrak dalam aplikasi dan syif itu disahkan.",
    "help.faqPaidQ": "Bagaimana saya menerima bayaran?",
    "help.faqPaidA": "Majikan mengikat dana untuk pekerja yang diterima sebelum syif bermula. Selepas syif selesai, bayaran dilepaskan ke akaun bank berdaftar anda — semak tab Pendapatan untuk sejarah bayaran anda.",
    "help.faqKycQ": "Apakah tahap KYC?",
    "help.faqKycA": "Asas: e-mel disahkan sahaja. Standard: dokumen pengenalan dimuat naik. Lanjutan: ID + swafoto + dokumen sokongan disahkan. Tahap KYC yang lebih tinggi membuka syif bergaji lebih tinggi dan membina kepercayaan dengan majikan.",
    "help.faqLocationQ": "Kenapa saya tidak dapat lihat lokasi syif yang tepat?",
    "help.faqLocationA": "Sesetengah majikan hanya mendedahkan alamat penuh kepada pekerja yang diterima, dan hanya menunjukkan bandar/kawasan secara umum demi keselamatan. Sebaik sahaja anda diterima, alamat penuh akan dipaparkan pada halaman butiran syif.",
    "help.faqWrongQ": "Bagaimana jika sesuatu tidak kena semasa syif?",
    "help.faqWrongA": "Hubungi khidmat pelanggan menggunakan pilihan dalam menu ini dan pasukan kami akan bantu selesaikan isu tersebut secara terus.",
    "help.stillNeedHelp": "Masih perlukan bantuan?",
    "help.contactSupportLink": "Hubungi khidmat pelanggan",
    "notification.title": "Notifikasi",
    "notification.markAllRead": "Tanda semua sudah dibaca",
    "notification.empty": "Belum ada notifikasi",
    "notification.justNow": "Baru sahaja",
    "notification.minAgo": "{n}m lalu",
    "notification.hourAgo": "{n}j lalu",
    "notification.dayAgo": "{n}h lalu",
    "discover.filtersLabel": "Penapis",
    "discover.hideFiltersLabel": "Sembunyi Penapis",
    "discover.filterCity": "Bandar",
    "discover.anyCity": "Mana-mana bandar",
    "discover.filterAreaPlaceholder": "Kawasan cth. Bukit Bintang",
    "discover.filterDate": "Tarikh",
    "discover.filterMaxDuration": "Tempoh Maksimum (jam)",
    "discover.filterJobType": "Jenis Kerja",
    "discover.allTypes": "Semua jenis",
    "discover.filterMinPay": "Gaji Min (RM/jam)",
    "discover.filterMaxPay": "Gaji Maks (RM/jam)",
    "discover.filterStartsAfter": "Bermula selepas",
    "discover.filterEndsBy": "Berakhir sebelum",
    "discover.highBookingChance": "🔥 Peluang tempahan tinggi",
    "discover.weekendsOnly": "📅 Hujung minggu sahaja",
    "discover.clearAll": "Kosongkan semua",
    "discover.loadingShifts": "Memuatkan syif…",
    "discover.loadingShiftsHint": "Tunggu sebentar semasa kami dapatkan syif terbuka.",
    "discover.noShiftsMatch": "Tiada syif sepadan buat masa ini",
    "discover.noShiftsMatchHint": "Cuba luaskan penapis anda, atau semak semula tidak lama lagi — syif baharu disiarkan secara berkala.",
    "worker.checkinTitle": "Pengimbas QR Daftar Masuk",
    "worker.checkinSubtitle": "Arahkan kamera anda ke kod QR di pintu masuk tempat acara",
    "worker.cameraViewfinder": "Pandangan kamera",
    "worker.simulateCheckin": "Simulasi Daftar Masuk Berjaya",
    "shiftDetail.rateHelperText": "Tatal atau ketik untuk pilih kadar anda",
    "myBids.signInTitle": "Log masuk untuk lihat tawaran anda",
    "myBids.signInHint": "Jejaki syif yang anda mohon dan statusnya sebaik sahaja anda log masuk.",
    "myBids.backToBids": "Kembali ke Tawaran Saya",
    "earnings.signInTitle": "Log masuk untuk lihat pendapatan",
    "earnings.signInHint": "Jejaki bayaran anda, status penyelesaian dalaman, dan pengesahan bank sebaik sahaja anda log masuk.",
    "toast.confirmOfferFailed": "Gagal mengesahkan: ",
    "toast.shiftConfirmed": "Syif disahkan! Tandatangani kontrak untuk selesaikan.",
    "toast.declineOfferFailed": "Gagal menolak: ",
    "toast.offerDeclined": "Tawaran ditolak.",
    "toast.cancelBidFailed": "Gagal batalkan tawaran: ",
    "toast.bidCancelled": "Tawaran dibatalkan.",
    "toast.disputeFiled": "Pertikaian difailkan. Pasukan kami akan menyemaknya tidak lama lagi.",
    "toast.disputeFiledFailed": "Gagal memfailkan pertikaian: ",
    "employer.fieldShiftTitle": "Tajuk syif",
    "employer.shiftTitlePlaceholder": "cth. Pelayan F&B – Makan Malam Korporat",
    "employer.fieldJobDescription": "Penerangan kerja",
    "employer.jobDescriptionPlaceholder": "Terangkan peranan, tanggungjawab, dan bagaimana rupa hari yang baik…",
    "employer.labelCategory": "Kategori",
    "employer.labelLocation": "Lokasi",
    "employer.addressVisibilityLabel": "Keterlihatan alamat",
    "employer.addressVisibilityPublic": "Tunjukkan alamat penuh pada penyenaraian",
    "employer.addressVisibilityPrivate": "Dedahkan hanya kepada pekerja yang diterima",
    "employer.labelDate": "Tarikh",
    "employer.labelHeadcount": "Bilangan pekerja",
    "employer.fieldStartTime": "Masa mula",
    "employer.fieldEndTime": "Masa tamat",
    "employer.labelSchedule": "Jadual",
    "employer.multiDayCheckbox": "Kerja ini berjalan lebih daripada satu hari",
    "employer.addAnotherDay": "Tambah hari lain",
    "employer.removeDay": "Buang hari ini",
    "employer.scheduleHint": "Tambah setiap hari kerja ini dijalankan — setiap hari boleh mempunyai masa mula dan tamat sendiri. Pemohon komited kepada semua hari ini sebagai satu pekerjaan.",
    "employer.wageRangeLabel": "Julat Gaji (RM/jam)",
    "employer.wageMinPlaceholder": "Min cth. 12",
    "employer.wageMaxPlaceholder": "Maks cth. 16",
    "employer.bidCapHint": "Pekerja boleh menawar sehingga RM{amount}/j (150% daripada maksimum)",
    "employer.offerTransportAllowance": "Tawarkan elaun pengangkutan",
    "employer.transportAllowanceHint": "Jumlah tetap pilihan (RM) dibayar tambahan kepada gaji sejam untuk bantu tampung kos perjalanan pekerja.",
    "employer.nextRequirements": "Seterusnya: Keperluan →",
    "employer.labelDressCode": "Kod pakaian",
    "employer.dressCodePlaceholder": "cth. Formal hitam sepenuhnya",
    "employer.requiredDocumentsLabel": "Dokumen diperlukan",
    "employer.docIcPassport": "IC / Pasport",
    "employer.docFoodHandler": "Sijil Pengendali Makanan",
    "employer.docFirstAid": "Sijil Bantuan Pertama",
    "employer.docDrivingLicense": "Lesen Memandu",
    "employer.labelLanguageRequirements": "Keperluan Bahasa",
    "employer.specialRequirementsLabel": "Keperluan khas",
    "employer.specialRequirementsPlaceholder": "Sebarang keperluan tambahan…",
    "employer.nextReview": "Seterusnya: Semak →",
    "employer.reviewYourShift": "Semak syif anda",
    "employer.reviewLabelTitle": "Tajuk",
    "employer.reviewNotSet": "(belum ditetapkan)",
    "employer.reviewLabelWageRange": "Julat gaji",
    "employer.reviewLabelTransportAllowance": "Elaun pengangkutan",
    "employer.reviewLabelLanguages": "Bahasa Diperlukan",
    "employer.transportNotOffered": "Tidak ditawarkan",
    "employer.dressCodeNone": "Tiada",
    "employer.estimatedReserveLabel": "Anggaran jumlah untuk direzab",
    "employer.estimatedReserveFormula": "gaji_maks × bilangan pekerja × jam syif + 15% yuran platform",
    "employer.tagline": "Konsol Majikan",
    "employer.openMenu": "Buka menu",
    "employer.paidToWorkers": "Dibayar kepada Pekerja",
    "employer.topUpSoon": "Tambah Nilai (akan datang)",
    "employer.returnToWorkerApp": "Kembali ke Aplikasi Pekerja",
    "employer.manageShiftsSubtitle": "Urus semua syif yang anda siarkan",
    "employer.loadingShifts": "Memuatkan syif…",
    "employer.loadingShiftsHint": "Tunggu sebentar semasa kami dapatkan syif anda.",
    "employer.noActiveShifts": "Tiada syif aktif",
    "employer.noActiveShiftsHint": "Siarkan syif untuk mula mengambil pekerja.",
    "employer.noShiftsPostedYet": "Belum ada syif disiarkan",
    "employer.noShiftsPostedYetHint": "Siarkan syif pertama anda untuk mula mengambil pekerja.",
    "employer.backToShifts": "Kembali ke syif",
    "employer.listCardPositionsNeeded": "Kekosongan diperlukan: {count}",
    "employer.listCardPositionsBadge": "Kekosongan {count}",
    "employer.listCardAppliedBadge": "Memohon {count}",
    "employer.listCardFilled": "Terisi: {count}",
    "employer.listCardCategory": "Kategori: {category}",
    "employer.listCardLanguages": "Bahasa: {languages}",
    "employer.toastLoadShiftFailed": "Tidak dapat memuatkan syif untuk disunting.",
    "employer.confirmCancelShift": "Batalkan \"{title}\"? Semua pemohon akan dimaklumkan.",
    "employer.lateCancelWarningTitle": "⚠️ Pembatalan lewat",
    "employer.lateCancelWarningBody": "Syif ini bermula kurang daripada 24 jam lagi dan mempunyai {count} pekerja yang disahkan. Membatalkan sekarang akan menawarkan setiap seorang pilihan: bayaran 50% tanpa perlu hadir, atau pilihan untuk hadir secara peribadi bagi 100% daripada gaji yang dipersetujui.",
    "employer.lateCancelWarningConfirmBtn": "Batalkan syif juga",
    "employer.cancellationOutcomesTitle": "Hasil pembatalan",
    "employer.cancellationAwaitingChoice": "Menunggu pilihan",
    "employer.cancellationTook50": "Menerima bayaran 50%",
    "employer.cancellationShowedUp100": "Hadir — 100% dibayar",
    "employer.cancellationAwaitingProofEmployer": "Memilih untuk hadir — menunggu bukti",
    "employer.toastCancelShiftFailed": "Gagal membatalkan syif: ",
    "employer.toastShiftCancelled": "Syif dibatalkan. Pemohon telah dimaklumkan.",
    "employer.statAppliedUsers": "Pengguna memohon",
    "employer.statSlotsFilled": "Slot diisi",
    "employer.statEstBudget": "Anggaran bajet (maks)",
    "employer.listCardEstBudget": "RM{amount} anggaran bajet",
    "employer.statAvgBid": "Purata tawaran",
    "employer.positionsOpenHint": "{open} daripada {total} kekosongan{plural} masih terbuka.",
    "employer.appliedBadge": "{count} memohon",
    "employer.selectMultiple": "Pilih berbilang",
    "employer.selectedOfTotal": "{selected} / {total} dipilih",
    "employer.sendingOffer": "Menghantar…",
    "employer.offerToWorkers": "Tawar kepada {count} pekerja{plural}",
    "employer.loadingApplicants": "Memuatkan pemohon…",
    "employer.loadingApplicantsHint": "Tunggu sebentar semasa kami dapatkan pemohon.",
    "employer.noApplicantsYet": "Belum ada pemohon",
    "employer.noApplicantsHint": "Pemohon akan dipaparkan di sini sebaik sahaja pekerja menawar syif ini.",
    "employer.colWorker": "Pekerja",
    "employer.colKYC": "KYC",
    "employer.colReliability": "Kebolehpercayaan",
    "employer.colRating": "Penilaian",
    "employer.colBidRate": "Tawaran (RM/j)",
    "employer.colStatus": "Status",
    "employer.colAction": "Tindakan",
    "employer.shiftsDoneSuffix": "syif selesai",
    "employer.awaitingResponse": "Menunggu respons",
    "employer.shortlistBtn": "Senarai pendek",
    "employer.selectBtn": "Pilih",
    "employer.waitingOnWorker": "⏳ Menunggu pekerja",
    "employer.confirmedStatus": "✓ Disahkan",
    "employer.notSelected": "✗ Tidak dipilih",
    "employer.offerExpiredStatus": "⏱ Tawaran tamat tempoh",
    "toast.offerSentMultiple": "Tawaran dihantar kepada {count} pekerja.",
    "toast.offerSentSingle": "Tawaran dihantar — menunggu pengesahan pekerja.",
    "toast.tooManySelected": "Hanya {open} kekosongan{plural} masih terbuka — pilih {open} atau kurang.",
    "employer.bulkUploadCsvHeading": "Muat naik CSV syif anda",
    "employer.bulkStatusReady": "Sedia",
    "employer.bulkStatusNeedsFix": "Perlu dibetulkan",
    "employer.bulkStatusPublished": "Disiarkan",
    "employer.bulkStatusFailed": "Gagal",
    "employer.bulkColTitle": "Tajuk",
    "employer.bulkColCategory": "Kategori",
    "employer.bulkColDate": "Tarikh",
    "employer.bulkColStart": "Mula",
    "employer.bulkColEnd": "Tamat",
    "employer.bulkColMinWage": "Min RM/j",
    "employer.bulkColMaxWage": "Maks RM/j",
    "employer.bulkColHeadcount": "Bilangan pekerja",
    "employer.bulkColLocation": "Lokasi",
    "employer.bulkColDressCode": "Kod pakaian",
    "employer.bulkColTransport": "Pengangkutan (RM)",
    "employer.bulkSelectCategoryPlaceholder": "— Pilih —",
    "employer.bulkRetry": "Cuba lagi",
    "employer.bulkUntitled": "(tiada tajuk)",
    "settings.bankingSignInTitle": "Log masuk untuk urus perbankan",
    "settings.bankingSignInHint": "Tambah dan sahkan butiran bank anda untuk bayaran gaji selepas log masuk.",
    "settings.accountHolderPlaceholder": "Seperti pada akaun bank",
    "settings.accountNumberPlaceholder": "Masukkan nombor akaun bank",
    "settings.secureSignPending": "SecureSign tertunda",
    "settings.accessOtherConsoles": "Akses konsol lain",
    "settings.accessOtherConsolesHint": "Ini disembunyikan daripada aplikasi utama dan hanya boleh dibuka di sini.",
    "settings.openEmployerConsole": "Buka Konsol Majikan",
    "settings.openAdminDashboard": "Buka Papan Pemuka Admin",
    "employer.companyDetailsTitle": "Butiran Syarikat",
    "employer.viewContractBtn": "Lihat kontrak",
    "employer.viewWorkerProfileHint": "Lihat profil pekerja",
    "employer.contractSignaturesHeading": "Tandatangan",
    "employer.contractSignedOnPrefix": "ditandatangani pada ",
    "employer.contractNotSignedYet": "belum ditandatangani",
    "employer.contractAwaitingWorker": "Pekerja belum menandatangani kontrak ini.",
    "employer.profileHistoryTitle": "Sejarah dengan syarikat anda",
    "employer.profileNoHistory": "Tiada permohonan terdahulu untuk syif anda.",
    "employer.historyCompleted": "selesai",
    "employer.profileHistoryScopeNote": "Demi privasi, ini hanya menunjukkan sejarah pekerja dengan syif anda sendiri, tahap KYC yang disahkan, dan skor kebolehpercayaan/penilaian seluruh platform.",
    "employer.verifiedBadge": "Disahkan",
    "employer.verifiedBadgeTitle": "Pengesahan SSM diluluskan — anda boleh menyiarkan syif.",
    "employer.applicantVerifiedTitle": "KYC disahkan — pekerja ini telah melengkapkan pengesahan identiti.",
    "employer.companyNameLabel": "Nama syarikat",
    "employer.companyNamePlaceholder": "cth. Grand Hyatt Kuala Lumpur",
    "employer.ssmNumberLabel": "Nombor pendaftaran SSM",
    "employer.ssmNumberPlaceholder": "cth. 1234567-A",
    "auth.fieldSsmNumber": "Nombor pendaftaran SSM *",
    "auth.ssmFormatHint": "Masukkan nombor SSM yang sah (12 digit, atau sehingga 8 digit dengan huruf akhiran).",
    "employer.ssmCertLabel": "Sijil SSM (disyorkan)",
    "employer.ssmCertHint": "Muat naik sijil pendaftaran SSM anda (imej atau PDF). Pasukan kami membandingkannya dengan pendaftaran rasmi semasa semakan — penyerahan dengan sijil disahkan lebih cepat.",
    "employer.ssmCertOnFile": "✓ Sijil telah dimuat naik — muat naik baharu akan menggantikannya untuk semakan.",
    "employer.ssmCertUploadFailed": "Muat naik sijil gagal: ",
    "employer.postShiftUnverifiedHint": "Penyiaran dikunci sehingga syarikat anda disahkan. Hantar nombor SSM anda (dan sebaiknya sijil SSM) di Akaun → Butiran Syarikat, kemudian tunggu semakan admin — anda akan dimaklumkan setelah disahkan.",
    "auth.employerVerifyNote": "Butiran syarikat anda akan disemak oleh pasukan kami. Anda boleh log masuk serta-merta, tetapi penyiaran syif hanya dibuka selepas pengesahan selesai.",
    "employer.verifyPendingTitle": "Pengesahan tertunda",
    "employer.verifyPendingBody": "Pendaftaran SSM anda sedang disemak. Ini biasanya mengambil masa 1-2 hari bekerja.",
    "employer.verifyRejectedTitle": "Pengesahan ditolak",
    "employer.verifyRejectedBody": "Kami tidak dapat mengesahkan pendaftaran SSM anda. Sila kemas kini butiran syarikat anda dan hubungi sokongan.",
    "employer.verifyUnverifiedBody": "Hantar nombor pendaftaran SSM anda untuk membuka penyiaran syif.",
    "employer.verifyWorkflowSteps": "Hantar nombor SSM → Semakan admin → Disahkan → Siarkan syif",
    "employer.postingLockedToast": "Sahkan butiran syarikat anda sebelum menyiarkan syif.",
    "employer.contactEmailLabel": "E-mel hubungan",
    "employer.bankingSectionTitle": "Perbankan Majikan (Pembiayaan Gaji)",
    "employer.bankingSectionHint": "Akaun pembiayaan mesti disahkan melalui SecureSign sebelum bayaran boleh bersedia untuk dilepaskan.",
    "employer.accountHolderPlaceholder": "Pemegang akaun syarikat",
    "employer.accountNumberPlaceholder": "Akaun pembiayaan majikan",
    "employer.fundingReadyLabel": "Akaun pembiayaan mempunyai baki yang mencukupi untuk kitaran ini",
    "employer.verificationLabel": "Pengesahan",
    "employer.outgoingObligationsTitle": "Tanggungan Gaji Keluar",
    "employer.noPayoutObligations": "Belum ada tanggungan bayaran untuk akaun majikan ini.",
    "employer.savedAccountPrefix": "Akaun disimpan: ••••",
    "employer.tbaShort": "Belum Ditetapkan",
    "employer.pendingPayout": "Bayaran tertunda",
    "employer.totalPaidOut": "Jumlah dibayar",
    "employer.escrowUnavailableNote": "Menambah dana belum tersedia lagi — ini adalah pratonton sehingga get pembayaran sebenar (FPX/DuitNow) disepadukan.",
    "employer.addFundsSoon": "+ Tambah Dana (akan datang)",
    "employer.payoutLedgerTitle": "Lejar Bayaran",
    "employer.colDateShort": "Tarikh",
    "employer.colAmount": "Jumlah",
    "auth.oauthDivider": "atau",
    "auth.oauthConnector": "{label} dengan {provider}",
    "auth.iWantTo": "Saya mahu…",
    "auth.roleWorkerTitle": "Cari kerja syif",
    "auth.roleWorkerHint": "Semak imbas dan tawar syif",
    "auth.roleEmployerTitle": "Ambil pekerja",
    "auth.roleEmployerHint": "Siarkan syif dan urus pemohon",
    "auth.socialSignupHint": "Mendaftar dengan Google, Apple, atau Facebook mencipta akaun anda serta-merta. Anda akan diminta melengkapkan pengesahan identiti (KYC) selepas itu untuk mula bekerja.",
    "auth.tncAgreeText": "Saya telah membaca dan bersetuju dengan",
    "auth.tncLinkText": "Terma & Syarat dan Notis Privasi",
    "auth.tncSuffixText": ", termasuk pengumpulan dan penggunaan dokumen pengenalan saya (MyKad/pasport) untuk tujuan pengesahan pekerjaan.",
    "auth.tncScrollHint": "Buka dan tatal Terma & Syarat hingga ke penghujung untuk mengaktifkan kotak semak ini.",
    "auth.tncGateTitle": "Sebelum anda teruskan",
    "auth.tncGateSubtitle": "Sila baca dan bersetuju dengan Terma & Syarat serta Notis Privasi kami untuk terus menggunakan CariGaji.",
    "auth.tncGateAcceptBtn": "Saya bersetuju — Teruskan",
    "auth.quickSignupHint": "Itu sahaja yang kami perlukan untuk bermula — kami akan minta nama dan butiran lain sejurus selepas anda mendaftar.",
    "details.title": "Lengkapkan butiran anda",
    "details.subtitleWorker": "Hanya beberapa butiran sebelum anda boleh mula membida syif. Ini diperlukan untuk bekerja secara sah di bawah undang-undang Malaysia.",
    "details.subtitleEmployer": "Hanya beberapa butiran sebelum anda boleh mula menyiarkan syif.",
    "details.companyContactName": "Nama syarikat / hubungan",
    "details.companyNameFinalHint": "Ini ialah nama syarikat yang dipaparkan kepada pekerja pada senarai syif. Setelah disahkan, ia tidak boleh ditukar — hubungi khidmat pelanggan jika perlu diperbetulkan.",
    "details.avatarTitle": "Foto profil",
    "details.avatarOptionalHint": "Pilihan, tetapi majikan melihat ini semasa menyemak pemohon — foto sebenar yang jelas membantu permohonan anda menonjol.",
    "details.avatarChooseBtn": "Pilih foto",
    "details.avatarChangeBtn": "Tukar foto",
    "details.avatarUploadFailed": "Muat naik foto gagal (butiran lain tetap disimpan): ",
    "details.avatarGuide1Worker": "Tunjukkan wajah anda dengan jelas, menghadap kamera",
    "details.avatarGuide2Worker": "Pencahayaan baik, tiada cermin mata hitam atau penutup wajah",
    "details.avatarGuide3Worker": "Tiada foto berkumpulan, kartun, meme, atau logo",
    "details.avatarGuide4Worker": "Foto segi empat sama menghadap depan paling sesuai dengan panduan bulatan",
    "details.avatarGuide1Employer": "Logo syarikat atau foto jelas pegawai perhubungan",
    "details.avatarGuide2Employer": "Tiada meme, imej tidak berkaitan, atau foto kabur",
    "details.fullNameFinalHint": "Masukkan nama sah anda tepat seperti pada MyKad/pasport anda. Setelah disahkan, ia tidak boleh ditukar — hubungi khidmat pelanggan jika perlu diperbetulkan.",
    "details.ssmOptional": "Nombor pendaftaran SSM (pilihan)",
    "details.kycDeferHint": "Pilihan buat masa ini — anda boleh muat naik dokumen pengenalan kemudian dari tab Profil anda. Pekerja yang disahkan lebih menonjol kepada majikan.",
    "details.kycOnlyTitle": "Lengkapkan pengesahan identiti",
    "details.kycOnlySubtitle": "Muat naik dokumen pengenalan anda untuk disahkan.",
    "details.kycOnlyHint": "Ketiga-tiganya diperlukan untuk pengesahan: bahagian hadapan dokumen, belakang, dan selfie yang jelas.",
    "details.kycUploadedToast": "Dokumen dimuat naik! Pasukan kami akan menyemaknya tidak lama lagi.",
    "details.saveBtn": "Simpan & teruskan",
    "details.saveFailed": "Gagal simpan butiran: ",
    "intro.title": "Selamat datang ke CariGaji!",
    "intro.subtitle": "Beginilah caranya:",
    "intro.workerStep1": "Layari syif terbuka di tab Terokai — tapis mengikut kategori, tarikh, dan gaji.",
    "intro.workerStep2": "Buat bidaan dengan kadar sejam anda pada syif yang anda mahu.",
    "intro.workerStep3": "Jika majikan memilih anda, sahkan tawaran dan tandatangani kontrak digital.",
    "intro.workerStep4": "Hadir, bekerja syif itu, dan jejak pendapatan anda di tab Pendapatan.",
    "intro.employerStep1": "Siarkan syif dengan peranan, jadual, dan julat gaji.",
    "intro.employerStep2": "Semak kumpulan pemohon semasa pekerja membida — lihat penilaian dan kebolehpercayaan mereka.",
    "intro.employerStep3": "Pilih pekerja anda; mereka mengesahkan dan menandatangani kontrak digital.",
    "intro.employerStep4": "Berbual dengan pekerja yang disahkan dan urus semuanya dari papan pemuka anda.",
    "intro.helpHint": "Anda boleh menemui ini semula pada bila-bila masa di bawah Bantuan dalam menu akaun.",
    "intro.getStartedBtn": "Mula sekarang",
    "toast.backAgainToExit": "Leret sekali lagi untuk keluar",
    "profile.completeKycTitle": "Lengkapkan pengesahan identiti",
    "profile.completeKycHint": "Anda belum memuat naik dokumen pengenalan anda. Pekerja yang disahkan lebih berkemungkinan dipilih oleh majikan.",
    "profile.completeKycBtn": "Muat naik dokumen",
    "auth.selectShort": "Pilih",
    "auth.selectCountry": "Pilih negara",
    "auth.searchCountryPlaceholder": "Cari mengikut nama atau kod...",
    "auth.enterYourPassword": "Masukkan kata laluan anda",
    "contract.workerTitle": "📄 Kontrak Pekerjaan Anda",
    "contract.readCarefully": "Sila baca dengan teliti sebelum menandatangani.",
    "contract.agreementHeading": "Platform CariGaji — Perjanjian Kerja Syif",
    "contract.printBtn": "Cetak / Simpan sebagai PDF",
    "contract.viewContractBtn": "Lihat kontrak",
    "toast.popupBlocked": "Tetingkap timbul disekat — sila benarkan tetingkap timbul untuk CariGaji mencetak kontrak.",
    "contract.employerLabel": "Majikan:",
    "contract.workerLabel": "Pekerja:",
    "contract.youLabel": "Anda",
    "contract.roleLabel": "Peranan:",
    "contract.dateLabel": "Tarikh:",
    "contract.agreedWageLabel": "Gaji dipersetujui:",
    "contract.agreeToTermsHeading": "Dengan menandatangani, anda bersetuju untuk:",
    "contract.workerClause1": "Hadir ke syif tepat pada masanya dan menjalankan tugas yang diberikan.",
    "contract.workerClause2": "Menerima gaji yang dipersetujui sebagai bayaran penuh untuk jam bekerja.",
    "contract.workerClause3": "Memaklumkan majikan dengan segera jika anda tidak dapat hadir.",
    "contract.workerClause4": "Mematuhi peraturan tempat kerja dan keperluan keselamatan majikan.",
    "contract.workerClause5": "Ini adalah penglibatan kasual jangka pendek. Anda bertanggungjawab untuk mengisytiharkan cukai pendapatan anda sendiri kepada LHDN jika berkenaan.",
    "contract.workerClause6": "CariGaji bertindak sebagai orang tengah pasaran dan bukan majikan anda.",
    "contract.workerClause7": "Tertakluk kepada undang-undang Malaysia termasuk Akta Kerja 1955.",
    "contract.cancellationTitle": "📄 Kontrak Bayaran Pembatalan",
    "contract.cancellationHeading": "Platform CariGaji — Perjanjian Pembatalan Syif",
    "contract.cancellationClause1": "Majikan membatalkan syif ini kurang daripada 24 jam sebelum ia dijadualkan bermula.",
    "contract.cancellationClause2": "Dengan menandatangani, anda menerima bayaran sekali sahaja sebanyak 50% daripada gaji yang dipersetujui untuk syif ini, dan membebaskan majikan daripada sebarang kewajipan selanjutnya untuknya.",
    "contract.cancellationClause3": "Anda tidak akan hadir di lokasi syif untuk penugasan ini.",
    "contract.cancellationClause4": "Bayaran ini diproses dengan cara yang sama seperti pendapatan CariGaji anda yang lain — lihat tab Pendapatan anda untuk status.",
    "contract.signBtn": "✍️ Saya telah membaca dan bersetuju — Tandatangan",
    "contract.employerTitle": "📄 Kontrak Pekerjaan",
    "contract.employerSubtitle": "Dijana secara automatik selepas tawaran diterima. Kedua-dua pihak perlu menandatangani.",
    "contract.enteredBetween": "Perjanjian ini dimeterai antara:",
    "contract.employerOnFile": "(nama perniagaan anda dalam rekod)",
    "contract.shiftDetailsHeading": "Butiran Syif:",
    "contract.locationLabel": "Lokasi:",
    "contract.timeLabel": "Masa:",
    "contract.termsHeading": "Terma:",
    "contract.employerClause1": "Ini adalah penglibatan kasual jangka pendek dan tidak membentuk pekerjaan tetap.",
    "contract.employerClause2": "Majikan akan membayar kadar gaji yang dipersetujui untuk semua jam bekerja, tidak kurang daripada gaji minimum Malaysia sebanyak RM8.72/jam.",
    "contract.employerClause3": "Majikan bertanggungjawab terhadap caruman KWSP, PERKESO, dan SIP seperti yang dikehendaki oleh undang-undang Malaysia.",
    "contract.employerClause4": "Pekerja bersetuju untuk hadir ke syif tepat pada masanya dan menjalankan tugas seperti yang dinyatakan.",
    "contract.employerClause5": "Mana-mana pihak boleh membatalkan dengan notis munasabah. Pembatalan saat akhir mungkin mengakibatkan penalti platform.",
    "contract.employerClause6": "CariGaji bertindak sebagai orang tengah pasaran dan bukan majikan dalam susunan ini.",
    "contract.employerClause7": "Perjanjian ini tertakluk kepada undang-undang Malaysia termasuk Akta Kerja 1955 dan Akta Pekerja Gig 2025.",
    "contract.confirmSendNote": "Dengan mengklik \"Sahkan & Hantar kepada Pekerja\", anda bersetuju dengan terma ini dan kontrak akan dihantar kepada {name} untuk tandatangan mereka.",
    "contract.confirmSendBtn": "Sahkan & Hantar kepada Pekerja",
    "auth.showPassword": "Tunjuk kata laluan",
    "auth.hidePassword": "Sembunyi kata laluan",
    "auth.fullNamePlaceholder": "cth. Nurul Ain Hassan",
    "discover.filterMaxDurationPlaceholder": "cth. 8",
    "discover.filterMinPayPlaceholder": "cth. 10",
    "discover.filterMaxPayPlaceholder": "cth. 25",
    "employer.transportAllowancePlaceholder": "cth. 10",
    "app.tagline": "Pasaran syif yang disahkan",
    "app.homeAriaLabel": "Laman utama CariGaji — pergi ke Terokai",
    "theme.system": "Sistem",
    "theme.light": "Terang",
    "theme.dark": "Gelap",
    "theme.ariaLabel": "Tema: {mode}. Klik untuk tukar.",
    "theme.title": "Tema: {mode}",
    "admin.accessRequiredTitle": "Akses admin diperlukan",
    "admin.notAdminHint": "Akaun anda bukan pentadbir.",
    "admin.signInHint": "Log masuk dengan akaun pentadbir untuk teruskan.",
    "admin.backToWorkerApp": "Kembali ke Aplikasi Pekerja",
  },
};

const MALAYSIAN_BANK_OPTIONS = [
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

const validateMalaysianBankAccount = (bankName, accountNumber) => {
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

const toCurrency = (value) => `RM ${Number(value || 0).toFixed(2)}`;

// Shared by the offer-deadline scaling below and the late-cancellation
// 24-hour threshold check — how many hours from now until a shift starts.
// Defaults to a large number (effectively "far away") when no start time is
// known yet, so callers don't need a separate null-check.
const hoursUntilShift = (shiftStartAt) => {
  const now = Date.now();
  const start = shiftStartAt ? new Date(shiftStartAt).getTime() : now + 999 * 3600000;
  return (start - now) / 3600000;
};

// Confirm-or-decline window for a shift offer, scaled to how soon the shift
// starts: >2 days away -> 24h to respond, 1-2 days -> 6h, <1 day -> 2h.
// Always capped so the window can never extend past the shift's start time
// (with a 30min safety buffer, floor of 15min so a window is never zero).
const computeOfferDeadline = (shiftStartAt) => {
  const now = Date.now();
  const hours = hoursUntilShift(shiftStartAt);
  let windowHours = hours > 48 ? 24 : hours > 24 ? 6 : 2;
  const cappedByShift = Math.max(0.25, hours - 0.5);
  windowHours = Math.min(windowHours, cappedByShift);
  return new Date(now + windowHours * 3600000).toISOString();
};

const mapVerificationPillColor = (status) => {
  if (status === "verified") return "green";
  if (status === "rejected") return "red";
  return "amber";
};

const mapPayoutPillColor = (status) => {
  if (status === "processed_internal") return "green";
  if (status === "held" || status === "failed_internal") return "red";
  if (["ready", "scheduled", "processing"].includes(status)) return "blue";
  return "gray";
};

// ─── Language / i18n ────────────────────────────────────────────────────────
const LANGUAGE_STORAGE_KEY = "carigaji_lang";

const readLanguagePreference = () => {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "bm" ? "bm" : "en";
};

const LanguageContext = createContext({ language: "en", setLanguage: () => {}, t: (key) => key });
const useLanguage = () => useContext(LanguageContext);

const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(() => readLanguagePreference());

  const setLanguage = useCallback((lang) => {
    const next = lang === "bm" ? "bm" : "en";
    setLanguageState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    }
  }, []);

  const t = useCallback((key) => (TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key), [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

// ─── Cookie consent ─────────────────────────────────────────────────────────
// GDPR/PDPA-style consent: essential storage (Supabase auth session) is
// always on and can't be switched off; functional (language + theme
// preference) and analytics/marketing (reserved — no tracker is wired up
// anywhere in this app yet) are user-controlled. Persisted the same way as
// LANGUAGE_STORAGE_KEY above, via a single JSON blob.
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

// ─── Toast system ───────────────────────────────────────────────────────────
const ToastContext = createContext(() => {});
const useToast = () => useContext(ToastContext);

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
          zIndex: 1000,
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
              borderRadius: 12,
              padding: "12px 16px",
              fontSize: 14,
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
const Badge = memo(({ color = "gray", children, size = "sm" }) => {
  const map = {
    gray: { bg: BRAND.grayLight, text: BRAND.textMuted },
    green: { bg: BRAND.greenLight, text: "#065F46" },
    red: { bg: BRAND.redLight, text: "#991B1B" },
    amber: { bg: BRAND.amberLight, text: "#92400E" },
    blue: { bg: BRAND.blueLight, text: "#1E40AF" },
    orange: { bg: BRAND.accentLight, text: "#155E75" },
    teal: { bg: "#CCFBF1", text: "#0F766E" },
  };
  const c = map[color] || map.gray;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: size === "xs" ? "1px 6px" : "2px 10px",
      borderRadius: 99,
      fontSize: size === "xs" ? 10 : 11,
      fontWeight: 600,
      letterSpacing: "0.02em",
      background: c.bg, color: c.text,
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
});

const Card = memo(({ children, style = {}, onClick, hover = false }) => (
  <div onClick={onClick} style={{
    background: BRAND.surface,
    border: `1px solid ${BRAND.border}`,
    borderRadius: 16,
    padding: "20px 24px",
    cursor: onClick ? "pointer" : "default",
    transition: "box-shadow 0.15s, transform 0.15s",
    ...style,
  }}
    onMouseEnter={e => { if (hover || onClick) { e.currentTarget.style.boxShadow = `0 4px 20px ${BRAND.shadow}`; e.currentTarget.style.transform = "translateY(-1px)"; } }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "none"; }}
  >{children}</div>
));

const Btn = memo(({ children, variant = "primary", onClick, size = "md", style = {}, disabled = false, type = "button", ...rest }) => {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    border: "none", borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600, fontFamily: "inherit",
    transition: "all 0.15s", opacity: disabled ? 0.5 : 1,
    minHeight: size === "xs" ? 28 : 36,
    fontSize: size === "sm" ? 13 : size === "xs" ? 12 : 14,
    padding: size === "sm" ? "7px 14px" : size === "xs" ? "4px 10px" : "10px 20px",
  };
  const variants = {
    primary: { background: BRAND.primary, color: "#fff" },
    secondary: { background: BRAND.grayLight, color: BRAND.text, border: `1px solid ${BRAND.border}` },
    ghost: { background: "transparent", color: BRAND.primary, border: `1px solid ${BRAND.primary}` },
    danger: { background: BRAND.red, color: "#fff" },
    success: { background: BRAND.green, color: "#fff" },
  };
  return (
    <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = "0.85"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = "1"; }}
      {...rest}
    >{children}</button>
  );
});

const Avatar = memo(({ name = "?", size = 36, color = BRAND.primary, src = null }) => {
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
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: color + "22", color: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
});

const Stat = memo(({ label, value, sub, color = BRAND.primary }) => (
  <div style={{ background: BRAND.grayLight, borderRadius: 14, padding: "16px 20px" }}>
    <div style={{ fontSize: 12, color: BRAND.textMuted, fontWeight: 500, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4 }}>{sub}</div>}
  </div>
));

const Input = ({ label, placeholder, value, onChange, type = "text", style = {}, error = false, ...rest }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input type={type} placeholder={placeholder} value={value} onChange={onChange} {...rest}
      style={{
        width: "100%", padding: "10px 14px", borderRadius: 10,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
        color: BRAND.text, background: BRAND.input, outline: "none",
        boxSizing: "border-box",
      }}
    />
  </div>
);

// Loads the Google Maps JS API (Places library) once, on demand.
const loadGoogleMaps = (() => {
  let promise = null;
  return (apiKey) => {
    if (typeof window === "undefined") return Promise.reject(new Error("no window"));
    if (window.google?.maps?.places) return Promise.resolve(window.google);
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      s.async = true;
      s.defer = true;
      s.onload = () => (window.google?.maps?.places ? resolve(window.google) : reject(new Error("places missing")));
      s.onerror = () => reject(new Error("maps script failed"));
      document.head.appendChild(s);
    });
    return promise;
  };
})();

// Location field with Google Places autocomplete (Malaysia-restricted).
// Falls back to a plain text input when no API key is configured.
const LocationAutocomplete = ({ label = "Location", value, onChange, error = false }) => {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const inputRef = useRef(null);
  useEffect(() => {
    if (!apiKey || !inputRef.current) return;
    let cancelled = false;
    let listener = null;
    let ac = null;
    loadGoogleMaps(apiKey).then(google => {
      if (cancelled || !inputRef.current) return;
      // Google's Autocomplete appends a `.pac-container` dropdown directly to
      // document.body (outside React's tree) and never removes it itself.
      // Diff body's children before/after construction to find the node it
      // just added, so we can clean it up on unmount instead of leaking it.
      const bodyChildrenBefore = new Set(document.body.children);
      ac = new google.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: "my" },
        fields: ["formatted_address", "name"],
      });
      const pacContainer = Array.from(document.body.children).find(el => !bodyChildrenBefore.has(el) && el.classList.contains("pac-container"));
      if (pacContainer) ac._pacContainerEl = pacContainer;
      listener = ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const name = place.name || "";
        const address = place.formatted_address || "";
        // Google's formatted_address often omits the venue name (e.g. "1 Utama
        // Shopping Centre"), showing only the street address. Prepend the name
        // so workers see the place, not just an address, on shift listings.
        const combined = name && address && !address.toLowerCase().startsWith(name.toLowerCase())
          ? `${name}, ${address}`
          : (address || name || inputRef.current.value);
        onChange(combined);
      });
    }).catch(() => {}); // silent fallback to manual typing
    return () => {
      cancelled = true;
      if (listener) listener.remove();
      if (ac) {
        window.google?.maps?.event?.clearInstanceListeners(ac);
        ac._pacContainerEl?.remove();
      }
    };
  }, [apiKey]);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={apiKey ? "Start typing an address or place…" : "e.g. KLCC, Kuala Lumpur"}
        style={{
          width: "100%", padding: "10px 14px", borderRadius: 10,
          border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
          color: BRAND.text, background: BRAND.input, outline: "none", boxSizing: "border-box",
        }}
      />
    </div>
  );
};

const PasswordInput = ({ label, placeholder, value, onChange, style = {}, hideToggle = false, error = false }) => {
  const [show, setShow] = useState(false);
  const { t } = useLanguage();
  return (
    <div style={{ marginBottom: 16, position: "relative", ...style }}>
      {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 10,
            border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: 14, fontFamily: "inherit",
            color: BRAND.text, background: BRAND.input, outline: "none",
            boxSizing: "border-box", height: 42, lineHeight: "20px",
          }}
        />
        {!hideToggle && (
          <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")} style={{ position: "absolute", right: 8, top: 6, border: "none", background: "transparent", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
            {show ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 3L21 21" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10.58 10.58A3 3 0 0 0 13.42 13.42" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2.05 12.6A11 11 0 0 0 12 20c2.1 0 4.09-.5 5.95-1.4" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

const FileInput = ({ label, onChange, accept, helper, fileName, error = false }) => (
  <div style={{ marginBottom: 16 }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
    <input
      type="file"
      accept={accept}
      onChange={onChange}
      style={{
        width: "100%",
        padding: "10px 14px",
        borderRadius: 10,
        border: `1.5px solid ${error ? BRAND.red : BRAND.border}`,
        fontSize: 14,
        fontFamily: "inherit",
        color: BRAND.text,
        background: BRAND.input,
        outline: "none",
        boxSizing: "border-box",
      }}
    />
    {(fileName || helper) && (
      <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 6, lineHeight: 1.5 }}>
        {fileName ? `Selected: ${fileName}` : helper}
      </div>
    )}
  </div>
);

const Select = ({ label, options, value, onChange, style = {} }) => (
  <div style={{ marginBottom: 16, ...style }}>
    {label && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
    <select value={value} onChange={onChange} style={{
      width: "100%", padding: "10px 14px", borderRadius: 10,
      border: `1px solid ${BRAND.border}`, fontSize: 14, fontFamily: "inherit",
      color: BRAND.text, background: BRAND.input, outline: "none",
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Pill = memo(({ label, color }) => (
  <span style={{
    display: "inline-block", padding: "3px 10px", borderRadius: 99,
    fontSize: 12, fontWeight: 600,
    background: color === "green" ? BRAND.greenLight : color === "red" ? BRAND.redLight : color === "amber" ? BRAND.amberLight : color === "blue" ? BRAND.blueLight : BRAND.grayLight,
    color: color === "green" ? "#065F46" : color === "red" ? "#991B1B" : color === "amber" ? "#92400E" : color === "blue" ? "#1E40AF" : BRAND.textMuted,
  }}>{label}</span>
));

const EmptyState = memo(({ icon = "📭", title, hint }) => (
  <div style={{
    border: `1px dashed ${BRAND.border}`,
    borderRadius: 14,
    padding: "28px 20px",
    textAlign: "center",
    background: BRAND.grayLight,
  }}>
    <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden="true">{icon}</div>
    <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{title}</div>
    {hint && <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5 }}>{hint}</div>}
  </div>
));

const AuthGate = memo(({ onRequireAuth, title, hint, icon = "🔒" }) => {
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
      background: BRAND.primaryLight, display: "flex",
      alignItems: "center", justifyContent: "center", fontSize: 28,
    }} aria-hidden="true">{icon}</div>
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: BRAND.textMuted, lineHeight: 1.5, maxWidth: 280 }}>{hint}</div>
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
    borderRadius: 14,
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

const openMailtoSupport = () => {
  window.location.href = "mailto:support@carigaji.com?subject=CariGaji%20Support%20Request";
};

const ProfileMenu = ({ user, onSignOut, onOpenSupportChat }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
    const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "https://jiayutee.github.io/CariGaji/";
    const shareText = t("account.referShareText");
    if (navigator.share) {
      try { await navigator.share({ title: "CariGaji", text: shareText, url: shareUrl }); } catch {} // user cancelled share sheet
      return;
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
      toast(t("toast.inviteLinkCopied"), "success");
      return;
    }
    toast(shareUrl, "info", 8000);
  };

  const items = [
    { label: t("account.help"), icon: "❓", onClick: () => setHelpOpen(true) },
    { label: t("account.contactSupport"), icon: "💬", onClick: onOpenSupportChat },
    { label: t("account.referFriends"), icon: "🎁", onClick: shareReferralLink },
    { label: t("account.signOut"), icon: "↩️", danger: true, onClick: onSignOut },
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
          borderRadius: 99, padding: "4px 10px 4px 4px", fontFamily: "inherit",
        }}
      >
        <Avatar name={displayName} size={32} color={BRAND.primary} src={avatarUrl} />
        <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
        <span aria-hidden="true" style={{ fontSize: 10, color: BRAND.textMuted }}>▼</span>
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 400,
          minWidth: 220, background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: 12, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
            <div style={{ fontSize: 11, color: BRAND.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
          </div>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", border: "none", background: "transparent",
                cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left",
                color: it.danger ? BRAND.red : BRAND.text,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span aria-hidden="true" style={{ fontSize: 15 }}>{it.icon}</span>
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
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, paddingTop: "10vh" }} onClick={() => setHelpOpen(false)}>
          {/* alignItems: flex-start (not center) pins the panel's top edge to a
              fixed viewport position — expanding/collapsing an FAQ only grows
              or shrinks the bottom, it no longer shifts the top edge. */}
          <div style={{ background: BRAND.surface, borderRadius: 16, padding: 24, maxWidth: 480, width: "100%", maxHeight: "70vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: BRAND.text, margin: 0 }}>❓ {t("help.title")}</h3>
              <button onClick={() => setHelpOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1 }}>×</button>
            </div>
            {HELP_FAQS.map((faq, i) => (
              <div key={faq.qKey} style={{ borderBottom: `1px solid ${BRAND.border}`, padding: "10px 0" }}>
                <button onClick={() => setOpenFaq((o) => (o === i ? null : i))} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontSize: 13, fontWeight: 600, color: BRAND.text }}>
                  <span>{t(faq.qKey)}</span>
                  <span aria-hidden="true">{openFaq === i ? "−" : "+"}</span>
                </button>
                {openFaq === i && <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8, lineHeight: 1.6 }}>{t(faq.aKey)}</div>}
              </div>
            ))}
            <div style={{ marginTop: 16, fontSize: 12, color: BRAND.textMuted }}>
              {t("help.stillNeedHelp")}{" "}
              <button onClick={() => { setHelpOpen(false); openMailtoSupport(); }} style={{ border: "none", background: "none", color: BRAND.primary, cursor: "pointer", fontWeight: 600, padding: 0, textDecoration: "underline", fontFamily: "inherit", fontSize: 12 }}>
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

const NotificationBell = ({ user, onNavigate = () => {} }) => {
  const { t } = useLanguage();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState(null); // { top, left } in viewport coords
  const ref = useRef(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

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

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (active) setNotifications(data ?? []);
      });
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`,
      }, payload => {
        if (active) setNotifications(prev => [payload.new, ...prev]);
      })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const markRead = async (id) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    await supabase.from('notifications').update({ read: true }).eq('id', id);
  };

  const handleNotificationClick = (n) => {
    markRead(n.id);
    if (n.link) {
      setOpen(false);
      onNavigate(n.link);
    }
  };

  const markAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    await supabase.from('notifications').update({ read: true }).in('id', unreadIds);
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
          borderRadius: 99, padding: 0, fontFamily: "inherit", fontSize: 16,
        }}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span aria-hidden="true" style={{
            position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, padding: "0 3px",
            borderRadius: 99, background: BRAND.red, color: "#fff", fontSize: 10, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && panelPos && (
        <div role="menu" style={{
          position: "fixed", top: panelPos.top, left: panelPos.left, zIndex: 400,
          width: panelPos.width, background: BRAND.surface, border: `1px solid ${BRAND.border}`,
          borderRadius: 12, boxShadow: `0 12px 40px ${BRAND.shadow}`, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 14px", borderBottom: `1px solid ${BRAND.border}`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text }}>{t("notification.title")}</div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 11, fontWeight: 600, color: BRAND.primary, padding: 0,
                }}
              >
                {t("notification.markAllRead")}
              </button>
            )}
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div style={{ padding: "24px 14px", textAlign: "center", fontSize: 12, color: BRAND.textMuted }}>
                {t("notification.empty")}
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  role="menuitem"
                  onClick={() => handleNotificationClick(n)}
                  style={{
                    width: "100%", display: "flex", alignItems: "flex-start", gap: 8,
                    padding: "10px 14px", border: "none", borderBottom: `1px solid ${BRAND.border}`,
                    background: n.read ? "transparent" : BRAND.grayLight,
                    cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.grayLight; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = n.read ? "transparent" : BRAND.grayLight; }}
                >
                  {!n.read && (
                    <span aria-hidden="true" style={{
                      width: 7, height: 7, borderRadius: 99, background: BRAND.primary,
                      marginTop: 5, flexShrink: 0,
                    }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.text }}>{n.title}</div>
                    {n.body && (
                      <div style={{ fontSize: 11.5, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.4 }}>{displayProtectedText(n.body)}</div>
                    )}
                    <div style={{ fontSize: 10.5, color: BRAND.textMuted, marginTop: 4 }}>{notificationTimeAgo(n.created_at, t)}</div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const StarRating = ({ value = 4.5, size = 14 }) => {
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
  return <span>{stars} <span style={{ fontSize: size - 2, color: BRAND.textMuted }}>({value})</span></span>;
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
        background: BRAND.primary, borderRadius: 10, pointerEvents: "none",
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
              justifyContent: "center", fontSize: v === Number(value) ? 20 : 15,
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

const Icons = {
  Search: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 21l-4.35-4.35" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="11" r="6" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  List: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Money: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="#374151" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.6" />
    </svg>
  ),
  User: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="7" r="4" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Settings: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="3" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 6L6 18M6 6l12 12" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Camera: ({ size = 48 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2v11z" stroke="#374151" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" stroke="#374151" strokeWidth="1.4" />
    </svg>
  ),
  Edit: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 20h9" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chat: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ArrowLeft: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 12H5" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 19l-7-7 7-7" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronDown: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 9l6 6 6-6" stroke="#374151" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Rocket: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2s4 1 6 3 3 6 3 6-4 1-6 3-6 6-6 6-4-4-6-6 6-6 6-6 1-4 3-6z" stroke="#374151" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Star: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="#F5A623" />
    </svg>
  ),
};

const Progress = ({ value, max = 100, color = BRAND.primary }) => (
  <div style={{ height: 6, background: BRAND.grayLight, borderRadius: 99, overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${(value / max) * 100}%`, background: color, borderRadius: 99, transition: "width 0.3s" }} />
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

const KYC_BUCKET = "kyc-documents";
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

const getAvatarUrl = (path) => {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
};

const uploadAvatarFile = async (userId, file) => {
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
const openContractPrintWindow = ({ heading, subheading, rows }) => {
  const body = rows.map((r) => {
    if (typeof r === "string") return r === "" ? "<br/>" : `<p>${escapeHtml(r)}</p>`;
    return `<p><strong>${escapeHtml(r.label)}</strong> ${escapeHtml(r.value)}</p>`;
  }).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; padding: 40px; max-width: 720px; margin: 0 auto; }
  .brand { font-weight: 800; font-size: 18px; margin-bottom: 28px; color: #2563EB; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #6b7280; margin-bottom: 24px; }
  p { font-size: 13px; line-height: 1.9; margin: 2px 0; }
  .actions { margin-top: 28px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: none; background: #2563EB; color: #fff; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style></head><body>
<div class="brand">CariGaji</div>
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

const uploadKycFile = async (userId, file, label) => {
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
        {label && !compact && <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{label}</label>}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={{
            width: compact ? 110 : "100%",
            padding: "10px 12px",
            borderRadius: 10,
            height: 42,
            border: `1px solid ${BRAND.border}`,
            fontSize: 14,
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
            borderRadius: 10,
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
                fontSize: 13,
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
                  fontSize: 13,
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
                    <span style={{ marginLeft: "auto", fontSize: 12, color: BRAND.textMuted }}>{country.dialCode}</span>
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
    <strong style={{ color: BRAND.text, fontSize: 12 }}>Privacy Notice & Terms of Consent</strong>
    <p style={{ marginTop: 8 }}>
      <strong>1. Data Controller</strong><br />
      CariGaji ("we", "us") operates this platform and is responsible for the personal data you provide during registration. This notice is issued pursuant to the <strong>Personal Data Protection Act 2010 (Act 709)</strong> ("PDPA").
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
      <li>Verifying your identity on the CariGaji platform as permitted under the <strong>National Registration Act 1959 (Act 78)</strong>;</li>
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
    <div style={{ marginBottom: 16, ...(error ? { border: `1.5px solid ${BRAND.red}`, borderRadius: 10, padding: 10 } : {}) }}>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: hasScrolledToEnd ? "pointer" : "not-allowed" }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!hasScrolledToEnd}
          onChange={e => onChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: BRAND.primary, flexShrink: 0, width: 16, height: 16 }}
        />
        <span style={{ fontSize: 12, color: error ? BRAND.red : BRAND.text, lineHeight: 1.5 }}>
          {t("auth.tncAgreeText")}{" "}
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.preventDefault(); toggleExpanded(); }}
            onKeyDown={e => e.key === "Enter" && toggleExpanded()}
            style={{ color: BRAND.primary, textDecoration: "underline", cursor: "pointer" }}
          >
            {t("auth.tncLinkText")}
          </span>
          {t("auth.tncSuffixText")}
        </span>
      </label>
      {!hasScrolledToEnd && (
        <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 4, marginLeft: 26 }}>
          {t("auth.tncScrollHint")}
        </div>
      )}
      {expanded && (
        <div
          ref={boxRef}
          onScroll={onScroll}
          style={{ marginTop: 10, padding: "12px 14px", background: BRAND.grayLight, borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 11.5, color: BRAND.textMuted, lineHeight: 1.7, maxHeight: 240, overflowY: "auto" }}
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
        <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t("auth.oauthDivider")}</span>
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
              width: "100%", padding: "10px 14px", borderRadius: 10,
              border: `1px solid ${BRAND.border}`, background: BRAND.surface,
              color: BRAND.text, fontSize: 14, fontWeight: 600, fontFamily: "inherit",
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
  const [showErrors, setShowErrors] = useState(false);
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
      subtitle: translate("auth.signinSubtitle"),
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
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(17,24,39,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div
        style={{ width: "100%", maxWidth: view === "register" ? 640 : 440, maxHeight: "90vh", background: BRAND.surface, borderRadius: 20, boxShadow: `0 24px 70px ${BRAND.shadow}`, overflow: "hidden", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${BRAND.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: `linear-gradient(135deg, ${BRAND.primaryLight}, ${BRAND.surface})`, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text }}>{copy.title}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 4 }}>{copy.subtitle}</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1 }} aria-label={translate("common.close")}>{Icons.Close({ size: 20 })}</button>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column" }}>
          {message && (
            <div style={{ position: "sticky", top: -20, zIndex: 10, margin: "-20px -4px 16px -4px", padding: "14px 16px", borderRadius: 12, background: "#EFF6FF", border: `1.5px solid ${BRAND.primary}`, color: BRAND.text, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, boxShadow: "0 4px 14px rgba(37,99,235,0.15)" }}>
              {message}
            </div>
          )}
          {showErrors && hasRegisterErrors && view === "register" && (
            <div style={{ position: "sticky", top: message ? 52 : -20, zIndex: 9, margin: "0 -4px 16px -4px", padding: "12px 16px", borderRadius: 12, background: "#FEF2F2", border: `1.5px solid ${BRAND.red}`, color: BRAND.red, fontSize: 13, lineHeight: 1.6 }}>
              <strong>{translate("auth.pleaseCompleteFields")}</strong> {missingLabels.join(", ")}
            </div>
          )}
          {view === "signin" && (
            <form onSubmit={onSignIn}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <PasswordInput label={translate("auth.password")} placeholder={translate("auth.enterYourPassword")} value={form.password} onChange={e => onChange("password", e.target.value)} />
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: -6, marginBottom: 16 }}>
                <button type="button" onClick={() => onViewChange("reset")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>{translate("auth.forgetPassword")}</button>
                <button type="button" onClick={() => onViewChange("register")} style={{ border: "none", background: "transparent", color: BRAND.primary, cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600 }}>{translate("auth.noAccountYet")}</button>
              </div>
              <Btn type="submit" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>{copy.action}</Btn>
              <SocialAuthButtons onOAuth={onOAuth} label={translate("common.signIn")} />
            </form>
          )}

          {view === "reset" && (
            <form onSubmit={onResetPassword}>
              <Input label={translate("auth.emailAddress")} type="email" placeholder="name@example.com" value={form.email} onChange={e => onChange("email", e.target.value)} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>{translate("auth.resetHint")}</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
            </form>
          )}

          {view === "register" && (
            <form onSubmit={handleRegisterSubmit} noValidate>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{translate("auth.iWantTo")}</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { value: "worker", title: translate("auth.roleWorkerTitle"), hint: translate("auth.roleWorkerHint") },
                    { value: "employer", title: translate("auth.roleEmployerTitle"), hint: translate("auth.roleEmployerHint") },
                  ].map(opt => (
                    <label key={opt.value} style={{
                      display: "block", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                      border: `1.5px solid ${form.accountRole === opt.value ? BRAND.primary : BRAND.border}`,
                      // A pale, hardcoded-light background (BRAND.primaryLight) with
                      // BRAND.text was unreadable in dark mode (light text on a pale
                      // band that reads as near-white in both themes). Use a solid
                      // primary fill + white text when selected instead, same fix as
                      // the wage-rate picker's earlier contrast bug.
                      background: form.accountRole === opt.value ? BRAND.primary : BRAND.surface,
                    }}>
                      <input type="radio" name="accountRole" value={opt.value} checked={form.accountRole === opt.value} onChange={() => onChange("accountRole", opt.value)} style={{ marginRight: 6 }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: form.accountRole === opt.value ? "#fff" : BRAND.text }}>{opt.title}</span>
                      <div style={{ fontSize: 11, color: form.accountRole === opt.value ? "rgba(255,255,255,0.85)" : BRAND.textMuted, marginLeft: 20 }}>{opt.hint}</div>
                    </label>
                  ))}
                </div>
              </div>
              {isEmployerSignup && (
                <>
                  <Input label={translate("employer.companyNameLabel")} placeholder={translate("employer.companyNamePlaceholder")} value={form.companyName || ""} onChange={e => onChange("companyName", e.target.value)} error={fieldError("companyName")} />
                  <Input label={translate("auth.fieldSsmNumber")} placeholder="202301012345 / 1234567-X" value={form.ssmNumber || ""} onChange={e => onChange("ssmNumber", e.target.value)} error={fieldError("ssmNumber")} />
                  {form.ssmNumber?.trim() && !ssmFormatOk && (
                    <div style={{ color: BRAND.red, fontSize: 12, marginTop: -10, marginBottom: 12 }}>{translate("auth.ssmFormatHint")}</div>
                  )}
                  <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -6, marginBottom: 14 }}>
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
                <div style={{ color: BRAND.red, fontSize: 13, marginTop: -8, marginBottom: 12 }}>{translate("auth.passwordsNoMatch")}</div>
              )}
              <div style={{ fontSize: 12, color: BRAND.textMuted, lineHeight: 1.5, marginTop: -4, marginBottom: 16 }}>
                {translate("auth.quickSignupHint")}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" type="button" onClick={() => onViewChange("signin")} style={{ flex: 1, justifyContent: "center" }}>{translate("common.back")}</Btn>
                <Btn type="submit" disabled={loading} style={{ flex: 1, justifyContent: "center" }}>{copy.action}</Btn>
              </div>
              <SocialAuthButtons onOAuth={onOAuth} label={translate("common.signUp")} />
              <div style={{ fontSize: 11, color: BRAND.textMuted, lineHeight: 1.5, marginTop: 4, textAlign: "center" }}>
                {translate("auth.socialSignupHint")}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Mock data ───────────────────────────────────────────────────────────────
const ADMIN_KYC = [
  { id: 1, name: "Muhammad Izzat", type: "Standard", submitted: "2 hours ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
  { id: 2, name: "Siti Rahmah Binti Ali", type: "Standard", submitted: "4 hours ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
  { id: 3, name: "Chong Wei Han", type: "Advanced", submitted: "1 day ago", status: "flagged", docs: ["MyKad front", "MyKad back", "Selfie", "Food Handler Cert"] },
  { id: 4, name: "Rubini Krishnan", type: "Standard", submitted: "1 day ago", status: "pending", docs: ["MyKad front", "MyKad back", "Selfie"] },
];

// Dispute categories shared by the worker/employer file-a-dispute modals and
// the admin dashboard. v1 is informational only — text-only evidence, no
// payout linkage (see supabase/migrations/20260712_disputes.sql).
const DISPUTE_CATEGORIES = [
  { value: "hours_disputed", labelKey: "dispute.categoryHoursDisputed" },
  { value: "no_show_claim", labelKey: "dispute.categoryNoShowClaim" },
  { value: "unsafe_conditions", labelKey: "dispute.categoryUnsafeConditions" },
  { value: "payment_issue", labelKey: "dispute.categoryPaymentIssue" },
  { value: "other", labelKey: "dispute.categoryOther" },
];

// ─── WORKER PORTAL ───────────────────────────────────────────────────────────
const WorkerPortal = ({ onOpenPortal, isMobile = false, user = null, userRole = null, onRequireAuth = () => {}, onUserUpdated = () => {}, homeSignal = 0, kycLevel = null, onOpenKycUpload = () => {}, backHandlerRef = null, deepLinkShift = null }) => {
  const toast = useToast();
  const { t, language, setLanguage } = useLanguage();
  const [avatarUploading, setAvatarUploading] = useState(false);

  const handleAvatarUpload = async (file) => {
    if (!file || !user) return;
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
  const [workerShiftsDone, setWorkerShiftsDone] = useState(null);
  const [tab, setTab] = useState("discover");
  const [showTnC, setShowTnC] = useState(false);
  const [selectedShift, setSelectedShift] = useState(null);
  const [showBidModal, setShowBidModal] = useState(false);
  const [bidAmount, setBidAmount] = useState("");
  const [bidSuccess, setBidSuccess] = useState(false);
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
  const [liveApplications, setLiveApplications] = useState(null);
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
  const [liveShifts, setLiveShifts] = useState(null);
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
  const [chatMessages, setChatMessages] = useState([]);
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
  const [cancellationContractModal, setCancellationContractModal] = useState(null); // { applicationId, shiftTitle, shiftDate, wageAsk }
  const [cancellationProofUploading, setCancellationProofUploading] = useState(null); // applicationId currently uploading, or null
  const [disputeModal, setDisputeModal] = useState(null); // { applicationId, shiftTitle }
  const [disputeForm, setDisputeForm] = useState({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  const [filingDispute, setFilingDispute] = useState(false);

  // Mobile back-gesture support: register a handler that closes the topmost
  // open thing and reports whether it handled the gesture. Reassigned every
  // render (no dep array) so the closure always sees current state; consumed
  // by BackGestureManager's popstate listener at the root.
  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => {
      if (showBidModal) { setShowBidModal(false); return true; }
      if (workerContractModal) { setWorkerContractModal(null); return true; }
      if (cancellationContractModal) { setCancellationContractModal(null); return true; }
      if (disputeModal) { setDisputeModal(null); return true; }
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
  useEffect(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("carigaji:nav"));
  }, [tab, selectedShift, selectedApplication, activeChatShift]);

  const navBaseHeight = isMobile ? 60 : 72;
  const navSafeAreaInset = "env(safe-area-inset-bottom, 0px)";
  const navHeight = `calc(${navBaseHeight}px + ${navSafeAreaInset})`;
  const navPadding = `calc(16px + ${navSafeAreaInset})`;

  useEffect(() => {
    if (!user || tab !== 'profile') return;
    let active = true;
    supabase.from('profiles').select('reliability_score, rating')
      .eq('id', user.id).single()
      .then(({ data }) => {
        if (active && data) setProfileStats({
          reliability_score: data.reliability_score ?? 0,
          rating: data.rating ?? 0
        });
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
      .select('shift_id, shift:shifts(id, title, start_at, employer_id, employer:profiles(full_name))')
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
      const { data, error } = await supabase
        .from('applications')
        .select('id, shift_id, wage_ask, status, applied_at, offer_expires_at, worker_signed_at, cancellation_choice, cancellation_choice_deadline, cancellation_proof_path, shift:shifts(id, title, description, category, location, start_at, end_at, occurrences, wage_min, wage_max, headcount, dress_code, employer_id, transport_allowance, status, language_requirements, employer:profiles(full_name))')
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
  // Worker confirms a shift offer -> status becomes 'accepted', which then
  // unlocks the existing digital-contract signing step (Sign Contract button).
  const confirmOffer = async (applicationId) => {
    setRespondingOffer(true);
    const { error } = await supabase.from('applications').update({ status: 'accepted' }).eq('id', applicationId);
    setRespondingOffer(false);
    if (error) { toast(t('toast.confirmOfferFailed') + error.message, 'error'); return; }
    toast(t('toast.shiftConfirmed'), 'success');
    setLiveApplications(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, status: 'accepted' } : a));
    setSelectedApplication(prev => prev && prev.id === applicationId ? { ...prev, status: 'accepted' } : prev);
  };
  // Worker declines an offer -> employer is notified (via DB trigger) to pick a substitute.
  const declineOffer = async (applicationId) => {
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
    setDisputeModal(null);
    setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  };

  useEffect(() => {
    // Open shifts are publicly browsable (anon RLS policy) so visitors can
    // see listings before signing up. Runs for both anon and signed-in users.
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, filled_count, applicant_count, status, address_visibility, transport_allowance, language_requirements, employer_id, employer:profiles(full_name, reliability_score)')
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
          location: displayProtectedText(s.location),
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          time: formatShiftTime(s.start_at) && formatShiftTime(s.end_at) ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          hours: totalOccurrenceHours(s.occurrences) || (s.start_at && s.end_at ? Math.round((new Date(s.end_at) - new Date(s.start_at)) / 3600000) : 0),
          wageMin: Number(s.wage_min),
          wageMax: Number(s.wage_max),
          headcount: s.headcount,
          filled: s.filled_count,
          status: s.status,
          addressVisibility: s.address_visibility || 'public',
          totalApplicants: s.applicant_count ?? 0,
          dress: displayProtectedText(s.dress_code || ''),
          languageRequirements: s.language_requirements || [],
          stipend: Number(s.transport_allowance) || 0,
          startTime: shiftHHMM(s.start_at),
          endTime: shiftHHMM(s.end_at),
          date: formatShiftDate(s.start_at),
        })));
      })
      .catch(() => { if (active) setLiveShifts([]); });
    return () => { active = false; };
  }, [user]);

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
    if (!deepLinkShift?.shiftId) return undefined;
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, filled_count, applicant_count, status, address_visibility, transport_allowance, language_requirements, employer_id, employer:profiles(full_name, reliability_score)')
      .eq('id', deepLinkShift.shiftId)
      .maybeSingle()
      .then(({ data: s }) => {
        if (!active || !s) return;
        setSelectedShift({
          id: s.id,
          title: displayProtectedText(s.title),
          description: displayProtectedText(s.description || ''),
          category: s.category,
          employer: s.employer?.full_name || 'Employer',
          employerId: s.employer_id ?? null,
          reliabilityScore: s.employer ? (s.employer.reliability_score ?? 0) : null,
          location: displayProtectedText(s.location),
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          time: formatShiftTime(s.start_at) && formatShiftTime(s.end_at) ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          hours: totalOccurrenceHours(s.occurrences) || (s.start_at && s.end_at ? Math.round((new Date(s.end_at) - new Date(s.start_at)) / 3600000) : 0),
          wageMin: Number(s.wage_min),
          wageMax: Number(s.wage_max),
          headcount: s.headcount,
          filled: s.filled_count,
          status: s.status,
          addressVisibility: s.address_visibility || 'public',
          totalApplicants: s.applicant_count ?? 0,
          dress: displayProtectedText(s.dress_code || ''),
          languageRequirements: s.language_requirements || [],
          stipend: Number(s.transport_allowance) || 0,
          startTime: shiftHHMM(s.start_at),
          endTime: shiftHHMM(s.end_at),
          date: formatShiftDate(s.start_at),
        });
        setTab('applications');
      });
    return () => { active = false; };
  }, [deepLinkShift]);

  useEffect(() => {
    let active = true;
    const loadWorkerPayoutData = async () => {
      if (!user) {
        setWorkerBanking(null);
        setLivePayouts(null);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, verification_provider, verified_at")
          .eq("user_id", user.id)
          .eq("role", "worker")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, scheduled_date, status, source_refs, created_at")
          .eq("worker_id", user.id)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      if (!active) return;

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
      }
    };

    loadWorkerPayoutData();
    return () => {
      active = false;
    };
  }, [user]);

  const saveWorkerBankingDetails = async () => {
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
  const shiftsSource = liveShifts ?? [];
  // Shifts the worker has an active (still-pending-decision) bid on should not
  // reappear in Discover — they can only place one bid per shift, and the
  // shift already lives in My Bids.
  const appliedShiftIds = useMemo(
    () => new Set((liveApplications ?? []).filter(a => ['pending', 'shortlisted', 'offered', 'accepted'].includes(a.status)).map(a => a.shiftId)),
    [liveApplications]
  );
  const filtered = useMemo(() => {
    let s = shiftsSource.filter(x => !appliedShiftIds.has(x.id));
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
  }, [shiftsSource, appliedShiftIds, filterCat, filterCity, filterArea, filterDate, filterDuration, filterPayMin, filterPayMax, filterHighBooking, filterWeekend, filterTimeStart, filterTimeEnd]);
  const payoutsLoading = Boolean(user) && livePayouts === null;
  const payoutRows = useMemo(
    () => (livePayouts || []).map((p) => ({
      id: p.id,
      shift: p.source_refs?.shift_id ? `Shift #${p.source_refs.shift_id}` : "Completed shift",
      amount: Number(p.amount || 0),
      date: p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA",
      status: p.status,
      travel: 0,
    })),
    [livePayouts]
  );

  const totalEarned = useMemo(
    () => payoutRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [payoutRows]
  );
  const payoutEligibility = workerBanking?.verification_status === "verified";
  const profileName = user
    ? (user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "Your account")
    : "";

  const navItems = [
    { id: "discover", label: t("nav.discover"), icon: <Icons.Search size={20} /> },
    { id: "applications", label: t("nav.myBids"), icon: <Icons.List size={20} /> },
    { id: "chat", label: t("nav.chat"), icon: <Icons.Chat size={20} /> },
    { id: "earnings", label: t("nav.earnings"), icon: <Icons.Money size={20} /> },
    { id: "profile", label: t("nav.profile"), icon: <Icons.User size={20} /> },
    { id: "settings", label: t("nav.settings"), icon: <Icons.Settings size={20} /> },
  ];

  const handleWorkerNavClick = (nextTab) => {
    setShowQR(false);
    setShowBidModal(false);
    setSelectedShift(null);
    setTab(nextTab);
  };

  // Logo click in the header bumps homeSignal → return to Discover.
  const isFirstHome = useRef(true);
  useEffect(() => {
    if (isFirstHome.current) { isFirstHome.current = false; return; }
    handleWorkerNavClick("discover");
  }, [homeSignal]);

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

  // Modal content - rendered on top of main content
  if (showQR) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingTop: 32, paddingLeft: 32, paddingRight: 32, paddingBottom: navPadding, background: BRAND.surface, overflow: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: BRAND.text, marginBottom: 8 }}>{t("worker.checkinTitle")}</div>
        <div style={{ color: BRAND.textMuted, fontSize: 14, marginBottom: 32, textAlign: "center" }}>{t("worker.checkinSubtitle")}</div>
        <div style={{ width: 220, height: 220, background: BRAND.grayLight, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", border: `3px dashed ${BRAND.border}`, marginBottom: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{Icons.Camera({ size: 48 })}</div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>{t("worker.cameraViewfinder")}</div>
          </div>
        </div>
        <div style={{ background: BRAND.greenLight, color: "#065F46", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 600, marginBottom: 16 }}>✓ GPS: KLCC (1.5km — within range)</div>
        <Btn onClick={() => { setShowQR(false); toast(t("toast.checkinSimulated"), "success"); }}>{t("worker.simulateCheckin")}</Btn>
        <Btn variant="secondary" onClick={() => setShowQR(false)} style={{ marginTop: 8 }}>{t("common.back")}</Btn>
      </div>
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  // Shift detail view with bottom nav
  if (selectedShift) return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {showBidModal && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "flex-end", zIndex: 100, borderRadius: 20 }}>
          <div style={{ background: BRAND.surface, borderRadius: "20px 20px 0 0", padding: 24, width: "100%" }}>
            <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.text, marginBottom: 4 }}>{t("shiftDetail.placeBidTitle")}</div>
            <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 20 }}>
              {t("shiftDetail.employerRange")}{selectedShift.wageMin}–RM{selectedShift.wageMax}/h{t("shiftDetail.maxBid")}{(selectedShift.wageMax * 1.5).toFixed(0)}/h
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("shiftDetail.wageAskLabel")}</label>
              <WageRatePicker
                min={selectedShift.wageMin}
                max={selectedShift.wageMax * 1.5}
                value={bidAmount || selectedShift.wageMin}
                onChange={v => setBidAmount(String(v))}
              />
              <div style={{ fontSize: 11, color: BRAND.textMuted, textAlign: "center", marginTop: 4 }}>{t("shiftDetail.rateHelperText")}</div>
            </div>
            {bidAmount && (
              <div style={{ background: BRAND.grayLight, borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>{t("shiftDetail.estimatedTotalPay")}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.green }}>RM{(parseFloat(bidAmount || 0) * selectedShift.hours).toFixed(0)}</div>
                {selectedShift.stipend > 0 && (
                  <div style={{ fontSize: 12, color: BRAND.textMuted }}>+ RM{selectedShift.stipend}{t("shiftDetail.transportAllowanceSuffix")}</div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setShowBidModal(false)} style={{ flex: 1 }}>{t("common.cancel")}</Btn>
              <Btn onClick={() => {
                (async () => {
                  if (!bidAmount) return;
                  if (parseFloat(bidAmount) > selectedShift.wageMax * 1.5) { toast(`${t("toast.maxBidPrefix")}${(selectedShift.wageMax * 1.5).toFixed(0)}/h`, "error"); return; }
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

                  const { data, error } = await supabase.from('applications').insert(payload).select();
                  if (error) {
                    // Unique constraint or FK errors will appear here
                    toast(t("toast.applicationFailed") + error.message, "error");
                    return;
                  }
                  logAnalyticsEvent('bid_placed', { shift_id: selectedShift.id }, user.id);

                  // Update local UI state and liveApplications cache if present
                  setShowBidModal(false);
                  setBidSuccess(true);
                  setLiveApplications(prev => prev ? [{ id: data[0].id, shiftId: selectedShift.id, shiftTitle: selectedShift.title, employer: selectedShift.employer, date: selectedShift.date, wageBid: Number(bidAmount), status: data[0].status || 'pending', appliedAt: data[0].applied_at }, ...prev] : null);
                  setTimeout(() => { setBidSuccess(false); setSelectedShift(null); setTab('applications'); }, 2000);
                })();
              }} style={{ flex: 1 }}>{t("common.submitBid")}</Btn>
            </div>
          </div>
        </div>
      )}
      {bidSuccess && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, borderRadius: 20 }}>
          <div style={{ background: BRAND.surface, borderRadius: 20, padding: isMobile ? 24 : 32, textAlign: "center" }}>
            <div style={{ fontSize: isMobile ? 40 : 48, marginBottom: 12 }}>🎉</div>
            <div style={{ fontWeight: 800, fontSize: isMobile ? 18 : 20, color: BRAND.text }}>{t("shiftDetail.bidSubmitted")}</div>
            <div style={{ color: BRAND.textMuted, fontSize: isMobile ? 12 : 14, marginTop: 8 }}>RM{bidAmount}/h · {t("shiftDetail.bidSubmittedHint")}</div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: navPadding, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark})`, padding: isMobile ? "32px 16px 16px" : "48px 24px 24px", borderRadius: isMobile ? 0 : "20px 20px 0 0", flexShrink: 0 }}>
          <button onClick={() => setSelectedShift(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 13, marginBottom: 12, fontFamily: "inherit" }} aria-label={t("common.back")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></button>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            <Badge color="amber">{selectedShift.category}</Badge>
            <Badge color="green">{t("shiftDetail.positions")} {selectedShift.headcount}</Badge>
            <Badge color="blue">{t("shiftDetail.applied")} {selectedShift.totalApplicants}</Badge>
          </div>
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: "#fff", lineHeight: 1.2, marginBottom: 8 }}>{selectedShift.title}</div>
          <div style={{ fontSize: isMobile ? 12 : 14, color: "rgba(255,255,255,0.85)" }}>{selectedShift.employer}</div>
        </div>
        <div style={{ padding: isMobile ? 14 : 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: isMobile ? 8 : 10, marginBottom: 16 }}>
            <Stat label={t("shiftDetail.wageRange")} value={`RM${selectedShift.wageMin}–${selectedShift.wageMax}`} sub={t("shiftDetail.perHour")} color={BRAND.text} />
            <Stat label={t("shiftDetail.shiftDuration")} value={`${selectedShift.hours}h`} sub={selectedShift.isMultiDay ? t("shiftDetail.daysCount").replace("{count}", selectedShift.occurrences.length) : selectedShift.date} color={BRAND.text} />
            <Stat label={t("shiftDetail.estimatedGross")} value={`RM${selectedShift.wageMax * selectedShift.hours}`} sub={t("shiftDetail.atMaxRate")} color={BRAND.green} />
            <Stat label={t("shiftDetail.transportAllowance")} value={selectedShift.stipend > 0 ? `RM${selectedShift.stipend}` : t("shiftDetail.notProvided")} color={selectedShift.stipend > 0 ? BRAND.blue : BRAND.textMuted} />
          </div>
          {selectedShift.description && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
              <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selectedShift.description}</div>
            </Card>
          )}
          {(() => {
            // Exact address is shown when the employer made it public, or when
            // this worker has been accepted for the shift. Otherwise only the
            // coarse city/region is shown, with a note explaining why.
            const acceptedForShift = selectedShift.myStatus === "accepted";
            const canSeeExact = selectedShift.addressVisibility !== "accepted_only" || acceptedForShift;
            const detailLocation = canSeeExact ? selectedShift.location : overviewLocation(selectedShift.location);
            const locationNote = canSeeExact ? null : t("shiftDetail.locationNote");
            return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("shiftDetail.title")}</div>
            {[
              [t("shiftDetail.location"), detailLocation, locationNote],
              selectedShift.isMultiDay
                ? [t("employer.labelSchedule"), selectedShift.occurrences.map(o => formatOccurrenceLine(o, { weekday: 'short', day: 'numeric', month: 'short' })).join(' · ')]
                : [t("shiftDetail.date"), selectedShift.date],
              !selectedShift.isMultiDay ? [t("shiftDetail.time"), selectedShift.time] : null,
              [t("shiftDetail.dressCode"), selectedShift.dress],
              selectedShift.languageRequirements && selectedShift.languageRequirements.length > 0 ? [t("shiftDetail.languagesRequired"), selectedShift.languageRequirements.join(", ")] : null,
              [t("shiftDetail.headcount"), `${selectedShift.headcount} ${t("shiftDetail.workersNeeded")}`],
              selectedShift.reliabilityScore != null ? [t("shiftDetail.employerScore"), `${selectedShift.reliabilityScore}/100`] : null,
            ].filter(Boolean).map(([k, v, note]) => (
              <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted, width: 130, flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: 13, color: BRAND.text, fontWeight: 500 }}>
                  {v}
                  {note && <span style={{ display: "block", fontSize: 11, color: BRAND.textMuted, fontWeight: 400, marginTop: 2 }}>🔒 {note}</span>}
                </span>
              </div>
            ))}
          </Card>
            );
          })()}
          <Card style={{ marginBottom: 20, background: BRAND.grayLight, border: "none" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: BRAND.text }}>{t("shiftDetail.employerReliability")}</div>
            {selectedShift.reliabilityScore != null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <div style={{ flex: 1 }}><Progress value={selectedShift.reliabilityScore} color={selectedShift.reliabilityScore > 90 ? BRAND.green : selectedShift.reliabilityScore > 75 ? BRAND.accent : BRAND.red} /></div>
                <span style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>{selectedShift.reliabilityScore}/100</span>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 8 }}>{t("shiftDetail.employerScoreSignInToView")}</div>
            )}
            <div style={{ display: "flex", gap: 16 }}>
              <StarRating value={selectedShift.rating} />
              <span style={{ fontSize: 12, color: BRAND.textMuted }}>{selectedShift.totalApplicants} {t("shiftDetail.applicants")}</span>
            </div>
          </Card>
          <Btn onClick={() => { if (user) { setBidAmount(String(selectedShift.wageMin)); setShowBidModal(true); } else { setPendingBidAfterAuth(true); onRequireAuth("signin"); } }} style={{ width: "100%", justifyContent: "center", fontSize: isMobile ? 14 : 16, padding: isMobile ? "12px 0" : "14px 0", marginBottom: 20 }}>
            {user ? t("common.placeBid") : t("common.signInToBid")}
          </Btn>
        </div>
      </div>
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => handleWorkerNavClick(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", paddingTop: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingLeft: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingRight: tab === "discover" ? 0 : isMobile ? 12 : 20, paddingBottom: navPadding, width: "100%", maxWidth: isMobile ? "100%" : 1160, margin: isMobile ? 0 : "0 auto", minHeight: 0 }}>
        {tab === "discover" && (
          <div>
            <div style={{ padding: isMobile ? "12px 12px 0" : "20px 20px 0", background: `linear-gradient(160deg, ${BRAND.primary}15, transparent)` }}>
              <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, color: BRAND.text, marginBottom: 2 }}>Selamat Datang 👋</div>
              <div style={{ fontSize: isMobile ? 12 : 14, color: BRAND.textMuted, marginBottom: 12 }}>Find shifts near you — bid your rate</div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 12, scrollbarWidth: "none" }}>
                {cats.map(c => (
                  <button key={c} onClick={() => setFilterCat(c)} style={{
                    padding: isMobile ? "6px 12px" : "8px 16px", borderRadius: 99, border: "none", cursor: "pointer", fontFamily: "inherit",
                    fontWeight: 600, fontSize: isMobile ? 12 : 13, whiteSpace: "nowrap",
                    background: filterCat === c ? BRAND.primary : BRAND.grayLight,
                    color: filterCat === c ? "#fff" : BRAND.textMuted,
                    transition: "all 0.15s",
                  }}>{c}</button>
                ))}
              </div>
            </div>
            <div style={{ padding: isMobile ? "0 12px 8px" : "0 20px 8px" }}>
              {(() => {
                const activeFilterCount = [filterCity, filterArea, filterDate, filterPayMin, filterPayMax, filterDuration, filterTimeStart, filterTimeEnd].filter(Boolean).length
                  + (filterCat !== 'All' ? 1 : 0)
                  + (filterHighBooking ? 1 : 0)
                  + (filterWeekend ? 1 : 0);
                return (
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
                    <button
                      onClick={() => setShowFilters(f => !f)}
                      style={{fontSize:12,padding:'4px 10px',borderRadius:6,border:'1px solid #e2e8f0',background:'#f8fafc',cursor:'pointer',color:'#64748b'}}
                    >
                      {showFilters ? `${t("discover.hideFiltersLabel")} ▲` : `${t("discover.filtersLabel")}${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} ▼`}
                    </button>
                  </div>
                );
              })()}
              {showFilters && (
                <div style={{marginBottom:12, padding:12, background:'#f8fafc', borderRadius:8, border:'1px solid #e2e8f0'}}>
                  {/* Row 1: Location, Date, Duration */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterCity")}</div>
                      <select value={filterCity} onChange={e=>{ setFilterCity(e.target.value); setFilterArea(''); }}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box', background:'#fff', marginBottom:4}}>
                        <option value="">{t("discover.anyCity")}</option>
                        {Object.keys(CITY_REGIONS).map(city => (
                          <option key={city} value={city}>{city}</option>
                        ))}
                      </select>
                      {filterCity && (
                        <input placeholder={t("discover.filterAreaPlaceholder")} value={filterArea} onChange={e=>setFilterArea(e.target.value)}
                          style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:12, boxSizing:'border-box', color:'#64748b'}} />
                      )}
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterDate")}</div>
                      <input type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterMaxDuration")}</div>
                      <input type="number" min="0" placeholder={t("discover.filterMaxDurationPlaceholder")} value={filterDuration} onChange={e=>setFilterDuration(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 2: Job type, Min pay, Max pay */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterJobType")}</div>
                      <select value={filterCat} onChange={e=>setFilterCat(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box', background:'#fff'}}>
                        <option value="All">{t("discover.allTypes")}</option>
                        {SHIFT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterMinPay")}</div>
                      <input type="number" min="0" placeholder={t("discover.filterMinPayPlaceholder")} value={filterPayMin} onChange={e=>setFilterPayMin(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterMaxPay")}</div>
                      <input type="number" min="0" placeholder={t("discover.filterMaxPayPlaceholder")} value={filterPayMax} onChange={e=>setFilterPayMax(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 3: Start time, End time */}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8}}>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterStartsAfter")}</div>
                      <input type="time" value={filterTimeStart} onChange={e=>setFilterTimeStart(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                    <div>
                      <div style={{fontSize:11, color:'#64748b', marginBottom:3}}>{t("discover.filterEndsBy")}</div>
                      <input type="time" value={filterTimeEnd} onChange={e=>setFilterTimeEnd(e.target.value)}
                        style={{width:'100%', padding:'6px 8px', borderRadius:6, border:'1px solid #e2e8f0', fontSize:13, boxSizing:'border-box'}} />
                    </div>
                  </div>
                  {/* Row 4: Toggles */}
                  <div style={{display:'flex', gap:16, flexWrap:'wrap'}}>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:13, color:'#374151'}}>
                      <input type="checkbox" checked={filterHighBooking} onChange={e=>setFilterHighBooking(e.target.checked)}
                        style={{width:15, height:15, accentColor:'#2563EB'}} />
                      {t("discover.highBookingChance")}
                    </label>
                    <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:13, color:'#374151'}}>
                      <input type="checkbox" checked={filterWeekend} onChange={e=>setFilterWeekend(e.target.checked)}
                        style={{width:15, height:15, accentColor:'#2563EB'}} />
                      {t("discover.weekendsOnly")}
                    </label>
                  </div>
                  {/* Clear all button */}
                  <div style={{display:'flex', justifyContent:'flex-end', marginTop:8}}>
                    {(filterCity||filterArea||filterDate||filterPayMin||filterPayMax||filterDuration||filterCat!=='All'||filterHighBooking||filterWeekend||filterTimeStart||filterTimeEnd) && (
                      <button onClick={() => {
                        setFilterCity(''); setFilterArea(''); setFilterDate(''); setFilterPayMin(''); setFilterPayMax('');
                        setFilterDuration(''); setFilterCat('All');
                        setFilterHighBooking(false); setFilterWeekend(false);
                        setFilterTimeStart(''); setFilterTimeEnd('');
                      }} style={{fontSize:12, padding:'5px 14px', borderRadius:6, border:'1px solid #fca5a5', background:'#fef2f2', cursor:'pointer', color:'#ef4444'}}>
                        {t("discover.clearAll")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: isMobile ? "8px 12px 12px" : "8px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              {filtered.length === 0 && (
                <EmptyState
                  icon="🔍"
                  title={liveShifts === null ? t("discover.loadingShifts") : t("discover.noShiftsMatch")}
                  hint={liveShifts === null ? t("discover.loadingShiftsHint") : t("discover.noShiftsMatchHint")}
                />
              )}
              {filtered.map(s => (
                <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "12px 12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                          <Badge color="amber" size="xs">{s.category}</Badge>
                        </div>
                        <div style={{ fontWeight: 700, fontSize: isMobile ? 13 : 15, color: BRAND.text, lineHeight: 1.3, marginBottom: 2 }}>{s.title}</div>
                        <div style={{ fontSize: isMobile ? 11 : 12, color: BRAND.textMuted }}>{s.employer}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                        {/* Estimated total for the shift (lower-bound rate × hours) is the
                            headline figure; the hourly range drops to the small muted line. */}
                        <div style={{ fontWeight: 800, fontSize: isMobile ? 15 : 18, color: BRAND.primary }}>~RM{Math.round(s.wageMin * s.hours)}</div>
                        <div style={{ fontSize: isMobile ? 10 : 11, color: BRAND.textMuted }}>RM{s.wageMin}–{s.wageMax}/hour</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${BRAND.border}`, marginTop: 10 }}>
                    {[
                      [s.isMultiDay ? t("shiftDetail.daysCount").replace("{count}", s.occurrences.length) : s.date, "📅"],
                      // Listing cards only ever show the city/region, never the exact place.
                      [overviewLocation(s.location), "📍"],
                      [`${s.hours}h`, "⏱️"],
                      [`${s.headcount} pos · ${s.totalApplicants} applied`, "👥"],
                    ].map(([v, ico], i) => (
                      <div key={i} style={{ flex: 1, padding: isMobile ? "6px 0" : "8px 0", textAlign: "center", borderRight: i < 3 ? `1px solid ${BRAND.border}` : "none" }}>
                        <div style={{ fontSize: isMobile ? 11 : 13 }}>{ico}</div>
                        <div style={{ fontSize: isMobile ? 9 : 10, color: BRAND.textMuted, marginTop: 1, lineHeight: 1.3 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {tab === "applications" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="📄"
            title={t("myBids.signInTitle")}
            hint={t("myBids.signInHint")}
          />
        )}

        {tab === "applications" && user && !selectedApplication && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("nav.myBids")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(liveApplications ?? []).length === 0 && (
                <EmptyState
                  icon="📄"
                  title={liveApplications === null ? t("myBids.loadingBids") : t("myBids.noBidsYet")}
                  hint={liveApplications === null ? t("myBids.loadingBidsHint") : t("myBids.noBidsHint")}
                />
              )}
              {(liveApplications ?? []).map(a => (
                <Card key={a.id} onClick={() => setSelectedApplication(a)} hover>
                  {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, background: BRAND.grayLight, fontSize: 11, fontWeight: 600, color: BRAND.textMuted, marginBottom: 8 }}>
                      {t("myBids.employerDecidesByPrefix")}{formatShiftDate(a.shiftStartAt, { day: 'numeric', month: 'short' })}, {formatShiftTime(a.shiftStartAt)}
                    </div>
                  )}
                  {a.status === "offered" && a.offerExpiresAt && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, background: BRAND.blueLight, fontSize: 11, fontWeight: 600, color: BRAND.blue, marginBottom: 8 }}>
                      {t("myBids.respondByPrefix")}{formatShiftDate(a.offerExpiresAt, { day: 'numeric', month: 'short' })}, {formatShiftTime(a.offerExpiresAt)}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 2 }}>{a.shiftTitle}</div>
                      <div style={{ fontSize: 12, color: BRAND.textMuted }}>{a.employer} · {a.isMultiDay ? formatOccurrencesSummary(a.shiftOccurrences) : a.date}</div>
                    </div>
                    <Pill
                      label={a.shiftStatus === "cancelled" ? t("myBids.pillShiftCancelled") : a.status === "offered" ? t("myBids.pillConfirmNow") : a.status === "shortlisted" ? t("myBids.pillShortlisted") : a.status === "accepted" ? t("myBids.pillAccepted") : a.status === "expired" ? t("myBids.pillOfferExpired") : a.status === "rejected" ? t("myBids.pillNotSelected") : t("myBids.pillPending")}
                      color={a.shiftStatus === "cancelled" ? "red" : a.status === "offered" ? "blue" : a.status === "shortlisted" ? "amber" : a.status === "accepted" ? "green" : (a.status === "expired" || a.status === "rejected") ? "red" : "gray"}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("myBids.yourBidPrefix")}</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.text }}>RM{a.wageBid}/h</span>
                    </div>
                    {a.status === "shortlisted" && (
                      <Btn size="sm" onClick={(e) => { e.stopPropagation(); setTab('chat'); }}>{t("myBids.chatBtn")}</Btn>
                    )}
                    {a.status === "accepted" && a.shiftStatus !== "cancelled" && (
                      <Btn size="sm" variant="success" onClick={(e) => { e.stopPropagation(); setShowQR(true); }}>{t("worker.checkInBtn")}</Btn>
                    )}
                  </div>
                  {a.status === "shortlisted" && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: BRAND.amberLight, borderRadius: 8, fontSize: 12, color: BRAND.amber }}>
                      {t("myBids.shortlistedBanner")}
                    </div>
                  )}
                  {a.status === 'accepted' && !a.workerSignedAt && a.shiftStatus !== 'cancelled' && (
                    <button onClick={(e) => { e.stopPropagation(); setWorkerContractModal({
                        applicationId: a.id,
                        shiftTitle: a.shiftTitle,
                        shiftDate: a.date,
                        wageAsk: a.wageBid,
                        employerName: a.employer,
                      }); }}
                      style={{marginTop:6, padding:'6px 14px', borderRadius:6, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontSize:12, fontWeight:600}}>
                      {t("myBids.signContractBtn")}
                    </button>
                  )}
                  {a.status === 'accepted' && a.workerSignedAt && (
                    <div style={{display:'flex', alignItems:'center', gap:8, marginTop:4}}>
                      <span style={{fontSize:11, color:'#16a34a'}}>{t("myBids.contractSignedBadge")}</span>
                      <button onClick={(e) => { e.stopPropagation(); setWorkerContractModal({
                          applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid, employerName: a.employer, readOnly: true,
                        }); }}
                        style={{padding:'4px 10px', borderRadius:6, background:'none', color: BRAND.primary, border:`1px solid ${BRAND.primary}`, cursor:'pointer', fontSize:11, fontWeight:600}}>
                        {t("contract.viewContractBtn")}
                      </button>
                    </div>
                  )}
                  {a.shiftStatus === 'completed' && (
                    <button onClick={(e) => { e.stopPropagation(); setDisputeModal({ applicationId: a.id, shiftTitle: a.shiftTitle }); }}
                      style={{marginTop:8, padding:'6px 14px', borderRadius:6, background: BRAND.grayLight, color: BRAND.text, border: `1px solid ${BRAND.border}`, cursor:'pointer', fontSize:12, fontWeight:600}}>
                      {t("myBids.fileDisputeBtn")}
                    </button>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {tab === "applications" && user && selectedApplication && (() => {
          const a = selectedApplication;
          return (
          <div>
            <button onClick={() => setSelectedApplication(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: BRAND.primary, fontFamily: "inherit", marginBottom: 16 }} aria-label={t("myBids.backToBids")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("myBids.backToBids")}</span></button>
            {a.status === "pending" && a.shiftStartAt && a.shiftStatus !== "cancelled" && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99, background: BRAND.grayLight, fontSize: 12, fontWeight: 600, color: BRAND.textMuted, marginBottom: 10 }}>
                {t("myBids.employerDecidesByPrefix")}{formatShiftDate(a.shiftStartAt, { day: 'numeric', month: 'short', year: 'numeric' })}, {formatShiftTime(a.shiftStartAt)}
              </div>
            )}
            {a.status === "offered" && a.offerExpiresAt && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99, background: BRAND.blueLight, fontSize: 12, fontWeight: 600, color: BRAND.blue, marginBottom: 10 }}>
                {t("myBids.respondByPrefix")}{formatShiftDate(a.offerExpiresAt, { day: 'numeric', month: 'short', year: 'numeric' })}, {formatShiftTime(a.offerExpiresAt)}
              </div>
            )}
            <div style={{ fontSize: 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{a.shiftTitle}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill
                label={a.shiftStatus === "cancelled" ? t("myBids.pillShiftCancelled") : a.status === "offered" ? t("myBids.pillConfirmNow") : a.status === "shortlisted" ? t("myBids.pillShortlisted") : a.status === "accepted" ? t("myBids.pillAccepted") : a.status === "expired" ? t("myBids.pillOfferExpired") : a.status === "rejected" ? t("myBids.pillNotSelected") : t("myBids.pillPending")}
                color={a.shiftStatus === "cancelled" ? "red" : a.status === "offered" ? "blue" : a.status === "shortlisted" ? "amber" : a.status === "accepted" ? "green" : (a.status === "expired" || a.status === "rejected") ? "red" : "gray"}
              />
              {a.shiftCategory && <Badge color="amber">{a.shiftCategory}</Badge>}
            </div>
            {a.shiftStatus === "cancelled" && !a.cancellationChoiceDeadline && (
              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 10, fontSize: 12, color: BRAND.red, marginBottom: 16 }}>
                {t("myBids.shiftCancelledNotice")}
              </div>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoiceDeadline && !a.cancellationChoice && (
              <Card style={{ marginBottom: 16, border: `1.5px solid ${BRAND.red}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.red, marginBottom: 4 }}>{t("myBids.lateCancellationTitle")}</div>
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 4 }}>
                  {t("myBids.lateCancellationBody")}
                </div>
                <div style={{ fontSize: 11, color: BRAND.textMuted, marginBottom: 12 }}>
                  {t("myBids.respondByPrefix")}{new Date(a.cancellationChoiceDeadline).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: MY_TIMEZONE })}, {new Date(a.cancellationChoiceDeadline).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: MY_TIMEZONE })}
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <Btn variant="secondary" style={{ flex: 1, justifyContent: "center" }}
                    onClick={() => setCancellationContractModal({ applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid })}>
                    {t("myBids.cancellation50Btn")}
                  </Btn>
                </div>
                <label style={{ display: "block" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("myBids.cancellationShowUpLabel")}</div>
                  <div style={{ fontSize: 11, color: BRAND.textMuted, marginBottom: 8 }}>{t("myBids.cancellationShowUpHint")}</div>
                  <input
                    type="file" accept="image/*" capture="environment"
                    disabled={cancellationProofUploading === a.id}
                    onChange={e => { const f = e.target.files?.[0]; if (f) submitShowUpProof(a.id, f); e.target.value = ""; }}
                    style={{ fontSize: 12 }}
                  />
                  {cancellationProofUploading === a.id && <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 6 }}>{t("myBids.cancellationProofUploading")}</div>}
                </label>
              </Card>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoice === "contract_50" && (
              <div style={{ padding: "10px 14px", background: BRAND.grayLight, borderRadius: 10, fontSize: 12, color: BRAND.text, marginBottom: 16 }}>
                {t("myBids.cancellationChose50")}
              </div>
            )}
            {a.shiftStatus === "cancelled" && a.cancellationChoice === "show_up_100" && (
              <div style={{ padding: "10px 14px", background: a.cancellationProofPath ? BRAND.greenLight : BRAND.amberLight, borderRadius: 10, fontSize: 12, color: a.cancellationProofPath ? BRAND.green : BRAND.amber, marginBottom: 16 }}>
                {a.cancellationProofPath ? t("myBids.cancellationProofSubmitted") : t("myBids.cancellationAwaitingProof")}
              </div>
            )}
            {a.status === "offered" && a.shiftStatus !== "cancelled" && (
              <div style={{ padding: "10px 14px", background: BRAND.blueLight, borderRadius: 10, fontSize: 12, color: BRAND.blue, marginBottom: 16 }}>
                {t("myBids.selectedNotice")}
              </div>
            )}
            {a.status === "expired" && (
              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 10, fontSize: 12, color: BRAND.red, marginBottom: 16 }}>
                {t("myBids.offerExpiredNotice")}
              </div>
            )}
            {a.shiftDescription && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("shiftDetail.aboutRole")}</div>
                <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{a.shiftDescription}</div>
              </Card>
            )}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("shiftDetail.title")}</div>
              {[
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
                  <span style={{ fontSize: 13, color: BRAND.textMuted, width: 150, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 13, color: BRAND.text, fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </Card>
            {a.status === "shortlisted" && (
              <div style={{ padding: "10px 14px", background: BRAND.amberLight, borderRadius: 10, fontSize: 12, color: BRAND.amber, marginBottom: 16 }}>
                {t("myBids.shortlistedBanner")}
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
                <Btn onClick={() => setWorkerContractModal({ applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid, employerName: a.employer })} style={{ flex: 1, justifyContent: "center" }}>{t("myBids.signContractBtn")}</Btn>
              )}
              {a.status === "accepted" && a.workerSignedAt && a.shiftStatus !== "cancelled" && (
                <>
                  <Btn variant="secondary" onClick={() => setWorkerContractModal({
                      applicationId: a.id, shiftTitle: a.shiftTitle, shiftDate: a.date, wageAsk: a.wageBid, employerName: a.employer, readOnly: true,
                    })} style={{ flex: 1, justifyContent: "center" }}>{t("contract.viewContractBtn")}</Btn>
                  <Btn variant="success" onClick={() => setShowQR(true)} style={{ flex: 1, justifyContent: "center" }}>{t("worker.checkInBtn")}</Btn>
                </>
              )}
              {a.shiftStatus === "completed" && (
                <Btn variant="secondary" onClick={() => setDisputeModal({ applicationId: a.id, shiftTitle: a.shiftTitle })} style={{ flex: 1, justifyContent: "center" }}>{t("myBids.fileDisputeBtn")}</Btn>
              )}
            </div>
          </div>
          );
        })()}

        {tab === 'chat' && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="💬"
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
            <h2 style={{fontSize: isMobile ? 18 : 20, fontWeight:800, color:BRAND.text, margin:'16px 0 12px', flexShrink:0}}>{t("chat.title")}</h2>
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:BRAND.textMuted, marginTop:48}}>
                  <div style={{fontSize:40}}>💬</div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleWorker")}</div>
                  <div style={{fontSize:12, marginTop:4}}>{t("chat.emptyHintWorker")}</div>
                </div>
              ) : (
                chatConversations.map(conv => (
                  <div key={conv.shiftId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:BRAND.surface, borderRadius:10, border:`1px solid ${BRAND.border}`,
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:600, color:BRAND.text}}>{conv.title}</div>
                      <div style={{fontSize:12, color:BRAND.textMuted}}>{conv.date} · {conv.otherUserLabel}</div>
                    </div>
                    <span style={{color:BRAND.textMuted}}>›</span>
                  </div>
                ))
              )
            ) : (
              <div style={{display:'flex', flexDirection:'column', flex:1, minHeight:0}}>
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    style={{background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#2563EB'}}>←</button>
                  <div>
                    <div style={{fontWeight:600, color:BRAND.text}}>{activeChatShift.title}</div>
                    <div style={{fontSize:12, color:BRAND.textMuted}}>{activeChatShift.otherUserLabel}</div>
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingBottom:8}}>
                  {chatLoading && <div style={{textAlign:'center', color:BRAND.textMuted, padding:16}}>{t("chat.loading")}</div>}
                  {chatMessages.map(msg => {
                    const isMe = msg.sender_id === user.id;
                    return (
                      <div key={msg.id} style={{display:'flex', flexDirection:'column', alignItems: isMe ? 'flex-end' : 'flex-start'}}>
                        <div style={{fontSize:11, fontWeight:600, color:BRAND.textMuted, margin: isMe ? '0 2px 2px 0' : '0 0 2px 2px'}}>
                          {isMe ? 'You' : (chatSenderNames[msg.sender_id] || 'Member')}
                        </div>
                        <div style={{maxWidth:'75%', padding:'8px 12px', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                          background: isMe ? BRAND.primary : BRAND.grayLight, color: isMe ? '#fff' : BRAND.text, fontSize:14}}>
                          <div>{msg.content}</div>
                          <div style={{fontSize:10, opacity:0.6, marginTop:2, textAlign:'right'}}>
                            {new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <div style={{display:'flex', gap:8, paddingTop:8, borderTop:`1px solid ${BRAND.border}`}}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    placeholder={t("chat.inputPlaceholder")}
                    style={{flex:1, padding:'10px 12px', borderRadius:8, border:`1px solid ${BRAND.border}`, fontSize:14, background:BRAND.input, color:BRAND.text}}
                  />
                  <button onClick={sendMessage}
                    style={{padding:'10px 16px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
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
            icon="💸"
            title={t("earnings.signInTitle")}
            hint={t("earnings.signInHint")}
          />
        )}

        {tab === "earnings" && user && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("earnings.title")}</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>{t("earnings.subtitle")}</div>
            <div style={{ background: `linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark})`, borderRadius: 20, padding: isMobile ? 18 : 24, marginBottom: 20, color: "#fff" }}>
              <div style={{ fontSize: isMobile ? 11 : 12, opacity: 0.8, marginBottom: 8 }}>{t("earnings.totalPayouts")}</div>
              <div style={{ fontSize: isMobile ? 32 : 38, fontWeight: 900, marginBottom: 4 }}>{toCurrency(totalEarned)}</div>
              <div style={{ fontSize: isMobile ? 12 : 13, opacity: 0.8 }}>
                {payoutEligibility ? t("earnings.verified") : t("earnings.notVerified")}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label={t("earnings.statRecords")} value={String(payoutRows.length)} color={BRAND.primary} />
              <Stat label={t("earnings.statReady")} value={String(payoutRows.filter(p => p.status === "ready").length)} color={BRAND.green} />
              <Stat label={t("earnings.statHeld")} value={String(payoutRows.filter(p => p.status === "held").length)} color={BRAND.red} />
              <Stat label={t("earnings.statBanking")} value={workerBanking?.verification_status || "pending"} sub="SecureSign" color={BRAND.blue} />
            </div>
            <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("earnings.recentPayouts")}</div>
            {payoutsLoading ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : payoutRows.length === 0 ? (
              <EmptyState
                icon="💸"
                title={t("earnings.noPayoutsTitle")}
                hint={t("earnings.noPayoutsHint")}
              />
            ) : (
              payoutRows.map((p) => (
                <Card key={p.id} style={{ marginBottom: 10, padding: "14px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: BRAND.text }}>{p.shift}</div>
                      <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>{p.date} · {p.travel > 0 ? `+RM${p.travel} travel` : t("earnings.salaryPayout")}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 800, fontSize: 16, color: BRAND.green }}>+{toCurrency(p.amount)}</div>
                      <Pill label={String(p.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(p.status)} />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === "profile" && !user && (
          <AuthGate
            onRequireAuth={onRequireAuth}
            icon="👤"
            title={t("profile.signInTitle")}
            hint={t("profile.signInHint")}
          />
        )}

        {tab === "profile" && user && (
          <div>
            <div style={{ textAlign: "center", padding: isMobile ? "12px 0 16px" : "20px 0 24px" }}>
              <div style={{ display: "inline-block", position: "relative" }}>
                <Avatar name={profileName} size={isMobile ? 56 : 72} color={BRAND.primary} src={getAvatarUrl(user.user_metadata?.avatar_url)} />
                <label style={{
                  position: "absolute", right: -2, bottom: -2, width: 26, height: 26,
                  borderRadius: "50%", background: BRAND.primary, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: avatarUploading ? "wait" : "pointer", fontSize: 13,
                  border: `2px solid ${BRAND.surface}`,
                }} title={t("profile.changePhoto")}>
                  {avatarUploading ? "…" : "✎"}
                  <input type="file" accept="image/*" disabled={avatarUploading}
                    onChange={(e) => handleAvatarUpload(e.target.files?.[0])}
                    style={{ display: "none" }} />
                </label>
              </div>
              {/* Full name is not user-editable here: it's tied to KYC identity
                  verification and the employment contract, so it may only be
                  set at registration (matched against the uploaded MyKad) or
                  backfilled from an OAuth provider's own asserted name — never
                  freely retyped after the fact. */}
              <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginTop: isMobile ? 8 : 12 }}>{profileName}</div>
              <div style={{ fontSize: isMobile ? 12 : 14, color: BRAND.textMuted }}>{user.email}</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                <Badge color="teal">{t("profile.standardKyc")}</Badge>
                <Badge color="green">🛡️ {profileStats.reliability_score}/100 {t("profile.reliabilitySuffix")}</Badge>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <Stat label={t("profile.shiftsDone")} value={workerShiftsDone ?? "—"} color={BRAND.primary} />
              <Stat label={t("profile.rating")} value={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span>⭐ {(profileStats.rating ?? 0).toFixed(1)}</span></span>} color={BRAND.accent} />
              <Stat label={t("profile.strikes")} value={t("common.comingSoon")} sub={t("profile.notTrackedYet")} color={BRAND.textMuted} />
              <Stat label={t("profile.onTimeRate")} value={t("common.comingSoon")} sub={t("profile.notTrackedYet")} color={BRAND.textMuted} />
            </div>
            {kycLevel === "Basic" && (
              // Worker deferred their KYC document uploads during progressive
              // sign-up (kyc_level never left the default). Nudge them to
              // finish — the button reopens the details modal in kycOnly mode.
              <Card style={{ marginBottom: 16, border: `1.5px solid ${BRAND.amber}`, background: BRAND.amberLight }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.amber, marginBottom: 4 }}>{t("profile.completeKycTitle")}</div>
                <div style={{ fontSize: 12, color: BRAND.amber, marginBottom: 12, lineHeight: 1.5 }}>{t("profile.completeKycHint")}</div>
                <Btn size="sm" onClick={onOpenKycUpload}>{t("profile.completeKycBtn")}</Btn>
              </Card>
            )}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.kycVerification")}</div>
              {[{ tier: t("profile.kycBasic"), status: "verified" }, { tier: t("profile.kycStandard"), status: "verified" }, { tier: t("profile.kycAdvanced"), status: "not started" }].map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < 2 ? `1px solid ${BRAND.border}` : "none" }}>
                  <span style={{ fontSize: 13, color: BRAND.text }}>{v.tier}</span>
                  <Pill label={v.status === "verified" ? t("profile.verified") : "—"} color={v.status === "verified" ? "green" : "gray"} />
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("profile.reliabilityScoreLabel")}{profileStats.reliability_score}</div>
              <Progress value={Math.min(100, Math.max(0, profileStats.reliability_score))} color={profileStats.reliability_score > 90 ? BRAND.green : profileStats.reliability_score > 75 ? BRAND.accent : BRAND.red} />
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8 }}>{profileStats.reliability_score >= 90 ? t("profile.reliabilityExcellent") :
 profileStats.reliability_score >= 75 ? t("profile.reliabilityGood") :
 profileStats.reliability_score >= 50 ? t("profile.reliabilityBuilding") :
 t("profile.reliabilityLow")}</div>
            </Card>
            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.recentRatings")}</div>
              <EmptyState icon="⭐" title={t("profile.noRatingsTitle")} hint={t("profile.noRatingsHint")} />
            </Card>
          </div>
        )}

        {tab === "settings" && (
          <div>
            <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("settings.title")}</div>
            <div style={{ fontSize: isMobile ? 12 : 13, color: BRAND.textMuted, marginBottom: 16 }}>{t("settings.subtitle")}</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("settings.account")}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.language")}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn
                    size="xs"
                    variant={language === "en" ? "primary" : "secondary"}
                    onClick={() => setLanguage("en")}
                    aria-pressed={language === "en"}
                  >
                    {t("settings.languageEnglish")}
                  </Btn>
                  <Btn
                    size="xs"
                    variant={language === "bm" ? "primary" : "secondary"}
                    onClick={() => setLanguage("bm")}
                    aria-pressed={language === "bm"}
                  >
                    {t("settings.languageBM")}
                  </Btn>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.notifications")}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("settings.notificationsValue")}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                <span style={{ fontSize: 13, color: BRAND.textMuted }}>{t("settings.privacy")}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("settings.privacyValue")}</span>
              </div>
            </Card>
            {!user && (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.salaryBankingTitle")}</div>
                <AuthGate
                  onRequireAuth={onRequireAuth}
                  icon="🏦"
                  title={t("settings.bankingSignInTitle")}
                  hint={t("settings.bankingSignInHint")}
                />
              </Card>
            )}
            {user && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.salaryBankingTitle")}</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                {t("settings.salaryBankingHint")}
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
                <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t("settings.status")}</span>
                <Pill
                  label={workerBanking?.verification_status ? `SecureSign ${workerBanking.verification_status}` : t("settings.secureSignPending")}
                  color={mapVerificationPillColor(workerBanking?.verification_status)}
                />
              </div>
              {workerBanking?.account_number_last4 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                  {t("employer.savedAccountPrefix")} {workerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.saveBanking")}</Btn>
                <Btn onClick={verifyWorkerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.verifySecureSign")}</Btn>
              </div>
            </Card>
            )}
            {(() => {
              const isAdminAccount = user?.app_metadata?.role === "admin";
              const canSeeEmployer = userRole === "employer" || isAdminAccount;
              if (!canSeeEmployer && !isAdminAccount) return null;
              return (
                <Card style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("settings.accessOtherConsoles")}</div>
                  <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 14 }}>{t("settings.accessOtherConsolesHint")}</div>
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
                <span style={{fontSize:14, fontWeight:600, color:BRAND.text}}>
                  📋 Terms & Conditions — Malaysian Labor Law
                </span>
                <span style={{fontSize:12, color:BRAND.textMuted}}>{showTnC ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {showTnC && (
                <div style={{marginTop:12, fontSize:13, color:BRAND.text, lineHeight:1.7}}>
                  <p style={{color:BRAND.textMuted, fontSize:12, marginBottom:12}}>
                    ⚠️ This is a summary for general guidance only. Consult a Malaysian employment lawyer before making decisions. Last updated: June 2026.
                  </p>

                  {[
                    {
                      title: '1. Employment Act Coverage',
                      body: 'Since the 2022 amendments (in force 1 Jan 2023), ALL employees in Peninsular Malaysia are covered regardless of salary. Workers earning below RM4,000/month are entitled to overtime pay (1.5×), rest day premiums (2×), and public holiday premiums (3×). Casual/single-shift workers are covered from their first day of work, though annual leave and sick leave require at least 1 month of continuous service with the same employer.'
                    },
                    {
                      title: '2. EPF (KWSP) — Employees Provident Fund',
                      body: 'EPF contributions are mandatory for any employee under a contract of service, from their very first day — there is no minimum hours or days threshold. Rates (2025–2026): Employer 13% + Employee 11% for wages ≤ RM5,000/month. Employer 12% + Employee 11% for wages > RM5,000/month. Foreign workers: Employer 2% + Employee 2% (from Oct 2025). EPF obligations belong to the hiring business, not to CariGaji as a marketplace platform.'
                    },
                    {
                      title: '3. SOCSO (PERKESO) — Social Security',
                      body: 'SOCSO is mandatory from an employee\'s first day of work. Wage ceiling is RM6,000/month (from Oct 2024). Rates: Employer 1.75% + Employee 0.5% (below age 60). SOCSO covers workplace injuries under the Employment Injury Scheme from Day 1, and invalidity from non-work causes for workers below age 60. The hiring business on CariGaji is responsible for registering and contributing SOCSO for their workers.'
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
                      body: 'The Gig Workers Act 2025 (Act 872) came into force on 31 March 2026, creating a new legal category between employee and independent contractor. Under Act 872, platform providers (digital intermediaries connecting gig workers to service users — which may include CariGaji) must: register gig workers with PERKESO; deduct and remit 1.25% of each transaction to PERKESO under the self-employment social security scheme; provide written service agreements; and integrate payment systems with PERKESO. EPF is not required for gig workers under Act 872. Non-compliance penalties: up to 2 years imprisonment or RM10,000 fine. CariGaji is currently seeking legal advice on its classification under this Act.'
                    },
                    {
                      title: '7. Minimum Wage (2025)',
                      body: 'The minimum wage in Malaysia is RM1,700/month or RM8.72/hour (effective August 2025 for all employers). This applies to all workers including casual and short-term shift workers. No exceptions exist for gig or platform workers. Employers on CariGaji must not post shifts with a wage below RM8.72/hour.'
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
                      title: '10. Platform Liability — CariGaji\'s Role',
                      body: 'CariGaji operates as a technology marketplace connecting employers and workers. The legal employment relationship — and the resulting EPF, SOCSO, EIS, minimum wage, and Employment Act obligations — is between the worker and the hiring business, not between the worker and CariGaji. CariGaji does not set hours, direct how work is performed, or pay wages directly. Employers using CariGaji are responsible for complying with all applicable Malaysian employment laws. CariGaji is separately assessing its obligations as a potential platform provider under the Gig Workers Act 2025 (Act 872). This summary does not constitute legal advice.'
                    },
                  ].map(({ title, body }) => (
                    <div key={title} style={{marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${BRAND.border}`}}>
                      <div style={{fontWeight:600, marginBottom:4, color:BRAND.text}}>{title}</div>
                      <div style={{color:BRAND.textMuted}}>{body}</div>
                    </div>
                  ))}

                  <p style={{fontSize:11, color:BRAND.textMuted, marginTop:8}}>
                    References: Employment Act 1955 (Act 265) · EPF Act 1991 (Act 452) · SOCSO Act 1969 (Act 4) · EIS Act 2017 (Act 800) · Gig Workers Act 2025 (Act 872) · Minimum Wages Act 2012 (Act 732) · Income Tax Act 1967 (Act 53)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={navBarStyle}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            flex: isMobile ? 1 : "0 0 auto", padding: isMobile ? "6px 0" : "8px 18px", border: "none", background: "none", cursor: "pointer",
            display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "center", gap: isMobile ? 2 : 8,
            borderRadius: isMobile ? 0 : 8,
            color: tab === n.id ? BRAND.primary : BRAND.textMuted,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1 }}>{n.icon}</span>
            <span style={{ fontSize: isMobile ? 9 : 14, fontWeight: tab === n.id ? 700 : 500, whiteSpace: "nowrap" }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>

    {workerContractModal && (
      <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div style={{background:'#fff', borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto'}}>
          <h3 style={{fontSize:18, fontWeight:700, color:'#1e293b', marginBottom:4}}>{t("contract.workerTitle")}</h3>
          <p style={{fontSize:12, color:'#6b7280', marginBottom:16}}>{t("contract.readCarefully")}</p>

          <div style={{background:'#f8fafc', borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color:'#374151', marginBottom:16}}>
            <p><strong>{t("contract.agreementHeading")}</strong></p>
            <p>• <strong>{t("contract.employerLabel")}</strong> {workerContractModal.employerName}</p>
            <p>• <strong>{t("contract.workerLabel")}</strong> {t("contract.youLabel")}</p>
            <p>• <strong>{t("contract.roleLabel")}</strong> {workerContractModal.shiftTitle}</p>
            <p>• <strong>{t("contract.dateLabel")}</strong> {workerContractModal.shiftDate}</p>
            <p>• <strong>{t("contract.agreedWageLabel")}</strong> RM {workerContractModal.wageAsk}/hr</p>
            <br/>
            <p><strong>{t("contract.agreeToTermsHeading")}</strong></p>
            <p>1. {t("contract.workerClause1")}</p>
            <p>2. {t("contract.workerClause2")}</p>
            <p>3. {t("contract.workerClause3")}</p>
            <p>4. {t("contract.workerClause4")}</p>
            <p>5. {t("contract.workerClause5")}</p>
            <p>6. {t("contract.workerClause6")}</p>
            <p>7. {t("contract.workerClause7")}</p>
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => setWorkerContractModal(null)}
              style={{flex:1, padding:'10px', borderRadius:8, border:'1px solid #e2e8f0', background:'#f8fafc', cursor:'pointer', color:'#64748b'}}>
              {workerContractModal.readOnly ? t("common.close") : t("common.cancel")}
            </button>
            <button onClick={() => {
              const ok = openContractPrintWindow({
                heading: t("contract.agreementHeading"),
                subheading: workerContractModal.shiftTitle,
                rows: [
                  { label: t("contract.employerLabel"), value: workerContractModal.employerName },
                  { label: t("contract.workerLabel"), value: t("contract.youLabel") },
                  { label: t("contract.roleLabel"), value: workerContractModal.shiftTitle },
                  { label: t("contract.dateLabel"), value: workerContractModal.shiftDate },
                  { label: t("contract.agreedWageLabel"), value: `RM ${workerContractModal.wageAsk}/hr` },
                  "",
                  t("contract.agreeToTermsHeading"),
                  `1. ${t("contract.workerClause1")}`,
                  `2. ${t("contract.workerClause2")}`,
                  `3. ${t("contract.workerClause3")}`,
                  `4. ${t("contract.workerClause4")}`,
                  `5. ${t("contract.workerClause5")}`,
                  `6. ${t("contract.workerClause6")}`,
                  `7. ${t("contract.workerClause7")}`,
                ],
              });
              if (!ok) toast(t("toast.popupBlocked"), "error");
            }}
              style={{flex: 1, padding:'10px', borderRadius:8, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
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
                style={{flex:2, padding:'10px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {t("contract.signBtn")}
              </button>
            )}
          </div>
        </div>
      </div>
    )}

    {disputeModal && (
      <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div style={{background: BRAND.surface, borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
          <h3 style={{fontSize:18, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("myBids.fileDisputeTitle")}</h3>
          <p style={{fontSize:12, color: BRAND.textMuted, marginBottom:16}}>{disputeModal.shiftTitle}</p>

          <Select
            label={t("myBids.disputeCategoryLabel")}
            value={disputeForm.category}
            onChange={e => setDisputeForm(f => ({ ...f, category: e.target.value }))}
            options={DISPUTE_CATEGORIES.map(c => ({ value: c.value, label: t(c.labelKey) }))}
          />

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("myBids.disputeDescriptionLabel")}</label>
            <textarea
              value={disputeForm.description}
              onChange={e => setDisputeForm(f => ({ ...f, description: e.target.value }))}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 100, resize: "none", boxSizing: "border-box" }}
            />
          </div>

          <div style={{display:'flex', gap:8}}>
            <button onClick={() => { setDisputeModal(null); setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" }); }}
              style={{flex:1, padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
              {t("common.cancel")}
            </button>
            <button onClick={submitDispute} disabled={filingDispute || !disputeForm.description.trim()}
              style={{flex:2, padding:'10px', borderRadius:8, background: BRAND.primary, color:'#fff', border:'none', cursor: filingDispute || !disputeForm.description.trim() ? 'not-allowed' : 'pointer', fontWeight:600, opacity: filingDispute || !disputeForm.description.trim() ? 0.6 : 1}}>
              {filingDispute ? "…" : t("myBids.disputeSubmitBtn")}
            </button>
          </div>
        </div>
      </div>
    )}

    {cancellationContractModal && (
      <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
        <div style={{background:BRAND.surface, borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto'}}>
          <h3 style={{fontSize:18, fontWeight:700, color:BRAND.text, marginBottom:4}}>{t("contract.cancellationTitle")}</h3>
          <p style={{fontSize:12, color:BRAND.textMuted, marginBottom:16}}>{t("contract.readCarefully")}</p>

          <div style={{background:BRAND.grayLight, borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color:BRAND.text, marginBottom:16}}>
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
              style={{flex:1, padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, cursor:'pointer', color:BRAND.textMuted}}>
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
              style={{flex:2, padding:'10px', borderRadius:8, background:BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
              {t("contract.signBtn")}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

// ─── EMPLOYER PORTAL ─────────────────────────────────────────────────────────
const EmployerPortal = ({ onOpenPortal, compact = false, user = null, backHandlerRef = null, deepLinkShift = null }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const [view, setView] = useState("dashboard");
  const [selectedShift, setSelectedShift] = useState(null);
  const [liveApplicants, setLiveApplicants] = useState(null);
  const [postStep, setPostStep] = useState(1);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [cancellingShift, setCancellingShift] = useState(false);
  const [lateCancelWarning, setLateCancelWarning] = useState(null); // { shiftId, title, confirmedCount } or null
  const [form, setForm] = useState({ title: "", category: "F&B", occurrences: [{ date: "", start: "", end: "" }], isMultiDay: false, wageMin: "", wageMax: "", headcount: 1, dress: "", location: "KLCC, KL City Centre", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "", languageRequirements: [], specialRequirements: "" });
  // Bulk shift upload (CSV) — separate from the single-shift `form` above.
  const [bulkUploadStep, setBulkUploadStep] = useState(1); // 1=upload, 2=review/fix, 3=publish
  const [bulkUploadRows, setBulkUploadRows] = useState([]);
  const [bulkUploadFileName, setBulkUploadFileName] = useState("");
  const [bulkUploadFileError, setBulkUploadFileError] = useState("");
  const [bulkUploadPublishing, setBulkUploadPublishing] = useState(false);
  const [bulkUploadProgress, setBulkUploadProgress] = useState({ done: 0, total: 0 });
  const [applicantAction, setApplicantAction] = useState({});
  const [selectedApplicantIds, setSelectedApplicantIds] = useState([]);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [offering, setOffering] = useState(false);
  const [liveEmployerShifts, setLiveEmployerShifts] = useState(null);
  const [employerProfile, setEmployerProfile] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [employerBanking, setEmployerBanking] = useState(null);
  const [employerBankForm, setEmployerBankForm] = useState({
    bankName: MALAYSIAN_BANK_OPTIONS[0],
    accountHolderName: "",
    accountNumber: "",
    fundingReady: false,
  });
  const [bankingMessage, setBankingMessage] = useState("");
  const [bankingLoading, setBankingLoading] = useState(false);
  const [employerCompanyForm, setEmployerCompanyForm] = useState({ companyName: "", ssmNumber: "", ssmCertFile: null });
  const [companyDetailsMessage, setCompanyDetailsMessage] = useState("");
  const [companyDetailsLoading, setCompanyDetailsLoading] = useState(false);
  const [employerPayoutItems, setEmployerPayoutItems] = useState([]);
  const [contractModal, setContractModal] = useState(null);
  // Read-only signed-contract view + worker profile card for the applicant
  // pool (owner request 2026-07-20).
  const [viewContractModal, setViewContractModal] = useState(null); // applicant row
  const [workerProfileModal, setWorkerProfileModal] = useState(null); // applicant row
  const [workerHistory, setWorkerHistory] = useState(null); // null = loading
  const [disputeModal, setDisputeModal] = useState(null); // { applicationId, shiftTitle }
  const [disputeForm, setDisputeForm] = useState({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  const [filingDispute, setFilingDispute] = useState(false);
  const [chatConversations, setChatConversations] = useState([]);
  const [activeChatShift, setActiveChatShift] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  // sender_id -> full_name for group-chat bubbles (ref mirrors state so the
  // realtime handler can check membership without re-subscribing).
  const [chatSenderNames, setChatSenderNames] = useState({});
  const chatSenderNamesRef = useRef({});
  useEffect(() => { chatSenderNamesRef.current = chatSenderNames; }, [chatSenderNames]);
  const chatEndRef = useRef(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [chatMessages]);

  // Mobile back-gesture support — same contract as WorkerPortal's handler:
  // close the topmost open thing, report handled; bare dashboard → false.
  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => {
      if (viewContractModal) { setViewContractModal(null); return true; }
      if (workerProfileModal) { setWorkerProfileModal(null); return true; }
      if (contractModal) { setContractModal(null); return true; }
      if (disputeModal) { setDisputeModal(null); return true; }
      if (activeChatShift) { setActiveChatShift(null); setChatMessages([]); return true; }
      if (selectedShift) { setSelectedShift(null); return true; }
      if (view !== "dashboard") { setView("dashboard"); return true; }
      return false;
    };
    return () => { if (backHandlerRef) backHandlerRef.current = null; };
  });

  // Same nav ping as WorkerPortal — keeps the swipe-back preview screenshot
  // fresh (see BackGestureManager).
  useEffect(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("carigaji:nav"));
  }, [view, selectedShift, activeChatShift]);

  // Mobile-only: the sidebar used to always render full-width, stacked above
  // the content, permanently expanded — eating over half the screen before
  // any actual work (managing shifts, reviewing applicants) was visible.
  // Now it's a collapsible left-side drawer on mobile, toggled by a
  // hamburger button; desktop (compact=false) is unaffected.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Exposed via useCallback (not just an effect-local function) so the
  // post/edit-shift handler can trigger a refetch after a successful publish
  // — previously the list only loaded on [user] change, so a freshly
  // published shift didn't appear until the next full reload.
  const loadEmployerShifts = useCallback(async () => {
    if (!user) return setLiveEmployerShifts(null);
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, category, start_at, end_at, occurrences, headcount, filled_count, status, language_requirements, wage_max')
      .eq('employer_id', user.id)
      .order('start_at', { ascending: false });
    // Same fix as the worker My Bids loader: empty (not null) on error so
    // a real failure shows "No shifts posted yet" rather than spinning
    // forever on "Loading shifts…".
    if (error) { console.error('liveEmployerShifts load failed:', error.message); setLiveEmployerShifts([]); return; }
    setLiveEmployerShifts((data ?? []).map(s => ({
      id: s.id,
      title: displayProtectedText(s.title),
      startAt: s.start_at,
      occurrences: s.occurrences ?? [],
      isMultiDay: (s.occurrences ?? []).length > 1,
      date: formatShiftDate(s.start_at) || 'TBA',
      time: s.start_at && s.end_at ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
      headcount: s.headcount ?? 1,
      filled: s.filled_count ?? 0,
      applicants: 0,
      status: s.status,
      // Worst-case wage bill if every position fills at the top of the range,
      // across every occurrence day (escrow/prepayment isn't built yet, so
      // this is an estimate, not money actually held).
      estBudget: Math.round(Number(s.wage_max ?? 0) * totalOccurrenceHours(s.occurrences ?? []) * (s.headcount ?? 1)),
      category: s.category,
      languageRequirements: s.language_requirements || [],
    })));
  }, [user]);

  useEffect(() => { loadEmployerShifts(); }, [loadEmployerShifts]);

  // Deep link from a clicked notification (e.g. "new bid received").
  useEffect(() => {
    if (!deepLinkShift?.shiftId || !user) return undefined;
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, category, start_at, end_at, occurrences, headcount, filled_count, status, language_requirements, wage_max')
      .eq('id', deepLinkShift.shiftId)
      .eq('employer_id', user.id)
      .maybeSingle()
      .then(({ data: s }) => {
        if (!active || !s) return;
        setSelectedShift({
          id: s.id,
          title: displayProtectedText(s.title),
          startAt: s.start_at,
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          date: formatShiftDate(s.start_at) || 'TBA',
          time: s.start_at && s.end_at ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          headcount: s.headcount ?? 1,
          filled: s.filled_count ?? 0,
          applicants: 0,
          status: s.status,
          estBudget: Math.round(Number(s.wage_max ?? 0) * totalOccurrenceHours(s.occurrences ?? []) * (s.headcount ?? 1)),
          category: s.category,
          languageRequirements: s.language_requirements || [],
        });
        setView('shifts');
      });
    return () => { active = false; };
  }, [deepLinkShift, user]);

  // Employer's own profile (real name + reliability score for the dashboard
  // greeting/stats — replaces the old hardcoded "Grand Hyatt KL" demo copy).
  const [employerProfileLoaded, setEmployerProfileLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    if (!user) { setEmployerProfile(null); setEmployerProfileLoaded(false); return; }
    setEmployerProfileLoaded(false);
    supabase.from('profiles').select('full_name, reliability_score, ssm_number, ssm_document_path, employer_verification_status').eq('id', user.id).maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        setEmployerProfile(error ? null : (data ?? null));
        setEmployerProfileLoaded(true);
        if (!error && data) {
          setEmployerCompanyForm({
            companyName: data.full_name || user.user_metadata?.full_name || "",
            ssmNumber: data.ssm_number || "",
          });
        }
      });
    return () => { active = false; };
  }, [user]);

  // Hard gate: posting shifts requires admin-verified SSM registration
  // (employer_verification_status is admin-settable only, enforced by the
  // guard trigger in 20260712b_employer_verification.sql, and by
  // shifts_employer_insert in 20260716_require_verified_employer_for_shift_insert.sql).
  // While the fetch is in flight (!employerProfileLoaded) we treat posting as
  // allowed to avoid flashing the lock for already-verified employers; once
  // loaded — whether it returned a row or errored — an unverified/errored
  // state is gated, and the DB-level check is the real backstop either way.
  const employerVerified = !employerProfileLoaded || employerProfile?.employer_verification_status === 'verified';
  const verificationStatus = employerProfile?.employer_verification_status ?? 'unverified';
  const guardPosting = () => {
    if (employerVerified) return true;
    toast(t('employer.postingLockedToast'), 'info');
    setView('dashboard');
    return false;
  };

  // Real applicant counts per shift + a recent-activity feed, both computed
  // from live applications data (no mock numbers).
  useEffect(() => {
    let active = true;
    const shiftIds = (liveEmployerShifts ?? []).map(s => s.id);
    if (shiftIds.length === 0) { setRecentActivity([]); return; }
    supabase
      .from('applications')
      .select('id, wage_ask, status, applied_at, shift_id, worker:profiles!applications_worker_id_profiles_fkey(full_name)')
      .in('shift_id', shiftIds)
      .order('applied_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active || error) return;
        const rows = data ?? [];
        const counts = {};
        const bidSums = {};
        rows.forEach(a => {
          counts[a.shift_id] = (counts[a.shift_id] || 0) + 1;
          bidSums[a.shift_id] = (bidSums[a.shift_id] || 0) + Number(a.wage_ask ?? 0);
        });
        setLiveEmployerShifts(prev => (prev ?? []).map(s => ({
          ...s,
          applicants: counts[s.id] || 0,
          avgBid: counts[s.id] ? bidSums[s.id] / counts[s.id] : 0,
        })));
        setRecentActivity(rows.slice(0, 5).map(a => {
          const shiftTitle = (liveEmployerShifts ?? []).find(s => s.id === a.shift_id)?.title || 'a shift';
          const who = a.worker?.full_name || 'A worker';
          if (a.status === 'accepted') return `${who} was accepted for ${shiftTitle}`;
          if (a.status === 'rejected') return `${who}'s bid for ${shiftTitle} was declined`;
          return `${who} bid RM${a.wage_ask}/h for ${shiftTitle}`;
        }));
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmployerShifts === null ? null : liveEmployerShifts.map(s => s.id).join(',')]);

  // Keep the open shift-detail view (selectedShift) in sync with background
  // updates to liveEmployerShifts — e.g. the applicant/avg-bid counts above
  // arrive after the initial list load, and without this the detail view
  // would keep showing the stale 0-applicant defaults until re-clicked.
  useEffect(() => {
    if (!selectedShift) return;
    const updated = (liveEmployerShifts ?? []).find(s => s.id === selectedShift.id);
    if (updated && updated !== selectedShift) setSelectedShift(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmployerShifts]);

  // Start a fresh shift post (clears any edit state + form).
  const beginNewShift = () => {
    if (!guardPosting()) return;
    setEditingShiftId(null);
    setSelectedShift(null);
    setForm({ title: "", category: "F&B", occurrences: [{ date: "", start: "", end: "" }], isMultiDay: false, wageMin: "", wageMax: "", headcount: 1, dress: "", location: "", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "", languageRequirements: [], specialRequirements: "" });
    setView("postshift");
    setPostStep(1);
  };

  // Start a fresh bulk-upload session (create-only, no edit path).
  const beginBulkUpload = () => {
    if (!guardPosting()) return;
    setBulkUploadStep(1);
    setBulkUploadRows([]);
    setBulkUploadFileName("");
    setBulkUploadFileError("");
    setBulkUploadPublishing(false);
    setBulkUploadProgress({ done: 0, total: 0 });
    setView("bulkupload");
  };

  const handleBulkUploadFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBulkUploadFileError("");
    setBulkUploadFileName(file.name);
    // Extension is the primary gate (MIME sniffing for CSV is unreliable
    // across browsers/OSes — Windows Excel reports "application/vnd.ms-excel").
    const looksLikeCsv = /\.csv$/i.test(file.name) && (file.type === "" || /csv|excel|text/i.test(file.type));
    if (!looksLikeCsv) {
      setBulkUploadFileError(t("employer.bulkInvalidFileType"));
      setBulkUploadRows([]);
      return;
    }
    if (file.size > BULK_UPLOAD_MAX_FILE_BYTES) {
      setBulkUploadFileError(t("employer.bulkFileTooLarge"));
      setBulkUploadRows([]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const { rows, fatalError } = parseBulkShiftCSV(String(reader.result || ""));
      if (fatalError) {
        setBulkUploadFileError(fatalError);
        setBulkUploadRows([]);
        return;
      }
      setBulkUploadRows(rows);
      setBulkUploadStep(2);
    };
    reader.onerror = () => setBulkUploadFileError(t("employer.bulkParseFailed") + "could not read the file.");
    reader.readAsText(file);
  };

  // Edits a single cell of a draft bulk row and re-validates that row.
  // (Free-text fields were already sanitized once at CSV parse time; manual
  // edits here are typed directly by the employer, not re-imported, so no
  // further sanitization is needed.)
  const updateBulkUploadRow = (rowNum, field, value) => {
    setBulkUploadRows(rows => rows.map(r => {
      if (r._rowNum !== rowNum || r._status === "published") return r;
      const updated = { ...r, [field]: value, _error: null };
      updated._status = evaluateBulkRowStatus(updated);
      return updated;
    }));
  };

  // Re-checks a failed row's readiness without requiring the employer to
  // touch a field first (e.g. after a transient network error).
  const retryBulkUploadRow = (rowNum) => {
    setBulkUploadRows(rows => rows.map(r => (r._rowNum === rowNum ? { ...r, _status: evaluateBulkRowStatus(r), _error: null } : r)));
  };

  // Publishes all currently-"ready" rows, one insert per row, in small
  // concurrency-capped chunks so a single bad row can't fail the batch and
  // so we get per-row error attribution back for the employer to fix + retry.
  const publishBulkUploadRows = async () => {
    if (!user) { toast(t('toast.signInToPostShift'), 'error'); return; }
    const readyRows = bulkUploadRows.filter(r => r._status === "ready");
    if (readyRows.length === 0) return;
    setBulkUploadPublishing(true);
    setBulkUploadProgress({ done: 0, total: readyRows.length });
    const chunkSize = 5;
    let doneCount = 0;
    for (let i = 0; i < readyRows.length; i += chunkSize) {
      const chunk = readyRows.slice(i, i + chunkSize);
      const results = await Promise.allSettled(chunk.map(async (row) => {
        const startAt = new Date(`${row.date}T${row.timeStart}:00+08:00`).toISOString();
        const endAt = new Date(`${row.date}T${row.timeEnd}:00+08:00`).toISOString();
        if (isNaN(new Date(startAt).getTime()) || isNaN(new Date(endAt).getTime())) {
          throw new Error("Invalid date/time.");
        }
        const wageMin = parseFloat(row.wageMin) || 0;
        const wageMax = parseFloat(row.wageMax) || wageMin;
        if (wageMax < wageMin) throw new Error("Max pay must be ≥ min pay.");
        const payload = {
          title: sanitizeBulkTextValue(row.title.trim()),
          description: row.description ? sanitizeBulkTextValue(row.description.trim()) : null,
          category: row.category,
          location: sanitizeBulkTextValue((row.location || "").trim() || "Kuala Lumpur"),
          dress_code: row.dress ? sanitizeBulkTextValue(row.dress.trim()) : null,
          start_at: startAt,
          end_at: endAt,
          occurrences: [{ date: row.date, start: row.timeStart, end: row.timeEnd }],
          wage_min: wageMin,
          wage_max: wageMax,
          headcount: parseInt(row.headcount) || 1,
          address_visibility: "public",
          transport_allowance: parseFloat(row.transportAllowance) || 0,
        };
        const { error } = await supabase.from('shifts').insert({ employer_id: user.id, status: 'open', ...payload });
        if (error) throw new Error(/row.?level security/i.test(error.message || "") ? t('employer.postShiftUnverifiedHint') : error.message);
        return true;
      }));
      setBulkUploadRows(rows => rows.map(r => {
        const idx = chunk.findIndex(c => c._rowNum === r._rowNum);
        if (idx === -1) return r;
        const res = results[idx];
        return res.status === "fulfilled"
          ? { ...r, _status: "published", _error: null }
          : { ...r, _status: "failed", _error: res.reason?.message || "Failed to publish." };
      }));
      doneCount += chunk.length;
      setBulkUploadProgress({ done: doneCount, total: readyRows.length });
    }
    setBulkUploadPublishing(false);
  };

  // Load an existing shift into the form for editing.
  const startEditShift = async (shiftId) => {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, address_visibility, transport_allowance, language_requirements, requirements')
      .eq('id', shiftId)
      .single();
    if (error || !data) { toast(t('employer.toastLoadShiftFailed'), 'error'); return; }
    const pad = n => String(n).padStart(2, '0');
    const start = data.start_at ? new Date(data.start_at) : null;
    const end = data.end_at ? new Date(data.end_at) : null;
    const hhmm = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    const transportAmt = Number(data.transport_allowance) || 0;
    // Pre-migration rows (or any row that somehow ended up with an empty
    // occurrences array) fall back to a single occurrence built from
    // start_at/end_at, so editing an old shift still works.
    const occurrences = (data.occurrences && data.occurrences.length > 0)
      ? data.occurrences
      : [{ date: start ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` : '', start: hhmm(start), end: hhmm(end) }];
    setForm({
      title: displayProtectedText(data.title || ''),
      description: displayProtectedText(data.description || ''),
      category: data.category || 'F&B',
      occurrences,
      isMultiDay: occurrences.length > 1,
      wageMin: data.wage_min != null ? String(data.wage_min) : '',
      wageMax: data.wage_max != null ? String(data.wage_max) : '',
      headcount: data.headcount || 1,
      dress: displayProtectedText(data.dress_code || ''),
      location: displayProtectedText(data.location || ''),
      addressVisibility: data.address_visibility || 'public',
      offersTransportAllowance: transportAmt > 0,
      transportAllowance: transportAmt > 0 ? String(transportAmt) : '',
      languageRequirements: data.language_requirements || [],
      specialRequirements: data.requirements?.special || '',
    });
    setEditingShiftId(shiftId);
    setSelectedShift(null);
    setView('postshift');
    setPostStep(1);
  };

  const doCancelShift = async (shiftId) => {
    setCancellingShift(true);
    const { error } = await supabase.from('shifts').update({ status: 'cancelled' }).eq('id', shiftId);
    setCancellingShift(false);
    if (error) { toast(t('employer.toastCancelShiftFailed') + error.message, 'error'); return; }
    toast(t('employer.toastShiftCancelled'), 'success');
    setLiveEmployerShifts(prev => (prev ?? []).map(s => s.id === shiftId ? { ...s, status: 'cancelled' } : s));
    setSelectedShift(prev => prev ? { ...prev, status: 'cancelled' } : prev);
    setLateCancelWarning(null);
  };

  // Confirmed = accepted + contract-signed — only these workers are owed a
  // late-cancellation choice (a pending/shortlisted applicant never had a
  // firm commitment to lose).
  const confirmedSignedApplicants = (liveApplicants ?? []).filter(a => a.status === 'accepted' && a.workerSignedAt);

  const handleCancelShiftClick = () => {
    if (confirmedSignedApplicants.length > 0 && hoursUntilShift(selectedShift.startAt) <= 24) {
      setLateCancelWarning({ shiftId: selectedShift.id, title: selectedShift.title, confirmedCount: confirmedSignedApplicants.length });
      return;
    }
    if (!window.confirm(t('employer.confirmCancelShift').replace('{title}', selectedShift.title))) return;
    doCancelShift(selectedShift.id);
  };

  useEffect(() => {
    if (!selectedShift?.id || typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) return;
    let active = true;
    supabase
      .from('applications')
      .select('id, worker_id, wage_ask, status, applied_at, offer_expires_at, worker_signed_at, employer_signed_at, cancellation_choice, cancellation_choice_deadline, cancellation_proof_path, worker:profiles!applications_worker_id_profiles_fkey(full_name, kyc_level, reliability_score, rating)')
      .eq('shift_id', selectedShift.id)
      .order('applied_at', { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) { console.error('liveApplicants load failed:', error.message); setLiveApplicants([]); return; }
        const mapped = (data ?? []).map(a => ({
          id: a.id,
          name: a.worker?.full_name ?? 'Worker',
          kyc: a.worker?.kyc_level ?? 'Basic',
          verified: a.worker?.kyc_level === 'Standard' || a.worker?.kyc_level === 'Advanced',
          reliability: a.worker?.reliability_score ?? 0,
          rating: a.worker?.rating ?? 0,
          wage: Number(a.wage_ask),
          wageBid: Number(a.wage_ask),
          completedShifts: 0,
          status: a.status,
          appliedAt: a.applied_at,
          offerExpiresAt: a.offer_expires_at,
          workerId: a.worker_id,
          workerSignedAt: a.worker_signed_at ?? null,
          employerSignedAt: a.employer_signed_at ?? null,
          cancellationChoice: a.cancellation_choice ?? null,
          cancellationChoiceDeadline: a.cancellation_choice_deadline ?? null,
          cancellationProofPath: a.cancellation_proof_path ?? null,
        }));
        // Stable sort keeps applied_at order within each group — only
        // reorders verified workers ahead of unverified ones.
        mapped.sort((x, y) => (y.verified ? 1 : 0) - (x.verified ? 1 : 0));
        setLiveApplicants(mapped);
      });
    return () => { active = false; };
  }, [selectedShift]);

  // Average hourly bid across the open detail's applicant pool (the shift-list
  // enrichment only lands on liveEmployerShifts, so the detail computes its
  // own from the applicants it already loads — this is what fixes the stat
  // showing "(not set)" whenever the detail opened before enrichment).
  const detailAvgBid = (liveApplicants ?? []).length
    ? (liveApplicants ?? []).reduce((sum, a) => sum + (a.wageBid || 0), 0) / liveApplicants.length
    : 0;

  // History between this employer and the clicked worker — RLS only returns
  // applications on THIS employer's own shifts, which is exactly the scope
  // we want to show ("your history with them", not platform-wide data).
  useEffect(() => {
    if (!workerProfileModal?.workerId) return undefined;
    let active = true;
    setWorkerHistory(null);
    supabase
      .from('applications')
      .select('id, status, applied_at, worker_signed_at, shift:shifts(title, status, start_at)')
      .eq('worker_id', workerProfileModal.workerId)
      .order('applied_at', { ascending: false })
      .limit(10)
      .then(({ data, error }) => {
        if (!active) return;
        setWorkerHistory(error ? [] : (data ?? []));
      });
    return () => { active = false; };
  }, [workerProfileModal]);

  // Best-effort expiry sweep: whenever the applicant pool loads, flip any
  // offers whose deadline has passed to 'expired' (permitted by the
  // applications_expire_offer RLS policy). Not a real-time cron — resolves
  // the next time either side opens the relevant screen.
  useEffect(() => {
    const stale = (liveApplicants ?? []).filter(a => a.status === 'offered' && a.offerExpiresAt && new Date(a.offerExpiresAt) < new Date());
    if (stale.length === 0) return;
    stale.forEach(a => {
      supabase.from('applications').update({ status: 'expired' }).eq('id', a.id).then(({ error }) => {
        if (!error) setLiveApplicants(prev => (prev ?? []).map(x => x.id === a.id ? { ...x, status: 'expired' } : x));
      });
    });
  }, [liveApplicants]);

  useEffect(() => {
    if (!user || view !== 'chat') return;
    let active = true;
    supabase
      .from('applications')
      .select('shift_id, worker_id, shift:shifts(id, title, start_at), worker:profiles!applications_worker_id_profiles_fkey(full_name)')
      .eq('status', 'accepted')
      .then(({ data }) => {
        if (!active) return;
        // Group chat: one room per shift, listing every accepted worker.
        const byShift = new Map();
        (data ?? []).forEach(a => {
          const entry = byShift.get(a.shift_id) ?? {
            shiftId: a.shift_id,
            title: displayProtectedText(a.shift?.title ?? 'Shift'),
            date: formatShiftDate(a.shift?.start_at),
            workerNames: [],
          };
          entry.workerNames.push(a.worker?.full_name || 'Worker');
          byShift.set(a.shift_id, entry);
        });
        setChatConversations([...byShift.values()].map(e => ({
          ...e,
          otherUserLabel: e.workerNames.join(', '),
        })));
      });
    return () => { active = false; };
  }, [user, view]);

  // Deep-linking straight into a shift's chat (e.g. the shift-card Chat
  // button) sets activeChatShift before chatConversations has loaded, so the
  // header's worker-name subtitle starts blank — backfill it once available.
  useEffect(() => {
    if (!activeChatShift || activeChatShift.otherUserLabel) return;
    const match = chatConversations.find(c => c.shiftId === activeChatShift.shiftId);
    if (match) setActiveChatShift(prev => (prev && !prev.otherUserLabel) ? { ...prev, otherUserLabel: match.otherUserLabel } : prev);
  }, [chatConversations, activeChatShift]);

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
      .channel(`employer-chat-${activeChatShift.shiftId}`)
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
    const loadEmployerPaymentData = async () => {
      if (!user) {
        setEmployerBanking(null);
        setEmployerPayoutItems([]);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
          .eq("user_id", user.id)
          .eq("role", "employer")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, status, scheduled_date, created_at")
          .eq("employer_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);

      if (!active) return;

      if (!bankError) {
        setEmployerBanking(bankData ?? null);
        if (bankData) {
          setEmployerBankForm({
            bankName: bankData.bank_name || MALAYSIAN_BANK_OPTIONS[0],
            accountHolderName: bankData.account_holder_name || "",
            accountNumber: "",
            fundingReady: Boolean(bankData.funding_ready),
          });
        }
      }
      if (!payoutError) setEmployerPayoutItems(payoutData ?? []);
    };

    loadEmployerPaymentData();
    return () => {
      active = false;
    };
  }, [user]);

  // SSM format mirrors the sign-up check (3368): new 12-digit registration,
  // or the classic up-to-8-digit-plus-letter-suffix format. Re-submitting a
  // changed number here re-queues the profile to pending_review via the
  // guard_employer_verification_status trigger — no client-side status write.
  const saveEmployerCompanyDetails = async () => {
    if (!user) {
      setCompanyDetailsMessage("Sign in to save company details.");
      return;
    }
    const companyName = employerCompanyForm.companyName.trim();
    const ssmNumber = employerCompanyForm.ssmNumber.trim();
    if (!companyName) {
      setCompanyDetailsMessage("Company name is required.");
      return;
    }
    if (ssmNumber && !/^(\d{12}|\d{1,8}-[A-Za-z])$/.test(ssmNumber)) {
      setCompanyDetailsMessage(t("auth.ssmFormatHint"));
      return;
    }

    setCompanyDetailsLoading(true);
    setCompanyDetailsMessage("");
    // SSM certificate upload (manual-verification workaround, 20260719): the
    // file goes into the private kyc-documents bucket under the owner's
    // folder; only the owner and admins can read it.
    let certPath;
    if (employerCompanyForm.ssmCertFile) {
      try {
        certPath = await uploadKycFile(user.id, employerCompanyForm.ssmCertFile, "ssm-cert");
      } catch (e) {
        setCompanyDetailsLoading(false);
        setCompanyDetailsMessage(`${t("employer.ssmCertUploadFailed")}${e.message}`);
        return;
      }
    }
    const { data, error } = await supabase
      .from("profiles")
      .update({ full_name: companyName, ssm_number: ssmNumber || null, ...(certPath ? { ssm_document_path: certPath } : {}) })
      .eq("id", user.id)
      .select("full_name, reliability_score, ssm_number, ssm_document_path, employer_verification_status")
      .single();

    setCompanyDetailsLoading(false);
    if (error) {
      setCompanyDetailsMessage(`Unable to save company details: ${error.message}`);
      return;
    }
    setEmployerProfile(data);
    setCompanyDetailsMessage("Company details saved.");
  };

  const saveEmployerBankingDetails = async () => {
    if (!user) {
      setBankingMessage("Sign in to save banking details.");
      return;
    }
    if (!employerBankForm.accountHolderName.trim() || !employerBankForm.accountNumber.trim()) {
      setBankingMessage("Account holder name and account number are required.");
      return;
    }
    const employerAcctValidation = validateMalaysianBankAccount(employerBankForm.bankName, employerBankForm.accountNumber);
    if (!employerAcctValidation.valid) {
      toast(employerAcctValidation.message, "error");
      return;
    }

    setBankingLoading(true);
    setBankingMessage("");
    const accountDigits = employerBankForm.accountNumber.replace(/\D/g, "");
    const last4 = accountDigits.slice(-4);
    const payload = {
      user_id: user.id,
      role: "employer",
      bank_name: employerBankForm.bankName,
      bank_code: employerBankForm.bankName.toUpperCase().replace(/\s+/g, "_"),
      account_holder_name: employerBankForm.accountHolderName.trim(),
      account_number_last4: last4,
      // Full account number must be encrypted server-side before go-live.
      // Storing masked placeholder here until a backend encryption flow is wired up.
      account_number_encrypted: `MASKED-${last4}`,
      verification_status: employerBanking?.verification_status || "pending",
      funding_ready: employerBankForm.fundingReady,
    };

    const { data, error } = await supabase
      .from("banking_details")
      .upsert(payload, { onConflict: "user_id,role" })
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Unable to save employer banking details: ${error.message}`);
      return;
    }
    setEmployerBanking(data);
    setBankingMessage("Employer banking details saved.");
  };

  const verifyEmployerBankingDetails = async () => {
    if (!employerBanking?.id) {
      setBankingMessage("Save banking details before verification.");
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
        funding_ready: employerBankForm.fundingReady,
      })
      .eq("id", employerBanking.id)
      .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
      .single();

    setBankingLoading(false);
    if (error) {
      setBankingMessage(`Employer verification failed: ${error.message}`);
      return;
    }
    setEmployerBanking(data);
    setBankingMessage("Employer bank verified via SecureSign.");
  };

  const navItems = [
    { id: "dashboard", label: t("employerNav.dashboard") },
    { id: "shifts", label: t("employerNav.shifts") },
    { id: "postshift", label: t("employerNav.postShift") },
    { id: "bulkupload", label: t("employerNav.bulkUpload") },
    { id: "chat", label: t("employerNav.chat") },
    { id: "billing", label: t("employerNav.billing") },
    { id: "account", label: t("employerNav.account") },
  ];

  const handleApplicantAction = async (id, action) => {
    if (!['shortlisted', 'rejected'].includes(action)) return;
    const { error } = await supabase
      .from('applications')
      .update({ status: action, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { toast(t('toast.updateFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => prev ? prev.map(a => a.id === id ? { ...a, status: action } : a) : prev);
    setApplicantAction(prev => ({ ...prev, [id]: action }));
  };

  // File a dispute on a completed shift. Text-only evidence (category +
  // description); disputes don't touch payouts in v1 — see
  // supabase/migrations/20260712_disputes.sql for the RLS that scopes
  // inserts to completed shifts only.
  const submitEmployerDispute = async () => {
    if (!disputeModal || !user || !disputeForm.description.trim()) return;
    setFilingDispute(true);
    const { error } = await supabase.from('disputes').insert({
      application_id: disputeModal.applicationId,
      filed_by: user.id,
      filed_by_role: 'employer',
      category: disputeForm.category,
      description: disputeForm.description.trim(),
    });
    setFilingDispute(false);
    if (error) { toast(t('toast.disputeFiledFailed') + error.message, 'error'); return; }
    toast(t('toast.disputeFiled'), 'success');
    setDisputeModal(null);
    setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  };

  // Slots still open on this shift = headcount minus already-accepted workers.
  const openSlotsRemaining = () => {
    const acceptedCount = (liveApplicants ?? []).filter(a => a.status === 'accepted').length;
    return Math.max(0, (selectedShift?.headcount ?? 1) - acceptedCount);
  };

  // Offer the shift to one or more applicants: moves them to 'offered' with a
  // deadline computed from how soon the shift starts. The worker must confirm
  // (which then unlocks the existing digital-contract signing step) or
  // decline within that window; a lazy sweep expires unanswered offers.
  const makeOffer = async (ids) => {
    const openSlots = openSlotsRemaining();
    if (ids.length > openSlots) {
      toast(t('toast.tooManySelected').replace(/{open}/g, openSlots).replace('{plural}', openSlots === 1 ? '' : t('common.pluralSuffix')), 'error');
      return;
    }
    setOffering(true);
    const deadline = computeOfferDeadline(selectedShift?.startAt);
    const { error } = await supabase
      .from('applications')
      .update({ status: 'offered', offer_expires_at: deadline, employer_signed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in('id', ids);
    setOffering(false);
    if (error) { toast(t('toast.updateFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(a => ids.includes(a.id) ? { ...a, status: 'offered', offerExpiresAt: deadline } : a));
    setSelectedApplicantIds([]);
    setBulkSelectMode(false);
    toast(ids.length > 1 ? t('toast.offerSentMultiple').replace('{count}', ids.length) : t('toast.offerSentSingle'), 'success');
  };

  const committedPayoutTotal = employerPayoutItems
    .filter(item => ['queued', 'ready', 'scheduled', 'held'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidOutPayoutTotal = employerPayoutItems
    .filter(item => item.status === 'processed_internal')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const sidebarContent = (
    <>
      <div style={{ padding: "0 20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 20, color: BRAND.primary }}>CariGaji</div>
          <div style={{ fontSize: 11, color: BRAND.textMuted, fontWeight: 500 }}>{t("employer.tagline")}</div>
        </div>
        {compact && (
          <button onClick={() => setSidebarOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1, padding: 4 }}>×</button>
        )}
      </div>
      {navItems.map(n => (
        <button key={n.id} onClick={() => { if ((n.id === "postshift" || n.id === "bulkupload") && !guardPosting()) { if (compact) setSidebarOpen(false); return; } setView(n.id); setSelectedShift(null); setPostStep(1); setEditingShiftId(null); if (compact) setSidebarOpen(false); }}
          style={{
            display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
            background: view === n.id ? BRAND.primaryLight : "none",
            color: view === n.id ? BRAND.primary : BRAND.textMuted,
            border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
            borderLeft: view === n.id ? `3px solid ${BRAND.primary}` : "3px solid transparent",
            transition: "all 0.1s",
          }}>{n.label}</button>
      ))}
      <div style={{ padding: "24px 20px 0", marginTop: "auto" }}>
        <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 6 }}>{t("employer.paidToWorkers")}</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: BRAND.green }}>{toCurrency(committedPayoutTotal)}</div>
        <Btn size="xs" variant="ghost" onClick={() => toast(t('toast.escrowTopupUnavailable'), 'info')} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>{t("employer.topUpSoon")}</Btn>
        <Btn size="xs" variant="secondary" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>{t("employer.returnToWorkerApp")}</Btn>
      </div>
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%", fontFamily: "inherit" }}>
      {compact ? (
        <>
          {/* Mobile top bar: hamburger toggle instead of a permanently-expanded sidebar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${BRAND.border}`, background: BRAND.surface, flexShrink: 0 }}>
            <button onClick={() => setSidebarOpen(true)} aria-label={t("employer.openMenu")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.text, padding: 4, lineHeight: 1 }}>☰</button>
            <div style={{ fontWeight: 800, fontSize: 15, color: BRAND.text }}>{navItems.find(n => n.id === view)?.label || "CariGaji"}</div>
          </div>
          {sidebarOpen && createPortal(
            <div style={{ position: "fixed", inset: 0, zIndex: 1250, display: "flex" }}>
              <div onClick={() => setSidebarOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} />
              <div style={{ position: "relative", width: "78%", maxWidth: 280, height: "100%", background: BRAND.surface, boxShadow: `4px 0 24px ${BRAND.shadow}`, display: "flex", flexDirection: "column", padding: "24px 0", overflowY: "auto" }}>
                {sidebarContent}
              </div>
            </div>,
            document.body
          )}
        </>
      ) : (
        <div style={{ width: 180, borderRight: `1px solid ${BRAND.border}`, padding: "24px 0", background: BRAND.surface, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          {sidebarContent}
        </div>
      )}

      {/* Main */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "dashboard" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("employer.dashboardTitle")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{t("employer.goodMorning")}{employerProfile?.full_name || user?.user_metadata?.full_name || "there"}</div>
            {/* Verification workflow banner — posting is hard-gated on admin
                SSM verification, so the employer always sees exactly where
                they are in the process and what happens next. */}
            {employerProfile && verificationStatus !== 'verified' && (
              <Card style={{ marginBottom: 20, border: `1.5px solid ${verificationStatus === 'rejected' ? BRAND.red : BRAND.amber}`, background: verificationStatus === 'rejected' ? BRAND.redLight : BRAND.amberLight }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: verificationStatus === 'rejected' ? BRAND.red : BRAND.amber, marginBottom: 6 }}>
                  {verificationStatus === 'rejected' ? t("employer.verifyRejectedTitle") : t("employer.verifyPendingTitle")}
                </div>
                <div style={{ fontSize: 12.5, color: verificationStatus === 'rejected' ? BRAND.red : BRAND.amber, lineHeight: 1.6 }}>
                  {verificationStatus === 'rejected'
                    ? t("employer.verifyRejectedBody")
                    : verificationStatus === 'pending_review'
                      ? t("employer.verifyPendingBody")
                      : t("employer.verifyUnverifiedBody")}
                </div>
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 8, lineHeight: 1.6 }}>
                  {t("employer.verifyWorkflowSteps")}
                </div>
              </Card>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label={t("employer.statActiveShifts")} value={(liveEmployerShifts ?? []).filter(s => s.status === "open").length} color={BRAND.primary} />
              <Stat label={t("employer.statTotalApplicants")} value={(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.applicants || 0), 0)} color={BRAND.blue} />
              <Stat label={t("employer.statFilledSlots")} value={`${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.filled || 0), 0)}/${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.headcount || 0), 0)}`} color={BRAND.green} />
              <Stat label={t("employer.statReliability")} value={employerProfile?.reliability_score ?? 0} sub="/100" color={BRAND.accent} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>{t("employer.activeShiftsHeading")}</div>
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").length === 0 && (
                  <EmptyState
                    icon="📋"
                    title={liveEmployerShifts === null ? t("employer.loadingShifts") : t("employer.noActiveShifts")}
                    hint={liveEmployerShifts === null ? t("employer.loadingShiftsHint") : t("employer.noActiveShiftsHint")}
                  />
                )}
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").map(s => (
                  <Card key={s.id} onClick={() => { setSelectedShift(s); setView("shifts"); }} hover style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 4 }}>{s.title}</div>
                        <div style={{ fontSize: 12, color: BRAND.textMuted }}>{s.isMultiDay ? formatOccurrencesSummary(s.occurrences) : `${s.date} · ${s.time}`}</div>
                      </div>
                      <Pill label={s.status} color={s.status === "open" ? "blue" : s.status === "completed" ? "green" : "gray"} />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                        <Badge color="green" size="xs">Positions {s.headcount}</Badge>
                        <Badge color="blue" size="xs">Applied {s.applicants}</Badge>
                      </div>
                      <Progress value={s.filled} max={s.headcount} color={BRAND.green} />
                    </div>
                  </Card>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>{t("employer.quickActions")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Btn onClick={beginNewShift} style={{ justifyContent: "center" }}>{t("employer.postNewShift")}</Btn>
                  <Btn variant="secondary" onClick={beginBulkUpload} style={{ justifyContent: "center" }}>{t("employer.bulkUploadBtn")}</Btn>
                  <Card style={{ padding: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.recentActivity")}</div>
                    {recentActivity.length === 0 && (
                      <div style={{ fontSize: 12, color: BRAND.textMuted, padding: "4px 0" }}>{t("employer.noActivity")}</div>
                    )}
                    {recentActivity.map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: BRAND.textMuted, padding: "4px 0", borderBottom: i < recentActivity.length - 1 ? `1px solid ${BRAND.border}` : "none" }}>{a}</div>
                    ))}
                  </Card>
                </div>
              </div>
            </div>
          </div>
        )}

        {view === "shifts" && !selectedShift && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>{t("employer.shiftsTitle")}</div>
                <div style={{ fontSize: 14, color: BRAND.textMuted }}>{t("employer.manageShiftsSubtitle")}</div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" onClick={beginBulkUpload}>{t("employer.bulkUploadBtn")}</Btn>
                <Btn onClick={beginNewShift}>{t("employer.postShiftBtn")}</Btn>
              </div>
            </div>
            {(liveEmployerShifts ?? []).length === 0 && (
              <EmptyState
                icon="📋"
                title={liveEmployerShifts === null ? t("employer.loadingShifts") : t("employer.noShiftsPostedYet")}
                hint={liveEmployerShifts === null ? t("employer.loadingShiftsHint") : t("employer.noShiftsPostedYetHint")}
              />
            )}
            {(liveEmployerShifts ?? []).map(s => (
              <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{s.title}</span>
                      <Pill label={s.status} color={s.status === "open" ? "blue" : s.status === "completed" ? "green" : "gray"} />
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{s.date} · {s.time}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.green }}>{t('employer.listCardEstBudget').replace('{amount}', s.estBudget)}</div>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 6 }}>
                          <Badge color="green" size="xs">{t('employer.listCardPositionsBadge').replace('{count}', s.headcount)}</Badge>
                          <Badge color="blue" size="xs">{t('employer.listCardAppliedBadge').replace('{count}', s.applicants)}</Badge>
                        </div>
                  </div>
                </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t('employer.listCardPositionsNeeded').replace('{count}', s.headcount)}</span>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t('employer.listCardFilled').replace('{count}', s.filled)}</span>
                      <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t('employer.listCardCategory').replace('{category}', s.category)}</span>
                      {s.languageRequirements && s.languageRequirements.length > 0 && (
                        <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t('employer.listCardLanguages').replace('{languages}', s.languageRequirements.join(", "))}</span>
                      )}
                      <Btn
                        size="sm"
                        variant="secondary"
                        style={{ marginLeft: "auto", padding: "6px 12px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveChatShift({ shiftId: s.id, title: s.title, date: s.date, otherUserLabel: '' });
                          setView('chat');
                        }}
                      >
                        {Icons.Chat ? Icons.Chat({ size: 14 }) : "💬"} <span style={{ marginLeft: 6 }}>{t('employer.listCardChatBtn')}</span>
                      </Btn>
                </div>
              </Card>
            ))}
          </div>
        )}

        {view === "shifts" && selectedShift && (
          <div>
            <button onClick={() => setSelectedShift(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: BRAND.primary, fontFamily: "inherit", marginBottom: 16 }} aria-label={t("employer.backToShifts")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("employer.backToShifts")}</span></button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text }}>{selectedShift.title}</div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Btn variant="secondary" onClick={() => startEditShift(selectedShift.id)} style={{ padding: "8px 14px" }}>{Icons.Edit ? Icons.Edit({ size: 14 }) : "✏️"} <span style={{ marginLeft: 6 }}>{t("employer.editShift")}</span></Btn>
                {selectedShift.status !== "cancelled" && selectedShift.status !== "completed" && (
                  <Btn
                    variant="secondary"
                    disabled={cancellingShift}
                    onClick={handleCancelShiftClick}
                    style={{ padding: "8px 14px", color: BRAND.red }}
                  >
                    {cancellingShift ? t("employer.cancellingShift") : t("employer.cancelShift")}
                  </Btn>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <Pill label={selectedShift.status} color={selectedShift.status === "open" ? "blue" : selectedShift.status === "completed" ? "green" : selectedShift.status === "cancelled" ? "red" : "gray"} />
              <span style={{ fontSize: 14, color: BRAND.textMuted }}>{selectedShift.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift.date}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
              <Stat label={t("employer.statAppliedUsers")} value={selectedShift.applicants} color={BRAND.blue} />
              <Stat label={t("employer.statSlotsFilled")} value={`${selectedShift.filled}/${selectedShift.headcount}`} color={BRAND.green} />
              <Stat label={t("employer.statEstBudget")} value={`RM${selectedShift.estBudget ?? 0}`} color={BRAND.primary} />
              <Stat label={t("employer.statAvgBid")} value={detailAvgBid ? `RM${detailAvgBid.toFixed(2)}` : t("employer.reviewNotSet")} color={BRAND.accent} />
            </div>
            {selectedShift.status === "cancelled" && confirmedSignedApplicants.length > 0 && (
              <Card style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 10 }}>{t("employer.cancellationOutcomesTitle")}</div>
                {confirmedSignedApplicants.map(a => (
                  <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <span style={{ fontSize: 13, color: BRAND.text }}>{a.name}</span>
                    <Pill
                      label={
                        !a.cancellationChoice ? t("employer.cancellationAwaitingChoice")
                        : a.cancellationChoice === "contract_50" ? t("employer.cancellationTook50")
                        : a.cancellationProofPath ? t("employer.cancellationShowedUp100") : t("employer.cancellationAwaitingProofEmployer")
                      }
                      color={!a.cancellationChoice ? "gray" : a.cancellationChoice === "contract_50" ? "amber" : a.cancellationProofPath ? "green" : "blue"}
                    />
                  </div>
                ))}
              </Card>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 4 }}>{t("employer.applicantPool")}</div>
                <div style={{ fontSize: 13, color: BRAND.textMuted }}>{t("employer.positionsOpenHint").replace("{open}", openSlotsRemaining()).replace("{total}", selectedShift.headcount).replace("{plural}", selectedShift.headcount === 1 ? '' : t("common.pluralSuffix"))}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge color="blue">{t("employer.appliedBadge").replace("{count}", selectedShift.applicants)}</Badge>
                {openSlotsRemaining() > 0 && (
                  <Btn size="xs" variant="secondary" onClick={() => { setBulkSelectMode(m => !m); setSelectedApplicantIds([]); }}>
                    {bulkSelectMode ? t("common.cancel") : t("employer.selectMultiple")}
                  </Btn>
                )}
              </div>
            </div>
            {bulkSelectMode && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: BRAND.primaryLight, borderRadius: 10, marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: BRAND.primary, fontWeight: 600 }}>{t("employer.selectedOfTotal").replace("{selected}", selectedApplicantIds.length).replace("{total}", openSlotsRemaining())}</span>
                <Btn size="xs" disabled={selectedApplicantIds.length === 0 || offering} onClick={() => makeOffer(selectedApplicantIds)}>
                  {offering ? t("employer.sendingOffer") : t("employer.offerToWorkers").replace("{count}", selectedApplicantIds.length || '').replace("{plural}", selectedApplicantIds.length === 1 ? '' : t("common.pluralSuffix"))}
                </Btn>
              </div>
            )}
            {(liveApplicants ?? []).length === 0 && (
              <EmptyState
                icon="👥"
                title={liveApplicants === null ? t("employer.loadingApplicants") : t("employer.noApplicantsYet")}
                hint={liveApplicants === null ? t("employer.loadingApplicantsHint") : t("employer.noApplicantsHint")}
              />
            )}
            {(liveApplicants ?? []).length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", background: BRAND.surface, borderRadius: 16, overflow: "hidden", border: `1px solid ${BRAND.border}` }}>
              <thead>
                <tr style={{ background: BRAND.grayLight }}>
                  {[bulkSelectMode ? "" : null, t("employer.colWorker"), t("employer.colKYC"), t("employer.colReliability"), t("employer.colRating"), t("employer.colBidRate"), t("employer.colStatus"), t("employer.colAction")].filter(h => h !== null).map((h, i) => (
                    <th key={h || `col${i}`} style={{ padding: "12px 14px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(liveApplicants ?? []).map(a => {
                  const action = applicantAction[a.id] || a.status;
                  const isSelectable = ['pending', 'shortlisted'].includes(action);
                  const isChecked = selectedApplicantIds.includes(a.id);
                  return (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      {bulkSelectMode && (
                        <td style={{ padding: "12px 14px" }}>
                          <input
                            type="checkbox"
                            disabled={!isSelectable || (!isChecked && selectedApplicantIds.length >= openSlotsRemaining())}
                            checked={isChecked}
                            onChange={e => setSelectedApplicantIds(prev => e.target.checked ? [...prev, a.id] : prev.filter(id => id !== a.id))}
                          />
                        </td>
                      )}
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setWorkerProfileModal(a)} title={t("employer.viewWorkerProfileHint")}>
                          <Avatar name={a.name} size={28} color={BRAND.blue} />
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.primary, textDecoration: "underline", textUnderlineOffset: 2 }}>{a.name}</div>
                              {a.verified && (
                                <span title={t("employer.applicantVerifiedTitle")} role="img" aria-label={t("employer.applicantVerifiedTitle")} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 13, height: 13, borderRadius: "50%", background: BRAND.blue, color: "#fff", fontSize: 9, lineHeight: 1, flexShrink: 0 }}>✓</span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: BRAND.textMuted }}>{a.completedShifts} {t("employer.shiftsDoneSuffix")}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px" }}><Badge color={a.kyc === "Advanced" ? "teal" : a.kyc === "Standard" ? "blue" : "gray"} size="xs">{a.kyc}</Badge></td>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <Progress value={a.reliability} color={a.reliability > 90 ? BRAND.green : a.reliability > 75 ? BRAND.accent : BRAND.red} />
                          <span style={{ fontSize: 12, color: BRAND.text, minWidth: 28 }}>{a.reliability}</span>
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px" }}><StarRating value={a.rating} size={11} /></td>
                      <td style={{ padding: "12px 14px", fontWeight: 700, color: BRAND.primary, fontSize: 14 }}>RM{a.wageBid}</td>
                      <td style={{ padding: "12px 14px" }}>
                        <Pill
                          label={action === 'offered' ? t("employer.awaitingResponse") : action}
                          color={action === "accepted" ? "green" : action === "shortlisted" ? "amber" : action === "offered" ? "blue" : (action === "rejected" || action === "expired") ? "red" : "gray"}
                        />
                        {action === 'offered' && a.offerExpiresAt && (
                          <div style={{ fontSize: 10, color: BRAND.textMuted, marginTop: 2 }}>by {new Date(a.offerExpiresAt).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                        )}
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        {isSelectable && !bulkSelectMode && (
                          <div style={{ display: "flex", gap: 6 }}>
                            {action !== "shortlisted" && <Btn size="xs" variant="secondary" onClick={() => handleApplicantAction(a.id, "shortlisted")}>{t("employer.shortlistBtn")}</Btn>}
                            <Btn size="xs" variant="success" disabled={offering || openSlotsRemaining() === 0} onClick={() => makeOffer([a.id])}>{t("employer.selectBtn")}</Btn>
                            <Btn size="xs" variant="danger" onClick={() => handleApplicantAction(a.id, "rejected")}>{t("common.reject")}</Btn>
                          </div>
                        )}
                        {action === "offered" && <span style={{ fontSize: 12, color: BRAND.blue }}>{t("employer.waitingOnWorker")}</span>}
                        {action === "accepted" && selectedShift.status !== "completed" && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 12, color: BRAND.green }}>{t("employer.confirmedStatus")}</span>
                            <Btn size="xs" variant="secondary" onClick={() => setViewContractModal(a)}>{t("employer.viewContractBtn")}</Btn>
                          </div>
                        )}
                        {action === "rejected" && <span style={{ fontSize: 12, color: BRAND.red }}>{t("employer.notSelected")}</span>}
                        {action === "expired" && <span style={{ fontSize: 12, color: BRAND.red }}>{t("employer.offerExpiredStatus")}</span>}
                        {action === "accepted" && selectedShift.status === "completed" && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <Btn size="xs" variant="secondary" onClick={() => setViewContractModal(a)}>{t("employer.viewContractBtn")}</Btn>
                            <Btn size="xs" variant="secondary" onClick={() => setDisputeModal({ applicationId: a.id, shiftTitle: selectedShift.title })}>{t("myBids.fileDisputeBtn")}</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        )}

        {view === "postshift" && (
          <div style={{ maxWidth: 600 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{editingShiftId ? t("employer.editShiftTitle") : t("employer.postAShiftTitle")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{editingShiftId ? t("employer.editShiftSubtitle") : t("employer.postAShiftSubtitle")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: postStep >= s ? BRAND.primary : BRAND.border, color: postStep >= s ? "#fff" : BRAND.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: 12, color: postStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: postStep === s ? 700 : 400 }}>{[t("employer.stepShiftDetails"), t("employer.stepRequirements"), t("employer.stepReview")][s - 1]}</span>
                  {s < 3 && <span style={{ color: BRAND.border, fontSize: 18 }}>→</span>}
                </div>
              ))}
            </div>

            <Card>
              {postStep === 1 && (
                <div>
                  <Input label={t("employer.fieldShiftTitle")} placeholder={t("employer.shiftTitlePlaceholder")} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.fieldJobDescription")}</label>
                    <textarea
                      placeholder={t("employer.jobDescriptionPlaceholder")}
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 80, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <Select label={t("employer.labelCategory")} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={SHIFT_CATEGORIES.map(v => ({ value: v, label: v }))} />
                  <LocationAutocomplete label={t("employer.labelLocation")} value={form.location} onChange={val => setForm(f => ({ ...f, location: val }))} />
                  <div style={{marginTop:8, marginBottom:16}}>
                    <div style={{fontSize:12, color:'#64748b', marginBottom:4}}>{t("employer.addressVisibilityLabel")}</div>
                    <div style={{display:'flex', gap:12}}>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:13, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="public"
                          checked={form.addressVisibility !== 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'public'}))} />
                        {t("employer.addressVisibilityPublic")}
                      </label>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:13, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="accepted_only"
                          checked={form.addressVisibility === 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'accepted_only'}))} />
                        {t("employer.addressVisibilityPrivate")}
                      </label>
                    </div>
                  </div>
                  <Input label={t("employer.labelHeadcount")} type="number" value={form.headcount} onChange={e => setForm(f => ({ ...f, headcount: e.target.value }))} style={{ maxWidth: 160 }} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.labelSchedule")}</label>
                    {form.occurrences.map((occ, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: form.isMultiDay ? "1fr 1fr 1fr auto" : "1fr 1fr 1fr", gap: 8, marginBottom: 8, alignItems: "start" }}>
                        <Input type="date" value={occ.date} style={{ marginBottom: 0 }} onChange={e => setForm(f => ({ ...f, occurrences: f.occurrences.map((o, oi) => oi === i ? { ...o, date: e.target.value } : o) }))} />
                        <Input type="time" value={occ.start} style={{ marginBottom: 0 }} onChange={e => setForm(f => ({ ...f, occurrences: f.occurrences.map((o, oi) => oi === i ? { ...o, start: e.target.value } : o) }))} />
                        <Input type="time" value={occ.end} style={{ marginBottom: 0 }} onChange={e => setForm(f => ({ ...f, occurrences: f.occurrences.map((o, oi) => oi === i ? { ...o, end: e.target.value } : o) }))} />
                        {form.isMultiDay && (
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, occurrences: f.occurrences.filter((_, oi) => oi !== i) }))}
                            disabled={form.occurrences.length <= 1}
                            aria-label={t("employer.removeDay")}
                            style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: form.occurrences.length <= 1 ? BRAND.textMuted : BRAND.red, cursor: form.occurrences.length <= 1 ? "not-allowed" : "pointer", fontSize: 16, opacity: form.occurrences.length <= 1 ? 0.4 : 1 }}
                          >×</button>
                        )}
                      </div>
                    ))}
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8, marginBottom: form.isMultiDay ? 8 : 0 }}>
                      <input
                        type="checkbox"
                        checked={form.isMultiDay}
                        onChange={e => {
                          const checked = e.target.checked;
                          setForm(f => ({ ...f, isMultiDay: checked, occurrences: checked ? f.occurrences : f.occurrences.slice(0, 1) }));
                        }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("employer.multiDayCheckbox")}</span>
                    </label>
                    {form.isMultiDay && (
                      <Btn
                        variant="secondary"
                        size="sm"
                        disabled={form.occurrences.length >= 14}
                        onClick={() => setForm(f => ({ ...f, occurrences: [...f.occurrences, { date: "", start: "", end: "" }] }))}
                      >+ {t("employer.addAnotherDay")}</Btn>
                    )}
                    <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 6 }}>{t("employer.scheduleHint")}</div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.wageRangeLabel")}</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Input placeholder={t("employer.wageMinPlaceholder")} type="number" value={form.wageMin} onChange={e => setForm(f => ({ ...f, wageMin: e.target.value }))} />
                      <Input placeholder={t("employer.wageMaxPlaceholder")} type="number" value={form.wageMax} onChange={e => setForm(f => ({ ...f, wageMax: e.target.value }))} />
                    </div>
                    {form.wageMin && form.wageMax && (
                      <div style={{ background: BRAND.primaryLight, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: BRAND.primary }}>
                        {t("employer.bidCapHint").replace("{amount}", (parseFloat(form.wageMax || 0) * 1.5).toFixed(0))}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: form.offersTransportAllowance ? 8 : 0 }}>
                      <input
                        type="checkbox"
                        checked={form.offersTransportAllowance}
                        onChange={e => setForm(f => ({ ...f, offersTransportAllowance: e.target.checked, transportAllowance: e.target.checked ? f.transportAllowance : "" }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{t("employer.offerTransportAllowance")}</span>
                    </label>
                    {form.offersTransportAllowance && (
                      <Input
                        placeholder={t("employer.transportAllowancePlaceholder")}
                        type="number"
                        value={form.transportAllowance}
                        onChange={e => setForm(f => ({ ...f, transportAllowance: e.target.value }))}
                        style={{ marginTop: 0, marginBottom: 0 }}
                      />
                    )}
                    <div style={{ fontSize: 11, color: BRAND.textMuted, marginTop: 6 }}>
                      {t("employer.transportAllowanceHint")}
                    </div>
                  </div>
                  <Btn onClick={() => {
                    const reason = validateOccurrences(form.occurrences);
                    if (reason === 'empty' || reason === 'incomplete') { toast(t('toast.shiftFieldsRequired'), 'error'); return; }
                    if (reason === 'pastDate') { toast(t('toast.scheduleDatePast'), 'error'); return; }
                    if (reason === 'duplicateDate') { toast(t('toast.scheduleDuplicateDate'), 'error'); return; }
                    setPostStep(2);
                  }} style={{ width: "100%", justifyContent: "center" }}>{t("employer.nextRequirements")}</Btn>
                </div>
              )}
              {postStep === 2 && (
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.labelDressCode")}</label>
                    <textarea
                      placeholder={t("employer.dressCodePlaceholder")}
                      value={form.dress}
                      onChange={e => setForm(f => ({ ...f, dress: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 60, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.requiredDocumentsLabel")}</label>
                    {[t("employer.docIcPassport"), t("employer.docFoodHandler"), t("employer.docFirstAid"), t("employer.docDrivingLicense")].map(doc => (
                      <label key={doc} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: 13, color: BRAND.text }}>
                        <input type="checkbox" /> {doc}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.labelLanguageRequirements")}</label>
                    {SHIFT_LANGUAGES.map(lang => (
                      <label key={lang} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: 13, color: BRAND.text }}>
                        <input
                          type="checkbox"
                          checked={form.languageRequirements.includes(lang)}
                          onChange={() => setForm(f => ({ ...f, languageRequirements: f.languageRequirements.includes(lang) ? f.languageRequirements.filter(l => l !== lang) : [...f.languageRequirements, lang] }))}
                        /> {lang}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.specialRequirementsLabel")}</label>
                    <textarea
                      placeholder={t("employer.specialRequirementsPlaceholder")}
                      value={form.specialRequirements}
                      onChange={e => setForm(f => ({ ...f, specialRequirements: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 80, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn variant="secondary" onClick={() => setPostStep(1)} style={{ flex: 1, justifyContent: "center" }}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></Btn>
                    <Btn onClick={() => setPostStep(3)} style={{ flex: 1, justifyContent: "center" }}>{t("employer.nextReview")}</Btn>
                  </div>
                </div>
              )}
              {postStep === 3 && (
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text, marginBottom: 16 }}>{t("employer.reviewYourShift")}</div>
                  {[
                    [t("employer.reviewLabelTitle"), form.title || t("employer.reviewNotSet")],
                    [t("employer.labelCategory"), form.category],
                    [t("employer.labelLocation"), form.location],
                    [t("employer.labelHeadcount"), form.headcount],
                    [t("employer.reviewLabelWageRange"), form.wageMin && form.wageMax ? `RM${form.wageMin}–RM${form.wageMax}/h` : t("employer.reviewNotSet")],
                    [t("employer.reviewLabelTransportAllowance"), form.offersTransportAllowance && form.transportAllowance ? `RM${form.transportAllowance}` : t("employer.transportNotOffered")],
                    [t("employer.labelDressCode"), form.dress || t("employer.dressCodeNone")],
                    [t("employer.reviewLabelLanguages"), form.languageRequirements.length > 0 ? form.languageRequirements.join(", ") : t("employer.reviewNotSet")],
                    [t("employer.specialRequirementsLabel"), form.specialRequirements || t("employer.reviewNotSet")],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${BRAND.border}`, fontSize: 13 }}>
                      <span style={{ color: BRAND.textMuted, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontWeight: 600, color: BRAND.text, textAlign: "right", whiteSpace: "pre-wrap" }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ padding: "8px 0", borderBottom: `1px solid ${BRAND.border}`, fontSize: 13 }}>
                    <div style={{ color: BRAND.textMuted, marginBottom: 6 }}>{t("employer.labelSchedule")}</div>
                    {form.occurrences.map((occ, i) => (
                      <div key={i} style={{ fontWeight: 600, color: BRAND.text, marginBottom: 2 }}>{formatOccurrenceLine(occ, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                    ))}
                  </div>
                  {form.wageMax && form.headcount && (() => {
                    // Sums real duration across every occurrence, not a
                    // hardcoded single 8h day — reflects the full multi-day
                    // commitment. Each occurrence's own overnight handling
                    // (end time past midnight) is done inside occurrenceHours.
                    const totalHours = totalOccurrenceHours(form.occurrences);
                    const reserve = parseFloat(form.wageMax || 0) * parseInt(form.headcount || 0) * totalHours;
                    return (
                      <div style={{ background: BRAND.amberLight, borderRadius: 10, padding: "12px 16px", marginTop: 16, marginBottom: 16 }}>
                        <div style={{ fontSize: 12, color: BRAND.amber, fontWeight: 600, marginBottom: 4 }}>{t("employer.estimatedReserveLabel")}</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.amber }}>RM{reserve.toFixed(0)}</div>
                        <div style={{ fontSize: 11, color: BRAND.amber }}>{t("employer.estimatedReserveFormula")}</div>
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <Btn variant="secondary" onClick={() => setPostStep(2)} style={{ flex: 1, justifyContent: "center" }}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></Btn>
                    <Btn onClick={async () => {
                      if (!user) { toast(t('toast.signInToPostShift'), 'error'); return; }
                      if (!editingShiftId && !guardPosting()) return;
                      const reason = validateOccurrences(form.occurrences);
                      if (!form.title || reason) {
                        toast(t('toast.shiftFieldsRequired'), 'error'); return;
                      }
                      const sortedOccurrences = [...form.occurrences].sort((a, b) => a.date.localeCompare(b.date));
                      const first = sortedOccurrences[0];
                      const startAt = new Date(`${first.date}T${first.start}:00+08:00`).toISOString();
                      const endAt   = new Date(`${first.date}T${first.end}:00+08:00`).toISOString();
                      const wageMin = parseFloat(form.wageMin) || 0;
                      const wageMax = parseFloat(form.wageMax) || 0;
                      if (wageMax < wageMin) { toast(t('toast.maxPayGteMinPay'), 'error'); return; }
                      const payload = {
                        title:       sanitizeBulkTextValue(form.title.trim()),
                        description: form.description ? sanitizeBulkTextValue(form.description.trim()) : null,
                        category:    form.category || 'Other',
                        location:    sanitizeBulkTextValue((form.location || '').trim() || 'Kuala Lumpur'),
                        dress_code:  form.dress ? sanitizeBulkTextValue(form.dress.trim()) : null,
                        start_at:    startAt,
                        end_at:      endAt,
                        occurrences: sortedOccurrences,
                        wage_min:    wageMin,
                        wage_max:    wageMax || wageMin,
                        headcount:   parseInt(form.headcount) || 1,
                        address_visibility: form.addressVisibility || 'public',
                        transport_allowance: form.offersTransportAllowance ? (parseFloat(form.transportAllowance) || 0) : 0,
                        language_requirements: form.languageRequirements,
                        requirements: form.specialRequirements.trim() ? { special: form.specialRequirements.trim() } : null,
                      };
                      let error;
                      if (editingShiftId) {
                        ({ error } = await supabase.from('shifts').update(payload).eq('id', editingShiftId));
                      } else {
                        ({ error } = await supabase.from('shifts').insert({ employer_id: user.id, status: 'open', ...payload }));
                      }
                      if (error) {
                        // The shifts insert policy rejects unverified employers with a raw
                        // "violates row-level security" error — translate it into the real
                        // reason instead of leaking Postgres internals.
                        const friendly = /row.?level security/i.test(error.message || "")
                          ? t('employer.postShiftUnverifiedHint')
                          : (editingShiftId ? 'Failed to update shift: ' : t('toast.postShiftFailed')) + error.message;
                        toast(friendly, 'error');
                        return;
                      }
                      toast(editingShiftId ? 'Shift updated!' : t('toast.shiftPublished'), 'success');
                      setEditingShiftId(null);
                      setView('shifts');
                      setPostStep(1);
                      loadEmployerShifts();
                    }} style={{ flex: 1, justifyContent: "center" }}>{Icons.Rocket({ size: 14 })} <span style={{ marginLeft: 8 }}>{editingShiftId ? t("employer.saveChanges") : t("employer.publishShift")}</span></Btn>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}

        {view === "bulkupload" && (
          <div style={{ maxWidth: bulkUploadStep === 1 ? 600 : 1160 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("employer.bulkUploadTitle")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{t("employer.bulkUploadSubtitle")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: bulkUploadStep >= s ? BRAND.primary : BRAND.border, color: bulkUploadStep >= s ? "#fff" : BRAND.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: 12, color: bulkUploadStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: bulkUploadStep === s ? 700 : 400 }}>{[t("employer.bulkStepUpload"), t("employer.bulkStepReview"), t("employer.bulkStepPublish")][s - 1]}</span>
                  {s < 3 && <span style={{ color: BRAND.border, fontSize: 18 }}>→</span>}
                </div>
              ))}
            </div>

            {bulkUploadStep === 1 && (
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{t("employer.bulkUploadCsvHeading")}</div>
                  <Btn variant="ghost" size="sm" onClick={downloadBulkUploadTemplate}>{t("employer.bulkDownloadTemplate")}</Btn>
                </div>
                <FileInput
                  label={t("employer.bulkChooseFile")}
                  accept=".csv"
                  onChange={handleBulkUploadFileChange}
                  helper={t("employer.bulkChooseFileHelper")}
                  fileName={bulkUploadFileName}
                  error={!!bulkUploadFileError}
                />
                {bulkUploadFileError && (
                  <div style={{ fontSize: 12, color: BRAND.red, marginTop: -8, marginBottom: 8 }}>{bulkUploadFileError}</div>
                )}
              </Card>
            )}

            {bulkUploadStep === 2 && (() => {
              const readyCount = bulkUploadRows.filter(r => r._status === "ready").length;
              const needsFixCount = bulkUploadRows.filter(r => r._status === "needs_fix").length;
              const total = bulkUploadRows.length;
              const pillFor = (status) => (
                <Pill
                  label={status === "ready" ? t("employer.bulkStatusReady") : status === "needs_fix" ? t("employer.bulkStatusNeedsFix") : status === "published" ? t("employer.bulkStatusPublished") : t("employer.bulkStatusFailed")}
                  color={status === "ready" ? "green" : status === "needs_fix" ? "amber" : status === "published" ? "blue" : "red"}
                />
              );
              return (
                <div>
                  <div style={{ background: needsFixCount > 0 ? BRAND.amberLight : BRAND.greenLight, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, fontWeight: 600, color: needsFixCount > 0 ? BRAND.amber : BRAND.green }}>
                    {t("employer.bulkRowsSummary").replace("{ready}", readyCount).replace("{total}", total).replace("{needsFix}", needsFixCount)}
                  </div>
                  <Card style={{ padding: 0, overflow: "auto", marginBottom: 16 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1280 }}>
                      <thead>
                        <tr style={{ background: BRAND.grayLight }}>
                          {[t("employer.bulkColRow"), t("employer.bulkColStatus"), t("employer.bulkColTitle"), t("employer.bulkColCategory"), t("employer.bulkColDate"), t("employer.bulkColStart"), t("employer.bulkColEnd"), t("employer.bulkColMinWage"), t("employer.bulkColMaxWage"), t("employer.bulkColHeadcount"), t("employer.bulkColLocation"), t("employer.bulkColDressCode"), t("employer.bulkColTransport"), ""].map(h => (
                            <th key={h} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}`, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bulkUploadRows.map(row => {
                          const locked = row._status === "published";
                          const wageBad = row.wageMin !== "" && row.wageMax !== "" && parseFloat(row.wageMax) < parseFloat(row.wageMin);
                          return (
                            <tr key={row._rowNum} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                              <td style={{ padding: "8px 12px", fontSize: 12, color: BRAND.textMuted }}>{row._rowNum}</td>
                              <td style={{ padding: "8px 12px" }}>
                                {pillFor(row._status)}
                                {row._status === "failed" && row._error && (
                                  <div style={{ fontSize: 11, color: BRAND.red, marginTop: 4, maxWidth: 140 }}>{row._error}</div>
                                )}
                              </td>
                              <td style={{ padding: "8px 12px", minWidth: 170 }}><Input value={row.title} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "title", e.target.value)} style={{ marginBottom: 0 }} error={!row.title.trim()} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 140 }}>
                                <Select value={row.category} onChange={e => updateBulkUploadRow(row._rowNum, "category", e.target.value)} options={[{ value: "", label: t("employer.bulkSelectCategoryPlaceholder") }, ...SHIFT_CATEGORIES.map(c => ({ value: c, label: c }))]} style={{ marginBottom: 0 }} />
                              </td>
                              <td style={{ padding: "8px 12px", minWidth: 140 }}><Input type="date" value={row.date} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "date", e.target.value)} style={{ marginBottom: 0 }} error={!/^\d{4}-\d{2}-\d{2}$/.test(row.date)} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 100 }}><Input type="time" value={row.timeStart} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "timeStart", e.target.value)} style={{ marginBottom: 0 }} error={!/^\d{2}:\d{2}$/.test(row.timeStart)} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 100 }}><Input type="time" value={row.timeEnd} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "timeEnd", e.target.value)} style={{ marginBottom: 0 }} error={!/^\d{2}:\d{2}$/.test(row.timeEnd)} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 90 }}><Input type="number" value={row.wageMin} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "wageMin", e.target.value)} style={{ marginBottom: 0 }} error={wageBad} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 90 }}><Input type="number" value={row.wageMax} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "wageMax", e.target.value)} style={{ marginBottom: 0 }} error={wageBad} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 90 }}><Input type="number" value={row.headcount} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "headcount", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 170 }}><Input value={row.location} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "location", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 150 }}><Input value={row.dress} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "dress", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 90 }}><Input type="number" value={row.transportAllowance} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "transportAllowance", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px" }}>
                                {row._status === "failed" && (
                                  <Btn size="xs" variant="secondary" onClick={() => retryBulkUploadRow(row._rowNum)}>{t("employer.bulkRetry")}</Btn>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </Card>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn variant="secondary" onClick={beginBulkUpload} style={{ flex: 1, justifyContent: "center" }}>{t("employer.bulkBackToUpload")}</Btn>
                    <Btn onClick={() => setBulkUploadStep(3)} disabled={readyCount === 0} style={{ flex: 1, justifyContent: "center" }}>{t("employer.bulkContinueToPublish")}</Btn>
                  </div>
                </div>
              );
            })()}

            {bulkUploadStep === 3 && (() => {
              const readyCount = bulkUploadRows.filter(r => r._status === "ready").length;
              const publishedCount = bulkUploadRows.filter(r => r._status === "published").length;
              const failedCount = bulkUploadRows.filter(r => r._status === "failed").length;
              const needsFixCount = bulkUploadRows.filter(r => r._status === "needs_fix").length;
              const allSettled = !bulkUploadPublishing && readyCount === 0 && needsFixCount === 0 && (publishedCount > 0 || failedCount > 0);
              return (
                <Card>
                  <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text, marginBottom: 12 }}>{t("employer.bulkStepPublish")}</div>
                  <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 16 }}>
                    {t("employer.bulkRowsSummary").replace("{ready}", readyCount).replace("{total}", bulkUploadRows.length).replace("{needsFix}", needsFixCount)}
                  </div>
                  {bulkUploadPublishing && (
                    <div style={{ background: BRAND.primaryLight, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, fontWeight: 600, color: BRAND.primary }}>
                      {t("employer.bulkPublishing").replace("{done}", bulkUploadProgress.done).replace("{total}", bulkUploadProgress.total)}
                    </div>
                  )}
                  {!bulkUploadPublishing && (publishedCount > 0 || failedCount > 0) && (
                    <div style={{ background: failedCount > 0 ? BRAND.amberLight : BRAND.greenLight, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, fontWeight: 600, color: failedCount > 0 ? BRAND.amber : BRAND.green }}>
                      {t("employer.bulkPublishSummary").replace("{published}", publishedCount).replace("{failed}", failedCount)}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, maxHeight: 280, overflowY: "auto" }}>
                    {bulkUploadRows.map(row => (
                      <div key={row._rowNum} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: BRAND.grayLight, borderRadius: 8, gap: 12 }}>
                        <div style={{ fontSize: 13, color: BRAND.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{row._rowNum} {row.title || t("employer.bulkUntitled")}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          {row._status === "failed" && row._error && <span style={{ fontSize: 11, color: BRAND.red }}>{row._error}</span>}
                          <Pill
                            label={row._status === "ready" ? t("employer.bulkStatusReady") : row._status === "needs_fix" ? t("employer.bulkStatusNeedsFix") : row._status === "published" ? t("employer.bulkStatusPublished") : t("employer.bulkStatusFailed")}
                            color={row._status === "ready" ? "green" : row._status === "needs_fix" ? "amber" : row._status === "published" ? "blue" : "red"}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn variant="secondary" onClick={() => setBulkUploadStep(2)} style={{ flex: 1, justifyContent: "center" }}>{t("employer.bulkBackToFix")}</Btn>
                    {allSettled ? (
                      <Btn onClick={beginBulkUpload} style={{ flex: 1, justifyContent: "center" }}>{t("employer.bulkDone")}</Btn>
                    ) : (
                      <Btn onClick={publishBulkUploadRows} disabled={bulkUploadPublishing || readyCount === 0} style={{ flex: 1, justifyContent: "center" }}>
                        {bulkUploadPublishing ? t("employer.bulkPublishing").replace("{done}", bulkUploadProgress.done).replace("{total}", bulkUploadProgress.total) : t("employer.bulkPublishReady")}
                      </Btn>
                    )}
                  </div>
                </Card>
              );
            })()}
          </div>
        )}

        {view === "billing" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>{t("employer.billingTitle")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 12 }}>
              <Stat label={t("employer.pendingPayout")} value={toCurrency(committedPayoutTotal)} color={BRAND.amber} />
              <Stat label={t("employer.totalPaidOut")} value={toCurrency(paidOutPayoutTotal)} color={BRAND.primary} />
            </div>
            <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 16 }}>
              {t("employer.escrowUnavailableNote")}
            </div>
            <Btn onClick={() => toast(t('toast.escrowTopupUnavailable'), 'info')} style={{ marginBottom: 24 }}>{t("employer.addFundsSoon")}</Btn>
            <div style={{ fontWeight: 700, fontSize: 16, color: BRAND.text, marginBottom: 12 }}>{t("employer.payoutLedgerTitle")}</div>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {[t("employer.colDateShort"), t("employer.colStatus"), t("employer.colAmount")].map(h => (
                      <th key={h} style={{ padding: "12px 16px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employerPayoutItems.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: "16px", fontSize: 13, color: BRAND.textMuted, textAlign: "center" }}>{t("employer.noPayoutObligations")}</td></tr>
                  )}
                  {employerPayoutItems.map(item => (
                    <tr key={item.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString('en-MY') : t("employer.tbaShort")}</td>
                      <td style={{ padding: "12px 16px" }}><Pill label={String(item.status || 'queued').replaceAll('_', ' ')} color={mapPayoutPillColor(item.status)} /></td>
                      <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 700, color: BRAND.text }}>{toCurrency(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "account" && (
          <div style={{ maxWidth: 500 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>{t("employer.accountTitle")}</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text }}>{t("employer.companyDetailsTitle")}</div>
                {employerProfile?.employer_verification_status === "verified" && (
                  <span title={t("employer.verifiedBadgeTitle")} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, background: BRAND.blueLight, color: BRAND.blue, fontSize: 11, fontWeight: 700 }}>
                    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 13, height: 13, borderRadius: "50%", background: BRAND.blue, color: "#fff", fontSize: 9, lineHeight: 1 }}>✓</span>
                    {t("employer.verifiedBadge")}
                  </span>
                )}
              </div>
              <Input label={t("employer.companyNameLabel")} placeholder={t("employer.companyNamePlaceholder")} value={employerCompanyForm.companyName} onChange={(e) => setEmployerCompanyForm(prev => ({ ...prev, companyName: e.target.value }))} />
              <Input label={t("employer.ssmNumberLabel")} placeholder={t("employer.ssmNumberPlaceholder")} value={employerCompanyForm.ssmNumber} onChange={(e) => setEmployerCompanyForm(prev => ({ ...prev, ssmNumber: e.target.value }))} />
              <Input label={t("employer.contactEmailLabel")} placeholder="hr@company.com" value={user?.email || ""} onChange={() => {}} disabled />
              <label style={{ display: "block", marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.ssmCertLabel")}</div>
                <div style={{ fontSize: 11, color: BRAND.textMuted, marginBottom: 8 }}>{t("employer.ssmCertHint")}</div>
                <input
                  type="file" accept="image/*,application/pdf"
                  onChange={e => { const f = e.target.files?.[0] || null; setEmployerCompanyForm(prev => ({ ...prev, ssmCertFile: f })); }}
                  style={{ fontSize: 12 }}
                />
                {employerProfile?.ssm_document_path && !employerCompanyForm.ssmCertFile && (
                  <div style={{ fontSize: 11, color: BRAND.green, marginTop: 6 }}>{t("employer.ssmCertOnFile")}</div>
                )}
              </label>
              {companyDetailsMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{companyDetailsMessage}</div>}
              <Btn onClick={saveEmployerCompanyDetails} disabled={companyDetailsLoading} style={{ width: "100%", justifyContent: "center" }}>{t("employer.saveChanges")}</Btn>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("employer.bankingSectionTitle")}</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>
                {t("employer.bankingSectionHint")}
              </div>
              <Select
                label={t("settings.bankLabel")}
                value={employerBankForm.bankName}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, bankName: e.target.value }))}
                options={MALAYSIAN_BANK_OPTIONS.map((name) => ({ value: name, label: name }))}
              />
              <Input
                label={t("settings.accountHolderName")}
                placeholder={t("employer.accountHolderPlaceholder")}
                value={employerBankForm.accountHolderName}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, accountHolderName: e.target.value }))}
              />
              <Input
                label={t("settings.accountNumber")}
                placeholder={t("employer.accountNumberPlaceholder")}
                value={employerBankForm.accountNumber}
                onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, accountNumber: e.target.value }))}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, color: BRAND.text }}>
                <input
                  type="checkbox"
                  checked={employerBankForm.fundingReady}
                  onChange={(e) => setEmployerBankForm((prev) => ({ ...prev, fundingReady: e.target.checked }))}
                />
                {t("employer.fundingReadyLabel")}
              </label>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: BRAND.textMuted }}>{t("employer.verificationLabel")}</span>
                <Pill
                  label={employerBanking?.verification_status ? `SecureSign ${employerBanking.verification_status}` : t("settings.secureSignPending")}
                  color={mapVerificationPillColor(employerBanking?.verification_status)}
                />
              </div>
              {employerBanking?.account_number_last4 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>
                  {t("employer.savedAccountPrefix")} {employerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.saveBanking")}</Btn>
                <Btn onClick={verifyEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.verifySecureSign")}</Btn>
              </div>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("employer.outgoingObligationsTitle")}</div>
              {employerPayoutItems.length === 0 && (
                <div style={{ fontSize: 12, color: BRAND.textMuted }}>{t("employer.noPayoutObligations")}</div>
              )}
              {employerPayoutItems.map((item) => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{toCurrency(item.amount)}</div>
                    <div style={{ fontSize: 11, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString("en-MY") : t("employer.tbaShort")}</div>
                  </div>
                  <Pill label={String(item.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(item.status)} />
                </div>
              ))}
            </Card>
          </div>
        )}

        {view === 'chat' && (
          // Same fix as the worker chat view: bound this wrapper to the
          // ancestor's actual box instead of guessing a vh-offset, so only
          // the message list scrolls instead of both it and the outer pane.
          <div style={activeChatShift ? {display:'flex', flexDirection:'column', height:'100%', minHeight:0} : {}}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4, flexShrink:0 }}>{t("chat.title")}</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 16, flexShrink:0 }}>{t("chat.employerSubtitle")}</div>
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:BRAND.textMuted, marginTop:48}}>
                  <div style={{fontSize:40}}>💬</div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleEmployer")}</div>
                  <div style={{fontSize:12, marginTop:4}}>{t("chat.emptyHintEmployer")}</div>
                </div>
              ) : (
                chatConversations.map(conv => (
                  <div key={conv.shiftId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:BRAND.surface, borderRadius:10, border:`1px solid ${BRAND.border}`,
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:600, color:BRAND.text}}>{conv.title}</div>
                      <div style={{fontSize:12, color:BRAND.textMuted}}>{conv.date} · {conv.otherUserLabel}</div>
                    </div>
                    <span style={{color:BRAND.textMuted}}>›</span>
                  </div>
                ))
              )
            ) : (
              <div style={{display:'flex', flexDirection:'column', flex:1, minHeight:0}}>
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    style={{background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#2563EB'}}>←</button>
                  <div>
                    <div style={{fontWeight:600, color:BRAND.text}}>{activeChatShift.title}</div>
                    <div style={{fontSize:12, color:BRAND.textMuted}}>{activeChatShift.otherUserLabel}</div>
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingBottom:8}}>
                  {chatLoading && <div style={{textAlign:'center', color:BRAND.textMuted, padding:16}}>{t("chat.loading")}</div>}
                  {chatMessages.map(msg => {
                    const isMe = msg.sender_id === user?.id;
                    return (
                      <div key={msg.id} style={{display:'flex', flexDirection:'column', alignItems: isMe ? 'flex-end' : 'flex-start'}}>
                        <div style={{fontSize:11, fontWeight:600, color:BRAND.textMuted, margin: isMe ? '0 2px 2px 0' : '0 0 2px 2px'}}>
                          {isMe ? 'You' : (chatSenderNames[msg.sender_id] || 'Member')}
                        </div>
                        <div style={{maxWidth:'75%', padding:'8px 12px', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                          background: isMe ? BRAND.primary : BRAND.grayLight, color: isMe ? '#fff' : BRAND.text, fontSize:14}}>
                          <div>{msg.content}</div>
                          <div style={{fontSize:10, opacity:0.6, marginTop:2, textAlign:'right'}}>
                            {new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <div style={{display:'flex', gap:8, paddingTop:8, borderTop:`1px solid ${BRAND.border}`}}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    placeholder={t("chat.inputPlaceholder")}
                    style={{flex:1, padding:'10px 12px', borderRadius:8, border:`1px solid ${BRAND.border}`, fontSize:14, background:BRAND.input, color:BRAND.text}}
                  />
                  <button onClick={sendMessage}
                    style={{padding:'10px 16px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                    {t("chat.send")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {contractModal && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div style={{background:'#fff', borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'80vh', overflowY:'auto'}}>
            <h3 style={{fontSize:18, fontWeight:700, color:'#1e293b', marginBottom:4}}>{t("contract.employerTitle")}</h3>
            <p style={{fontSize:12, color:'#64748b', marginBottom:16}}>{t("contract.employerSubtitle")}</p>
            <div style={{background:'#f8fafc', borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color:'#374151', marginBottom:16}}>
              <p><strong>{t("contract.agreementHeading")}</strong></p>
              <p>{t("contract.enteredBetween")}</p>
              <p>• <strong>{t("contract.employerLabel")}</strong> {t("contract.employerOnFile")}</p>
              <p>• <strong>{t("contract.workerLabel")}</strong> {contractModal.workerName}</p>
              <br/>
              <p><strong>{t("contract.shiftDetailsHeading")}</strong></p>
              <p>• {t("contract.roleLabel")} {contractModal.shiftTitle}</p>
              <p>• {t("contract.dateLabel")} {contractModal.shiftDate}</p>
              <p>• {t("contract.timeLabel")} {contractModal.shiftTime}</p>
              <p>• {t("contract.locationLabel")} {contractModal.location}</p>
              <p>• {t("contract.agreedWageLabel")} RM {contractModal.wageAsk}/hr</p>
              <br/>
              <p><strong>{t("contract.termsHeading")}</strong></p>
              <p>1. {t("contract.employerClause1")}</p>
              <p>2. {t("contract.employerClause2")}</p>
              <p>3. {t("contract.employerClause3")}</p>
              <p>4. {t("contract.employerClause4")}</p>
              <p>5. {t("contract.employerClause5")}</p>
              <p>6. {t("contract.employerClause6")}</p>
              <p>7. {t("contract.employerClause7")}</p>
            </div>
            <p style={{fontSize:12, color:'#64748b', marginBottom:12}}>
              {t("contract.confirmSendNote").replace("{name}", contractModal.workerName)}
            </p>
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setContractModal(null)}
                style={{flex:1, padding:'10px', borderRadius:8, border:'1px solid #e2e8f0', background:'#f8fafc', cursor:'pointer', color:'#64748b'}}>
                {t("common.cancel")}
              </button>
              <button onClick={() => {
                toast(t('toast.contractSent'), 'success');
                setContractModal(null);
              }}
                style={{flex:2, padding:'10px', borderRadius:8, background:'#2563EB', color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {t("contract.confirmSendBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {disputeModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div style={{background: BRAND.surface, borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
            <h3 style={{fontSize:18, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("myBids.fileDisputeTitle")}</h3>
            <p style={{fontSize:12, color: BRAND.textMuted, marginBottom:16}}>{disputeModal.shiftTitle}</p>

            <Select
              label={t("myBids.disputeCategoryLabel")}
              value={disputeForm.category}
              onChange={e => setDisputeForm(f => ({ ...f, category: e.target.value }))}
              options={DISPUTE_CATEGORIES.map(c => ({ value: c.value, label: t(c.labelKey) }))}
            />

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("myBids.disputeDescriptionLabel")}</label>
              <textarea
                value={disputeForm.description}
                onChange={e => setDisputeForm(f => ({ ...f, description: e.target.value }))}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 100, resize: "none", boxSizing: "border-box" }}
              />
            </div>

            <div style={{display:'flex', gap:8}}>
              <button onClick={() => { setDisputeModal(null); setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" }); }}
                style={{flex:1, padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.textMuted}}>
                {t("common.cancel")}
              </button>
              <button onClick={submitEmployerDispute} disabled={filingDispute || !disputeForm.description.trim()}
                style={{flex:2, padding:'10px', borderRadius:8, background: BRAND.primary, color:'#fff', border:'none', cursor: filingDispute || !disputeForm.description.trim() ? 'not-allowed' : 'pointer', fontWeight:600, opacity: filingDispute || !disputeForm.description.trim() ? 0.6 : 1}}>
                {filingDispute ? "…" : t("myBids.disputeSubmitBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewContractModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setViewContractModal(null)}>
          <div style={{background: BRAND.surface, borderRadius:16, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border:`1px solid ${BRAND.border}`}} onClick={e => e.stopPropagation()}>
            <h3 style={{fontSize:18, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("contract.agreementHeading")}</h3>
            <p style={{fontSize:12, color: BRAND.textMuted, marginBottom:16}}>{selectedShift?.title}</p>
            <div style={{background: BRAND.grayLight, borderRadius:8, padding:16, fontSize:13, lineHeight:1.8, color: BRAND.text, marginBottom:16}}>
              <p>{t("contract.enteredBetween")}</p>
              <p>• <strong>{t("contract.employerLabel")}</strong> {t("contract.employerOnFile")}</p>
              <p>• <strong>{t("contract.workerLabel")}</strong> {viewContractModal.name}</p>
              <br/>
              <p><strong>{t("contract.shiftDetailsHeading")}</strong></p>
              <p>• {t("contract.roleLabel")} {selectedShift?.title}</p>
              <p>• {t("contract.dateLabel")} {selectedShift?.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift?.date}</p>
              <p>• {t("contract.timeLabel")} {selectedShift?.time}</p>
              <p>• {t("contract.agreedWageLabel")} RM {viewContractModal.wageBid}/hr</p>
              <br/>
              <p><strong>{t("employer.contractSignaturesHeading")}</strong></p>
              <p>• {t("contract.employerLabel")} {viewContractModal.employerSignedAt
                ? `${t("employer.contractSignedOnPrefix")}${new Date(viewContractModal.employerSignedAt).toLocaleString('en-MY', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone: MY_TIMEZONE })}`
                : t("employer.contractNotSignedYet")}</p>
              <p>• {t("contract.workerLabel")} {viewContractModal.workerSignedAt
                ? `${t("employer.contractSignedOnPrefix")}${new Date(viewContractModal.workerSignedAt).toLocaleString('en-MY', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone: MY_TIMEZONE })}`
                : t("employer.contractNotSignedYet")}</p>
            </div>
            {!viewContractModal.workerSignedAt && (
              <div style={{ padding:'8px 12px', background: BRAND.amberLight, borderRadius:8, fontSize:12, color: BRAND.amber, marginBottom:12 }}>{t("employer.contractAwaitingWorker")}</div>
            )}
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setViewContractModal(null)}
                style={{flex:1, padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.text, fontWeight:600}}>
                {t("common.close")}
              </button>
              <button onClick={() => {
                const fmt = (iso) => iso ? `${t("employer.contractSignedOnPrefix")}${new Date(iso).toLocaleString('en-MY', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone: MY_TIMEZONE })}` : t("employer.contractNotSignedYet");
                const ok = openContractPrintWindow({
                  heading: t("contract.agreementHeading"),
                  subheading: selectedShift?.title || "",
                  rows: [
                    { label: t("contract.employerLabel"), value: t("contract.employerOnFile") },
                    { label: t("contract.workerLabel"), value: viewContractModal.name },
                    "",
                    t("contract.shiftDetailsHeading"),
                    { label: t("contract.roleLabel"), value: selectedShift?.title || "" },
                    { label: t("contract.dateLabel"), value: selectedShift?.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : (selectedShift?.date || "") },
                    { label: t("contract.timeLabel"), value: selectedShift?.time || "" },
                    { label: t("contract.agreedWageLabel"), value: `RM ${viewContractModal.wageBid}/hr` },
                    "",
                    t("employer.contractSignaturesHeading"),
                    { label: t("contract.employerLabel"), value: fmt(viewContractModal.employerSignedAt) },
                    { label: t("contract.workerLabel"), value: fmt(viewContractModal.workerSignedAt) },
                  ],
                });
                if (!ok) toast(t("toast.popupBlocked"), "error");
              }}
                style={{flex:1, padding:'10px', borderRadius:8, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {t("contract.printBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {workerProfileModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setWorkerProfileModal(null)}>
          <div style={{background: BRAND.surface, borderRadius:16, padding:24, maxWidth:440, width:'100%', maxHeight:'85vh', overflowY:'auto', border:`1px solid ${BRAND.border}`}} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <Avatar name={workerProfileModal.name} size={48} color={BRAND.blue} />
              <div>
                <div style={{ fontSize:17, fontWeight:800, color: BRAND.text }}>{workerProfileModal.name}</div>
                <Badge color={workerProfileModal.kyc === "Advanced" ? "teal" : workerProfileModal.kyc === "Standard" ? "blue" : "gray"} size="xs">KYC: {workerProfileModal.kyc}</Badge>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:16 }}>
              <Stat label={t("employer.colReliability")} value={workerProfileModal.reliability} color={BRAND.green} />
              <Stat label={t("employer.colRating")} value={workerProfileModal.rating ? workerProfileModal.rating.toFixed(1) : '—'} color={BRAND.accent} />
              <Stat label={t("employer.colBidRate")} value={`RM${workerProfileModal.wageBid}`} color={BRAND.primary} />
            </div>
            <div style={{ fontSize:13, fontWeight:700, color: BRAND.text, marginBottom:8 }}>{t("employer.profileHistoryTitle")}</div>
            {workerHistory === null && <div style={{ fontSize:12, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
            {workerHistory?.length === 0 && <div style={{ fontSize:12, color: BRAND.textMuted, marginBottom:8 }}>{t("employer.profileNoHistory")}</div>}
            {(workerHistory ?? []).map(h => (
              <div key={h.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:`1px solid ${BRAND.border}` }}>
                <div>
                  <div style={{ fontSize:12, fontWeight:600, color: BRAND.text }}>{displayProtectedText(h.shift?.title ?? 'Shift')}</div>
                  <div style={{ fontSize:11, color: BRAND.textMuted }}>{formatShiftDate(h.shift?.start_at)}</div>
                </div>
                <Pill label={h.shift?.status === 'completed' && h.status === 'accepted' ? t("employer.historyCompleted") : h.status} color={h.status === 'accepted' ? 'green' : (h.status === 'rejected' || h.status === 'expired') ? 'red' : 'gray'} />
              </div>
            ))}
            <div style={{ fontSize:11, color: BRAND.textMuted, marginTop:10, marginBottom:14 }}>{t("employer.profileHistoryScopeNote")}</div>
            <button onClick={() => setWorkerProfileModal(null)}
              style={{width:'100%', padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.text, fontWeight:600}}>
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {lateCancelWarning && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div style={{background:BRAND.surface, borderRadius:16, padding:24, maxWidth:440, width:'100%'}}>
            <h3 style={{fontSize:18, fontWeight:700, color:BRAND.red, marginBottom:8}}>{t("employer.lateCancelWarningTitle")}</h3>
            <p style={{fontSize:13, color:BRAND.text, lineHeight:1.6, marginBottom:16}}>
              {t("employer.lateCancelWarningBody").replace('{count}', lateCancelWarning.confirmedCount)}
            </p>
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setLateCancelWarning(null)}
                style={{flex:1, padding:'10px', borderRadius:8, border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, cursor:'pointer', color:BRAND.textMuted}}>
                {t("common.cancel")}
              </button>
              <button onClick={() => doCancelShift(lateCancelWarning.shiftId)} disabled={cancellingShift}
                style={{flex:2, padding:'10px', borderRadius:8, background:BRAND.red, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {cancellingShift ? t("employer.cancellingShift") : t("employer.lateCancelWarningConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── ADMIN PORTAL ─────────────────────────────────────────────────────────────
const AdminPortal = ({ onOpenPortal, compact = false, user = null }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const [view, setView] = useState("overview");
  const [kycActions, setKycActions] = useState({});
  const [flagActions, setFlagActions] = useState({});
  const [livePayoutQueue, setLivePayoutQueue] = useState(null);
  const [payoutRunning, setPayoutRunning] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState("");
  const [kycQueue, setKycQueue] = useState(null);
  const [employerQueue, setEmployerQueue] = useState(null);
  const [kycSignedUrls, setKycSignedUrls] = useState({});
  const [overviewStats, setOverviewStats] = useState(null);
  const [disputesQueue, setDisputesQueue] = useState(null);
  // Basic analytics: event_type -> count, last 7 days (see
  // supabase/migrations/20260720_analytics_events.sql). null = loading,
  // [] = loaded but empty/unavailable (RLS denial or table missing pre-migration).
  const [analyticsCounts, setAnalyticsCounts] = useState(null);

  const navItems = ["Overview", "KYC Queue", "Employer Queue", "Disputes", "Flags", "Payouts", "Config"];

  const FLAGS = [
    { id: 1, user: "Wei Jian Lim", type: "GPS mismatch", riskScore: 87, shift: "Warehouse Packer – Shah Alam", time: "3 hours ago", status: "open" },
    { id: 2, user: "Unknown Device #42", type: "QR token reuse", riskScore: 95, shift: "Event Crew – Music Festival", time: "5 hours ago", status: "open" },
    { id: 3, user: "Muhammad Izzat", type: "No-show (confirmed)", riskScore: 72, shift: "F&B Server – Wedding Banquet", time: "1 day ago", status: "open" },
  ];

  const loadPayoutQueue = async () => {
    const { data, error } = await supabase
      .from("payout_item")
      .select("id, worker_id, employer_id, amount, scheduled_date, status, source_refs, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      setLivePayoutQueue(null);
      setPayoutMessage(`Unable to load payout queue: ${error.message}`);
      return;
    }
    setLivePayoutQueue(data || []);
  };

  useEffect(() => {
    loadPayoutQueue();
  }, []);

  useEffect(() => {
    if (!supabase || (view !== "kycqueue" && view !== "overview")) return;
    (async () => {
      setKycQueue(null);
      const { data: pending, error } = await supabase
        .from("profiles")
        .select("id, full_name, kyc_level, created_at")
        .eq("kyc_level", "pending_review")
        .order("created_at", { ascending: true });
      if (error) { setKycQueue([]); return; }
      setKycQueue(pending || []);
    })();
  }, [view]);

  // Employer SSM verification queue — mirrors the KYC queue pattern. Rows
  // land here automatically: the guard trigger in
  // 20260712b_employer_verification.sql flips any non-admin SSM submission
  // to pending_review, and only an admin JWT may set verified/rejected.
  useEffect(() => {
    if (!supabase || (view !== "employerqueue" && view !== "overview")) return;
    (async () => {
      setEmployerQueue(null);
      const { data: pending, error } = await supabase
        .from("profiles")
        .select("id, full_name, ssm_number, ssm_document_path, employer_verification_status, created_at")
        .eq("employer_verification_status", "pending_review")
        .order("created_at", { ascending: true });
      if (error) { setEmployerQueue([]); return; }
      setEmployerQueue(pending || []);
    })();
  }, [view]);

  const setEmployerVerification = async (userId, status) => {
    const { error } = await supabase.from("profiles").update({ employer_verification_status: status }).eq("id", userId);
    if (error) { toast(`Failed to update: ${error.message}`, "error"); return; }
    setEmployerQueue(prev => (prev ?? []).filter(u => u.id !== userId));
    toast(status === "verified" ? "Employer verified." : "Employer verification rejected.", "success");
  };

  useEffect(() => {
    if (!supabase || (view !== "disputes" && view !== "overview")) return;
    (async () => {
      setDisputesQueue(null);
      const { data, error } = await supabase
        .from("disputes")
        .select("id, category, description, status, admin_notes, created_at, application:applications(id, worker_id, shift:shifts(title, employer_id))")
        .order("created_at", { ascending: false });
      if (error) { setDisputesQueue([]); return; }
      setDisputesQueue(data || []);
    })();
  }, [view]);

  useEffect(() => {
    if (!supabase || view !== "overview") return;
    let active = true;
    (async () => {
      setOverviewStats(null);
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const [openShiftsRes, fillShiftsRes, workersRes, employersRes, todayShiftsRes] = await Promise.all([
        supabase.from("shifts").select("id").eq("status", "open"),
        supabase.from("shifts").select("headcount, filled_count").in("status", ["open", "filled", "completed"]),
        supabase.from("profiles").select("id").eq("role", "worker"),
        supabase.from("profiles").select("id").eq("role", "employer"),
        supabase.from("shifts").select("id")
          .in("status", ["open", "filled", "completed"])
          .gte("start_at", dayStart.toISOString())
          .lt("start_at", dayEnd.toISOString()),
      ]);
      if (!active) return;

      const fillShifts = fillShiftsRes.data || [];
      const totalHeadcount = fillShifts.reduce((sum, s) => sum + (s.headcount || 0), 0);
      const totalFilled = fillShifts.reduce((sum, s) => sum + (s.filled_count || 0), 0);

      setOverviewStats({
        openShifts: openShiftsRes.data?.length ?? null,
        fillRatePct: totalHeadcount > 0 ? Math.round((totalFilled / totalHeadcount) * 100) : null,
        activeWorkers: workersRes.data?.length ?? null,
        registeredEmployers: employersRes.data?.length ?? null,
        shiftsToday: todayShiftsRes.data?.length ?? null,
      });
    })();
    return () => { active = false; };
  }, [view]);

  // Basic analytics: event_type -> count over the trailing 7 days (see
  // supabase/migrations/20260720_analytics_events.sql). Aggregated server-side
  // via the analytics_event_counts RPC (a plain SQL function, RLS still
  // applies since it runs as SECURITY INVOKER) rather than pulling raw rows —
  // pulling raw rows would silently under-count once volume passes
  // PostgREST's default row cap. Any query failure (RLS denial, or the
  // migration not having run yet) degrades to an empty list rather than
  // surfacing an error.
  useEffect(() => {
    if (!supabase || view !== "overview") return;
    let active = true;
    (async () => {
      setAnalyticsCounts(null);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const { data, error } = await supabase
        .rpc("analytics_event_counts", { since: sevenDaysAgo.toISOString() });
      if (!active) return;
      if (error) { setAnalyticsCounts([]); return; }

      setAnalyticsCounts((data || []).map(row => ({ eventType: row.event_type, count: row.count })));
    })();
    return () => { active = false; };
  }, [view]);

  const updatePayoutStatus = async (item, nextStatus) => {
    const { error } = await supabase
      .from("payout_item")
      .update({ status: nextStatus })
      .eq("id", item.id);
    if (error) {
      setPayoutMessage(`Failed to update payout item: ${error.message}`);
      return;
    }

    await supabase.from("payout_audit").insert({
      payout_item_id: item.id,
      actor_type: "admin",
      actor_id: user?.id ?? null,
      action: "manual_status_update",
      from_status: item.status,
      to_status: nextStatus,
      notes: "Admin action from payout queue",
      metadata_json: { source: "admin_portal" },
    });

    setPayoutMessage(`Payout ${item.id} moved to ${nextStatus}.`);
    await loadPayoutQueue();
  };

  const runScheduler = async () => {
    if (!user) {
      setPayoutMessage("You must be signed in to run the scheduler.");
      return;
    }
    setPayoutRunning(true);
    setPayoutMessage("");
    try {
      const result = await runInternalPayoutScheduling(supabase);
      setPayoutMessage(`Scheduler completed. Created ${result.created}, ready ${result.ready}, held ${result.held}.`);
      await loadPayoutQueue();
    } catch (error) {
      setPayoutMessage(error.message);
    }
    setPayoutRunning(false);
  };

  const loadKycDocuments = async (userId) => {
    if (kycSignedUrls[userId]) return;
    const { data: files, error: listError } = await supabase.storage
      .from("kyc-documents")
      .list(userId, { limit: 20 });
    if (listError) { addToast("Could not load documents.", "error"); return; }
    if (!files?.length) { setKycSignedUrls(prev => ({ ...prev, [userId]: {} })); return; }
    const urls = {};
    await Promise.all(files.map(async (file) => {
      const { data, error: urlErr } = await supabase.storage
        .from("kyc-documents")
        .createSignedUrl(`${userId}/${file.name}`, 3600);
      if (urlErr) return;
      if (data?.signedUrl) urls[file.name] = data.signedUrl;
    }));
    setKycSignedUrls(prev => ({ ...prev, [userId]: urls }));
  };

  const approveKyc = async (userId, level = "Standard") => {
    const { error } = await supabase.from("profiles").update({ kyc_level: level }).eq("id", userId);
    if (error) { addToast(`Failed to approve KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    addToast(`KYC approved — level set to ${level}`, "success");
  };

  const rejectKyc = async (userId) => {
    const { error } = await supabase.from("profiles").update({ kyc_level: "Basic" }).eq("id", userId);
    if (error) { addToast(`Failed to reject KYC: ${error.message}`, "error"); return; }
    setKycQueue(prev => prev.filter(u => u.id !== userId));
    setKycSignedUrls(prev => { const next = { ...prev }; delete next[userId]; return next; });
    addToast("KYC rejected — user reset to Basic", "info");
  };

  const resolveDispute = async (disputeId) => {
    const resolvedAt = new Date().toISOString();
    const { error } = await supabase.from("disputes")
      .update({ status: "resolved", resolved_by: user?.id ?? null, resolved_at: resolvedAt })
      .eq("id", disputeId);
    if (error) { toast(`${t("admin.disputeResolveFailed")}${error.message}`, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeId ? { ...d, status: "resolved", resolved_at: resolvedAt } : d));
    toast(t("admin.disputeResolved"), "success");
  };

  const dismissDispute = async (disputeId) => {
    const resolvedAt = new Date().toISOString();
    const { error } = await supabase.from("disputes")
      .update({ status: "dismissed", resolved_by: user?.id ?? null, resolved_at: resolvedAt })
      .eq("id", disputeId);
    if (error) { toast(`${t("admin.disputeDismissFailed")}${error.message}`, "error"); return; }
    setDisputesQueue(prev => (prev ?? []).map(d => d.id === disputeId ? { ...d, status: "dismissed", resolved_at: resolvedAt } : d));
    toast(t("admin.disputeDismissed"), "info");
  };

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%" }}>
      {/* Sidebar */}
      <div style={{ width: compact ? "100%" : 190, borderRight: compact ? "none" : `1px solid ${BRAND.border}`, borderBottom: compact ? `1px solid ${BRAND.border}` : "none", padding: "24px 0", background: BRAND.dark, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 20px 28px" }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: BRAND.primary }}>CariGaji</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontWeight: 500 }}>Admin Dashboard</div>
        </div>
        {navItems.map(n => {
          const key = n.toLowerCase().replace(" ", "");
          return (
            <button key={n} onClick={() => setView(key)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
              background: view === key ? "rgba(232,56,13,0.15)" : "none",
              color: view === key ? BRAND.primary : "rgba(255,255,255,0.55)",
              border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
              borderLeft: view === key ? `3px solid ${BRAND.primary}` : "3px solid transparent",
            }}>{n}</button>
          );
        })}
        <div style={{ padding: "24px 20px 0", marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>Logged in as</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>Rafiq Ismail</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Superadmin</div>
          <Btn size="xs" variant="ghost" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 10, width: "100%", justifyContent: "center", borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}>Return to Worker App</Btn>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: compact ? 16 : 28, background: BRAND.grayLight }}>

        {view === "overview" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Platform Overview</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Klang Valley — Live metrics</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Open shifts" value={overviewStats?.openShifts ?? "—"} color={BRAND.blue} />
              <Stat label="Pending KYC" value={kycQueue?.length ?? "—"} color={BRAND.amber} />
              <Stat label="Open disputes" value={disputesQueue?.filter(d => d.status === "open" || d.status === "under_review").length ?? "—"} color={BRAND.red} />
              <Stat label="Fill rate" value={overviewStats?.fillRatePct != null ? `${overviewStats.fillRatePct}%` : "—"} color={BRAND.green} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Registered workers" value={overviewStats?.activeWorkers ?? "—"} color={BRAND.primary} />
              <Stat label="Registered employers" value={overviewStats?.registeredEmployers ?? "—"} color={BRAND.primary} />
              <Stat label="Shifts today" value={overviewStats?.shiftsToday ?? "—"} color={BRAND.primary} />
              <Stat label="Payout queue" value="Coming soon" sub="Escrow/payout not built yet" color={BRAND.textMuted} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 12 }}>KYC Queue</div>
                {kycQueue === null && <div style={{ fontSize: 13, color: BRAND.textMuted }}>Loading…</div>}
                {kycQueue?.length === 0 && <div style={{ fontSize: 13, color: BRAND.textMuted }}>No pending submissions.</div>}
                {kycQueue?.slice(0, 3).map(k => (
                  <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{k.full_name || "Unnamed user"}</div>
                    <Badge color="amber" size="xs">pending</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("kycqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 12 }}>Employer Queue</div>
                {employerQueue === null && <div style={{ fontSize: 13, color: BRAND.textMuted }}>Loading…</div>}
                {employerQueue?.length === 0 && <div style={{ fontSize: 13, color: BRAND.textMuted }}>No pending submissions.</div>}
                {employerQueue?.slice(0, 3).map(e => (
                  <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{e.full_name || "Unnamed employer"}</div>
                    <Badge color="amber" size="xs">pending</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("employerqueue")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text }}>Active Disputes</div>
                </div>
                {disputesQueue === null && <div style={{ fontSize: 13, color: BRAND.textMuted }}>Loading…</div>}
                {disputesQueue?.length === 0 && <div style={{ fontSize: 13, color: BRAND.textMuted }}>{t("admin.disputesEmptyState")}</div>}
                {disputesQueue?.slice(0, 3).map(d => (
                  <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{displayProtectedText(d.application?.shift?.title ?? "Shift")} – {t(DISPUTE_CATEGORIES.find(c => c.value === d.category)?.labelKey ?? "dispute.categoryOther")}</div>
                    <Badge color={d.status === "under_review" ? "amber" : d.status === "resolved" ? "green" : d.status === "dismissed" ? "gray" : "blue"} size="xs">{d.status}</Badge>
                  </div>
                ))}
                <Btn size="xs" variant="secondary" onClick={() => setView("disputes")} style={{ marginTop: 10 }}>View all →</Btn>
              </Card>
              <Card>
                <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 12 }}>Analytics (7d)</div>
                {analyticsCounts === null && <div style={{ fontSize: 13, color: BRAND.textMuted }}>Loading…</div>}
                {analyticsCounts?.length === 0 && <div style={{ fontSize: 13, color: BRAND.textMuted }}>No events recorded.</div>}
                {analyticsCounts?.map(({ eventType, count }) => (
                  <div key={eventType} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <div style={{ fontSize: 13, color: BRAND.text }}>{eventType}</div>
                    <div style={{ fontSize: 13, color: BRAND.textMuted, fontWeight: 600 }}>{count}</div>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {view === "kycqueue" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>KYC Review Queue</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>
              {kycQueue === null ? "Loading…" : `${kycQueue.length} pending review${kycQueue.length !== 1 ? "s" : ""}`}
            </div>

            {kycQueue === null && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>Loading...</div>
            )}
            {kycQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>✅ No pending KYC submissions.</div>
            )}

            {kycQueue?.map(worker => (
              <Card key={worker.id} style={{ marginBottom: 14 }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{worker.full_name || "Unnamed user"}</div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{worker.id}</div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>
                      Submitted: {new Date(worker.created_at).toLocaleDateString("en-MY")}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <Btn size="sm" variant="secondary" onClick={() => loadKycDocuments(worker.id)}>
                      View Docs
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker.id, "Standard")}>
                      Approve Standard
                    </Btn>
                    <Btn size="sm" variant="success" onClick={() => approveKyc(worker.id, "Advanced")}>
                      Approve Advanced
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => rejectKyc(worker.id)}>
                      Reject
                    </Btn>
                  </div>
                </div>

                {/* Documents */}
                {kycSignedUrls[worker.id] && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {Object.keys(kycSignedUrls[worker.id]).length === 0 ? (
                      <div style={{ fontSize: 12, color: BRAND.textMuted }}>No documents found in storage.</div>
                    ) : (
                      Object.entries(kycSignedUrls[worker.id]).map(([filename, url]) => (
                        <a key={filename} href={url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, color: BRAND.primary, textDecoration: "underline" }}>
                          📄 {filename}
                        </a>
                      ))
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {view === "employerqueue" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Employer Verification Queue</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>
              {employerQueue === null ? "Loading…" : `${employerQueue.length} pending verification${employerQueue.length !== 1 ? "s" : ""}`}
            </div>
            {employerQueue === null && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>Loading...</div>
            )}
            {employerQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>✅ No employers awaiting verification.</div>
            )}
            {employerQueue?.map(emp => (
              <Card key={emp.id} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text }}>{emp.full_name || "Unnamed company"}</div>
                    <div style={{ fontSize: 13, color: BRAND.text, marginTop: 4 }}>SSM: <strong>{emp.ssm_number || "—"}</strong></div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>
                      Registered: {new Date(emp.created_at).toLocaleDateString("en-MY")} · {emp.id}
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                      Check the SSM number against the official registry (ssm-einfo.my) before verifying — the number alone proves nothing.
                      {emp.ssm_document_path ? " Compare it with the uploaded certificate." : " No certificate uploaded."}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {emp.ssm_document_path && (
                      <Btn size="sm" variant="secondary" onClick={async () => {
                        const { data, error } = await supabase.storage.from(KYC_BUCKET).createSignedUrl(emp.ssm_document_path, 300);
                        if (error || !data?.signedUrl) { toast(`Could not open certificate: ${error?.message || "no URL"}`, "error"); return; }
                        window.open(data.signedUrl, "_blank", "noopener");
                      }}>
                        View certificate
                      </Btn>
                    )}
                    <Btn size="sm" variant="success" onClick={() => setEmployerVerification(emp.id, "verified")}>
                      Verify
                    </Btn>
                    <Btn size="sm" variant="danger" onClick={() => setEmployerVerification(emp.id, "rejected")}>
                      Reject
                    </Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {view === "disputes" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Disputes Dashboard</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>
              {disputesQueue === null ? "Loading…" : `${disputesQueue.length} dispute${disputesQueue.length !== 1 ? "s" : ""} total`}
            </div>
            {disputesQueue?.length === 0 && (
              <div style={{ color: BRAND.textMuted, padding: 16 }}>{t("admin.disputesEmptyState")}</div>
            )}
            {disputesQueue?.map(d => {
              const categoryLabel = t(DISPUTE_CATEGORIES.find(c => c.value === d.category)?.labelKey ?? "dispute.categoryOther");
              const isPending = d.status === "open" || d.status === "under_review";
              return (
                <Card key={d.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: BRAND.text }}>{categoryLabel}</span>
                        <Badge color={d.status === "under_review" ? "amber" : d.status === "resolved" ? "green" : d.status === "dismissed" ? "gray" : "blue"}>{d.status}</Badge>
                      </div>
                      <div style={{ fontSize: 13, color: BRAND.textMuted }}>Opened {new Date(d.created_at).toLocaleDateString("en-MY")}</div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div><div style={{ fontSize: 11, color: BRAND.textMuted }}>Shift</div><div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{displayProtectedText(d.application?.shift?.title ?? "—")}</div></div>
                    <div><div style={{ fontSize: 11, color: BRAND.textMuted }}>Application ID</div><div style={{ fontSize: 13, fontWeight: 600, color: BRAND.text }}>{d.application?.id ?? "—"}</div></div>
                  </div>
                  <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6, marginBottom: 12, whiteSpace: "pre-wrap" }}>{d.description}</div>
                  {d.admin_notes && (
                    <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12, padding: "8px 12px", background: BRAND.grayLight, borderRadius: 8 }}>
                      Admin notes: {d.admin_notes}
                    </div>
                  )}
                  {isPending ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" variant="success" onClick={() => resolveDispute(d.id)}>{t("admin.disputeResolve")}</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => dismissDispute(d.id)}>{t("admin.disputeDismiss")}</Btn>
                    </div>
                  ) : (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: d.status === "resolved" ? BRAND.greenLight : BRAND.grayLight, fontSize: 13, fontWeight: 600, color: d.status === "resolved" ? "#065F46" : BRAND.textMuted }}>
                      {d.status === "resolved" ? `✓ ${t("admin.disputeResolve")}` : `✕ ${t("admin.disputeDismiss")}`}
                      {d.resolved_at ? ` — ${new Date(d.resolved_at).toLocaleDateString("en-MY")}` : ""}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {view === "flags" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Fraud & No-Show Flags</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>{FLAGS.length} active flags requiring review</div>
            {FLAGS.map(f => {
              const action = flagActions[f.id];
              return (
                <Card key={f.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: BRAND.text, marginBottom: 4 }}>{f.user}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Badge color={f.type === "QR token reuse" ? "red" : f.type === "GPS mismatch" ? "amber" : "orange"}>{f.type}</Badge>
                        <Badge color={f.riskScore > 90 ? "red" : f.riskScore > 75 ? "amber" : "gray"}>Risk: {f.riskScore}/100</Badge>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: BRAND.textMuted }}>{f.time}</div>
                  </div>
                  <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 14 }}>Shift: {f.shift}</div>
                  {action ? (
                    <div style={{ padding: "8px 12px", borderRadius: 8, background: action === "suspended" ? BRAND.redLight : BRAND.amberLight, fontSize: 13, fontWeight: 600, color: action === "suspended" ? "#991B1B" : "#92400E" }}>
                      Action: {action} — logged to audit trail
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" variant="danger" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "suspended" }))}>Suspend Account</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "warning issued" }))}>Issue Warning</Btn>
                      <Btn size="sm" variant="secondary" onClick={() => setFlagActions(prev => ({ ...prev, [f.id]: "dismissed" }))}>Dismiss</Btn>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {view === "payouts" && (
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 24 }}>Payout Overrides</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label="Pending payouts" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "ready" || p.status === "scheduled").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.amber} />
              <Stat label="Disputed (held)" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "held").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.red} />
              <Stat label="Processed internal" value={toCurrency((livePayoutQueue || []).filter(p => p.status === "processed_internal").reduce((sum, item) => sum + Number(item.amount || 0), 0))} color={BRAND.green} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
              <Btn onClick={runScheduler} disabled={payoutRunning}>{payoutRunning ? "Running..." : "Run Internal Scheduler"}</Btn>
              <Btn variant="secondary" onClick={loadPayoutQueue}>Refresh Queue</Btn>
            </div>
            {payoutMessage && <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10 }}>{payoutMessage}</div>}
            <Card>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 16 }}>Payout Queue</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {["Worker", "Shift", "Amount", "Scheduled", "Status", "Action"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {livePayoutQueue === null && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: 13, color: BRAND.textMuted }}>Loading payout queue…</td>
                    </tr>
                  )}
                  {livePayoutQueue && livePayoutQueue.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: "20px 12px", textAlign: "center", fontSize: 13, color: BRAND.textMuted }}>No payouts in the queue. Run the internal scheduler to generate this cycle's payouts.</td>
                    </tr>
                  )}
                  {(livePayoutQueue || []).map((p) => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: BRAND.text }}>{p.worker_id || "N/A"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.source_refs?.shift_id ? `Shift #${p.source_refs.shift_id}` : "Shift"}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 700, color: BRAND.green }}>{toCurrency(p.amount)}</td>
                      <td style={{ padding: "10px 12px", fontSize: 13, color: BRAND.textMuted }}>{p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("en-MY") : "TBA"}</td>
                      <td style={{ padding: "10px 12px" }}><Pill label={String(p.status || "queued").replaceAll("_", " ")} color={mapPayoutPillColor(p.status)} /></td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn size="xs" variant="success" onClick={() => updatePayoutStatus(p, "processed_internal")}>Release</Btn>
                          <Btn size="xs" variant="secondary" onClick={() => updatePayoutStatus(p, "held")}>Hold</Btn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "config" && (
          <div style={{ maxWidth: 520 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>Platform Configuration</div>
            <div style={{ fontSize: 14, color: BRAND.textMuted, marginBottom: 24 }}>Global rules — changes apply immediately</div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Bid rules</div>
              <Input label="Max bid multiplier (% of employer wage_max)" type="number" value="150" onChange={() => {}} />
              <Input label="Minimum wage floor (RM/hour)" type="number" value="5" onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Cancellation windows</div>
              <Input label="Employer cancellation fee threshold (hours before shift)" type="number" value="24" onChange={() => {}} />
              <Input label="Worker late-cancel threshold (hours before shift)" type="number" value="4" onChange={() => {}} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Transport allowance bands (RM)</div>
              {[["0–5 km", "0"], ["5–15 km", "5"], ["15–30 km", "10"], ["30–50 km", "18"], [">50 km", "25"]].map(([band, val]) => (
                <div key={band} style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: BRAND.text, minWidth: 80 }}>{band}</span>
                  <input type="number" defaultValue={val} style={{ width: 80, padding: "6px 10px", borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13, fontFamily: "inherit" }} />
                  <span style={{ fontSize: 12, color: BRAND.textMuted }}>RM</span>
                </div>
              ))}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: BRAND.text, marginBottom: 14 }}>Platform fee</div>
              <Input label="Platform fee (% of gross shift cost)" type="number" value="15" onChange={() => {}} />
            </Card>
            <Btn onClick={() => toast("Configuration saved and applied globally", "success")} style={{ width: "100%", justifyContent: "center" }}>Save Configuration</Btn>
          </div>
        )}
      </div>
    </div>
  );
};

// Minimal inline on/off switch styled with BRAND tokens — there's no
// reusable Switch/Toggle component elsewhere in this file (only unrelated
// hits for "toggle": PasswordInput's show/hide eye and a settings button
// labelled "Toggles"), so this is built fresh for the cookie categories tab.
const CookieToggleRow = ({ label, description, checked, disabled = false, onChange }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text }}>{label}</div>
      <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 2 }}>{description}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled && onChange) onChange(!checked); }}
      style={{
        flexShrink: 0, width: 40, height: 24, borderRadius: 12, border: "none",
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
            position: "fixed", right: 20, bottom: bubbleBottom, zIndex: 900,
            width: 48, height: 48, borderRadius: "50%",
            background: BRAND.primary, border: "none",
            boxShadow: `0 6px 18px ${BRAND.shadow}`, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, padding: 0, color: "#fff",
          }}
        >
          <span aria-hidden="true">💬</span>
        </button>,
        document.body
      );
    }
    return createPortal(
      <button
        onClick={() => setMode("open")}
        style={{
          position: "fixed", right: 24, bottom: 24, zIndex: 900,
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px", borderRadius: 99,
          background: BRAND.primary, border: "none", color: "#fff",
          boxShadow: `0 6px 18px ${BRAND.shadow}`, cursor: "pointer",
          fontSize: 13, fontWeight: 700, fontFamily: "inherit",
        }}
      >
        <span aria-hidden="true">💬</span>
        <span>{t("supportChat.title")}</span>
      </button>,
      document.body
    );
  }

  // ── Open state ───────────────────────────────────────────────────────────
  const containerStyle = isMobile
    ? { position: "fixed", inset: 0, zIndex: 1300, background: BRAND.surface, display: "flex", flexDirection: "column" }
    : {
        position: "fixed", right: 24, bottom: 24, zIndex: 1300,
        width: 360, height: 500, maxHeight: "80vh",
        background: BRAND.surface, border: `1px solid ${BRAND.border}`, borderRadius: 16,
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
        <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.text, display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden="true">💬</span> {t("supportChat.title")}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setMode("minimized")}
            aria-label={t("supportChat.minimize")}
            title={t("supportChat.minimize")}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: BRAND.textMuted, width: 28, height: 28, borderRadius: 6, lineHeight: 1 }}
          >−</button>
          <button
            onClick={closeWidget}
            aria-label={t("supportChat.close")}
            title={t("supportChat.close")}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: BRAND.textMuted, width: 28, height: 28, borderRadius: 6, lineHeight: 1 }}
          >×</button>
        </div>
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ maxWidth: "85%", padding: "10px 12px", borderRadius: "12px 12px 12px 2px", background: BRAND.grayLight, color: BRAND.text, fontSize: 13.5, lineHeight: 1.5 }}>
            {t("supportChat.greeting")}
          </div>
        </div>
        {messages.map((m, i) => {
          const isMe = m.role === "user";
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
              <div style={{
                maxWidth: "85%", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5,
                borderRadius: isMe ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                background: isMe ? BRAND.primary : BRAND.grayLight,
                color: isMe ? "#fff" : BRAND.text,
                whiteSpace: "pre-wrap",
              }}>
                {m.content}
              </div>
            </div>
          );
        })}
        {sending && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "10px 12px", borderRadius: "12px 12px 12px 2px", background: BRAND.grayLight, color: BRAND.textMuted, fontSize: 12.5 }}>
              {t("supportChat.thinking")}
            </div>
          </div>
        )}
        {escalate && (
          <div style={{ marginTop: 4, padding: "10px 12px", borderRadius: 10, background: BRAND.amberLight, color: BRAND.amber, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 8 }}>
            <span>{t("supportChat.escalateText")}</span>
            <button
              onClick={openMailtoSupport}
              style={{
                alignSelf: "flex-start", border: "none", borderRadius: 8, padding: "6px 12px",
                background: BRAND.amber, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
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
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 13.5, background: BRAND.input, color: BRAND.text, fontFamily: "inherit" }}
        />
        <button
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          style={{
            padding: "10px 16px", borderRadius: 8, border: "none", fontFamily: "inherit",
            background: BRAND.primary, color: "#fff", fontWeight: 700, fontSize: 13,
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
// Scope note: this is UI + local persistence only. There is no analytics/
// consent-mode SDK anywhere in this codebase (grepped for gtag/fbq/mixpanel/
// analytics — no hits), so the "Analytics & Marketing" category is reserved
// for future use and stays off by default; toggling it today has no effect
// beyond being remembered.
const DEFAULT_COOKIE_DRAFT = { functional: true, analytics: false };

const CookieConsentManager = ({ isMobile }) => {
  const { t } = useLanguage();
  const [consent, setConsent] = useState(() => readCookieConsent());
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("categories");
  const [draft, setDraft] = useState(() => {
    const stored = readCookieConsent();
    return stored ? { functional: !!stored.functional, analytics: !!stored.analytics } : DEFAULT_COOKIE_DRAFT;
  });

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
        <div style={{ position: "fixed", left: 16, right: 16, bottom: edgeBottom, zIndex: 1300, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{
            pointerEvents: "auto",
            background: BRAND.surfaceElevated, border: `1px solid ${BRAND.border}`, borderRadius: 16,
            boxShadow: `0 12px 32px ${BRAND.shadow}`, padding: 20, maxWidth: 560, width: "100%",
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ fontSize: 13.5, color: BRAND.text, lineHeight: 1.5 }}>
              <strong style={{ display: "block", marginBottom: 4, fontSize: 15 }}>{t("cookie.bannerTitle")}</strong>
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

      {panelOpen && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setPanelOpen(false)}
        >
          <div
            style={{ background: BRAND.surface, borderRadius: 16, padding: 24, maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: BRAND.text, margin: 0 }}>🍪 {t("cookie.panelTitle")}</h3>
              <button onClick={() => setPanelOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: BRAND.textMuted, lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: `1px solid ${BRAND.border}` }}>
              {tabs.map((tabKey) => (
                <button
                  key={tabKey}
                  onClick={() => setActiveTab(tabKey)}
                  style={{
                    border: "none", background: "transparent", cursor: "pointer",
                    padding: "8px 12px", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
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
              <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13, color: BRAND.text, lineHeight: 1.5 }}>
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
              <div style={{ fontSize: 13, color: BRAND.text, lineHeight: 1.6 }}>
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
      <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color: BRAND.text, letterSpacing: "-0.03em" }}>
        Cari<span style={{ color: BRAND.primary }}>Gaji</span>
      </div>
      <div style={{ fontSize: isMobile ? 10 : 12, color: BRAND.textMuted }}>{t("app.tagline")}</div>
    </button>
  );
};

const ThemeToggleButton = ({ themePreference, onClick }) => {
  const { t } = useLanguage();
  const label = themePreference === "system" ? t("theme.system") : themePreference === "light" ? t("theme.light") : t("theme.dark");
  return (
    <Btn
      size="sm"
      variant="secondary"
      onClick={onClick}
      aria-label={t("theme.ariaLabel").replace("{mode}", themePreference)}
      title={t("theme.title").replace("{mode}", themePreference)}
      style={{ width: 112, justifyContent: "center", gap: 7 }}
    >
      <span aria-hidden="true">{themePreference === "system" ? "🖥️" : themePreference === "light" ? "☀️" : "🌙"}</span>
      <span>{label}</span>
    </Btn>
  );
};

const AdminAccessRequired = ({ user, onBack }) => {
  const { t } = useLanguage();
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 40 }} aria-hidden="true">🚫</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text }}>{t("admin.accessRequiredTitle")}</div>
      <div style={{ fontSize: 13, color: BRAND.textMuted, maxWidth: 320 }}>
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
    <div style={{ position: "fixed", inset: 0, zIndex: 1500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: 16, padding: 24, maxWidth: 520, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{t("auth.tncGateTitle")}</div>
        <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 16 }}>{t("auth.tncGateSubtitle")}</div>
        <div
          ref={boxRef}
          onScroll={onScroll}
          style={{ padding: "12px 14px", background: BRAND.grayLight, borderRadius: 8, border: `1px solid ${BRAND.border}`, fontSize: 12, color: BRAND.textMuted, lineHeight: 1.7, overflowY: "auto", flex: 1, marginBottom: 12 }}
        >
          <TnCLegalText />
        </div>
        {!hasScrolledToEnd && (
          <div style={{ fontSize: 11, color: BRAND.textMuted, marginBottom: 12, textAlign: "center" }}>{t("auth.tncScrollHint")}</div>
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
      <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 2 }}>{t("details.avatarTitle")}</div>
      <div style={{ fontSize: 11.5, color: BRAND.textMuted, marginBottom: 10 }}>{t("details.avatarOptionalHint")}</div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 108, height: 108, flexShrink: 0 }}>
          <div style={{
            width: "100%", height: "100%", borderRadius: "50%", overflow: "hidden",
            background: displayUrl ? `center/cover no-repeat url(${displayUrl})` : BRAND.grayLight,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: `1px solid ${BRAND.border}`,
          }}>
            {!displayUrl && <span style={{ fontSize: 34 }} aria-hidden="true">👤</span>}
          </div>
          {/* Dashed circular crop guide — the app renders avatars as circles
              everywhere else, so this previews exactly what gets cut off. */}
          <div style={{ position: "absolute", inset: -4, borderRadius: "50%", border: `2px dashed ${BRAND.primary}`, pointerEvents: "none" }} aria-hidden="true" />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={{
            display: "inline-block", padding: "8px 14px", borderRadius: 8,
            border: `1px solid ${BRAND.border}`, background: BRAND.surface,
            cursor: disabled ? "wait" : "pointer", fontSize: 13, fontWeight: 600, color: BRAND.primary,
          }}>
            {displayUrl ? t("details.avatarChangeBtn") : t("details.avatarChooseBtn")}
            <input type="file" accept="image/*" disabled={disabled} style={{ display: "none" }}
              onChange={e => onChange(e.target.files?.[0] || null)} />
          </label>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 11.5, color: BRAND.textMuted, lineHeight: 1.6 }}>
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
    <div style={{ position: "fixed", inset: 0, zIndex: 1500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: 16, padding: 24, maxWidth: 560, width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text, marginBottom: 4 }}>{kycOnly ? t("details.kycOnlyTitle") : t("details.title")}</div>
        <div style={{ fontSize: 13, color: BRAND.textMuted, marginBottom: 16 }}>{kycOnly ? t("details.kycOnlySubtitle") : (isEmployer ? t("details.subtitleEmployer") : t("details.subtitleWorker"))}</div>
        {showErrors && hasErrors && (
          <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "#FEF2F2", border: `1.5px solid ${BRAND.red}`, color: BRAND.red, fontSize: 13 }}>
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
              <div style={{ fontSize: 11.5, color: BRAND.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
                {isEmployer ? t("details.companyNameFinalHint") : t("details.fullNameFinalHint")}
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("auth.phoneNumber")}</label>
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
                    <div style={{ fontSize: 12, color: BRAND.red, fontWeight: 600, lineHeight: 1.5, marginBottom: 12 }}>
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
              <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("auth.uploadDocuments")}</div>
              <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
                {kycOnly ? t("details.kycOnlyHint") : t("details.kycDeferHint")}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FileInput label={DOC_LABELS.front} accept="image/*,application/pdf" onChange={e => { const f = e.target.files?.[0] || null; set("kycFront", f); verifyIdOnImage(f); }} fileName={form.kycFront?.name} helper={t("auth.uploadFrontHelper")} error={fieldError("kycFront")} />
                <FileInput label={DOC_LABELS.back} accept="image/*,application/pdf" onChange={e => set("kycBack", e.target.files?.[0] || null)} fileName={form.kycBack?.name} helper={t("auth.uploadBackHelper")} error={fieldError("kycBack")} />
              </div>
              {idOcr.status === "checking" && (
                <div style={{ fontSize: 12, color: BRAND.textMuted, marginBottom: 12 }}>{t("auth.ocrChecking")}</div>
              )}
              {idOcr.status === "match" && (
                <div style={{ fontSize: 12, color: BRAND.green, fontWeight: 600, marginBottom: 12 }}>{t("auth.ocrMatch")}</div>
              )}
              {idOcr.status === "mismatch" && (
                <div style={{ fontSize: 12, color: "#B45309", marginBottom: 12 }}>
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
  const steps = role === "employer"
    ? [t("intro.employerStep1"), t("intro.employerStep2"), t("intro.employerStep3"), t("intro.employerStep4")]
    : [t("intro.workerStep1"), t("intro.workerStep2"), t("intro.workerStep3"), t("intro.workerStep4")];
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: BRAND.surface, borderRadius: 16, padding: 24, maxWidth: 480, width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" }}>
        <div style={{ fontSize: 34, textAlign: "center", marginBottom: 8 }} aria-hidden="true">👋</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: BRAND.text, textAlign: "center", marginBottom: 4 }}>{t("intro.title")}</div>
        <div style={{ fontSize: 13, color: BRAND.textMuted, textAlign: "center", marginBottom: 18 }}>{t("intro.subtitle")}</div>
        {steps.map((step, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: BRAND.primary, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
            <div style={{ fontSize: 13.5, color: BRAND.text, lineHeight: 1.6 }}>{step}</div>
          </div>
        ))}
        <div style={{ fontSize: 12, color: BRAND.textMuted, marginTop: 4, marginBottom: 16 }}>{t("intro.helpHint")}</div>
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

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function CariGaji() {
  const [portal, setPortal] = useState("worker");
  const [userRole, setUserRole] = useState(null);
  const [homeSignal, setHomeSignal] = useState(0);
  // Set when a notification with a "/worker/shifts/{id}",
  // "/employer/shifts/{id}" or "/worker/applications/{id}" link (the
  // cancellation-choice notifications use the latter) is clicked. nonce
  // always increments so the target portal's effect re-fires even on a
  // repeat click of the same link.
  const [notifDeepLink, setNotifDeepLink] = useState(null);
  const handleNotificationNavigate = (link) => {
    const match = /^\/(worker|employer)\/(shifts|applications)\/([^/]+)$/.exec(link || "");
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
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

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
    supabase.from('profiles').select('role, tnc_accepted_at, full_name, details_completed_at, intro_seen_at, kyc_level').eq('id', user.id).maybeSingle()
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
        const isAdminAccount = user?.app_metadata?.role === 'admin';
        if (isAdminAccount) setPortal('admin');
        else if (role === 'employer') setPortal('employer');
        else setPortal('worker');

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

  const isMobile = viewport.width < 768;

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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!isMobile && (
              <Badge color={portal === "worker" ? "green" : portal === "employer" ? "blue" : "amber"}>
                {cfg.label}
              </Badge>
            )}
            <ThemeToggleButton themePreference={themePreference} onClick={() => setThemePreference(current => cycleThemePreference(current))} />
            {user && <NotificationBell user={user} onNavigate={handleNotificationNavigate} />}
            {user ? (
              <ProfileMenu
                user={user}
                onSignOut={async () => { await supabase.auth.signOut(); setUser(null); setPortal("worker"); }}
                onOpenSupportChat={() => setSupportChatOpen(true)}
              />
            ) : (
              <HeaderSignInButton onClick={() => openAuthModal("signin")} />
            )}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {portal === "worker" && <WorkerPortal onOpenPortal={setPortal} isMobile={isMobile} user={user} userRole={userRole} onRequireAuth={openAuthModal} onUserUpdated={refreshUser} homeSignal={homeSignal} kycLevel={profileKycLevel} onOpenKycUpload={() => setKycUploadOpen(true)} backHandlerRef={backHandlerRef} deepLinkShift={portal === "worker" ? notifDeepLink : null} />}
          {portal === "employer" && <EmployerPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} backHandlerRef={backHandlerRef} deepLinkShift={portal === "employer" ? notifDeepLink : null} />}
          {portal === "admin" && (
            isAdmin
              ? <AdminPortal onOpenPortal={setPortal} compact={isMobile} user={user} onRequireAuth={openAuthModal} />
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
      <CookieConsentManager isMobile={isMobile} />
      <TnCGateModal
        open={Boolean(user) && tncAcceptedAt === null}
        accepting={tncAccepting}
        onAccept={acceptTnC}
        onSignOut={async () => { await supabase.auth.signOut(); setUser(null); setPortal("worker"); }}
      />
      {/* Progressive-signup sequence: T&C gate above, then required details,
          then the one-time intro. The gate conditions are mutually exclusive
          by construction (each requires the previous timestamp to be set). */}
      <DetailsGateModal
        open={Boolean(user) && typeof tncAcceptedAt === "string" && detailsCompletedAt === null}
        user={user}
        role={userRole}
        onCompleted={ts => setDetailsCompletedAt(ts)}
        onSignOut={async () => { await supabase.auth.signOut(); setUser(null); setPortal("worker"); }}
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
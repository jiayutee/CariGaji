// Split out of carigaji-app.jsx so a visitor who never opens this portal never downloads it.
// Everything it shares with the rest of the app is imported from the main module.
import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { supabase } from "../lib/supabase.js";
import { createPortal } from "react-dom";
import { Avatar, BRAND, Badge, Btn, CHECKOUT_WINDOW_MS, Card, DISPUTE_CATEGORIES, EmptyState, FS, FileInput, FilterClearAll, FilterPanel, FilterToggle, HoursNote, Icons, InlineIcon, Input, MALAYSIAN_BANK_OPTIONS, OPEN_COOKIE_PREFS_EVENT, PLATFORM_FEE_PCT, Pill, Progress, RADIUS, RATING_ASPECTS, RatingDetailsModal, ReceivedFeedback, SEDCARD_QUALIFICATIONS, SHIFT_CATEGORIES, SHIFT_LANGUAGES, SHIFT_REQUIRED_DOCUMENTS, SITE, Select, StarInput, StarRating, Stat, TYPE, Z, bankVerificationLabel, buildContractRows, chatDayKey, chatDayLabel, chatFullTimestamp, chatPreviewLine, decodeSeg, disablePushNotifications, displayProtectedText, disputeStatusLabel, enablePushNotifications, formatOccurrenceLine, formatOccurrencesSummary, formatShiftDate, formatShiftTime, getAvatarUrl, hasTranslation, hoursUntilShift, initialRouteSegments, mapPayoutPillColor, mapVerificationPillColor, openContractPrintWindow, openMailtoSupport, payoutHoldReasonLabel, payoutStatusLabel, readChatSeen, readPushStatus, reconfirmState, renderContractRowsJSX, routeKeyFromSegment, sanitizeBulkTextValue, shiftCategoryLabel, shiftLastEndsAt, shiftRequiredDocuments, sortConversationsByRecent, statusTone, toCurrency, totalOccurrenceHours, uploadAvatarFile, uploadKycFile, useDialog, useLanguage, usePortalRoute, useToast, useUnreadChatRooms, validateMalaysianBankAccount, writeChatSeen } from "../../carigaji-app.jsx";

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
  addressvisibility: "addressVisibility", visibility: "addressVisibility",
  languagerequirements: "languageRequirements", languages: "languageRequirements", language: "languageRequirements",
  specialrequirements: "specialRequirements", requirements: "specialRequirements", notes: "specialRequirements", additionalrequirements: "specialRequirements",
  groupid: "groupId", group: "groupId", multidaygroup: "groupId", seriesid: "groupId",
};
const BULK_UPLOAD_MANDATORY_FIELDS = ["title", "date", "timeStart", "timeEnd"];
const BULK_UPLOAD_MAX_ROWS = 200;
const BULK_UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB cap

// Continuation rows of a multi-day group (see parseBulkShiftCSV) only need
// Date/Start/End filled in — every other field forward-fills from the
// first non-blank value seen for that Group ID, so the employer enters the
// shared details once, same as the one-by-one wizard's multi-day form.
const BULK_UPLOAD_FORWARD_FILL_FIELDS = ["title", "description", "category", "location", "dress", "wageMin", "wageMax", "headcount", "transportAllowance", "addressVisibility", "languageRequirements", "specialRequirements"];

const BULK_ADDRESS_VISIBILITY_SYNONYMS = { public: "public", accepted: "accepted_only", acceptedonly: "accepted_only", private: "accepted_only" };

// Matches a free-typed language list ("English, Bahasa Melayu" or
// "english;tamil") against the fixed SHIFT_LANGUAGES set, dropping
// anything that doesn't match rather than erroring — this field is
// optional so an unrecognized token just doesn't get applied.
const parseBulkLanguageList = (raw) => String(raw ?? "")
  .split(/[,;|]/)
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => SHIFT_LANGUAGES.find(l => l.toLowerCase() === s.toLowerCase()))
  .filter(Boolean);

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
  // Raw per-row fields first, before multi-day forward-fill runs (below).
  const rawRows = dataRows.map((cells, idx) => {
    const get = (field) => { const c = fieldToCol[field]; return c !== undefined ? (cells[c] ?? "") : ""; };
    return {
      _rowNum: idx + 1,
      groupId: get("groupId").trim(),
      title: get("title"),
      description: get("description"),
      category: get("category").trim(),
      location: get("location"),
      dress: get("dress"),
      date: get("date").trim(),
      timeStart: get("timeStart").trim(),
      timeEnd: get("timeEnd").trim(),
      wageMin: get("wageMin").trim(),
      wageMax: get("wageMax").trim(),
      headcount: get("headcount").trim(),
      transportAllowance: get("transportAllowance").trim(),
      addressVisibility: get("addressVisibility").trim(),
      languageRequirements: get("languageRequirements").trim(),
      specialRequirements: get("specialRequirements"),
    };
  });

  // Forward-fill: for rows sharing a non-empty Group ID, any blank field
  // (other than Date/Start/End, which are per-occurrence) inherits the
  // first non-blank value seen for that group.
  const groupDefaults = {};
  rawRows.forEach(r => {
    if (!r.groupId) return;
    const defaults = groupDefaults[r.groupId] || (groupDefaults[r.groupId] = {});
    BULK_UPLOAD_FORWARD_FILL_FIELDS.forEach(f => { if (r[f] && !defaults[f]) defaults[f] = r[f]; });
  });
  rawRows.forEach(r => {
    if (!r.groupId) return;
    const defaults = groupDefaults[r.groupId];
    BULK_UPLOAD_FORWARD_FILL_FIELDS.forEach(f => { if (!r[f] && defaults[f]) r[f] = defaults[f]; });
  });

  const draftRows = rawRows.map(r => {
    const matchedCategory = SHIFT_CATEGORIES.find(c => c.toLowerCase() === r.category.toLowerCase()) || "";
    const row = {
      _rowNum: r._rowNum,
      _error: null,
      groupId: r.groupId,
      title: sanitizeBulkTextValue(r.title),
      description: sanitizeBulkTextValue(r.description),
      category: matchedCategory,
      location: sanitizeBulkTextValue(r.location),
      dress: sanitizeBulkTextValue(r.dress),
      date: r.date,
      timeStart: r.timeStart,
      timeEnd: r.timeEnd,
      wageMin: r.wageMin,
      wageMax: r.wageMax,
      headcount: r.headcount || "1",
      transportAllowance: r.transportAllowance,
      addressVisibility: BULK_ADDRESS_VISIBILITY_SYNONYMS[normalizeBulkHeader(r.addressVisibility)] || "public",
      languageRequirements: r.languageRequirements,
      specialRequirements: sanitizeBulkTextValue(r.specialRequirements),
    };
    row._status = evaluateBulkRowStatus(row);
    return row;
  });
  return { rows: draftRows };
};

const BULK_UPLOAD_TEMPLATE_HEADER = ["Title", "Description", "Category", "Location", "Dress Code", "Date", "Start Time", "End Time", "Min Wage", "Max Wage", "Headcount", "Transport Allowance", "Address Visibility", "Language Requirements", "Special Requirements", "Group ID"];
const BULK_UPLOAD_TEMPLATE_ROWS = [
  ["F&B Server – Corporate Dinner", "Serve drinks and canapés at a corporate dinner event.", "F&B", "KLCC, KL City Centre", "All black formal", "2026-08-15", "18:00", "23:00", "12", "16", "3", "10", "Public", "English, Bahasa Melayu", "Must be comfortable carrying trays", ""],
  ["Warehouse Picker – 3-Day Stock Count", "Assist with year-end stock count.", "Warehouse", "Shah Alam Logistics Hub", "Closed-toe shoes", "2026-08-20", "09:00", "17:00", "11", "13", "4", "", "Accepted Only", "English", "", "STOCKCOUNT-AUG"],
  ["", "", "", "", "", "2026-08-21", "09:00", "17:00", "", "", "", "", "", "", "", "STOCKCOUNT-AUG"],
  ["", "", "", "", "", "2026-08-22", "09:00", "17:00", "", "", "", "", "", "", "", "STOCKCOUNT-AUG"],
];

const downloadBulkUploadTemplate = () => {
  const csv = serializeCSV([BULK_UPLOAD_TEMPLATE_HEADER, ...BULK_UPLOAD_TEMPLATE_ROWS]);
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

// How many ledger movements the Billing tab lists. Display only -- see the
// comment on walletEntries. When the page is full the UI says so rather than
// trailing off, so a truncated list never reads as a complete one.
const WALLET_HISTORY_LIMIT = 25;

const walletKindLabel = (kind, t) => {
  const key = `employer.walletKind.${kind}`;
  return hasTranslation(key) ? t(key) : String(kind || '');
};

const walletKindColor = (kind) => (
  kind === 'topup' || kind === 'refund' || kind === 'release' ? 'green'
    : kind === 'hold' ? 'amber'
    : kind === 'capture' ? 'blue'
    : kind === 'fee' ? 'primary'
    : 'gray'
);

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

// Loads the Google Maps JS API (Places library) once, on demand.
const loadGoogleMaps = (() => {
  let promise = null;
  return (apiKey) => {
    if (typeof window === "undefined") return Promise.reject(new Error("no window"));
    if (window.google?.maps?.places) return Promise.resolve(window.google);
    if (promise) return promise;
    // Google's official inline bootstrap loader (see "Load the Maps
    // JavaScript API" docs) — defines google.maps.importLibrary immediately
    // and lazily injects the real API script only once a library is actually
    // requested. Replaces a hand-rolled <script src=...&loading=async> +
    // onload approach that looked fine but hung forever in practice: with
    // loading=async, the base script's onload no longer guarantees
    // google.maps.places (or even importLibrary itself) is ready yet, so
    // calling importLibrary from inside onload raced Google's own internal
    // bootstrap and silently never resolved or rejected.
    (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a) })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)) })({
      key: apiKey,
      v: "weekly",
    });
    promise = window.google.maps.importLibrary("places").then(() => window.google);
    return promise;
  };
})();

// Location field with Google Places autocomplete (Malaysia-restricted).
// Falls back to a plain text input when no API key is configured.
//
// Uses the PlaceAutocompleteElement Web Component rather than the older
// google.maps.places.Autocomplete class — Google stopped offering the latter
// to new customers in March 2025 (still functional for existing usage, but
// no longer recommended; see places-migration-overview). Unlike the old
// class, this one IS the input (a custom element with its own Shadow DOM),
// so it's mounted imperatively into a container div rather than bound to a
// React-controlled <input>. It also doesn't leak a body-level dropdown node
// the way the old one did, so the manual cleanup hack is gone too.
// Switched from google.maps.places.PlaceAutocompleteElement (the new
// custom-element API) to the older google.maps.places.Autocomplete class,
// bound to a plain <input> we fully control — see the 2026-08-11
// investigation this replaced: the new element's suggestion dropdown
// silently rendered empty (a fixed-position container with 0 children)
// EVEN THOUGH its own network request to the Places API was verified
// (via direct XHR instrumentation) to succeed with real, correct results —
// this was reproducible for well-known places (Pavilion KL, Mid Valley,
// Suria KLCC), so it isn't a no-match edge case. Its internal <input> also
// didn't respond to Backspace/Delete at all (typing forward worked, typing
// backward silently did nothing), which independently explained the styling
// complaint too — a real <input> could never diverge from every other form
// field the way a Shadow-DOM custom element can. Google's own docs concede
// the old class still works for existing usage, just isn't offered to new
// customers as of March 2025 — appropriate here since this key predates
// that cutoff, and the old class is the mature, battle-tested one.
const LocationAutocomplete = ({ label = "Location", value, onChange, error = false }) => {
  const { t } = useLanguage();
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const inputRef = useRef(null);
  const autocompleteRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!apiKey || !inputRef.current) return;
    let cancelled = false;
    let autocomplete = null;
    let placeChangedListener = null;
    loadGoogleMaps(apiKey).then(google => {
      if (cancelled || !inputRef.current) return;
      autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: "my" },
        fields: ["name", "formatted_address"],
      });
      placeChangedListener = () => {
        const place = autocomplete.getPlace();
        const name = place?.name || "";
        const address = place?.formatted_address || "";
        // Same reasoning as before: formatted_address often omits the venue
        // name (e.g. "1 Utama Shopping Centre"), showing only the street
        // address, so prepend the name when it isn't already part of it.
        const combined = name && address && !address.toLowerCase().startsWith(name.toLowerCase())
          ? `${name}, ${address}`
          : (address || name || inputRef.current.value);
        onChangeRef.current(combined);
      };
      autocomplete.addListener("place_changed", placeChangedListener);
      autocompleteRef.current = autocomplete;
    }).catch(() => {}); // silent fallback to manual typing
    return () => {
      cancelled = true;
      // window.google, not the callback-scoped `google` param above (out of
      // scope here) — safe since this only runs after the .then already
      // resolved and set window.google itself, per loadGoogleMaps.
      if (autocomplete && window.google) {
        window.google.maps.event.clearInstanceListeners(autocomplete);
      }
      autocompleteRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: error ? BRAND.red : BRAND.text, marginBottom: 6 }}>{label}</label>}
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t("form.locationPlaceholder")}
        style={{
          width: "100%", padding: "10px 14px", borderRadius: RADIUS.control,
          border: `1.5px solid ${error ? BRAND.red : BRAND.border}`, fontSize: FS.body, fontFamily: "inherit",
          color: BRAND.text, background: BRAND.input, outline: "none", boxSizing: "border-box",
        }}
      />
      {/* The old Autocomplete class's dropdown is still Google's own
          top-layer UI we can't inject a "no results" message into, so this
          hint stays: a no-match query is still a valid, saved answer even
          with no suggestion selected. */}
      {apiKey && (
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>
          {t("employer.locationHint")}
        </div>
      )}
    </div>
  );
};

// ── Filtering, one pattern ────────────────────────────────────────────────
// Discover established this: a small "Filters (3) ▼" toggle carrying a count of
// what is active, opening a grey panel of compact fields with a Clear all at the
// end. When the applicant pool got its own filter and sort, it shipped as two
// always-visible full-size Selects instead -- two controls doing the same job,
// looking nothing alike, in one app. The owner spotted it.
//
// Extracted so there is one definition rather than a second copy to drift.
// FILTER_CONTROL_STYLE deliberately omits `color`: the root carries
// color-scheme, so the UA picks a readable value in both themes (measured at
// 14:1 and 17:1 in dark). Setting it explicitly here would be a guess that
// happens to agree.
const FILTER_CONTROL_STYLE = {
  width: "100%", padding: "6px 8px", borderRadius: RADIUS.control,
  border: `1px solid ${BRAND.border}`, fontSize: FS.meta,
  boxSizing: "border-box", background: BRAND.input,
};

const FilterField = ({ label, children }) => (
  <div>
    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 3 }}>{label}</div>
    {children}
  </div>
);

const SHIFT_STATUS_LABEL_KEYS = {
  open: "employer.shiftStatusOpen",
  filled: "employer.shiftStatusFilled",
  closed: "employer.shiftStatusClosed",
  completed: "employer.shiftStatusCompleted",
  cancelled: "employer.shiftStatusCancelled",
  draft: "employer.shiftStatusDraft",
};

const shiftStatusLabel = (status, t) => {
  if (SHIFT_STATUS_LABEL_KEYS[status]) return t(SHIFT_STATUS_LABEL_KEYS[status]);
  // Unknown/future value: humanise rather than print raw snake_case.
  const raw = String(status || "").replaceAll("_", " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "—";
};

// ─── EMPLOYER PORTAL ─────────────────────────────────────────────────────────
const EmployerPortal = ({ onOpenPortal, compact = false, user = null, backHandlerRef = null, deepLinkShift = null, onUserUpdated = () => {}, onOpenSupportChat = openMailtoSupport }) => {
  const toast = useToast();
  const { t } = useLanguage();
  const [view, setView] = useState(() => parseEmployerRoute(initialRouteSegments("employer")).view);
  const [selectedShift, setSelectedShift] = useState(null);
  const [liveApplicants, setLiveApplicants] = useState(null);
  const [postStep, setPostStep] = useState(1);
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [cancellingShift, setCancellingShift] = useState(false);
  const [closingApplications, setClosingApplications] = useState(false);
  const [form, setForm] = useState({ title: "", category: "F&B", occurrences: [{ date: "", start: "", end: "" }], isMultiDay: false, wageMin: "", wageMax: "", headcount: 1, dress: "", location: "KLCC, KL City Centre", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "", languageRequirements: [], specialRequirements: "", requiredDocuments: [], applicationsCloseAt: "" });
  // Bulk shift upload (CSV) — separate from the single-shift `form` above.
  const [bulkUploadStep, setBulkUploadStep] = useState(1); // 1=upload, 2=review/fix, 3=publish
  const [bulkGuideOpen, setBulkGuideOpen] = useState(false);
  const [bulkUploadRows, setBulkUploadRows] = useState([]);
  const [bulkUploadFileName, setBulkUploadFileName] = useState("");
  const [bulkUploadFileError, setBulkUploadFileError] = useState("");
  const [bulkUploadPublishing, setBulkUploadPublishing] = useState(false);
  const [bulkUploadProgress, setBulkUploadProgress] = useState({ done: 0, total: 0 });
  const [applicantAction, setApplicantAction] = useState({});
  const [selectedApplicantIds, setSelectedApplicantIds] = useState([]);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [applicantFiltersOpen, setApplicantFiltersOpen] = useState(false);
  const [applicantSort, setApplicantSort] = useState("default");
  const [applicantStatusFilter, setApplicantStatusFilter] = useState("all");
  const [offering, setOffering] = useState(false);
  const [liveEmployerShifts, setLiveEmployerShifts] = useState(null);
  const [employerProfile, setEmployerProfile] = useState(null);
  // Short "about us" shown to workers on shift pages and the employer's profile.
  const [companyDescriptionDraft, setCompanyDescriptionDraft] = useState("");
  const [savingCompanyDescription, setSavingCompanyDescription] = useState(false);
  const saveCompanyDescription = async () => {
    if (!user) return;
    setSavingCompanyDescription(true);
    const value = companyDescriptionDraft.trim() || null;
    const { error } = await supabase.from('profiles').update({ company_description: value }).eq('id', user.id);
    setSavingCompanyDescription(false);
    if (error) { toast(t('employer.aboutCompanySaveFailed') + error.message, 'error'); return; }
    setEmployerProfile(prev => prev ? { ...prev, company_description: value } : prev);
    toast(t('employer.aboutCompanySaved'), 'success');
  };
  // Profile photo + personal (contact-person) details, moved here from the
  // worker app: an employer's own profile editing belongs in their own
  // console, not behind a worker-app preview. Note the worker "Sedcard"
  // (bio / languages spoken / qualifications) is deliberately NOT mirrored
  // — it exists to sell a worker to employers reviewing their application,
  // which has no employer-side equivalent; Company Details is that.
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [personalDetailsForm, setPersonalDetailsForm] = useState({ phone: "", identityType: "MyKad", idNumber: "", dateOfBirth: "", address: "" });
  const [personalDetailsSaving, setPersonalDetailsSaving] = useState(false);
  const [personalDetailsMessage, setPersonalDetailsMessage] = useState("");
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
  // Separate from employerPayoutItems (capped to the 100 most recent rows
  // for the ledger list below) -- same bug class as the worker-side
  // Earnings total fixed earlier: an employer active across many months
  // and workers would otherwise see "Total paid out"/"Pending payout"
  // silently undercount once they pass 100 payout_item rows. This
  // unlimited, lightweight (amount + status only) query feeds those two
  // totals instead.
  const [employerPayoutSummary, setEmployerPayoutSummary] = useState([]);
  const [contractModal, setContractModal] = useState(null);
  // Read-only signed-contract view + worker profile card for the applicant
  // pool (owner request 2026-07-20).
  const [viewContractModal, setViewContractModal] = useState(null); // applicant row
  const [workerProfileModal, setWorkerProfileModal] = useState(null); // applicant row
  const [workerHistory, setWorkerHistory] = useState(null); // null = loading
  // Rotating check-in code display (owner decision 2026-07-25) — shown to
  // the employer at the venue for workers to key in. Regenerated every 5s
  // client-side; the RPC itself derives the code from a 30s server-side
  // time bucket, so the display just tracks whatever the server currently
  // considers valid rather than trying to run its own clock.
  const [checkinCodeModal, setCheckinCodeModal] = useState(null); // { shiftId, title }
  const [checkinCode, setCheckinCode] = useState(null);
  const [checkinCodeExpiresAt, setCheckinCodeExpiresAt] = useState(null);
  // Component-scope so both the polling effect below AND the manual
  // "Refresh now" button call the exact same fetch -- one implementation,
  // not a duplicate copy that could drift.
  const refreshCheckinCode = () => {
    if (!checkinCodeModal?.shiftId) return;
    supabase.rpc('get_shift_checkin_code', { p_shift_id: checkinCodeModal.shiftId }).then(({ data, error }) => {
      if (error || !data?.[0]) { setCheckinCode(null); return; }
      setCheckinCode(data[0].code);
      setCheckinCodeExpiresAt(data[0].expires_at);
    });
  };
  // Countdown display, ticking every 1s from the server's real expires_at.
  // The code itself still comes from the 5s poll below (or the manual
  // refresh button) -- this is purely what the number on screen shows
  // between those actual fetches, computed fresh each tick rather than
  // stored, so it can never drift out of sync with checkinCodeExpiresAt.
  const [checkinCodeNow, setCheckinCodeNow] = useState(() => Date.now());
  useEffect(() => {
    if (!checkinCodeModal) return undefined;
    const tick = setInterval(() => setCheckinCodeNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [checkinCodeModal]);
  const checkinCodeSecondsLeft = checkinCodeExpiresAt
    ? Math.max(0, Math.ceil((new Date(checkinCodeExpiresAt).getTime() - checkinCodeNow) / 1000))
    : 30;
  const [disputeModal, setDisputeModal] = useState(null); // { applicationId, shiftTitle }
  const [disputeForm, setDisputeForm] = useState({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  const [filingDispute, setFilingDispute] = useState(false);
  const [myDisputes, setMyDisputes] = useState(null);
  // Same duplicate-dispute guard as WorkerPortal (see there for why) —
  // application_ids this employer has already filed a dispute for.
  const [myDisputedApplicationIds, setMyDisputedApplicationIds] = useState(new Set());
  // Employer's OWN received ratings (workers rating this employer), for the
  // Account screen -- mirrors WorkerPortal's myReceivedRatings, same RPC,
  // opposite direction. Employer had no self-rating view at all before this.
  const [myEmployerRatings, setMyEmployerRatings] = useState(null);
  const [myEmployerFeedback, setMyEmployerFeedback] = useState([]);   // comments, private to the rated person
  useEffect(() => {
    if (view !== "account" || !user) return;
    let cancelled = false;
    supabase.from('ratings').select('comment, overall, created_at')
      .eq('ratee_id', user.id).eq('direction', 'worker_to_employer').not('comment', 'is', null)
      .order('created_at', { ascending: false }).limit(20)
      .then(({ data, error }) => { if (!cancelled) setMyEmployerFeedback(error ? [] : (data ?? [])); });
    return () => { cancelled = true; };
  }, [view, user]);
  useEffect(() => {
    if (view !== "account" || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_ratee_ratings', { p_ratee_id: user.id, p_direction: 'worker_to_employer' });
        if (!cancelled) setMyEmployerRatings(error ? [] : (data ?? []));
      } catch {
        if (!cancelled) setMyEmployerRatings([]);
      }
    })();
    return () => { cancelled = true; };
  }, [view, user]);
  const [ratingModal, setRatingModal] = useState(null); // { applicationId, shiftTitle, rateeId, direction }
  const [ratingForm, setRatingForm] = useState({});
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingComment, setRatingComment] = useState("");   // optional private feedback to the rated person
  // application_ids the signed-in employer has already rated (employer_to_worker
  // direction) — hides the Rate button once filed, mirrors the immutable-once-
  // filed convention already used for disputes.
  const [myRatedApplicationIds, setMyRatedApplicationIds] = useState(new Set());
  const [ratingDetailsModal, setRatingDetailsModal] = useState(null); // { rateeId, direction, label, list }

  // Workers the employer has finished a shift with but not yet rated.
  //
  // The Rate button already existed, but only inside the applicant pool of an
  // individual completed shift -- so an employer had to remember to go back
  // into a finished job to use it, and almost nobody does. Employer-to-worker
  // ratings are the ones the marketplace leans on hardest (they are what other
  // employers filter the applicant pool by), so they have to be ASKED for.
  //
  // Queried across all completed shifts rather than derived from
  // liveEmployerShifts, which carries no applicant data.
  // Real balance, derived server-side from the append-only ledger. Replaces
  // the self-declared "funding account has sufficient balance" checkbox, which
  // was the employer asserting something about themselves that nothing checked.
  const [wallet, setWallet] = useState(null);   // { available, held, topped_up, captured } | null
  // The movements behind that balance. Fetched separately and DISPLAY ONLY --
  // the figures above come from employer_wallet_balance, which sums the whole
  // ledger server-side. Nothing here is ever added up: a .limit() feeding a
  // total has silently undercounted three separate times in this project, and
  // a wrong deposit balance is the worst place for it to happen again.
  const [walletEntries, setWalletEntries] = useState([]);
  // A failed load must not render as "no activity yet". An employer whose
  // request timed out would otherwise be told, in plain language, that their
  // deposit history is empty -- which is a statement about their money, and
  // false. Transient ERR_INTERNET_DISCONNECTED failures showed up while
  // building this, so it is not a hypothetical.
  const [walletEntriesFailed, setWalletEntriesFailed] = useState(false);
  const refreshWalletBalance = useCallback(async () => {
    if (!user) { setWallet(null); setWalletEntries([]); setWalletEntriesFailed(false); return; }
    const { data, error } = await supabase.rpc('employer_wallet_balance', { p_employer_id: user.id });
    if (error) { setWallet(null); } else {
      setWallet(Array.isArray(data) ? (data[0] ?? null) : (data ?? null));
    }
    // A cascade can null shift_id (see 20260822b), so the join returns null for
    // any movement whose shift has since been removed -- expected, not an error.
    const { data: rows, error: entryError } = await supabase
      .from('employer_wallet_entry')
      .select('id, kind, amount, note, created_at, shift:shifts(id, title)')
      .eq('employer_id', user.id)
      .order('created_at', { ascending: false })
      .limit(WALLET_HISTORY_LIMIT);
    setWalletEntriesFailed(Boolean(entryError));
    setWalletEntries(entryError ? [] : (rows || []));
  }, [user]);
  useEffect(() => { refreshWalletBalance(); }, [refreshWalletBalance]);

  const [pendingWorkerRatings, setPendingWorkerRatings] = useState([]);
  useEffect(() => {
    if (!user) { setPendingWorkerRatings([]); return undefined; }
    let active = true;
    supabase
      .from('applications')
      .select('id, worker_id, worker:profiles!applications_worker_id_profiles_fkey(full_name), shift:shifts!inner(id, title, status, employer_id)')
      .eq('status', 'accepted')
      .eq('shift.employer_id', user.id)
      .eq('shift.status', 'completed')
      .then(({ data, error }) => {
        if (!active) return;
        // Same convention as loadMyRatings: a query failure degrades to an
        // empty prompt rather than breaking the dashboard.
        if (error) { setPendingWorkerRatings([]); return; }
        setPendingWorkerRatings((data ?? []).map(a => ({
          id: a.id,
          workerId: a.worker_id,
          workerName: a.worker?.full_name ?? 'Worker',
          shiftId: a.shift?.id ?? null,
          shiftTitle: a.shift?.title ?? '',
        })));
      });
    return () => { active = false; };
  }, [user]);

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
  // Set by the chat room's "View shift" shortcut; see the deep-link loader.
  const [openShiftId, setOpenShiftId] = useState(null);
  // ── Addresses for every page (see usePortalRoute).
  const [routeShift, setRouteShift] = useState(() => {
    const id = parseEmployerRoute(initialRouteSegments("employer")).shiftId;
    return id ? { id, n: 0 } : null;
  });
  const [pendingChatShiftId, setPendingChatShiftId] = useState(() => parseEmployerRoute(initialRouteSegments("employer")).chatShiftId);
  useEffect(() => {
    if (!pendingChatShiftId) return undefined;
    const conv = chatConversations.find(c => c.shiftId === pendingChatShiftId);
    if (conv) { setActiveChatShift(conv); setPendingChatShiftId(null); return undefined; }
    const timer = setTimeout(() => setPendingChatShiftId(null), 8000);
    return () => clearTimeout(timer);
  }, [pendingChatShiftId, chatConversations]);
  usePortalRoute({
    portal: "employer",
    head: { title: `${t("employerNav." + (view === "postshift" ? "postShift" : view === "bulkupload" ? "bulkUpload" : view))} | ${SITE.name}`, description: t("seo.homeDescription"), index: false },
    segments: buildEmployerSegments({ view, shiftId: selectedShift?.id ?? null, chatShiftId: activeChatShift?.shiftId ?? null }),
    parse: parseEmployerRoute,
    apply: (r) => {
      setView(r.view);
      if (r.view === "shifts") {
        if (r.shiftId) { if (selectedShift?.id !== r.shiftId) setRouteShift({ id: r.shiftId, n: Date.now() }); }
        else { setSelectedShift(null); setRouteShift(null); setOpenShiftId(null); }
      }
      setPendingChatShiftId(r.chatShiftId);
      if (r.view === "chat" && !r.chatShiftId) { setActiveChatShift(null); setChatMessages([]); }
    },
  });
  const { unreadRooms, refreshUnreadChat, roomPreviews, previewSenderNames, unreadRoomIds } = useUnreadChatRooms(user);
  // Same control as the worker console. An employer waiting on a bid or a
  // cancellation needs the phone to buzz just as much as a worker does, and
  // the two consoles are separate components -- shared helpers, separate state.
  const [pushState, setPushState] = useState("unsupported");
  useEffect(() => {
    let active = true;
    readPushStatus().then(status => { if (active) setPushState(status); });
    return () => { active = false; };
  }, [user?.id]);
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
    // navigating to another view leaves it set, and its realtime subscription
    // keeps running. Without the visible-tab check, a message arriving while
    // the user is on Discover was marked seen and never raised the badge.
    if (view !== "chat") return;
    if (!user?.id || !activeChatShift?.shiftId || !chatMessages.length) return;
    const newest = chatMessages[chatMessages.length - 1]?.created_at;
    if (!newest) return;
    writeChatSeen(user.id, activeChatShift.shiftId, newest);
    refreshUnreadChat();
  }, [view, user?.id, activeChatShift?.shiftId, chatMessages, refreshUnreadChat]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  // sender_id -> full_name for group-chat bubbles (ref mirrors state so the
  // realtime handler can check membership without re-subscribing).
  const [chatSenderNames, setChatSenderNames] = useState({});
  const chatSenderNamesRef = useRef({});
  useEffect(() => { chatSenderNamesRef.current = chatSenderNames; }, [chatSenderNames]);
  const chatEndRef = useRef(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [chatMessages]);

  // The `ratings` table (20260725b) may not be migrated in prod yet — any
  // query failure (including 42P01 relation-does-not-exist) degrades to an
  // empty/graceful state rather than a crash, same convention as
  // workerHistory falling back to [] on error below.
  useEffect(() => {
    let active = true;
    const loadMyRatings = async () => {
      if (!user) { setMyRatedApplicationIds(new Set()); return; }
      try {
        const { data, error } = await supabase
          .from('ratings')
          .select('application_id')
          .eq('rater_id', user.id)
          .eq('direction', 'employer_to_worker');
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

  // Self-service dispute status view (account view) — RLS's disputes_owner_read
  // policy already scopes this to disputes where the signed-in employer is the
  // employer_id or worker_id on the linked application/shift, so no extra
  // .eq() filter is needed here (an employer should also see disputes a
  // worker filed against them, not just ones they filed themselves).
  useEffect(() => {
    if (!supabase || !user || view !== "account") return;
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
  }, [user, view]);

  // Fetch aggregated ratings for the clicked ratee (any StarRating display) —
  // same 42P01-graceful degradation as above.
  const openRatingDetails = (rateeId, direction, label) => {
    if (!rateeId) return;
    setRatingDetailsModal({ rateeId, direction, label, list: null });
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

  // Mobile back-gesture support — same contract as WorkerPortal's handler:
  // close the topmost open thing, report handled; bare dashboard → false.
  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => {
      if (viewContractModal) { setViewContractModal(null); return true; }
      if (workerProfileModal) { setWorkerProfileModal(null); return true; }
      if (checkinCodeModal) { setCheckinCodeModal(null); return true; }
      if (contractModal) { setContractModal(null); return true; }
      if (disputeModal) { setDisputeModal(null); return true; }
      if (ratingModal) { setRatingModal(null); return true; }
      if (ratingDetailsModal) { setRatingDetailsModal(null); return true; }
      if (activeChatShift) { setActiveChatShift(null); setChatMessages([]); return true; }
      if (selectedShift) { setSelectedShift(null); return true; }
      if (view !== "dashboard") { setView("dashboard"); return true; }
      return false;
    };
    return () => { if (backHandlerRef) backHandlerRef.current = null; };
  });

  // Same nav ping as WorkerPortal — keeps the swipe-back preview screenshot
  // fresh (see BackGestureManager). Must cover every state the handler
  // above checks, same reasoning as WorkerPortal's version.
  useEffect(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("carigaji:nav"));
  }, [view, selectedShift, activeChatShift, viewContractModal, workerProfileModal, checkinCodeModal, contractModal, disputeModal, ratingModal, ratingDetailsModal]);

  // Mobile-only: the sidebar used to always render full-width, stacked above
  // the content, permanently expanded — eating over half the screen before
  // any actual work (managing shifts, reviewing applicants) was visible.
  // Now it's a collapsible left-side drawer on mobile, toggled by a
  // hamburger button; desktop (compact=false) is unaffected.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarDialog = useDialog(sidebarOpen, () => setSidebarOpen(false), { label: t("nav.menuTitle") });

  // The rate a NEW shift would be posted at, read from the database rather
  // than from the constant above, so ending the launch promotion is one SQL
  // change with no deploy. Shifts already posted are priced from their own
  // snapshot (`feePct`), never from this.
  const [platformFeePct, setPlatformFeePct] = useState(PLATFORM_FEE_PCT);
  // When this employer's free window ends. null = trial not started (they have
  // posted nothing yet) or already over. Read from their own profile row, so
  // it survives a rate change and needs no client-side date arithmetic.
  const [feeFreeUntil, setFeeFreeUntil] = useState(null);
  useEffect(() => {
    let active = true;
    supabase.rpc('platform_fee_pct').then(({ data, error }) => {
      if (!active || error || data == null) return;
      setPlatformFeePct(Number(data));
    });
    if (user?.id) {
      supabase.from('profiles').select('fee_free_until').eq('id', user.id).maybeSingle()
        .then(({ data, error }) => {
          if (!active || error) return;
          setFeeFreeUntil(data?.fee_free_until ?? null);
        });
    }
    return () => { active = false; };
  }, []);

  // Exposed via useCallback (not just an effect-local function) so the
  // post/edit-shift handler can trigger a refetch after a successful publish
  // — previously the list only loaded on [user] change, so a freshly
  // published shift didn't appear until the next full reload.
  const loadEmployerShifts = useCallback(async () => {
    if (!user) return setLiveEmployerShifts(null);
    // Complete any shift whose last occurrence has ended, BEFORE reading.
    // Ratings, disputes and "shifts done" all key off status = 'completed',
    // and nothing else ever set it (20260911). No pg_cron here, so this is
    // the sweep. Best-effort on purpose: until that migration is applied the
    // RPC does not exist, and loading must not depend on it.
    try { await supabase.rpc('complete_ended_shifts'); } catch { /* sweep is best-effort */ }
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, category, location, dress_code, transport_allowance, description, start_at, end_at, occurrences, headcount, filled_count, status, language_requirements, wage_max, applications_close_at, platform_fee_pct')
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
      endAt: s.end_at,
      occurrences: s.occurrences ?? [],
      isMultiDay: (s.occurrences ?? []).length > 1,
      date: formatShiftDate(s.start_at) || 'TBA',
      time: s.start_at && s.end_at ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
      headcount: s.headcount ?? 1,
      filled: s.filled_count ?? 0,
      applicants: 0,
      status: s.status,
      // Worst-case wage bill if every position fills at the top of the range,
      // across every occurrence day, plus the platform commission the
      // employer pays on top (escrow/prepayment isn't built yet, so this is
      // an estimate, not money actually held).
      estBudget: Math.round(Number(s.wage_max ?? 0) * totalOccurrenceHours(s.occurrences ?? []) * (s.headcount ?? 1) * (1 + Number(s.platform_fee_pct ?? PLATFORM_FEE_PCT))),
      feePct: Number(s.platform_fee_pct ?? PLATFORM_FEE_PCT),
      category: s.category,
      languageRequirements: s.language_requirements || [],
      location: displayProtectedText(s.location || ''),
      dress: displayProtectedText(s.dress_code || ''),
      transportAllowance: Number(s.transport_allowance ?? 0),
      description: displayProtectedText(s.description || ''),
      applicationsCloseAt: s.applications_close_at,
    })));
  }, [user]);

  useEffect(() => { loadEmployerShifts(); }, [loadEmployerShifts]);

  // Deep link from a clicked notification (e.g. "new bid received").
  useEffect(() => {
    // Shared by tapped notifications and the chat room's "View shift" shortcut.
    const wantedShiftId = deepLinkShift?.shiftId || openShiftId || routeShift?.id;
    if (!wantedShiftId || !user) return undefined;
    let active = true;
    supabase
      .from('shifts')
      .select('id, title, category, start_at, end_at, occurrences, headcount, filled_count, status, language_requirements, wage_max, applications_close_at, platform_fee_pct')
      .eq('id', wantedShiftId)
      .eq('employer_id', user.id)
      .maybeSingle()
      .then(({ data: s }) => {
        if (!active || !s) return;
        setSelectedShift({
          id: s.id,
          title: displayProtectedText(s.title),
          startAt: s.start_at,
          endAt: s.end_at,
          occurrences: s.occurrences ?? [],
          isMultiDay: (s.occurrences ?? []).length > 1,
          date: formatShiftDate(s.start_at) || 'TBA',
          time: s.start_at && s.end_at ? `${formatShiftTime(s.start_at)}–${formatShiftTime(s.end_at)}` : 'TBA',
          headcount: s.headcount ?? 1,
          filled: s.filled_count ?? 0,
          applicants: 0,
          status: s.status,
          estBudget: Math.round(Number(s.wage_max ?? 0) * totalOccurrenceHours(s.occurrences ?? []) * (s.headcount ?? 1) * (1 + Number(s.platform_fee_pct ?? PLATFORM_FEE_PCT))),
      feePct: Number(s.platform_fee_pct ?? PLATFORM_FEE_PCT),
          category: s.category,
          languageRequirements: s.language_requirements || [],
          applicationsCloseAt: s.applications_close_at,
        });
        setView('shifts');
      });
    return () => { active = false; };
  }, [deepLinkShift, user, openShiftId, routeShift]);

  // Employer's own profile (real name + reliability score for the dashboard
  // greeting/stats — replaces the old hardcoded "Grand Hyatt KL" demo copy).
  const [employerProfileLoaded, setEmployerProfileLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    if (!user) { setEmployerProfile(null); setEmployerProfileLoaded(false); return; }
    setEmployerProfileLoaded(false);
    supabase.from('profiles').select('full_name, reliability_score, ssm_number, ssm_document_path, employer_verification_status, company_description').eq('id', user.id).maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        setEmployerProfile(error ? null : (data ?? null));
        setEmployerProfileLoaded(true);
        if (!error && data) {
          setEmployerCompanyForm({
            companyName: data.full_name || user.user_metadata?.full_name || "",
            ssmNumber: data.ssm_number || "",
          });
          setCompanyDescriptionDraft(data.company_description || "");
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
      .select('id, wage_ask, status, applied_at, shift_id, worker_signed_at, no_show_at, checked_in_at, checked_out_at, employer_hours_confirmed_at, employer_hours_disputed, employer_proposed_hours, hours_resubmitted, worker:profiles!applications_worker_id_profiles_fkey(full_name)')
      .in('shift_id', shiftIds)
      .order('applied_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active || error) return;
        const rows = data ?? [];
        const counts = {};
        const bidSums = {};
        // What the employer still has to DO per shift, so the list can say so
        // without opening each one. "waiting" is the worker's move, shown
        // separately so it is not mistaken for something this side owes.
        const open = {};
        const shiftById = Object.fromEntries((liveEmployerShifts ?? []).map(sh => [sh.id, sh]));
        rows.forEach(a => {
          counts[a.shift_id] = (counts[a.shift_id] || 0) + 1;
          bidSums[a.shift_id] = (bidSums[a.shift_id] || 0) + Number(a.wage_ask ?? 0);
          const o = open[a.shift_id] || (open[a.shift_id] = { bids: 0, hours: 0, waiting: 0, attendance: 0 });
          // Attendance nobody has settled: no check-in after the shift ended, or
          // no check-out once it ended and no proposal is already in flight.
          const sh = shiftById[a.shift_id];
          const endsAt = sh ? shiftLastEndsAt(sh.occurrences, sh.endAt) : null;
          if (endsAt && endsAt.getTime() < Date.now() && a.status === 'accepted' && a.worker_signed_at && sh.status !== 'cancelled') {
            if (!a.checked_in_at && !a.no_show_at) o.attendance += 1;
            else if (a.checked_in_at && !a.checked_out_at && a.employer_proposed_hours == null && !a.hours_resubmitted) o.attendance += 1;
          }
          if (a.status === 'pending' || a.status === 'shortlisted') o.bids += 1;
          if (a.status === 'accepted' && a.checked_out_at && !a.employer_hours_confirmed_at) {
            if (a.employer_hours_disputed || a.employer_proposed_hours != null) o.waiting += 1;
            else o.hours += 1;
          } else if (a.status === 'accepted' && a.checked_in_at && !a.checked_out_at && a.hours_resubmitted) {
            // Worker rejected the proposal and owes a resubmission.
            o.waiting += 1;
          }
        });
        setLiveEmployerShifts(prev => (prev ?? []).map(s => ({
          ...s,
          applicants: counts[s.id] || 0,
          avgBid: counts[s.id] ? bidSums[s.id] / counts[s.id] : 0,
          openBids: open[s.id]?.bids ?? 0,
          openHours: open[s.id]?.hours ?? 0,
          openWaiting: open[s.id]?.waiting ?? 0,
          openAttendance: open[s.id]?.attendance ?? 0,
        })));
        setRecentActivity(rows.slice(0, 5).map(a => ({
          kind: a.status === 'accepted' ? 'accepted' : a.status === 'rejected' ? 'declined' : 'bid',
          who: a.worker?.full_name || null,
          shiftTitle: (liveEmployerShifts ?? []).find(s => s.id === a.shift_id)?.title || null,
          wageAsk: a.wage_ask,
        })));
      });
    return () => { active = false; };
    // Re-read when the employer lands back on the list: confirming hours or
    // deciding a bid inside a shift changes what is still open on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmployerShifts === null ? null : liveEmployerShifts.map(s => s.id).join(','), view === "shifts" && !selectedShift]);

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
  // guardPosting() only runs on the buttons. Arriving straight on the post-shift
  // or bulk-upload address must not sidestep the same gate.
  useEffect(() => {
    if ((view === "postshift" || view === "bulkupload") && employerProfileLoaded && !employerVerified) {
      toast(t('employer.postingLockedToast'), 'info');
      setView('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, employerProfileLoaded, employerVerified]);

  const beginNewShift = () => {
    if (!guardPosting()) return;
    setEditingShiftId(null);
    setSelectedShift(null);
    setForm({ title: "", category: "F&B", occurrences: [{ date: "", start: "", end: "" }], isMultiDay: false, wageMin: "", wageMax: "", headcount: 1, dress: "", location: "", addressVisibility: "public", offersTransportAllowance: false, transportAllowance: "", description: "", languageRequirements: [], specialRequirements: "", requiredDocuments: [] });
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

    // Rows sharing a non-empty Group ID publish as ONE multi-day shift
    // (mirrors the one-by-one wizard's multi-day occurrences); every other
    // row is its own single-occurrence shift.
    const groups = [];
    const groupIndexByKey = {};
    readyRows.forEach(row => {
      const key = row.groupId || `__row_${row._rowNum}`;
      if (groupIndexByKey[key] === undefined) { groupIndexByKey[key] = groups.length; groups.push([]); }
      groups[groupIndexByKey[key]].push(row);
    });

    setBulkUploadPublishing(true);
    setBulkUploadProgress({ done: 0, total: groups.length });
    const chunkSize = 5;
    let doneCount = 0;
    for (let i = 0; i < groups.length; i += chunkSize) {
      const chunk = groups.slice(i, i + chunkSize);
      const results = await Promise.allSettled(chunk.map(async (groupRows) => {
        const sorted = [...groupRows].sort((a, b) => (a.date + a.timeStart).localeCompare(b.date + b.timeStart));
        const first = sorted[0];
        const startAt = new Date(`${first.date}T${first.timeStart}:00+08:00`).toISOString();
        const endAt = new Date(`${first.date}T${first.timeEnd}:00+08:00`).toISOString();
        if (isNaN(new Date(startAt).getTime()) || isNaN(new Date(endAt).getTime())) {
          throw new Error("Invalid date/time.");
        }
        const wageMin = parseFloat(first.wageMin) || 0;
        const wageMax = parseFloat(first.wageMax) || wageMin;
        if (wageMax < wageMin) throw new Error("Max pay must be ≥ min pay.");
        const payload = {
          title: sanitizeBulkTextValue(first.title.trim()),
          description: first.description ? sanitizeBulkTextValue(first.description.trim()) : null,
          category: first.category,
          location: sanitizeBulkTextValue((first.location || "").trim() || "Kuala Lumpur"),
          dress_code: first.dress ? sanitizeBulkTextValue(first.dress.trim()) : null,
          start_at: startAt,
          end_at: endAt,
          occurrences: sorted.map(r => ({ date: r.date, start: r.timeStart, end: r.timeEnd })),
          wage_min: wageMin,
          wage_max: wageMax,
          headcount: parseInt(first.headcount) || 1,
          address_visibility: first.addressVisibility === "accepted_only" ? "accepted_only" : "public",
          transport_allowance: parseFloat(first.transportAllowance) || 0,
          language_requirements: parseBulkLanguageList(first.languageRequirements),
          requirements: first.specialRequirements && first.specialRequirements.trim() ? { special: sanitizeBulkTextValue(first.specialRequirements.trim()) } : {},
        };
        const { error } = await supabase.from('shifts').insert({ employer_id: user.id, status: 'open', ...payload });
        if (error) throw new Error(/row.?level security/i.test(error.message || "") ? t('employer.postShiftUnverifiedHint') : error.message);
        return true;
      }));
      setBulkUploadRows(rows => rows.map(r => {
        const groupIdx = chunk.findIndex(g => g.some(gr => gr._rowNum === r._rowNum));
        if (groupIdx === -1) return r;
        const res = results[groupIdx];
        return res.status === "fulfilled"
          ? { ...r, _status: "published", _error: null }
          : { ...r, _status: "failed", _error: res.reason?.message || "Failed to publish." };
      }));
      doneCount += chunk.length;
      setBulkUploadProgress({ done: doneCount, total: groups.length });
    }
    setBulkUploadPublishing(false);
  };

  // Load an existing shift into the form for editing.
  const startEditShift = async (shiftId) => {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, title, description, category, location, dress_code, start_at, end_at, occurrences, wage_min, wage_max, headcount, address_visibility, transport_allowance, language_requirements, requirements, applications_close_at')
      .eq('id', shiftId)
      .single();
    if (error || !data) { toast(t('employer.toastLoadShiftFailed'), 'error'); return; }
    const pad = n => String(n).padStart(2, '0');
    const start = data.start_at ? new Date(data.start_at) : null;
    const end = data.end_at ? new Date(data.end_at) : null;
    const hhmm = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    // Same browser-local-getter convention as start/end above, for the same
    // "datetime-local has no timezone" reason.
    const closeAtDate = data.applications_close_at ? new Date(data.applications_close_at) : null;
    const applicationsCloseAt = closeAtDate
      ? `${closeAtDate.getFullYear()}-${pad(closeAtDate.getMonth() + 1)}-${pad(closeAtDate.getDate())}T${hhmm(closeAtDate)}`
      : '';
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
      requiredDocuments: shiftRequiredDocuments(data.requirements),
      applicationsCloseAt,
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
  };

  // Stops new applications without cancelling the shift -- unlike Cancel,
  // this has no payout side effects and existing applicants are untouched;
  // it only flips the shift out of 'open' so the applications_worker_insert
  // RLS policy (which requires shift.status = 'open') blocks new bids.
  const handleCloseApplicationsClick = () => {
    if (!window.confirm(t('employer.confirmCloseApplications').replace('{title}', selectedShift.title))) return;
    doCloseApplications(selectedShift.id);
  };

  const doCloseApplications = async (shiftId) => {
    setClosingApplications(true);
    const { error } = await supabase.from('shifts').update({ status: 'closed' }).eq('id', shiftId);
    setClosingApplications(false);
    if (error) { toast(t('employer.toastCloseApplicationsFailed') + error.message, 'error'); return; }
    toast(t('employer.toastApplicationsClosed'), 'success');
    setLiveEmployerShifts(prev => (prev ?? []).map(s => s.id === shiftId ? { ...s, status: 'closed' } : s));
    setSelectedShift(prev => prev ? { ...prev, status: 'closed' } : prev);
  };

  const confirmCheckoutHours = async (applicationId) => {
    const { error } = await supabase.rpc('employer_confirm_checkout', { p_application_id: applicationId });
    if (error) { toast(t('employer.toastConfirmHoursFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, employerHoursConfirmedAt: new Date().toISOString(), employerHoursDisputed: false } : a));
    toast(t('employer.toastHoursConfirmed'), 'success');
  };

  const disputeCheckoutHours = async (applicationId, note) => {
    const { error } = await supabase.rpc('employer_dispute_checkout', { p_application_id: applicationId, p_note: note || null });
    if (error) { toast(t('employer.toastDisputeHoursFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(a => a.id === applicationId ? { ...a, employerHoursDisputed: true, employerHoursDisputeNote: note || null, employerHoursConfirmedAt: null } : a));
    // Closes the inline form only on success -- on failure the note the
    // employer typed stays on screen instead of silently vanishing.
    setHoursActionTarget(null);
    toast(t('employer.toastHoursDisputed'), 'success');
  };

  // Decline & Modify -- the negotiation middle ground between Accept and
  // Dispute. hoursActionTarget carries { applicationId, mode: 'modify' |
  // 'dispute' } for whichever row currently has its inline form open (one
  // shared form, both paths need hours-or-note input, so one state pair
  // rather than two near-duplicate ones).
  const [hoursActionTarget, setHoursActionTarget] = useState(null);
  const [hoursActionValue, setHoursActionValue] = useState("");
  const [hoursActionNote, setHoursActionNote] = useState("");
  const [submittingHoursAction, setSubmittingHoursAction] = useState(false);

  // ── Attendance recovery, employer side: workers who missed check-in/out ask
  // to be fixed; the employer checks them in, declines, or submits their hours
  // (which the worker must still accept). Only PENDING requests matter here.
  const [attendanceReqs, setAttendanceReqs] = useState({});   // `${applicationId}:${kind}` -> pending request
  const attendanceApplicantIds = (liveApplicants ?? []).filter(a => a.status === 'accepted').map(a => a.id).join(',');
  const loadAttendanceReqs = useCallback(async () => {
    if (!attendanceApplicantIds) { setAttendanceReqs({}); return; }
    const { data, error } = await supabase
      .from('attendance_requests')
      .select('id, application_id, kind, note, created_at')
      .in('application_id', attendanceApplicantIds.split(','))
      .eq('status', 'pending');
    if (error) return;
    const map = {};
    (data ?? []).forEach(r => { map[`${r.application_id}:${r.kind}`] = r; });
    setAttendanceReqs(map);
  }, [attendanceApplicantIds]);
  useEffect(() => { loadAttendanceReqs(); }, [loadAttendanceReqs]);

  // One inline form serves both: { applicationId, mode: 'decline' | 'submit_hours', requestId? }
  const [attendanceActionTarget, setAttendanceActionTarget] = useState(null);
  const [attendanceActionValue, setAttendanceActionValue] = useState("");
  const [attendanceActionNote, setAttendanceActionNote] = useState("");
  const [submittingAttendanceAction, setSubmittingAttendanceAction] = useState(false);

  const closeAttendanceAction = () => { setAttendanceActionTarget(null); setAttendanceActionValue(""); setAttendanceActionNote(""); };

  const checkInWorkerOnBehalf = async (a) => {
    setSubmittingAttendanceAction(true);
    const { error } = await supabase.rpc('employer_check_in_worker', { p_application_id: a.id, p_note: null });
    setSubmittingAttendanceAction(false);
    if (error) { toast(error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(x => x.id === a.id ? { ...x, checkedInAt: selectedShift?.startAt ?? new Date().toISOString(), noShowAt: null, noShowNote: null } : x));
    toast(t('attendance.toastCheckedIn'), 'success');
    loadAttendanceReqs();
  };

  const declineAttendanceRequest = async () => {
    if (!attendanceActionTarget?.requestId) return;
    setSubmittingAttendanceAction(true);
    const { error } = await supabase.rpc('employer_decline_attendance_request', { p_request_id: attendanceActionTarget.requestId, p_note: attendanceActionNote.trim() || null });
    setSubmittingAttendanceAction(false);
    if (error) { toast(error.message, 'error'); return; }
    closeAttendanceAction();
    toast(t('attendance.toastDeclined'), 'success');
    loadAttendanceReqs();
  };

  const submitHoursForWorker = async () => {
    if (!attendanceActionTarget) return;
    setSubmittingAttendanceAction(true);
    const { error } = await supabase.rpc('employer_submit_hours_for_worker', {
      p_application_id: attendanceActionTarget.applicationId, p_hours: Number(attendanceActionValue), p_note: attendanceActionNote.trim() || null,
    });
    setSubmittingAttendanceAction(false);
    if (error) { toast(error.message, 'error'); return; }
    const id = attendanceActionTarget.applicationId;
    setLiveApplicants(prev => (prev ?? []).map(x => x.id === id ? { ...x, employerProposedHours: Number(attendanceActionValue), employerProposedNote: attendanceActionNote.trim() || null } : x));
    closeAttendanceAction();
    toast(t('attendance.toastHoursSubmitted'), 'success');
    loadAttendanceReqs();
  };

  const undoNoShow = async (a) => {
    setSubmittingAttendanceAction(true);
    const { error } = await supabase.rpc('employer_undo_no_show', { p_application_id: a.id });
    setSubmittingAttendanceAction(false);
    if (error) { toast(error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(x => x.id === a.id ? { ...x, noShowAt: null, noShowNote: null } : x));
    toast(t('attendance.toastNoShowUndone'), 'success');
  };

  const proposeHoursModification = async (applicationId, hours, note) => {
    setSubmittingHoursAction(true);
    const { error } = await supabase.rpc('employer_propose_modification', {
      p_application_id: applicationId, p_hours: Number(hours), p_note: note || null,
    });
    setSubmittingHoursAction(false);
    if (error) { toast(t('employer.toastModifyHoursFailed') + error.message, 'error'); return; }
    setLiveApplicants(prev => (prev ?? []).map(a => a.id === applicationId
      ? { ...a, employerProposedHours: Number(hours), employerProposedNote: note || null }
      : a));
    setHoursActionTarget(null);
    toast(t('employer.toastHoursModifyProposed'), 'success');
  };

  // Confirmed = accepted + contract-signed — only these workers are owed a
  // late-cancellation choice (a pending/shortlisted applicant never had a
  // firm commitment to lose).
  const confirmedSignedApplicants = (liveApplicants ?? []).filter(a => a.status === 'accepted' && a.workerSignedAt);

  const [noShowTarget, setNoShowTarget] = useState(null);   // applicant row, or null
  const [noShowNote, setNoShowNote] = useState("");
  const [reportingNoShow, setReportingNoShow] = useState(false);

  // Reporting a no-show costs the worker 25 reliability points -- more than
  // any withdrawal tier, deliberately, so that giving notice is always the
  // cheaper choice. It is a serious mark applied by the counterparty, so the
  // confirm step says plainly what it does and that the worker can contest it.
  const confirmNoShow = async () => {
    if (!noShowTarget) return;
    setReportingNoShow(true);
    const { error } = await supabase.rpc('employer_mark_no_show', {
      p_application_id: noShowTarget.id,
      p_note: noShowNote.trim() || null,
    });
    setReportingNoShow(false);
    if (error) { toast(t('employer.noShowFailed') + error.message, 'error'); return; }
    toast(t('employer.noShowReported'), 'success');
    const now = new Date().toISOString();
    setLiveApplicants(prev => (prev ?? []).map(x => x.id === noShowTarget.id ? { ...x, noShowAt: now, noShowNote: noShowNote.trim() || null } : x));
    setNoShowTarget(null);
    setNoShowNote("");
  };

  // One path for every cancellation, replacing the old split of a bare
  // window.confirm beyond 24h and a countless warning inside it. Nobody can
  // weigh a decision they cannot see the price of, and "50% of their agreed
  // wage" is not a price -- RM 312.00 is.
  //
  // The figures come from quote_shift_cancellation, which reads the same
  // shift_contracted_hours the payout trigger uses. A quote computed in JS
  // would drift from what actually gets paid, and the employer would have
  // agreed to a number that never materialises.
  const [cancelQuote, setCancelQuote] = useState(null);   // { shiftId, title, rows, total, maxTotal } | null

  // Dialog semantics for this console's eight overlays. Called unconditionally
  // here, never inside the {modal && (...)} JSX -- a hook behind a condition
  // changes the hook order between renders and React throws. Each returns props
  // for its PANEL div; the backdrop keeps whatever click handling it already had.
  // Each `label` reuses the SAME translation key as that dialog's visible
  // heading, so the announced name and the on-screen title cannot drift apart.
  // Without it a screen reader announces only "dialog", with no indication of
  // which one -- role without a name is barely better than no role at all.
  const contractDialog       = useDialog(Boolean(contractModal),       () => setContractModal(null),       { label: t("contract.employerTitle") });
  const disputeDialog        = useDialog(Boolean(disputeModal),        () => setDisputeModal(null),        { label: t("myBids.fileDisputeTitle") });
  const ratingDialog         = useDialog(Boolean(ratingModal),         () => setRatingModal(null),         { label: t("rating.modalTitle") });
  const viewContractDialog   = useDialog(Boolean(viewContractModal),   () => setViewContractModal(null),   { label: t("contract.agreementHeading") });
  const checkinCodeDialog    = useDialog(Boolean(checkinCodeModal),    () => setCheckinCodeModal(null),    { label: t("employer.checkinCodeTitle") });
  const workerProfileDialog  = useDialog(Boolean(workerProfileModal),  () => setWorkerProfileModal(null),  { label: t("employer.workerProfileTitle") });
  const noShowDialog         = useDialog(Boolean(noShowTarget),        () => setNoShowTarget(null),        { label: t("employer.noShowTitle") });
  const cancelQuoteDialog    = useDialog(Boolean(cancelQuote),         () => setCancelQuote(null),         { label: t("employer.cancelQuoteTitle") });
  const [cancelQuoteLoading, setCancelQuoteLoading] = useState(false);
  const [cancelAccepted, setCancelAccepted] = useState(false);

  const handleCancelShiftClick = async () => {
    setCancelAccepted(false);
    setCancelQuoteLoading(true);
    setCancelQuote({ shiftId: selectedShift.id, title: selectedShift.title, rows: null, total: 0, maxTotal: 0 });
    const { data, error } = await supabase.rpc('quote_shift_cancellation', { p_shift_id: selectedShift.id });
    setCancelQuoteLoading(false);
    if (error) {
      // Fail closed: without a reliable figure the employer must not be asked
      // to agree to one.
      toast(t('employer.cancelQuoteFailed') + error.message, 'error');
      setCancelQuote(null);
      return;
    }
    const rows = data ?? [];
    setCancelQuote({
      shiftId: selectedShift.id,
      title: selectedShift.title,
      rows,
      total: rows.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      maxTotal: rows.reduce((sum, r) => sum + Number(r.max_amount || 0), 0),
    });
  };

  useEffect(() => {
    if (!selectedShift?.id || typeof selectedShift.id !== 'string' || !selectedShift.id.includes('-')) return;
    let active = true;
    supabase
      .from('applications')
      .select('id, worker_id, wage_ask, status, applied_at, offer_expires_at, worker_signed_at, employer_signed_at, checked_in_at, checked_out_at, worker_reported_hours, worker_reported_break_minutes, worker_checkout_note, employer_hours_confirmed_at, employer_hours_disputed, employer_hours_dispute_note, employer_proposed_hours, employer_proposed_note, hours_resubmitted, cancellation_choice, cancellation_choice_deadline, cancellation_proof_path, terms_changed_at, terms_reconfirmed_at, terms_change_summary, no_show_at, no_show_note, worker:profiles!applications_worker_id_profiles_fkey(full_name, kyc_level, reliability_score, rating, avatar_url, bio, languages_spoken, qualifications, qualifications_other)')
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
          avatarUrl: a.worker?.avatar_url ?? null,
          bio: a.worker?.bio ?? "",
          languagesSpoken: a.worker?.languages_spoken ?? [],
          qualifications: a.worker?.qualifications ?? [],
          qualificationsOther: a.worker?.qualifications_other ?? "",
          wage: Number(a.wage_ask),
          wageBid: Number(a.wage_ask),
          // Placeholder. RLS cannot count this client-side -- an employer only
          // sees applications on their OWN shifts -- so the real number is
          // filled in below from worker_completed_shift_counts(). 0 until then,
          // which is also the fallback if that function is not deployed yet.
          completedShifts: 0,
          status: a.status,
          appliedAt: a.applied_at,
          offerExpiresAt: a.offer_expires_at,
          workerId: a.worker_id,
          workerSignedAt: a.worker_signed_at ?? null,
          employerSignedAt: a.employer_signed_at ?? null,
          checkedInAt: a.checked_in_at ?? null,
          checkedOutAt: a.checked_out_at ?? null,
          workerReportedHours: a.worker_reported_hours ?? null,
          workerReportedBreakMinutes: a.worker_reported_break_minutes ?? null,
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
          termsChangedAt: a.terms_changed_at ?? null,
          termsReconfirmedAt: a.terms_reconfirmed_at ?? null,
          termsChangeSummary: a.terms_change_summary ?? null,
          noShowAt: a.no_show_at ?? null,
          noShowNote: a.no_show_note ?? null,
          // reconfirmState() reads shiftStartAt to derive the deadline; here
          // that comes from the shift being viewed, not a join.
          shiftStartAt: selectedShift?.startAt ?? null,
        }));
        // Stable sort keeps applied_at order within each group — only
        // reorders verified workers ahead of unverified ones.
        mapped.sort((x, y) => (y.verified ? 1 : 0) - (x.verified ? 1 : 0));
        setLiveApplicants(mapped);

        // Real "N shifts done", patched in after the pool is already on screen.
        // Deliberately not awaited before the first render: the count is a
        // secondary signal and holding the whole applicant list behind a second
        // round trip to show it would be the wrong trade. Best-effort -- if the
        // function is missing or errors, every card keeps the 0 it has now,
        // which is exactly today's behaviour.
        const workerIds = [...new Set(mapped.map(a => a.workerId).filter(Boolean))];
        if (workerIds.length) {
          supabase.rpc('worker_completed_shift_counts', { p_worker_ids: workerIds })
            .then(({ data: counts, error: countError }) => {
              if (!active || countError || !counts) return;
              const byWorker = new Map(counts.map(c => [c.worker_id, c.completed_shifts]));
              // Workers with none are omitted by the function rather than
              // returned as 0, so default here instead of trusting a lookup.
              setLiveApplicants(prev => (prev ?? []).map(a => (
                { ...a, completedShifts: byWorker.get(a.workerId) ?? 0 }
              )));
            });
        }
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

  // Real running total for exactly who's checked in the bulk-select bar —
  // unlike Est. budget (a worst-case ceiling at wage_max) or Avg bid (just
  // informational), this is the actual amount owed if the offer goes out to
  // precisely this selection, at each person's own bid rate.
  const selectedApplicantsTotal = selectedShift
    ? selectedApplicantIds.reduce((sum, id) => {
        const a = (liveApplicants ?? []).find(x => x.id === id);
        return sum + (a ? a.wageBid * totalOccurrenceHours(selectedShift.occurrences ?? []) : 0);
      }, 0)
    : 0;

  // Live feedback in the Post Shift form, ahead of the submit-time block —
  // same two checks as the submit handler (deadline must be in the future,
  // and no later than the shift's own start), just surfaced as the user
  // types instead of only after they hit Publish.
  const applicationDeadlineError = (() => {
    if (!form.applicationsCloseAt) return null;
    const deadline = new Date(`${form.applicationsCloseAt}:00+08:00`);
    if (Number.isNaN(deadline.getTime())) return null;
    if (deadline <= new Date()) return t('toast.applicationDeadlinePast');
    const firstOccurrence = [...form.occurrences].filter(o => o.date && o.start).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (firstOccurrence) {
      const shiftStart = new Date(`${firstOccurrence.date}T${firstOccurrence.start}:00+08:00`);
      if (!Number.isNaN(shiftStart.getTime()) && deadline > shiftStart) return t('toast.applicationDeadlineAfterStart');
    }
    return null;
  })();

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

  // Rotating check-in code: refresh every 5s while the modal is open so the
  // display never shows a code past its 30s-bucket expiry by more than a
  // few seconds.
  useEffect(() => {
    if (!checkinCodeModal?.shiftId) return undefined;
    refreshCheckinCode();
    const interval = setInterval(refreshCheckinCode, 5000);
    return () => clearInterval(interval);
  }, [checkinCodeModal]);

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
        setEmployerPayoutSummary([]);
        return;
      }

      const [{ data: bankData, error: bankError }, { data: payoutData, error: payoutError }, { data: summaryData, error: summaryError }] = await Promise.all([
        supabase
          .from("banking_details")
          .select("id, bank_name, account_holder_name, account_number_last4, verification_status, funding_ready, verified_at")
          .eq("user_id", user.id)
          .eq("role", "employer")
          .maybeSingle(),
        supabase
          .from("payout_item")
          .select("id, amount, status, scheduled_date, error_message, created_at")
          .eq("employer_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("payout_item")
          .select("amount, status")
          .eq("employer_id", user.id),
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
      if (!summaryError) setEmployerPayoutSummary(summaryData ?? []);
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
  // Loads the employer's own contact/identity record for the Personal
  // Details card below. Same table and columns the worker app used before
  // this moved here — only the surface changed, not the data model.
  useEffect(() => {
    if (view !== "account" || !user) return undefined;
    let active = true;
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
      });
    return () => { active = false; };
  }, [view, user]);

  const saveEmployerPersonalDetails = async () => {
    if (!user) return;
    setPersonalDetailsSaving(true);
    setPersonalDetailsMessage("");
    const { error } = await supabase.from('user_private').upsert({
      id: user.id,
      phone: personalDetailsForm.phone.trim(),
      identity_type: personalDetailsForm.identityType,
      id_number: personalDetailsForm.idNumber.trim(),
      date_of_birth: personalDetailsForm.dateOfBirth || null,
      address: sanitizeBulkTextValue(personalDetailsForm.address.trim()),
    });
    setPersonalDetailsSaving(false);
    if (error) { toast(t('toast.personalDetailsSaveFailed') + error.message, 'error'); return; }
    toast(t('toast.personalDetailsSaved'), 'success');
  };

  const handleEmployerAvatarUpload = async (file) => {
    if (!file || !user) return;
    setAvatarUploading(true);
    try {
      const path = await uploadAvatarFile(user.id, file);
      const { error } = await supabase.auth.updateUser({
        data: { ...user.user_metadata, avatar_url: path },
      });
      if (error) throw error;
      // Mirrors the worker-side upload: profiles.avatar_url is what other
      // users read, user_metadata is what this session renders from, so
      // both have to be written or the header goes stale until re-login.
      await supabase.from('profiles').upsert(
        { id: user.id, avatar_url: path, full_name: user.user_metadata?.full_name || user.user_metadata?.name || null },
        { onConflict: 'id' }
      );
      onUserUpdated();
      toast(t('toast.avatarUpdated'), 'success');
    } catch (err) {
      toast(t('toast.avatarUpdateFailed') + (err?.message ?? ''), 'error');
    } finally {
      setAvatarUploading(false);
    }
  };

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
    { id: "chat", label: t("employerNav.chat"), badge: unreadRooms },
    { id: "billing", label: t("employerNav.billing") },
    { id: "account", label: t("employerNav.account") },
  ];

  // What the employer still owes on one shift, per kind. Shared by the Shifts
  // list's amber to-do badges and the dashboard's "Needs you" card, so the two
  // can never disagree about what is outstanding. null for a cancelled shift:
  // nothing on it is actionable any more. Bids only count while the shift is
  // still taking them; `waiting` is the worker's move, never the employer's.
  const shiftTodos = (s) => {
    if (s.status === "cancelled") return null;
    const live = s.status === "open" || s.status === "closed";
    return {
      bids: live ? (s.openBids ?? 0) : 0,
      attendance: s.openAttendance ?? 0,
      hours: s.openHours ?? 0,
      toRate: pendingWorkerRatings.filter(x => x.shiftId === s.id && !myRatedApplicationIds.has(x.id)).length,
      waiting: s.openWaiting ?? 0,
    };
  };

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
    setMyDisputedApplicationIds(prev => new Set(prev).add(disputeModal.applicationId));
    setDisputeModal(null);
    setDisputeForm({ category: DISPUTE_CATEGORIES[0].value, description: "" });
  };

  // Slots still open on this shift = headcount minus already-accepted workers.
  // What the applicant pool actually shows, after the employer's filter and
  // sort. Everything else -- open slots, the bulk-select counter, the "N
  // applied" badge -- deliberately keeps reading liveApplicants, because those
  // are facts about the SHIFT and must not change when someone narrows a view.
  //
  // Sort is stable: ties keep the order applied, which is the order the query
  // returns and the only ordering that carries any meaning of its own. Without
  // that, two workers on the same bid would swap places between renders.
  const APPLICANT_SORTS = {
    default:     null,
    bidLow:      (a, b) => a.wageBid - b.wageBid,
    bidHigh:     (a, b) => b.wageBid - a.wageBid,
    newest:      (a, b) => new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0),
    oldest:      (a, b) => new Date(a.appliedAt || 0) - new Date(b.appliedAt || 0),
    rating:      (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    reliability: (a, b) => (b.reliability ?? 0) - (a.reliability ?? 0),
  };
  const visibleApplicants = useMemo(() => {
    const all = liveApplicants ?? [];
    // The pill an employer sees is applicantAction[id] when they have just acted
    // and the row has not reloaded yet, so filter on the same value the card
    // displays -- otherwise rejecting someone under a "Pending" filter leaves
    // them on screen labelled "Not selected".
    const shown = applicantStatusFilter === "all"
      ? all
      : all.filter(a => (applicantAction[a.id] || a.status) === applicantStatusFilter);
    const cmp = APPLICANT_SORTS[applicantSort];
    if (!cmp) return shown;
    return shown
      .map((a, i) => [a, i])
      .sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1])
      .map(pair => pair[0]);
  }, [liveApplicants, applicantAction, applicantSort, applicantStatusFilter]);

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

    // Hold the full contracted wage now — the moment the amount is known and
    // the employer acts, so an unfunded employer learns before a worker has
    // relied on the booking.
    //
    // Runs AFTER the offer while the wallet is warn-only: the hold cannot
    // refuse anything yet, so gating the offer on it would take hiring down
    // for every employer (all balances are zero) in exchange for nothing.
    // When enforcement is switched on, this moves ahead of the update.
    let shortfall = 0;
    for (const id of ids) {
      const { data, error } = await supabase.rpc('employer_hold_for_offer', { p_application_id: id });
      if (error) { console.error('employer_hold_for_offer failed:', error.message); continue; }
      if (data && data.held === false && data.reason === 'insufficient_funds') {
        shortfall += Number(data.shortfall || 0);
      }
    }
    if (shortfall > 0) {
      toast(t('employer.walletShortfallWarning', { amount: shortfall.toFixed(2) }), 'info', 6000);
    }
    refreshWalletBalance();
  };

  const committedPayoutTotal = employerPayoutSummary
    .filter(item => ['queued', 'ready', 'scheduled', 'held'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidOutPayoutTotal = employerPayoutSummary
    .filter(item => item.status === 'processed_internal')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const sidebarContent = (
    <>
      <div style={{ padding: "0 20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: FS.h3, color: BRAND.primary }}>{SITE.name}</div>
          <div style={{ fontSize: FS.meta, color: BRAND.textMuted, fontWeight: 500 }}>{t("employer.tagline")}</div>
        </div>
        {compact && (
          <button onClick={() => setSidebarOpen(false)} aria-label={t("common.close")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.textMuted, lineHeight: 1, padding: 4 }}><Icons.Close size={18} /></button>
        )}
      </div>
      {navItems.map(n => (
        <button key={n.id} onClick={() => { if ((n.id === "postshift" || n.id === "bulkupload") && !guardPosting()) { if (compact) setSidebarOpen(false); return; } setView(n.id); setSelectedShift(null); setPostStep(1); setEditingShiftId(null); if (compact) setSidebarOpen(false); }}
          style={{
            display: "block", width: "100%", textAlign: "left", padding: "10px 20px",
            background: view === n.id ? BRAND.primaryLight : "none",
            color: view === n.id ? BRAND.primary : BRAND.textMuted,
            border: "none", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: FS.meta,
            borderLeft: view === n.id ? `3px solid ${BRAND.primary}` : "3px solid transparent",
            transition: "all 0.1s",
          }}>
          {n.label}
          {n.badge > 0 && (
            <span style={{
              marginLeft: 8, minWidth: 16, height: 16, padding: "0 4px", borderRadius: RADIUS.pill,
              background: BRAND.red, color: BRAND.onSolid, fontSize: FS.micro, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
            }}>{n.badge > 9 ? "9+" : n.badge}</span>
          )}
        </button>
      ))}
      <div style={{ padding: "24px 20px 0", marginTop: "auto" }}>
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 6 }}>{t("employer.paidToWorkers")}</div>
        <div style={{ fontWeight: 800, fontSize: FS.lead, color: BRAND.greenOnSurface }}>{toCurrency(committedPayoutTotal)}</div>
        <Btn size="xs" variant="ghost" onClick={onOpenSupportChat} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>{t("employer.topUpBtn")}</Btn>
        <Btn size="xs" variant="secondary" onClick={() => onOpenPortal?.("worker")} style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>{t("employer.returnToWorkerApp")}</Btn>
      </div>
    </>
  );

  // ── Applicant pool: one set of pieces, two layouts ────────────────────────
  // A table on desktop, cards on mobile. Both call these rather than each
  // hand-rolling the same markup. The action block alone has nine branches, and
  // a second copy of it is exactly how the bulk-upload stepper and two of the
  // three payout pills ended up still carrying bugs that had already been fixed
  // in their twin. One copy, two layouts.
  const applicantIdentity = (a) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 0 }} onClick={() => setWorkerProfileModal(a)} title={t("employer.viewWorkerProfile")}>
      <Avatar name={a.name} size={28} color={BRAND.blue} src={getAvatarUrl(a.avatarUrl)} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.primaryOnSurface, textDecoration: "underline", textUnderlineOffset: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
          {a.verified && (
            <span title={t("employer.applicantVerifiedTitle")} role="img" aria-label={t("employer.applicantVerifiedTitle")} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 13, height: 13, borderRadius: "50%", background: BRAND.blue, color: BRAND.onSolid, lineHeight: 1, flexShrink: 0 }}><Icons.Check size={9} /></span>
          )}
        </div>
        {/* Same {plural} shape as positionsOpenHint and offerToWorkers. This
            read "1 shifts done" the moment the count stopped being hardcoded --
            the zero had been hiding the plural bug, since "0 shifts" is right. */}
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>
          {a.completedShifts}{" "}
          {t("employer.shiftsDoneSuffix").replace("{plural}", a.completedShifts === 1 ? "" : t("common.pluralSuffix"))}
        </div>
        {/* This worker signed, then the employer changed the terms -- the slot
            is NOT confirmed until they re-accept. Shown here so the employer can
            see the slot is at risk while there's still time to backfill it. */}
        {reconfirmState(a) && (
          <div
            title={t("employer.awaitingReconfirmHint")}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, padding: "2px 7px", borderRadius: RADIUS.pill, background: BRAND.amberLight, fontSize: FS.meta, fontWeight: 700, color: BRAND.onAmberLight }}
          >
            <InlineIcon icon={Icons.Alert} />{t("employer.awaitingReconfirm")}
          </div>
        )}
      </div>
    </div>
  );

  const applicantStatusPill = (a, action) => {
    // Display-only refinement of the SAME 'accepted' state -- does not touch
    // `action` itself (isSelectable and the action buttons still correctly
    // key off the real applications.status). Without this an accepted
    // worker still reads "Accepted" after they've physically checked in,
    // which an employer scanning the pool mid-shift can't tell apart from
    // someone who hasn't shown up yet.
    const isCheckedIn = action === 'accepted' && a.checkedInAt && !a.checkedOutAt;
    return (
    <>
      <Pill
        label={
          isCheckedIn ? t("employer.pillCheckedIn") :
          action === 'offered' ? t("employer.awaitingResponse") :
          action === 'accepted' ? t("employer.pillAccepted") :
          action === 'shortlisted' ? t("employer.pillShortlisted") :
          action === 'rejected' ? t("employer.pillNotSelected") :
          action === 'expired' ? t("employer.pillOfferExpired") :
          action === 'withdrawn' ? t("employer.pillWithdrawn") :
          t("employer.pillPending")
        }
        {...statusTone("application", isCheckedIn ? "checked_in" : action, "employer")}
      />
      {action === 'offered' && a.offerExpiresAt && (
        <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2 }}>by {formatShiftDate(a.offerExpiresAt, { day: 'numeric', month: 'short' })}, {formatShiftTime(a.offerExpiresAt)}</div>
      )}
    </>
    );
  };

  // Every colour here is the *OnSurface variant rather than the raw token:
  // these are glyphs on a surface, not fills. BRAND.red and BRAND.blue as text
  // measure 4.2 and 4.0 against a dark and light surface respectively. The
  // dogfood sweep never caught them because no QA account has ever been in the
  // no-show, expired or awaiting-response state.
  // What the employer still owes an accepted worker's attendance, judged from
  // the shift's real start/end. Nothing shows during a normal shift: the code
  // is the ordinary path. This appears once someone has missed it.
  const renderAttendanceControls = (a, action) => {
    if (action !== "accepted" || !a.workerSignedAt || selectedShift.status === "cancelled") return null;
    const startsAt = selectedShift.startAt ? new Date(selectedShift.startAt).getTime() : null;
    const endsAtDate = shiftLastEndsAt(selectedShift.occurrences, selectedShift.endAt);
    const now = Date.now();
    const started = startsAt != null && startsAt <= now;
    const ended = endsAtDate != null && endsAtDate.getTime() < now;
    const windowEndsMs = endsAtDate ? endsAtDate.getTime() + CHECKOUT_WINDOW_MS : null;
    const windowClosed = windowEndsMs != null && now > windowEndsMs;
    const inReq = attendanceReqs[`${a.id}:check_in`];
    const outReq = attendanceReqs[`${a.id}:check_out`];
    const box = { marginTop: 6, padding: "6px 10px", borderRadius: RADIUS.control, background: BRAND.amberLight, color: BRAND.onAmberLight, fontSize: FS.meta };
    const inputStyle = { width: "100%", padding: "6px 8px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, marginTop: 4, color: BRAND.text, background: BRAND.input, boxSizing: "border-box", fontFamily: "inherit" };
    const formOpen = (mode) => attendanceActionTarget?.applicationId === a.id && attendanceActionTarget.mode === mode;

    if (a.noShowAt) {
      return (
        <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
          <Btn size="xs" variant="secondary" disabled={submittingAttendanceAction} onClick={() => undoNoShow(a)}>{t("attendance.employerUndoNoShowBtn")}</Btn>
        </div>
      );
    }

    if (!a.checkedInAt && started && (inReq || ended)) {
      return (
        <div style={box} onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 700 }}>{inReq ? t("attendance.employerRequestCheckIn") : t("attendance.employerNotCheckedIn")}</div>
          <HoursNote label={t("hours.workerNoteLabel")} text={inReq?.note} tone="them" />
          {formOpen("decline") ? (
            <div>
              <input value={attendanceActionNote} onChange={e => setAttendanceActionNote(e.target.value)} placeholder={t("attendance.employerDeclineNotePlaceholder")} style={inputStyle} />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <Btn size="xs" variant="danger" disabled={submittingAttendanceAction} onClick={declineAttendanceRequest}>{t("attendance.employerConfirmDeclineBtn")}</Btn>
                <Btn size="xs" variant="secondary" onClick={closeAttendanceAction}>{t("common.cancel")}</Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <Btn size="xs" variant="success" disabled={submittingAttendanceAction} onClick={() => checkInWorkerOnBehalf(a)}>{t("attendance.employerCheckInBehalfBtn")}</Btn>
              {inReq && <Btn size="xs" variant="secondary" onClick={() => { setAttendanceActionNote(""); setAttendanceActionTarget({ applicationId: a.id, mode: "decline", requestId: inReq.id }); }}>{t("attendance.employerDeclineBtn")}</Btn>}
            </div>
          )}
        </div>
      );
    }

    if (a.employerProposedHours != null && !a.checkedOutAt) {
      return (
        <div style={box}>
          <div style={{ fontWeight: 700 }}>{t("attendance.employerOnBehalfPending").replace("{hours}", a.employerProposedHours)}</div>
          <HoursNote label={t("hours.yourNoteLabel")} text={a.employerProposedNote} tone="me" />
        </div>
      );
    }

    if (a.checkedInAt && !a.checkedOutAt && ended && !a.hoursResubmitted) {
      if (!windowClosed && !outReq) {
        const iso = new Date(windowEndsMs).toISOString();
        const when = `${formatShiftDate(iso, { day: "numeric", month: "short" })}, ${formatShiftTime(iso)}`;
        return <div style={{ marginTop: 6, fontSize: FS.meta, color: BRAND.textMuted }}>{t("attendance.employerAwaitingCheckout").replace("{when}", when)}</div>;
      }
      return (
        <div style={box} onClick={e => e.stopPropagation()}>
          <div style={{ fontWeight: 700 }}>{outReq ? t("attendance.employerRequestCheckOut") : t("attendance.employerNotCheckedOut")}</div>
          <HoursNote label={t("hours.workerNoteLabel")} text={outReq?.note} tone="them" />
          {formOpen("submit_hours") ? (
            <div>
              <input type="number" step="0.5" min="0" value={attendanceActionValue} onChange={e => setAttendanceActionValue(e.target.value)} placeholder={t("attendance.employerHoursPlaceholder")} style={inputStyle} />
              <input value={attendanceActionNote} onChange={e => setAttendanceActionNote(e.target.value)} placeholder={t("attendance.employerNotePlaceholder")} style={inputStyle} />
              <div style={{ marginTop: 4, opacity: 0.85 }}>{t("attendance.employerSubmitHoursHint")}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <Btn size="xs" variant="success" disabled={submittingAttendanceAction || !attendanceActionValue || Number(attendanceActionValue) <= 0} onClick={submitHoursForWorker}>{t("attendance.employerSubmitHoursConfirmBtn")}</Btn>
                <Btn size="xs" variant="secondary" onClick={closeAttendanceAction}>{t("common.cancel")}</Btn>
              </div>
            </div>
          ) : formOpen("decline") ? (
            <div>
              <input value={attendanceActionNote} onChange={e => setAttendanceActionNote(e.target.value)} placeholder={t("attendance.employerDeclineNotePlaceholder")} style={inputStyle} />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <Btn size="xs" variant="danger" disabled={submittingAttendanceAction} onClick={declineAttendanceRequest}>{t("attendance.employerConfirmDeclineBtn")}</Btn>
                <Btn size="xs" variant="secondary" onClick={closeAttendanceAction}>{t("common.cancel")}</Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <Btn size="xs" variant="success" onClick={() => { setAttendanceActionValue(""); setAttendanceActionNote(""); setAttendanceActionTarget({ applicationId: a.id, mode: "submit_hours" }); }}>{t("attendance.employerSubmitHoursBtn")}</Btn>
              {outReq && <Btn size="xs" variant="secondary" onClick={() => { setAttendanceActionNote(""); setAttendanceActionTarget({ applicationId: a.id, mode: "decline", requestId: outReq.id }); }}>{t("attendance.employerDeclineBtn")}</Btn>}
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  const applicantActions = (a, action, isSelectable) => (
    <>
      {isSelectable && !bulkSelectMode && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {action !== "shortlisted" && <Btn size="xs" variant="secondary" onClick={() => handleApplicantAction(a.id, "shortlisted")}>{t("employer.shortlistBtn")}</Btn>}
          <Btn size="xs" variant="success" disabled={offering || openSlotsRemaining() === 0} onClick={() => makeOffer([a.id])}>{t("employer.selectBtn")}</Btn>
          <Btn size="xs" variant="danger" onClick={() => handleApplicantAction(a.id, "rejected")}>{t("common.reject")}</Btn>
        </div>
      )}
      {action === "offered" && <span style={{ fontSize: FS.meta, color: BRAND.primaryOnSurface }}><InlineIcon icon={Icons.Clock} />{t("employer.waitingOnWorker")}</span>}
      {action === "accepted" && selectedShift.status !== "completed" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: FS.meta, color: BRAND.greenOnSurface }}><InlineIcon icon={Icons.Check} />{t("employer.confirmedStatus")}</span>
          <Btn size="xs" variant="secondary" onClick={() => setViewContractModal(a)}>{t("employer.viewContractBtn")}</Btn>
          {/* Only once the shift has actually started, and only for someone who
              never checked in -- the same preconditions employer_mark_no_show
              enforces, so the button is never offered where it would fail. */}
          {a.noShowAt ? (
            <span title={a.noShowNote || undefined} style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.redOnSurface }}>
              {t("employer.noShowReported")}
            </span>
          ) : (
            !a.checkedInAt && selectedShift.startAt && new Date(selectedShift.startAt) <= new Date() && (
              <Btn size="xs" variant="secondary" onClick={() => { setNoShowTarget(a); setNoShowNote(""); }}
                   style={{ color: BRAND.redOnSurface, borderColor: BRAND.red }}>
                {t("employer.reportNoShowBtn")}
              </Btn>
            )
          )}
        </div>
      )}
      {action === "rejected" && <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.notSelected")}</span>}
      {action === "expired" && <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.offerExpiredStatus")}</span>}
      {action === "accepted" && selectedShift.status === "completed" && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn size="xs" variant="secondary" onClick={() => setViewContractModal(a)}>{t("employer.viewContractBtn")}</Btn>
          {!myRatedApplicationIds.has(a.id) && (
            <Btn size="xs" variant="secondary" onClick={() => { setRatingForm({}); setRatingModal({ applicationId: a.id, shiftTitle: selectedShift.title, rateeId: a.workerId, direction: 'employer_to_worker' }); }}>{t("rating.rateBtn")}</Btn>
          )}
          {myDisputedApplicationIds.has(a.id) ? (
            <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.textMuted, alignSelf: "center" }}>{t("myBids.disputeAlreadyFiledBadge")}</span>
          ) : (
            <Btn size="xs" variant="secondary" onClick={() => setDisputeModal({ applicationId: a.id, shiftTitle: selectedShift.title })}>{t("myBids.fileDisputeBtn")}</Btn>
          )}
        </div>
      )}
      {renderAttendanceControls(a, action)}
      {action === "accepted" && a.checkedOutAt && (
        <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: RADIUS.control, background: BRAND.grayLight, fontSize: FS.meta }}>
          <div style={{ color: BRAND.text, fontWeight: 600 }}>
            {t("employer.reportedHoursPrefix")}{a.workerReportedHours}h
          </div>
          <HoursNote label={t("hours.workerNoteLabel")} text={a.workerCheckoutNote} tone="them" />
          {a.employerHoursConfirmedAt && (
            <div style={{ color: BRAND.greenOnSurface, fontWeight: 600, marginTop: 2 }}><InlineIcon icon={Icons.Check} />{t("employer.hoursConfirmedLabel")}</div>
          )}
          {a.employerHoursDisputed && (
            <div style={{ color: BRAND.redOnSurface, fontWeight: 600, marginTop: 2 }}>
              {t("employer.hoursDisputedLabel")}
              <HoursNote label={t("hours.yourNoteLabel")} text={a.employerHoursDisputeNote} tone="me" />
            </div>
          )}
          {/* Awaiting the worker's response to a pending proposal -- no
              buttons here, this side has already acted. */}
          {a.employerProposedHours != null && (
            <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: RADIUS.control, background: BRAND.amberLight, color: BRAND.onAmberLight }}>
              <div style={{ fontWeight: 700 }}>{t("employer.hoursProposedPendingLabel").replace("{hours}", a.employerProposedHours)}</div>
              <HoursNote label={t("hours.yourNoteLabel")} text={a.employerProposedNote} tone="me" />
            </div>
          )}
          {!a.employerHoursConfirmedAt && !a.employerHoursDisputed && a.employerProposedHours == null && (
            hoursActionTarget?.applicationId === a.id ? (
              <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
                {hoursActionTarget.mode === 'modify' && (
                  <input type="number" step="0.5" min="0" placeholder={t("employer.modifyHoursPlaceholder")}
                    value={hoursActionValue} onChange={e => setHoursActionValue(e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, marginBottom: 4, color: BRAND.text, background: BRAND.input }} />
                )}
                <textarea rows={2} placeholder={t(hoursActionTarget.mode === 'modify' ? "employer.modifyHoursNotePlaceholder" : "employer.disputeHoursPlaceholder")}
                  value={hoursActionNote} onChange={e => setHoursActionNote(e.target.value)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", resize: "vertical", color: BRAND.text, background: BRAND.input, marginBottom: 4 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="xs" variant={hoursActionTarget.mode === 'modify' ? 'success' : 'danger'} disabled={submittingHoursAction || (hoursActionTarget.mode === 'modify' && !hoursActionValue)}
                    onClick={() => hoursActionTarget.mode === 'modify'
                      ? proposeHoursModification(a.id, hoursActionValue, hoursActionNote)
                      : disputeCheckoutHours(a.id, hoursActionNote).then(() => setHoursActionTarget(null))}
                  >{t(hoursActionTarget.mode === 'modify' ? "employer.modifyHoursSubmitBtn" : "employer.disputeHoursBtn")}</Btn>
                  <Btn size="xs" variant="secondary" onClick={() => setHoursActionTarget(null)}>{t("common.cancel")}</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <Btn size="xs" variant="success" onClick={() => confirmCheckoutHours(a.id)}>{t("employer.confirmHoursBtn")}</Btn>
                {!a.hoursResubmitted ? (
                  <Btn size="xs" variant="secondary" onClick={() => { setHoursActionValue(String(a.workerReportedHours ?? '')); setHoursActionNote(''); setHoursActionTarget({ applicationId: a.id, mode: 'modify' }); }}>{t("employer.modifyHoursBtn")}</Btn>
                ) : (
                  <Btn size="xs" variant="danger" onClick={() => { setHoursActionNote(''); setHoursActionTarget({ applicationId: a.id, mode: 'dispute' }); }}>{t("employer.disputeHoursBtn")}</Btn>
                )}
              </div>
            )
          )}
        </div>
      )}
      {/* The worker rejected the proposal and has to check out again -- say so,
          otherwise the card looks idle between the rejection and the resubmit. */}
      {action === "accepted" && a.checkedInAt && !a.checkedOutAt && a.hoursResubmitted && (
        <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: RADIUS.control, background: BRAND.amberLight, color: BRAND.onAmberLight, fontSize: FS.meta, fontWeight: 600 }}>
          {t("employer.hoursAwaitingResubmit")}
        </div>
      )}
    </>
  );

  const applicantSelectBox = (a, isSelectable, isChecked, style) => (
    <input
      type="checkbox"
      style={style}
      disabled={!isSelectable || (!isChecked && selectedApplicantIds.length >= openSlotsRemaining())}
      checked={isChecked}
      onChange={e => setSelectedApplicantIds(prev => e.target.checked ? [...prev, a.id] : prev.filter(id => id !== a.id))}
    />
  );
  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", height: "100%", fontFamily: "inherit" }}>
      {compact ? (
        <>
          {/* Mobile top bar: hamburger toggle instead of a permanently-expanded sidebar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${BRAND.border}`, background: BRAND.surface, flexShrink: 0 }}>
            <button onClick={() => setSidebarOpen(true)} aria-label={t("employer.openMenu")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: FS.h3, color: BRAND.text, padding: 4, lineHeight: 1, display: "inline-flex" }}><Icons.Menu size={20} /></button>
            <div style={{ fontWeight: 800, fontSize: FS.bodyLg, color: BRAND.text }}>{navItems.find(n => n.id === view)?.label || SITE.name}</div>
          </div>
          {sidebarOpen && createPortal(
            <div style={{ position: "fixed", inset: 0, zIndex: Z.drawer, display: "flex" }}>
              <div onClick={() => setSidebarOpen(false)} style={{ position: "absolute", inset: 0, background: BRAND.overlay }} />
              <div {...sidebarDialog} style={{ position: "relative", width: "78%", maxWidth: 280, height: "100%", background: BRAND.surface, boxShadow: `4px 0 24px ${BRAND.shadow}`, display: "flex", flexDirection: "column", padding: "24px 0", overflowY: "auto" }}>
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

        {view === "dashboard" && (() => {
          const unrated = pendingWorkerRatings.filter(x => !myRatedApplicationIds.has(x.id));
          // Every outstanding to-do across every shift, one row each, so the
          // employer lands on what needs them instead of opening shifts one by
          // one. Ordered by how badly a delay hurts: attendance blocks pay,
          // then hours (pay again), then bids (the soonest shift first, since
          // it fills or doesn't), then ratings, which never expire.
          const NEEDS_YOU_KINDS = [
            { kind: "attendance", labelKey: "employer.actionAttendance" },
            { kind: "hours", labelKey: "employer.actionHoursToConfirm" },
            { kind: "bids", labelKey: "employer.actionBidsToReview" },
            { kind: "toRate", labelKey: "employer.actionToRate" },
          ];
          const shiftStart = (s) => (s.startAt ? new Date(s.startAt).getTime() : Infinity);
          const needsYouRows = NEEDS_YOU_KINDS.flatMap(({ kind, labelKey }, rank) =>
            (liveEmployerShifts ?? [])
              .map(s => ({ s, count: shiftTodos(s)?.[kind] ?? 0 }))
              .filter(r => r.count > 0)
              .sort((x, y) => shiftStart(x.s) - shiftStart(y.s))
              .map(r => ({ ...r, kind, labelKey, rank }))
          );
          // Per-shift counts arrive from a second query after the shift list;
          // until then every count reads 0, which would flash "all caught up".
          const needsYouLoaded = liveEmployerShifts !== null && liveEmployerShifts.every(s => s.openBids !== undefined);
          return (
          <div>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("employer.dashboardTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>{t("employer.goodMorning")}{employerProfile?.full_name || user?.user_metadata?.full_name || "there"}</div>
            {needsYouLoaded && (
              <Card style={{ marginBottom: 20, ...(needsYouRows.length > 0 ? { border: `1.5px solid ${BRAND.primary}` } : {}) }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: needsYouRows.length > 0 ? 4 : 0 }}>
                  <span style={{ ...TYPE.section, color: BRAND.text }}>{t("employer.needsYouTitle")}</span>
                  {needsYouRows.length > 0 && <Badge color="blue">{needsYouRows.length}</Badge>}
                </div>
                {needsYouRows.length === 0 && (
                  <div style={{ ...TYPE.body, color: BRAND.textMuted, marginTop: 4 }}>{t("employer.needsYouAllCaughtUp")}</div>
                )}
                {needsYouRows.map(({ s, count, kind, labelKey }, i) => (
                  <div key={`${kind}:${s.id}`} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "12px 0",
                    borderBottom: i < needsYouRows.length - 1 ? `1px solid ${BRAND.border}` : "none",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ ...TYPE.cardTitle, color: BRAND.text }}>{t(labelKey, { count })}</div>
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>
                        {s.title} · {s.isMultiDay ? formatOccurrencesSummary(s.occurrences) : s.date}
                      </div>
                    </div>
                    <Btn size="sm" onClick={() => { setSelectedShift(s); setView("shifts"); }} style={{ flexShrink: 0 }}>
                      {t("employer.needsYouOpenBtn")}
                    </Btn>
                  </div>
                ))}
              </Card>
            )}
            {/* On the dashboard, not buried in a finished shift's applicant
                pool -- this is the first screen an employer sees. */}
            {unrated.length > 0 && (
              <Card style={{ marginBottom: 20, border: `1px solid ${BRAND.amber}`, background: BRAND.amberLight }}>
                <div style={{ fontSize: FS.body, fontWeight: 800, color: BRAND.onAmberLight, marginBottom: 4 }}>
                  <InlineIcon icon={Icons.Star} />{t("employer.ratePromptTitle", { count: unrated.length })}
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5, marginBottom: 10 }}>
                  {t("employer.ratePromptBody", { name: unrated[0].workerName, shift: unrated[0].shiftTitle })}
                </div>
                <Btn onClick={() => { setRatingForm({}); setRatingModal({ applicationId: unrated[0].id, shiftTitle: unrated[0].shiftTitle, rateeId: unrated[0].workerId, direction: 'employer_to_worker' }); }}
                     style={{ padding: "9px 16px" }}>
                  {t("employer.ratePromptCta", { name: unrated[0].workerName })}
                </Btn>
              </Card>
            )}
            {/* Verification workflow banner — posting is hard-gated on admin
                SSM verification, so the employer always sees exactly where
                they are in the process and what happens next. */}
            {employerProfile && verificationStatus !== 'verified' && (
              <Card style={{ marginBottom: 20, border: `1.5px solid ${verificationStatus === 'rejected' ? BRAND.red : BRAND.amber}`, background: verificationStatus === 'rejected' ? BRAND.redLight : BRAND.amberLight }}>
                <div style={{ fontSize: FS.body, fontWeight: 700, color: verificationStatus === 'rejected' ? BRAND.red : BRAND.amber, marginBottom: 6 }}>
                  {verificationStatus === 'rejected' ? t("employer.verifyRejectedTitle") : t("employer.verifyPendingTitle")}
                </div>
                <div style={{ fontSize: FS.meta, color: verificationStatus === 'rejected' ? BRAND.red : BRAND.amber, lineHeight: 1.6 }}>
                  {verificationStatus === 'rejected'
                    ? t("employer.verifyRejectedBody")
                    : verificationStatus === 'pending_review'
                      ? t("employer.verifyPendingBody")
                      : t("employer.verifyUnverifiedBody")}
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 8, lineHeight: 1.6 }}>
                  {t("employer.verifyWorkflowSteps")}
                </div>
              </Card>
            )}
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              <Stat label={t("employer.statActiveShifts")} value={(liveEmployerShifts ?? []).filter(s => s.status === "open" || s.status === "closed").length} color={BRAND.primaryOnSurface} />
              <Stat label={t("employer.statTotalApplicants")} value={(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.applicants || 0), 0)} color={BRAND.blue} />
              <Stat label={t("employer.statFilledSlots")} value={`${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.filled || 0), 0)}/${(liveEmployerShifts ?? []).reduce((sum, s) => sum + (s.headcount || 0), 0)}`} color={BRAND.green} />
              <Stat label={t("employer.statReliability")} value={employerProfile?.reliability_score ?? 0} sub="/100" color={BRAND.accent} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "2fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: FS.card, color: BRAND.text, marginBottom: 12 }}>{t("employer.activeShiftsHeading")}</div>
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").length === 0 && (
                  <EmptyState
                    icon={<Icons.List size={28} />}
                    title={liveEmployerShifts === null ? t("employer.loadingShifts") : t("employer.noActiveShifts")}
                    hint={liveEmployerShifts === null ? t("employer.loadingShiftsHint") : t("employer.noActiveShiftsHint")}
                  />
                )}
                {(liveEmployerShifts ?? []).filter(s => s.status !== "draft").map(s => (
                  <Card key={s.id} onClick={() => { setSelectedShift(s); setView("shifts"); }} hover style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.text, marginBottom: 4 }}>{s.title}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{s.isMultiDay ? formatOccurrencesSummary(s.occurrences) : `${s.date} · ${s.time}`}</div>
                      </div>
                      <Pill label={shiftStatusLabel(s.status, t)} {...statusTone("shift", s.status)} />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                        <Badge color="green" size="xs">{t("employer.listCardPositionsBadge", { count: s.headcount })}</Badge>
                        <Badge color="blue" size="xs">{t("employer.listCardAppliedBadge", { count: s.applicants })}</Badge>
                      </div>
                      <Progress value={s.filled} max={s.headcount} color={BRAND.green} />
                    </div>
                  </Card>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: FS.card, color: BRAND.text, marginBottom: 12 }}>{t("employer.quickActions")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Btn onClick={beginNewShift} style={{ justifyContent: "center" }}>{t("employer.postNewShift")}</Btn>
                  <Btn variant="secondary" onClick={beginBulkUpload} style={{ justifyContent: "center" }}>{t("employer.bulkUploadBtn")}</Btn>
                  <Card style={{ padding: 14 }}>
                    <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.recentActivity")}</div>
                    {recentActivity.length === 0 && (
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, padding: "4px 0" }}>{t("employer.noActivity")}</div>
                    )}
                    {recentActivity.map((a, i) => (
                      <div key={i} style={{ fontSize: FS.meta, color: BRAND.textMuted, padding: "4px 0", borderBottom: i < recentActivity.length - 1 ? `1px solid ${BRAND.border}` : "none" }}>
                        {t(
                          a.kind === 'accepted' ? 'employer.activityAccepted' : a.kind === 'declined' ? 'employer.activityDeclined' : 'employer.activityBid',
                          { who: a.who ?? t('employer.activityUnknownWorker'), shift: a.shiftTitle ?? t('employer.activityAShift'), amount: a.wageAsk }
                        )}
                      </div>
                    ))}
                  </Card>
                </div>
              </div>
            </div>
          </div>
          );
        })()}

        {view === "shifts" && !selectedShift && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text }}>{t("employer.shiftsTitle")}</div>
                <div style={{ fontSize: FS.body, color: BRAND.textMuted }}>{t("employer.manageShiftsSubtitle")}</div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="secondary" onClick={beginBulkUpload}>{t("employer.bulkUploadBtn")}</Btn>
                <Btn onClick={beginNewShift}>{t("employer.postShiftBtn")}</Btn>
              </div>
            </div>
            {(liveEmployerShifts ?? []).length === 0 && (
              <EmptyState
                icon={<Icons.List size={28} />}
                title={liveEmployerShifts === null ? t("employer.loadingShifts") : t("employer.noShiftsPostedYet")}
                hint={liveEmployerShifts === null ? t("employer.loadingShiftsHint") : t("employer.noShiftsPostedYetHint")}
              />
            )}
            {(liveEmployerShifts ?? []).map(s => (
              <Card key={s.id} onClick={() => setSelectedShift(s)} hover style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text }}>{s.title}</span>
                      <Pill label={shiftStatusLabel(s.status, t)} {...statusTone("shift", s.status)} />
                    </div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{s.date} · {s.time}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700, fontSize: FS.body, color: BRAND.greenOnSurface }}>{t('employer.listCardEstBudget').replace('{amount}', s.estBudget)}</div>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 6 }}>
                          <Badge color="green" size="xs">{t('employer.listCardPositionsBadge').replace('{count}', s.headcount)}</Badge>
                          <Badge color="blue" size="xs">{t('employer.listCardAppliedBadge').replace('{count}', s.applicants)}</Badge>
                        </div>
                  </div>
                </div>
                    {(() => {
                      const todos = shiftTodos(s);
                      if (!todos) return null;
                      const { bids, hours, waiting, attendance, toRate } = todos;
                      if (bids + hours + waiting + attendance + toRate === 0) return null;
                      return (
                        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {bids > 0 && <Badge color="amber">{t("employer.actionBidsToReview", { count: bids })}</Badge>}
                          {attendance > 0 && <Badge color="amber">{t("employer.actionAttendance", { count: attendance })}</Badge>}
                          {hours > 0 && <Badge color="amber">{t("employer.actionHoursToConfirm", { count: hours })}</Badge>}
                          {toRate > 0 && <Badge color="amber">{t("employer.actionToRate", { count: toRate })}</Badge>}
                          {waiting > 0 && <Badge color="gray">{t("employer.actionWaitingOnWorker", { count: waiting })}</Badge>}
                        </div>
                      );
                    })()}
                    <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t('employer.listCardPositionsNeeded').replace('{count}', s.headcount)}</span>
                      <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t('employer.listCardFilled').replace('{count}', s.filled)}</span>
                      <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t('employer.listCardCategory').replace('{category}', s.category)}</span>
                      {s.languageRequirements && s.languageRequirements.length > 0 && (
                        <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t('employer.listCardLanguages').replace('{languages}', s.languageRequirements.join(", "))}</span>
                      )}
                      <Btn
                        size="sm"
                        variant="secondary"
                        disabled={!(s.filled > 0)}
                        title={s.filled > 0 ? undefined : t("employer.chatDisabledHint")}
                        style={{ marginLeft: "auto", padding: "6px 12px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveChatShift({ shiftId: s.id, title: s.title, date: s.date, otherUserLabel: '' });
                          setView('chat');
                        }}
                      >
                        <Icons.Chat size={14} /> <span style={{ marginLeft: 6 }}>{t('employer.listCardChatBtn')}</span>
                      </Btn>
                </div>
              </Card>
            ))}
          </div>
        )}

        {view === "shifts" && selectedShift && (
          <div>
            <button onClick={() => setSelectedShift(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: FS.body, color: BRAND.primaryOnSurface, fontFamily: "inherit", marginBottom: 16 }} aria-label={t("employer.backToShifts")}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("employer.backToShifts")}</span></button>
            {/* Stacked on mobile. Side by side, the title and five action
                buttons forced this row to 654px on a 375px screen, so it
                scrolled sideways and "Cancel shift" sat off the edge. */}
            <div style={{ display: "flex", flexDirection: compact ? "column" : "row", justifyContent: "space-between", alignItems: compact ? "stretch" : "flex-start", gap: 12, marginBottom: 4 }}>
              <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text }}>{selectedShift.title}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexShrink: compact ? 1 : 0 }}>
                <Btn variant="secondary" onClick={() => startEditShift(selectedShift.id)} style={{ padding: "8px 14px" }}>{Icons.Edit ? Icons.Edit({ size: 14 }) : "✏️"} <span style={{ marginLeft: 6 }}>{t("employer.editShift")}</span></Btn>
                <Btn
                  variant="secondary"
                  disabled={!(selectedShift.filled > 0)}
                  title={selectedShift.filled > 0 ? undefined : t("employer.chatDisabledHint")}
                  onClick={() => {
                    const acceptedNames = (liveApplicants ?? []).filter(a => a.status === "accepted").map(a => a.name);
                    setActiveChatShift({
                      shiftId: selectedShift.id,
                      title: selectedShift.title,
                      date: selectedShift.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift.date,
                      workerNames: acceptedNames,
                      otherUserLabel: acceptedNames.join(", ") || t("employer.confirmedStatus"),
                    });
                    setView("chat");
                  }} style={{ padding: "8px 14px" }}>
                  <Icons.Chat size={14} /> <span style={{ marginLeft: 6 }}>{t("chat.title")}</span>
                </Btn>
                {selectedShift.filled > 0 && (
                  <Btn
                    variant="secondary"
                    onClick={() => { setCheckinCode(null); setCheckinCodeModal({ shiftId: selectedShift.id, title: selectedShift.title }); }}
                    style={{ padding: "8px 14px" }}
                  >
                    {Icons.QrCode ? Icons.QrCode({ size: 14 }) : "🔢"} <span style={{ marginLeft: 6 }}>{t("employer.checkinCodeBtn")}</span>
                  </Btn>
                )}
                {selectedShift.status === "open" && (
                  <Btn
                    variant="secondary"
                    disabled={closingApplications}
                    onClick={handleCloseApplicationsClick}
                    title={t("employer.closeApplicationsHint")}
                    style={{ padding: "8px 14px" }}
                  >
                    {closingApplications ? t("employer.closingApplications") : t("employer.closeApplicationsBtn")}
                  </Btn>
                )}
                {selectedShift.status !== "cancelled" && selectedShift.status !== "completed" && (
                  <Btn
                    variant="secondary"
                    disabled={cancellingShift}
                    onClick={handleCancelShiftClick}
                    style={{ padding: "8px 14px", color: BRAND.redOnSurface }}
                  >
                    {cancellingShift ? t("employer.cancellingShift") : t("employer.cancelShift")}
                  </Btn>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Pill label={shiftStatusLabel(selectedShift.status, t)} {...statusTone("shift", selectedShift.status)} />
              <span style={{ fontSize: FS.body, color: BRAND.textMuted }}>{selectedShift.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift.date}</span>
            </div>
            {(() => {
              // The deadline never auto-flips shift.status (no cron exists
              // to do it) -- it's enforced purely at the RLS level on new
              // application inserts, so a shift can sit displayed as "open"
              // well past its own deadline. Surface that explicitly rather
              // than let the employer wonder why applications stopped
              // coming in despite the status pill still saying "open" --
              // and give them the actual way out (short notice, still
              // understaffed): editing the shift and pushing the deadline
              // back, or clearing it, immediately reopens applications --
              // it's a normal field like any other, not a one-way lock.
              if (selectedShift.status !== 'open' || !selectedShift.applicationsCloseAt) return null;
              if (new Date(selectedShift.applicationsCloseAt) > new Date()) return null;
              if (selectedShift.filled >= selectedShift.headcount) return null;
              return (
                <div style={{ background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "10px 14px", marginBottom: 12, fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5 }}>
                  {t('employer.applicationDeadlinePassedBanner')}{' '}
                  <button onClick={() => startEditShift(selectedShift.id)} style={{ border: 'none', background: 'none', color: BRAND.amber, textDecoration: 'underline', cursor: 'pointer', fontWeight: 700, padding: 0, fontFamily: 'inherit', fontSize: FS.meta }}>
                    {t('employer.editShift')}
                  </button>
                </div>
              );
            })()}
            {selectedShift.applicationsCloseAt && new Date(selectedShift.applicationsCloseAt) > new Date() && (
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16 }}>
                {t('employer.applicationDeadlineActiveLabel')} <b style={{ color: BRAND.text }}>{new Date(selectedShift.applicationsCloseAt).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' })}</b>
              </div>
            )}
            {/* Two rows on a phone, not four columns. At 375px the four tiles
                measured 481px wide and simply overflowed into a sideways
                scroller, which left Avg bid ~106px off-screen with no cue that
                it was there. Money leads: Est. budget takes the first slot --
                top-left on mobile, leftmost on desktop -- which is the strongest
                position in both layouts, rather than the far edge. */}
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
              <Stat label={t("employer.statEstBudget")} value={`RM${selectedShift.estBudget ?? 0}`} tooltip={(selectedShift.feePct ?? platformFeePct) > 0 ? t("employer.statEstBudgetTooltip").replace("{feePct}", +((selectedShift.feePct ?? platformFeePct) * 100).toFixed(2)) : t("employer.statEstBudgetTooltipNoFee")} color={BRAND.primaryOnSurface} />
              <Stat label={t("employer.statAvgBid")} value={detailAvgBid ? `RM${detailAvgBid.toFixed(2)}` : t("employer.reviewNotSet")} tooltip={t("employer.statAvgBidTooltip")} color={BRAND.accent} />
              <Stat label={t("employer.statAppliedUsers")} value={selectedShift.applicants} color={BRAND.blue} />
              <Stat label={t("employer.statSlotsFilled")} value={`${selectedShift.filled}/${selectedShift.headcount}`} color={BRAND.green} />
            </div>
            {selectedShift.status === "cancelled" && confirmedSignedApplicants.length > 0 && (
              <Card style={{ marginBottom: 20 }}>
                <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 10 }}>{t("employer.cancellationOutcomesTitle")}</div>
                {confirmedSignedApplicants.map(a => (
                  <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                    <span style={{ fontSize: FS.meta, color: BRAND.text }}>{a.name}</span>
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
                <div style={{ fontWeight: 700, fontSize: FS.card, color: BRAND.text, marginBottom: 4 }}>{t("employer.applicantPool")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.positionsOpenHint").replace("{open}", openSlotsRemaining()).replace("{total}", selectedShift.headcount).replace("{plural}", selectedShift.headcount === 1 ? '' : t("common.pluralSuffix"))}</div>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: BRAND.primaryLight, color: BRAND.onPrimaryLight, borderRadius: RADIUS.control, marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: FS.meta, color: BRAND.onPrimaryLight, fontWeight: 600 }}>{t("employer.selectedOfTotal").replace("{selected}", selectedApplicantIds.length).replace("{total}", openSlotsRemaining())}</div>
                  {selectedApplicantIds.length > 0 && (
                    <div style={{ fontSize: FS.meta, color: BRAND.onPrimaryLight, marginTop: 2 }}>
                      {t("employer.selectedTotalLabel")} <b>RM{selectedApplicantsTotal.toFixed(2)}</b>
                    </div>
                  )}
                </div>
                <Btn size="xs" disabled={selectedApplicantIds.length === 0 || offering} onClick={() => makeOffer(selectedApplicantIds)}>
                  {offering ? t("employer.sendingOffer") : t("employer.offerToWorkers").replace("{count}", selectedApplicantIds.length || '').replace("{plural}", selectedApplicantIds.length === 1 ? '' : t("common.pluralSuffix"))}
                </Btn>
              </div>
            )}
            {(liveApplicants ?? []).length === 0 && (
              <EmptyState
                icon={<Icons.Users size={28} />}
                title={liveApplicants === null ? t("employer.loadingApplicants") : t("employer.noApplicantsYet")}
                hint={liveApplicants === null ? t("employer.loadingApplicantsHint") : t("employer.noApplicantsHint")}
              />
            )}
            {(liveApplicants ?? []).length > 0 && (
              <>
                <FilterToggle
                  open={applicantFiltersOpen}
                  onToggle={() => setApplicantFiltersOpen(o => !o)}
                  activeCount={(applicantStatusFilter !== "all" ? 1 : 0) + (applicantSort !== "default" ? 1 : 0)}
                  t={t}
                />
                {applicantFiltersOpen && (
                  <FilterPanel>
                    <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr", gap: 8 }}>
                      <FilterField label={t("employer.filterStatusLabel")}>
                        <select value={applicantStatusFilter} onChange={e => setApplicantStatusFilter(e.target.value)} style={FILTER_CONTROL_STYLE}>
                          <option value="all">{t("employer.filterAll")}</option>
                          <option value="pending">{t("employer.pillPending")}</option>
                          <option value="shortlisted">{t("employer.pillShortlisted")}</option>
                          <option value="offered">{t("employer.awaitingResponse")}</option>
                          <option value="accepted">{t("employer.pillAccepted")}</option>
                          <option value="rejected">{t("employer.pillNotSelected")}</option>
                        </select>
                      </FilterField>
                      <FilterField label={t("employer.sortLabel")}>
                        <select value={applicantSort} onChange={e => setApplicantSort(e.target.value)} style={FILTER_CONTROL_STYLE}>
                          <option value="default">{t("employer.sortDefault")}</option>
                          <option value="bidLow">{t("employer.sortBidLow")}</option>
                          <option value="bidHigh">{t("employer.sortBidHigh")}</option>
                          <option value="newest">{t("employer.sortNewest")}</option>
                          <option value="oldest">{t("employer.sortOldest")}</option>
                          <option value="rating">{t("employer.sortRating")}</option>
                          <option value="reliability">{t("employer.sortReliability")}</option>
                        </select>
                      </FilterField>
                    </div>
                    <FilterClearAll
                      show={applicantStatusFilter !== "all" || applicantSort !== "default"}
                      onClear={() => { setApplicantStatusFilter("all"); setApplicantSort("default"); }}
                      t={t}
                    />
                  </FilterPanel>
                )}
                {/* Outside the panel on purpose: when a filter is hiding rows that
                    has to stay visible after the panel collapses, or a half-empty
                    pool looks like the shift lost applicants. Only rendered when
                    the two counts actually differ. */}
                {visibleApplicants.length !== (liveApplicants ?? []).length && (
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>
                    {t("employer.showingCount")
                      .replace("{shown}", visibleApplicants.length)
                      .replace("{total}", (liveApplicants ?? []).length)}
                  </div>
                )}
              </>
            )}
            {/* Distinct from "no applicants yet": there ARE applicants, this
                filter just excludes all of them. Telling someone their shift has
                no applicants when it has six would be a lie the UI told. */}
            {(liveApplicants ?? []).length > 0 && visibleApplicants.length === 0 && (
              <EmptyState
                icon={<Icons.Search size={28} />}
                title={t("employer.noneMatchFilter")}
                hint={t("employer.noneMatchFilterHint")}
              />
            )}
            {visibleApplicants.length > 0 && (compact ? (
              /* Mobile: this was a 723px table inside a 341px viewport, so it
                 scrolled sideways and everything past the worker's name -- bid,
                 rating, and the accept/reject buttons -- sat off-screen. One
                 card per applicant fits the width and puts the whole decision
                 in a single glance. Same helpers as the table below it, so the
                 two cannot drift apart. */
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {visibleApplicants.map(a => {
                  const action = applicantAction[a.id] || a.status;
                  const isSelectable = ['pending', 'shortlisted'].includes(action);
                  const isChecked = selectedApplicantIds.includes(a.id);
                  // NOT `applicantActions(...) && ...`: that helper returns a
                  // Fragment, which is truthy even when every branch inside it
                  // is false, so the card would grow an empty bordered strip for
                  // a withdrawn applicant. Mirror the branches instead.
                  const hasActions = (isSelectable && !bulkSelectMode)
                    || ["offered", "accepted", "rejected", "expired"].includes(action);
                  const metaLabel = { fontSize: FS.meta, color: BRAND.textMuted };
                  return (
                    <Card key={a.id} style={{ padding: 14 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        {bulkSelectMode && applicantSelectBox(a, isSelectable, isChecked, { marginTop: 7, flexShrink: 0 })}
                        <div style={{ flex: 1, minWidth: 0 }}>{applicantIdentity(a)}</div>
                        <div style={{ flexShrink: 0, textAlign: "right" }}>{applicantStatusPill(a, action)}</div>
                      </div>
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BRAND.border}`, display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 9, columnGap: 12, alignItems: "center" }}>
                        <span style={metaLabel}>{t("employer.colBidRate")}</span>
                        <span style={{ justifySelf: "end", fontSize: FS.bodyLg, fontWeight: 800, color: BRAND.primaryOnSurface }}>RM{a.wageBid}</span>

                        <span style={metaLabel}>{t("employer.colRating")}</span>
                        <div style={{ justifySelf: "end" }}>
                          <StarRating value={a.rating} size={12} onClick={() => openRatingDetails(a.workerId, 'employer_to_worker', a.name)} />
                        </div>

                        <span style={metaLabel}>{t("employer.colReliability")}</span>
                        <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 8, width: 130 }}>
                          <div style={{ flex: 1 }}>
                            <Progress value={a.reliability} color={a.reliability > 90 ? BRAND.green : a.reliability > 75 ? BRAND.accent : BRAND.red} />
                          </div>
                          <span style={{ fontSize: FS.meta, color: BRAND.text, minWidth: 22, textAlign: "right" }}>{a.reliability}</span>
                        </div>

                        <span style={metaLabel}>{t("employer.colKYC")}</span>
                        <div style={{ justifySelf: "end" }}>
                          <Badge color={a.kyc === "Advanced" ? "teal" : a.kyc === "Standard" ? "blue" : "gray"} size="xs">{a.kyc}</Badge>
                        </div>
                      </div>
                      {hasActions && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BRAND.border}` }}>
                          {applicantActions(a, action, isSelectable)}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            ) : (
            <div style={{ overflowX: "auto", borderRadius: RADIUS.card, border: `1px solid ${BRAND.border}` }}>
            <table style={{ width: "100%", minWidth: 720, borderCollapse: "collapse", background: BRAND.surface }}>
              <thead>
                <tr style={{ background: BRAND.grayLight }}>
                  {[bulkSelectMode ? "" : null, t("employer.colWorker"), t("employer.colKYC"), t("employer.colReliability"), t("employer.colRating"), t("employer.colBidRate"), t("employer.colStatus"), t("employer.colAction")].filter(h => h !== null).map((h, i) => (
                    <th key={h || `col${i}`} style={{ padding: "12px 14px", fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleApplicants.map(a => {
                  const action = applicantAction[a.id] || a.status;
                  const isSelectable = ['pending', 'shortlisted'].includes(action);
                  const isChecked = selectedApplicantIds.includes(a.id);
                  return (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      {bulkSelectMode && (
                        <td style={{ padding: "12px 14px" }}>{applicantSelectBox(a, isSelectable, isChecked)}</td>
                      )}
                      <td style={{ padding: "12px 14px" }}>{applicantIdentity(a)}</td>
                      <td style={{ padding: "12px 14px" }}><Badge color={a.kyc === "Advanced" ? "teal" : a.kyc === "Standard" ? "blue" : "gray"} size="xs">{a.kyc}</Badge></td>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <Progress value={a.reliability} color={a.reliability > 90 ? BRAND.green : a.reliability > 75 ? BRAND.accent : BRAND.red} />
                          <span style={{ fontSize: FS.meta, color: BRAND.text, minWidth: 28 }}>{a.reliability}</span>
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px" }}><StarRating value={a.rating} size={11} onClick={() => openRatingDetails(a.workerId, 'employer_to_worker', a.name)} /></td>
                      <td style={{ padding: "12px 14px", fontWeight: 700, color: BRAND.primaryOnSurface, fontSize: FS.body }}>RM{a.wageBid}</td>
                      <td style={{ padding: "12px 14px" }}>{applicantStatusPill(a, action)}</td>
                      <td style={{ padding: "12px 14px" }}>{applicantActions(a, action, isSelectable)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            ))}
          </div>
        )}

        {view === "postshift" && (
          <div style={{ maxWidth: 600 }}>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{editingShiftId ? t("employer.editShiftTitle") : t("employer.postAShiftTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>{editingShiftId ? t("employer.editShiftSubtitle") : t("employer.postAShiftSubtitle")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: postStep >= s ? BRAND.primary : BRAND.border, color: postStep >= s ? "#fff" : BRAND.text, display: "flex", alignItems: "center", justifyContent: "center", fontSize: FS.meta, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: FS.meta, color: postStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: postStep === s ? 700 : 400 }}>{[t("employer.stepShiftDetails"), t("employer.stepRequirements"), t("employer.stepReview")][s - 1]}</span>
                  {s < 3 && <span aria-hidden="true" style={{ color: BRAND.textMuted, fontSize: FS.lead }}>→</span>}
                </div>
              ))}
            </div>

            <Card>
              {postStep === 1 && (
                <div>
                  <Input label={t("employer.fieldShiftTitle")} placeholder={t("employer.shiftTitlePlaceholder")} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.fieldJobDescription")}</label>
                    <textarea
                      placeholder={t("employer.jobDescriptionPlaceholder")}
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 80, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <Select label={t("employer.labelCategory")} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={SHIFT_CATEGORIES.map(v => ({ value: v, label: shiftCategoryLabel(v, t) }))} />
                  <LocationAutocomplete label={t("employer.labelLocation")} value={form.location} onChange={val => setForm(f => ({ ...f, location: val }))} />
                  <div style={{marginTop:8, marginBottom:16}}>
                    <div style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:4}}>{t("employer.addressVisibilityLabel")}</div>
                    <div style={{display:'flex', gap:12}}>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:FS.meta, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="public"
                          checked={form.addressVisibility !== 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'public'}))} />
                        {t("employer.addressVisibilityPublic")}
                      </label>
                      <label style={{display:'flex', alignItems:'center', gap:5, fontSize:FS.meta, cursor:'pointer'}}>
                        <input type="radio" name="addrVisibility" value="accepted_only"
                          checked={form.addressVisibility === 'accepted_only'}
                          onChange={() => setForm(f=>({...f, addressVisibility:'accepted_only'}))} />
                        {t("employer.addressVisibilityPrivate")}
                      </label>
                    </div>
                  </div>
                  <Input label={t("employer.labelHeadcount")} type="number" value={form.headcount} onChange={e => setForm(f => ({ ...f, headcount: e.target.value }))} style={{ maxWidth: 160 }} />
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.labelSchedule")}</label>
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
                            style={{ width: 36, height: 36, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.input, color: form.occurrences.length <= 1 ? BRAND.textMuted : BRAND.red, cursor: form.occurrences.length <= 1 ? "not-allowed" : "pointer", fontSize: FS.card, opacity: form.occurrences.length <= 1 ? 0.4 : 1 }}
                          ><Icons.Close size={18} /></button>
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
                      <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{t("employer.multiDayCheckbox")}</span>
                    </label>
                    {form.isMultiDay && (
                      <Btn
                        variant="secondary"
                        size="sm"
                        disabled={form.occurrences.length >= 14}
                        onClick={() => setForm(f => ({ ...f, occurrences: [...f.occurrences, { date: "", start: "", end: "" }] }))}
                      >+ {t("employer.addAnotherDay")}</Btn>
                    )}
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>{t("employer.scheduleHint")}</div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.applicationDeadlineLabel")}</label>
                    <input
                      type="datetime-local"
                      value={form.applicationsCloseAt}
                      onChange={e => setForm(f => ({ ...f, applicationsCloseAt: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1.5px solid ${applicationDeadlineError ? BRAND.red : BRAND.border}`, fontSize: FS.body, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, outline: "none", boxSizing: "border-box" }}
                    />
                    {applicationDeadlineError ? (
                      <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: 6 }}>{applicationDeadlineError}</div>
                    ) : (
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>{t("employer.applicationDeadlineHint")}</div>
                    )}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.wageRangeLabel")}</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Input placeholder={t("employer.wageMinPlaceholder")} type="number" value={form.wageMin} onChange={e => setForm(f => ({ ...f, wageMin: e.target.value }))} />
                      <Input placeholder={t("employer.wageMaxPlaceholder")} type="number" value={form.wageMax} onChange={e => setForm(f => ({ ...f, wageMax: e.target.value }))} />
                    </div>
                    {form.wageMin && form.wageMax && (
                      <div style={{ background: BRAND.primaryLight, borderRadius: RADIUS.control, padding: "8px 12px", fontSize: FS.meta, color: BRAND.onPrimaryLight }}>
                        {t("employer.bidCapHint").replace("{amount}", (parseFloat(form.wageMax || 0) * 1.5).toFixed(2))}
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
                      <span style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{t("employer.offerTransportAllowance")}</span>
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
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>
                      {t("employer.transportAllowanceHint")}
                    </div>
                  </div>
                  <Btn onClick={() => {
                    const reason = validateOccurrences(form.occurrences);
                    if (reason === 'empty' || reason === 'incomplete') { toast(t('toast.shiftFieldsRequired'), 'error'); return; }
                    if (reason === 'pastDate') { toast(t('toast.scheduleDatePast'), 'error'); return; }
                    if (reason === 'duplicateDate') { toast(t('toast.scheduleDuplicateDate'), 'error'); return; }
                    if (applicationDeadlineError) { toast(applicationDeadlineError, 'error'); return; }
                    setPostStep(2);
                  }} style={{ width: "100%", justifyContent: "center" }}>{t("employer.nextRequirements")}</Btn>
                </div>
              )}
              {postStep === 2 && (
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.labelDressCode")}</label>
                    <textarea
                      placeholder={t("employer.dressCodePlaceholder")}
                      value={form.dress}
                      onChange={e => setForm(f => ({ ...f, dress: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 60, resize: "none", boxSizing: "border-box" }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.requiredDocumentsLabel")}</label>
                    {SHIFT_REQUIRED_DOCUMENTS.map(doc => (
                      <label key={doc.value} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: FS.meta, color: BRAND.text }}>
                        <input
                          type="checkbox"
                          checked={form.requiredDocuments.includes(doc.value)}
                          onChange={e => setForm(f => ({
                            ...f,
                            requiredDocuments: e.target.checked
                              ? [...f.requiredDocuments, doc.value]
                              : f.requiredDocuments.filter(v => v !== doc.value),
                          }))}
                        /> {t(doc.labelKey)}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 8 }}>{t("employer.labelLanguageRequirements")}</label>
                    {SHIFT_LANGUAGES.map(lang => (
                      <label key={lang} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: FS.meta, color: BRAND.text }}>
                        <input
                          type="checkbox"
                          checked={form.languageRequirements.includes(lang)}
                          onChange={() => setForm(f => ({ ...f, languageRequirements: f.languageRequirements.includes(lang) ? f.languageRequirements.filter(l => l !== lang) : [...f.languageRequirements, lang] }))}
                        /> {lang}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.specialRequirementsLabel")}</label>
                    <textarea
                      placeholder={t("employer.specialRequirementsPlaceholder")}
                      value={form.specialRequirements}
                      onChange={e => setForm(f => ({ ...f, specialRequirements: e.target.value }))}
                      style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, height: 80, resize: "none", boxSizing: "border-box" }}
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
                  <div style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text, marginBottom: 16 }}>{t("employer.reviewYourShift")}</div>
                  {[
                    [t("employer.reviewLabelTitle"), form.title || t("employer.reviewNotSet")],
                    [t("employer.fieldJobDescription"), form.description || t("employer.reviewNotSet")],
                    [t("employer.labelCategory"), form.category],
                    [t("employer.labelLocation"), form.location],
                    [t("employer.labelHeadcount"), form.headcount],
                    [t("employer.reviewLabelWageRange"), form.wageMin && form.wageMax ? `RM${form.wageMin}–RM${form.wageMax}/h` : t("employer.reviewNotSet")],
                    [t("employer.reviewLabelTransportAllowance"), form.offersTransportAllowance && form.transportAllowance ? `RM${form.transportAllowance}` : t("employer.transportNotOffered")],
                    [t("employer.labelDressCode"), form.dress || t("employer.dressCodeNone")],
                    [t("employer.reviewLabelLanguages"), form.languageRequirements.length > 0 ? form.languageRequirements.join(", ") : t("employer.reviewNotSet")],
                    [t("employer.specialRequirementsLabel"), form.specialRequirements || t("employer.reviewNotSet")],
                    [t("employer.requiredDocumentsLabel"), form.requiredDocuments.length > 0 ? SHIFT_REQUIRED_DOCUMENTS.filter(d => form.requiredDocuments.includes(d.value)).map(d => t(d.labelKey)).join(", ") : t("employer.reviewNotSet")],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${BRAND.border}`, fontSize: FS.meta }}>
                      <span style={{ color: BRAND.textMuted, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontWeight: 600, color: BRAND.text, textAlign: "right", whiteSpace: "pre-wrap" }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ padding: "8px 0", borderBottom: `1px solid ${BRAND.border}`, fontSize: FS.meta }}>
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
                    const reserve = parseFloat(form.wageMax || 0) * parseInt(form.headcount || 0) * totalHours * (1 + platformFeePct);
                    return (
                      <div style={{ background: BRAND.amberLight, borderRadius: RADIUS.control, padding: "12px 16px", marginTop: 16, marginBottom: 16 }}>
                        <div style={{ fontSize: FS.meta, color: BRAND.amber, fontWeight: 600, marginBottom: 4 }}>{t("employer.estimatedReserveLabel")}</div>
                        <div style={{ fontSize: FS.h2, fontWeight: 800, color: BRAND.amber }}>{toCurrency(reserve)}</div>
                        <div style={{ fontSize: FS.meta, color: BRAND.amber }}>{platformFeePct > 0 ? t("employer.estimatedReserveFormula").replace("{feePct}", +(platformFeePct * 100).toFixed(2)) : t("employer.estimatedReserveFormulaNoFee")}</div>
                        {/* The trial line only appears when a fee actually
                            exists. While the global rate is 0 everyone is free
                            anyway, and announcing a "free trial" then would
                            advertise a benefit indistinguishable from the
                            status quo -- and burn employers' two months on a
                            period that cost them nothing. */}
                        {platformFeePct > 0 && feeFreeUntil && new Date(feeFreeUntil) > new Date() && (
                          <div style={{ fontSize: FS.meta, color: BRAND.onGreenLight, background: BRAND.greenLight, borderRadius: RADIUS.control, padding: "4px 8px", marginTop: 6, display: "inline-block" }}>
                            {t("employer.feeTrialActive").replace("{date}", new Date(feeFreeUntil).toLocaleDateString())}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <Btn variant="secondary" onClick={() => setPostStep(2)} style={{ flex: 1, justifyContent: "center" }}>{Icons.ArrowLeft({ size: 14 })} <span style={{ marginLeft: 8 }}>{t("common.back")}</span></Btn>
                    <Btn onClick={async () => {
                      if (!user) { toast(t('toast.signInToPostShift'), 'error'); return; }
                      if (!editingShiftId && !guardPosting()) return;
                      const reason = validateOccurrences(form.occurrences);
                      if (!form.title || !form.location.trim() || reason) {
                        toast(t('toast.shiftFieldsRequired'), 'error'); return;
                      }
                      const sortedOccurrences = [...form.occurrences].sort((a, b) => a.date.localeCompare(b.date));
                      const first = sortedOccurrences[0];
                      const startAt = new Date(`${first.date}T${first.start}:00+08:00`).toISOString();
                      const endAt   = new Date(`${first.date}T${first.end}:00+08:00`).toISOString();
                      const wageMin = parseFloat(form.wageMin) || 0;
                      const wageMax = parseFloat(form.wageMax) || 0;
                      if (wageMax < wageMin) { toast(t('toast.maxPayGteMinPay'), 'error'); return; }
                      // Reuses the same live-validated value shown inline
                      // above (applicationDeadlineError) instead of
                      // re-deriving separate submit-time logic that could
                      // silently drift out of sync with it.
                      if (applicationDeadlineError) { toast(applicationDeadlineError, 'error'); return; }
                      // Same +08:00-literal convention as the occurrence
                      // date/times above — the datetime-local input's value
                      // has no timezone of its own, so it's treated as
                      // Malaysia wall-clock time, not the browser's.
                      const applicationsCloseAtIso = form.applicationsCloseAt
                        ? new Date(`${form.applicationsCloseAt}:00+08:00`).toISOString()
                        : null;
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
                        applications_close_at: applicationsCloseAtIso,
                        // {} not null: `requirements` is NOT NULL DEFAULT '{}'::jsonb live —
                        // an explicit null still violates NOT NULL (the default only
                        // applies when the column is omitted from the insert/update
                        // entirely), which was silently failing every post/edit of a
                        // shift with no special requirements filled in.
                        requirements: {
                          ...(form.specialRequirements.trim() ? { special: form.specialRequirements.trim() } : {}),
                          ...(form.requiredDocuments.length > 0 ? { documents: form.requiredDocuments } : {}),
                        },
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
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4 }}>{t("employer.bulkUploadTitle")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 24 }}>{t("employer.bulkUploadSubtitle")}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
              {[1, 2, 3].map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: bulkUploadStep >= s ? BRAND.primary : BRAND.border, color: bulkUploadStep >= s ? "#fff" : BRAND.text, display: "flex", alignItems: "center", justifyContent: "center", fontSize: FS.meta, fontWeight: 700 }}>{s}</div>
                  <span style={{ fontSize: FS.meta, color: bulkUploadStep >= s ? BRAND.text : BRAND.textMuted, fontWeight: bulkUploadStep === s ? 700 : 400 }}>{[t("employer.bulkStepUpload"), t("employer.bulkStepReview"), t("employer.bulkStepPublish")][s - 1]}</span>
                  {s < 3 && <span aria-hidden="true" style={{ color: BRAND.textMuted, fontSize: FS.lead }}>→</span>}
                </div>
              ))}
            </div>

            {bulkUploadStep === 1 && (
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text }}>{t("employer.bulkUploadCsvHeading")}</div>
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
                  <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: -8, marginBottom: 8 }}>{bulkUploadFileError}</div>
                )}
                <button type="button" onClick={() => setBulkGuideOpen(o => !o)}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 16, background: "none", border: "none", padding: 0, cursor: "pointer", color: BRAND.primaryOnSurface, fontSize: FS.meta, fontWeight: 600, fontFamily: "inherit" }}>
                  <span style={{ display: "inline-block", transform: bulkGuideOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
                  {t("employer.bulkGuideToggle")}
                </button>
                {bulkGuideOpen && (
                  <div style={{ marginTop: 12, padding: 16, background: BRAND.grayLight, borderRadius: RADIUS.control, fontSize: FS.meta, lineHeight: 1.7, color: BRAND.text }}>
                    <p style={{ margin: "0 0 10px" }}>{t("employer.bulkGuideIntro")}</p>
                    <p style={{ margin: "0 0 10px" }}>• {t("employer.bulkGuideRequired")}</p>
                    <p style={{ margin: "0 0 10px" }}>• {t("employer.bulkGuideCategory")}</p>
                    <p style={{ margin: "0 0 10px" }}>• {t("employer.bulkGuideOptional")}</p>
                    <p style={{ margin: 0 }}>• {t("employer.bulkGuideMultiDay")}</p>
                  </div>
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
                  <div style={{ background: needsFixCount > 0 ? BRAND.amberLight : BRAND.greenLight, borderRadius: RADIUS.control, padding: "10px 16px", marginBottom: 16, fontSize: FS.meta, fontWeight: 600, color: needsFixCount > 0 ? BRAND.amber : BRAND.green }}>
                    {t("employer.bulkRowsSummary").replace("{ready}", readyCount).replace("{total}", total).replace("{needsFix}", needsFixCount)}
                  </div>
                  <Card style={{ padding: 0, overflow: "auto", marginBottom: 16 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1780 }}>
                      <thead>
                        <tr style={{ background: BRAND.grayLight }}>
                          {[t("employer.bulkColRow"), t("employer.bulkColGroupId"), t("employer.bulkColStatus"), t("employer.bulkColTitle"), t("employer.bulkColCategory"), t("employer.bulkColDate"), t("employer.bulkColStart"), t("employer.bulkColEnd"), t("employer.bulkColMinWage"), t("employer.bulkColMaxWage"), t("employer.bulkColHeadcount"), t("employer.bulkColLocation"), t("employer.bulkColDressCode"), t("employer.bulkColTransport"), t("employer.bulkColVisibility"), t("employer.bulkColLanguages"), t("employer.bulkColSpecialReq"), ""].map(h => (
                            <th key={h} style={{ padding: "10px 12px", fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}`, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bulkUploadRows.map(row => {
                          const locked = row._status === "published";
                          const wageBad = row.wageMin !== "" && row.wageMax !== "" && parseFloat(row.wageMax) < parseFloat(row.wageMin);
                          return (
                            <tr key={row._rowNum} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                              <td style={{ padding: "8px 12px", fontSize: FS.meta, color: BRAND.textMuted }}>{row._rowNum}</td>
                              <td style={{ padding: "8px 12px", minWidth: 120 }}><Input value={row.groupId} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "groupId", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px" }}>
                                {pillFor(row._status)}
                                {row._status === "failed" && row._error && (
                                  <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: 4, maxWidth: 140 }}>{row._error}</div>
                                )}
                              </td>
                              <td style={{ padding: "8px 12px", minWidth: 170 }}><Input value={row.title} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "title", e.target.value)} style={{ marginBottom: 0 }} error={!row.title.trim()} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 140 }}>
                                <Select value={row.category} onChange={e => updateBulkUploadRow(row._rowNum, "category", e.target.value)} options={[{ value: "", label: t("employer.bulkSelectCategoryPlaceholder") }, ...SHIFT_CATEGORIES.map(c => ({ value: c, label: shiftCategoryLabel(c, t) }))]} style={{ marginBottom: 0 }} />
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
                              <td style={{ padding: "8px 12px", minWidth: 130 }}>
                                <Select value={row.addressVisibility} onChange={e => updateBulkUploadRow(row._rowNum, "addressVisibility", e.target.value)} options={[{ value: "public", label: t("employer.addressVisibilityPublic") }, { value: "accepted_only", label: t("employer.addressVisibilityPrivate") }]} style={{ marginBottom: 0 }} />
                              </td>
                              <td style={{ padding: "8px 12px", minWidth: 150 }}><Input value={row.languageRequirements} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "languageRequirements", e.target.value)} style={{ marginBottom: 0 }} /></td>
                              <td style={{ padding: "8px 12px", minWidth: 170 }}><Input value={row.specialRequirements} disabled={locked} onChange={e => updateBulkUploadRow(row._rowNum, "specialRequirements", e.target.value)} style={{ marginBottom: 0 }} /></td>
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
                  <div style={{ fontWeight: 700, fontSize: FS.bodyLg, color: BRAND.text, marginBottom: 12 }}>{t("employer.bulkStepPublish")}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16 }}>
                    {t("employer.bulkRowsSummary").replace("{ready}", readyCount).replace("{total}", bulkUploadRows.length).replace("{needsFix}", needsFixCount)}
                  </div>
                  {bulkUploadPublishing && (
                    <div style={{ background: BRAND.primaryLight, borderRadius: RADIUS.control, padding: "10px 16px", marginBottom: 16, fontSize: FS.meta, fontWeight: 600, color: BRAND.onPrimaryLight }}>
                      {t("employer.bulkPublishing").replace("{done}", bulkUploadProgress.done).replace("{total}", bulkUploadProgress.total)}
                    </div>
                  )}
                  {!bulkUploadPublishing && (publishedCount > 0 || failedCount > 0) && (
                    <div style={{ background: failedCount > 0 ? BRAND.amberLight : BRAND.greenLight, borderRadius: RADIUS.control, padding: "10px 16px", marginBottom: 16, fontSize: FS.meta, fontWeight: 600, color: failedCount > 0 ? BRAND.amber : BRAND.green }}>
                      {t("employer.bulkPublishSummary").replace("{published}", publishedCount).replace("{failed}", failedCount)}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, maxHeight: 280, overflowY: "auto" }}>
                    {bulkUploadRows.map(row => (
                      <div key={row._rowNum} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: BRAND.grayLight, borderRadius: RADIUS.control, gap: 12 }}>
                        <div style={{ fontSize: FS.meta, color: BRAND.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{row._rowNum} {row.title || t("employer.bulkUntitled")}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                          {row._status === "failed" && row._error && <span style={{ fontSize: FS.meta, color: BRAND.red }}>{row._error}</span>}
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
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 24 }}>{t("employer.billingTitle")}</div>
            {/* The deposit reads first: it is what backs the payout figures
                below. Replaces a checkbox the employer ticked about
                themselves, which nothing verified. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 10 }}>{t("employer.walletTitle")}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.walletAvailable")}</span>
                <span style={{ fontSize: FS.lead, fontWeight: 800, color: BRAND.text }}>RM{Number(wallet?.available ?? 0).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.walletHeld")}</span>
                <span style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.text }}>RM{Number(wallet?.held ?? 0).toFixed(2)}</span>
              </div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5 }}>{t("employer.walletHeldHint")}</div>
              {/* Said plainly, so a RM0.00 balance does not read as "hiring is
                  blocked" when nothing is enforced yet. */}
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginTop: 8, fontStyle: "italic" }}>{t("employer.walletWarnOnlyNote")}</div>
            </Card>
            {/* What the two figures above are made of. The ledger is
                append-only and the balance is derived from it, so this list IS
                the explanation of the balance rather than a separate record. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 10 }}>{t("employer.walletHistoryTitle")}</div>
              {walletEntriesFailed ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.walletHistoryError")}</div>
              ) : walletEntries.length === 0 ? (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.walletHistoryEmpty")}</div>
              ) : (
                <>
                  {walletEntries.map(entry => (
                    <div key={entry.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 0", borderBottom: `1px solid ${BRAND.border}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                          <Pill label={walletKindLabel(entry.kind, t)} color={walletKindColor(entry.kind)} />
                          <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>
                            {entry.created_at ? formatShiftDate(entry.created_at, { day: "numeric", month: "short" }) : ""}
                          </span>
                        </div>
                        {/* shift is null when the shift has since been removed --
                            the movement outlives it by design. */}
                        <div style={{
                          fontSize: FS.meta, color: BRAND.textMuted,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {entry.shift?.title || entry.note || t("employer.walletHistoryShiftGone")}
                        </div>
                      </div>
                      <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, flexShrink: 0 }}>
                        RM{Number(entry.amount ?? 0).toFixed(2)}
                      </div>
                    </div>
                  ))}
                  {/* Say when the list is capped. A truncated list that trails
                      off silently reads as a complete one. */}
                  {walletEntries.length >= WALLET_HISTORY_LIMIT && (
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 10 }}>
                      {t("employer.walletHistoryTruncated", { n: WALLET_HISTORY_LIMIT })}
                    </div>
                  )}
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginTop: 10 }}>{t("employer.walletHistoryHint")}</div>
                </>
              )}
            </Card>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 12 }}>
              <Stat label={t("employer.pendingPayout")} value={toCurrency(committedPayoutTotal)} tooltip={t("employer.pendingPayoutTooltip")} color={BRAND.amber} />
              <Stat label={t("employer.totalPaidOut")} value={toCurrency(paidOutPayoutTotal)} tooltip={t("employer.totalPaidOutTooltip")} color={BRAND.primaryOnSurface} />
            </div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 16 }}>
              {t("employer.escrowUnavailableNote")}
            </div>
            <Btn onClick={onOpenSupportChat} style={{ marginBottom: 24 }}>{t("employer.addFundsBtn")}</Btn>
            <div style={{ fontWeight: 700, fontSize: FS.card, color: BRAND.text, marginBottom: 12 }}>{t("employer.payoutLedgerTitle")}</div>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: BRAND.grayLight }}>
                    {[t("employer.colDateShort"), t("employer.colStatus"), t("employer.colAmount")].map(h => (
                      <th key={h} style={{ padding: "12px 16px", fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, textAlign: "left", borderBottom: `1px solid ${BRAND.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employerPayoutItems.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: "16px", fontSize: FS.meta, color: BRAND.textMuted, textAlign: "center" }}>{t("employer.noPayoutObligations")}</td></tr>
                  )}
                  {employerPayoutItems.map(item => (
                    <tr key={item.id} style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                      <td style={{ padding: "12px 16px", fontSize: FS.meta, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString('en-MY') : t("employer.tbaShort")}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <Pill label={String(item.status || 'queued').replaceAll('_', ' ')} color={mapPayoutPillColor(item.status)} />
                        {item.status === "held" && payoutHoldReasonLabel(t, item.error_message) && (
                          <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: 4 }}>{payoutHoldReasonLabel(t, item.error_message)}</div>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: FS.meta, fontWeight: 700, color: BRAND.text }}>{toCurrency(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {view === "account" && (
          <div style={{ maxWidth: 500 }}>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 24 }}>{t("employer.accountTitle")}</div>
            {/* Profile photo — the employer-console home for what used to be
                editable only via the worker-app view's avatar overlay. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("employer.profilePhotoTitle")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Avatar name={employerProfile?.full_name || user?.email || "?"} size={64} color={BRAND.primary} src={getAvatarUrl(user?.user_metadata?.avatar_url)} />
                  <label style={{
                    position: "absolute", right: -2, bottom: -2, width: 26, height: 26,
                    borderRadius: "50%", background: BRAND.primary, color: BRAND.onSolid,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: avatarUploading ? "wait" : "pointer", fontSize: FS.meta,
                    border: `2px solid ${BRAND.surface}`,
                  }} title={t("profile.changePhoto")}>
                    {avatarUploading ? "…" : <Icons.Edit size={13} />}
                    <input type="file" accept="image/*" disabled={avatarUploading}
                      onChange={(e) => handleEmployerAvatarUpload(e.target.files?.[0])}
                      style={{ display: "none" }} />
                  </label>
                </div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5 }}>{t("employer.profilePhotoHint")}</div>
              </div>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("employer.aboutCompanyTitle")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5, marginBottom: 10 }}>{t("employer.aboutCompanyHint")}</div>
              <textarea
                value={companyDescriptionDraft}
                onChange={e => setCompanyDescriptionDraft(e.target.value.slice(0, 500))}
                placeholder={t("employer.aboutCompanyPlaceholder")}
                aria-label={t("employer.aboutCompanyTitle")}
                rows={4}
                style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, fontSize: FS.meta, fontFamily: "inherit", color: BRAND.text, background: BRAND.input, resize: "vertical" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{companyDescriptionDraft.length}/500</span>
                <Btn size="sm" onClick={saveCompanyDescription}
                  disabled={savingCompanyDescription || companyDescriptionDraft.trim() === (employerProfile?.company_description || "")}>
                  {savingCompanyDescription ? "…" : t("employer.aboutCompanySaveBtn")}
                </Btn>
              </div>
            </Card>
            {/* Mirrors WorkerPortal's own "Recent Ratings" card -- same RPC
                (get_ratee_ratings), opposite direction. Employer had no
                self-rating view of any kind before this. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 12 }}>{t("profile.recentRatings")}</div>
              {myEmployerRatings === null && <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
              {myEmployerRatings && myEmployerRatings.length === 0 && (
                <EmptyState icon={<Icons.Star size={28} />} title={t("profile.noRatingsTitle")} hint={t("employer.noRatingsHint")} />
              )}
              {myEmployerRatings && myEmployerRatings.length > 0 && (
                <>
                  {RATING_ASPECTS.worker_to_employer.map(asp => {
                    const scores = myEmployerRatings.map(r => r.aspects?.[asp.value]).filter(v => typeof v === "number");
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
                    {t("profile.rating")}: {(myEmployerRatings.reduce((s, r) => s + (r.overall || 0), 0) / myEmployerRatings.length).toFixed(1)} ({myEmployerRatings.length})
                  </div>
                </>
              )}
              <ReceivedFeedback items={myEmployerFeedback} />
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", rowGap: 8, gap: 12 }}>
                <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                  <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("settings.pushTitle")}</div>
                  <div style={{ fontSize: FS.meta, color: BRAND.textMuted, lineHeight: 1.5 }}>
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
            </Card>
            {/* Personal (contact-person) details — same user_private record
                the worker app edited; surfaced here so an employer never has
                to enter the worker preview to maintain their own account. */}
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("personalDetails.title")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>{t("employer.personalDetailsHint")}</div>
              <Input label={t("auth.phoneNumber")} value={personalDetailsForm.phone} onChange={e => setPersonalDetailsForm(f => ({ ...f, phone: e.target.value }))} />
              <Select
                label={t("auth.identityType")}
                value={personalDetailsForm.identityType}
                onChange={e => setPersonalDetailsForm(f => ({ ...f, identityType: e.target.value }))}
                options={[{ value: "MyKad", label: t("auth.icMyKad") }, { value: "MyPR", label: t("auth.myPR") }, { value: "Passport", label: t("auth.passport") }]}
              />
              <Input
                label={personalDetailsForm.identityType === "MyKad" ? t("auth.myKadNumber") : personalDetailsForm.identityType === "MyPR" ? t("auth.myPRNumber") : t("auth.passportNumber")}
                placeholder={["MyKad", "MyPR"].includes(personalDetailsForm.identityType) ? "XXXXXX-XX-XXXX" : "A1234567"}
                value={personalDetailsForm.idNumber}
                onChange={e => setPersonalDetailsForm(f => ({ ...f, idNumber: e.target.value }))}
              />
              <Input label={t("auth.dateOfBirth")} type="date" value={personalDetailsForm.dateOfBirth} onChange={e => setPersonalDetailsForm(f => ({ ...f, dateOfBirth: e.target.value }))} />
              <Input label={t("auth.address")} value={personalDetailsForm.address} onChange={e => setPersonalDetailsForm(f => ({ ...f, address: e.target.value }))} />
              {personalDetailsMessage && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{personalDetailsMessage}</div>}
              <Btn onClick={saveEmployerPersonalDetails} disabled={personalDetailsSaving} style={{ width: "100%", justifyContent: "center" }}>
                {personalDetailsSaving ? "…" : t("personalDetails.saveBtn")}
              </Btn>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text }}>{t("employer.companyDetailsTitle")}</div>
                {employerProfile?.employer_verification_status === "verified" && (
                  <span title={t("employer.verifiedBadgeTitle")} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: RADIUS.pill, background: BRAND.blueLight, color: BRAND.onBlueLight, fontSize: FS.meta, fontWeight: 700 }}>
                    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 13, height: 13, borderRadius: "50%", background: BRAND.blue, color: BRAND.onSolid, lineHeight: 1 }}><Icons.Check size={9} /></span>
                    {t("employer.verifiedBadge")}
                  </span>
                )}
              </div>
              <Input label={t("employer.companyNameLabel")} placeholder={t("employer.companyNamePlaceholder")} value={employerCompanyForm.companyName} onChange={(e) => setEmployerCompanyForm(prev => ({ ...prev, companyName: e.target.value }))} />
              <Input label={t("employer.ssmNumberLabel")} placeholder={t("employer.ssmNumberPlaceholder")} value={employerCompanyForm.ssmNumber} onChange={(e) => setEmployerCompanyForm(prev => ({ ...prev, ssmNumber: e.target.value }))} />
              <Input label={t("employer.contactEmailLabel")} placeholder="hr@company.com" value={user?.email || ""} onChange={() => {}} disabled />
              <label style={{ display: "block", marginBottom: 12 }}>
                <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text, marginBottom: 6 }}>{t("employer.ssmCertLabel")}</div>
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 8 }}>{t("employer.ssmCertHint")}</div>
                <input
                  type="file" accept="image/*,application/pdf"
                  onChange={e => { const f = e.target.files?.[0] || null; setEmployerCompanyForm(prev => ({ ...prev, ssmCertFile: f })); }}
                  style={{ fontSize: FS.meta }}
                />
                {employerProfile?.ssm_document_path && !employerCompanyForm.ssmCertFile && (
                  <div style={{ fontSize: FS.meta, color: BRAND.greenOnSurface, marginTop: 6 }}><InlineIcon icon={Icons.Check} />{t("employer.ssmCertOnFile")}</div>
                )}
              </label>
              {companyDetailsMessage && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{companyDetailsMessage}</div>}
              <Btn onClick={saveEmployerCompanyDetails} disabled={companyDetailsLoading} style={{ width: "100%", justifyContent: "center" }}>{t("employer.saveChanges")}</Btn>
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("employer.bankingSectionTitle")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 12 }}>
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.verificationLabel")}</span>
                <Pill
                  label={employerBanking?.verification_status ? `SecureSign ${bankVerificationLabel(employerBanking.verification_status, t)}` : t("settings.secureSignPending")}
                  color={mapVerificationPillColor(employerBanking?.verification_status)}
                />
              </div>
              {employerBanking?.account_number_last4 && (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>
                  {t("employer.savedAccountPrefix")} {employerBanking.account_number_last4}
                </div>
              )}
              {bankingMessage && <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 10 }}>{bankingMessage}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="secondary" onClick={saveEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.saveBanking")}</Btn>
                <Btn onClick={verifyEmployerBankingDetails} disabled={bankingLoading} style={{ flex: 1, justifyContent: "center" }}>{t("settings.verifySecureSign")}</Btn>
              </div>
            </Card>
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
                    <Btn size="xs" variant="secondary" style={{ marginTop: 6 }} onClick={() => { setActiveChatShift({ shiftId: d.application?.shift_id, title: d.application?.shift?.title ?? "", date: "", otherUserLabel: "" }); setView("chat"); }}>{t("disputes.viewShiftChat")}</Btn>
                    {d.resolved_at && (
                      <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginTop: 6 }}>
                        {t("disputes.resolvedLabel")} {new Date(d.resolved_at).toLocaleDateString("en-MY")}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: FS.body, fontWeight: 700, color: BRAND.text, marginBottom: 8 }}>{t("employer.outgoingObligationsTitle")}</div>
              {employerPayoutItems.length === 0 && (
                <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{t("employer.noPayoutObligations")}</div>
              )}
              {employerPayoutItems.map((item) => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${BRAND.border}` }}>
                  <div>
                    <div style={{ fontSize: FS.meta, fontWeight: 600, color: BRAND.text }}>{toCurrency(item.amount)}</div>
                    <div style={{ fontSize: FS.meta, color: BRAND.textMuted }}>{item.scheduled_date ? new Date(item.scheduled_date).toLocaleDateString("en-MY") : t("employer.tbaShort")}</div>
                    {item.status === "held" && payoutHoldReasonLabel(t, item.error_message) && (
                      <div style={{ fontSize: FS.meta, color: BRAND.red, marginTop: 2 }}>{payoutHoldReasonLabel(t, item.error_message)}</div>
                    )}
                  </div>
                  <Pill label={payoutStatusLabel(t, item.status)} color={mapPayoutPillColor(item.status)} />
                </div>
              ))}
            </Card>
            {/* Same reopen hook as the worker-side Settings tab — reaches
                CookieConsentManager (mounted once at the app root) via a
                DOM event, since it isn't in this component's tree. */}
            <Card style={{ marginBottom: 16 }}>
              <button
                onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_PREFS_EVENT))}
                style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  border: "none", background: "none", cursor: "pointer",
                  fontFamily: "inherit", fontSize: FS.meta, color: BRAND.textMuted, textAlign: "left",
                }}
              >
                <span>{t("cookie.reopenPreferences")}</span>
                <span aria-hidden="true">›</span>
              </button>
            </Card>
          </div>
        )}

        {view === 'chat' && (
          // Same fix as the worker chat view: bound this wrapper to the
          // ancestor's actual box instead of guessing a vh-offset, so only
          // the message list scrolls instead of both it and the outer pane.
          <div style={activeChatShift ? {display:'flex', flexDirection:'column', height:'100%', minHeight:0} : {}}>
            <div style={{ ...(compact ? TYPE.titleMobile : TYPE.title), color: BRAND.text, marginBottom: 4, flexShrink:0 }}>{t("chat.title")}</div>
            <div style={{ fontSize: FS.body, color: BRAND.textMuted, marginBottom: 16, flexShrink:0 }}>{t("chat.employerSubtitle")}</div>
            {!activeChatShift ? (
              chatConversations.length === 0 ? (
                <div style={{textAlign:'center', color:BRAND.textMuted, marginTop:48}}>
                  <div aria-hidden="true" style={{ display: "flex", justifyContent: "center" }}><Icons.Chat size={34} /></div>
                  <div style={{marginTop:8}}>{t("chat.emptyTitleEmployer")}</div>
                  <div style={{fontSize:FS.meta, marginTop:4}}>{t("chat.emptyHintEmployer")}</div>
                </div>
              ) : (
                sortConversationsByRecent(chatConversations, roomPreviews).map(conv => (
                  <div key={conv.shiftId} onClick={() => setActiveChatShift(conv)}
                    style={{padding:14, background:BRAND.surface, borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`,
                      marginBottom:10, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
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
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:12}}>
                  <button onClick={() => { setActiveChatShift(null); setChatMessages([]); }}
                    style={{background:'none', border:'none', cursor:'pointer', fontSize:FS.lead, color:BRAND.primaryOnSurface}}>←</button>
                  <div style={{minWidth:0, flex:1}}>
                    <div style={{fontWeight:600, color:BRAND.text}}>{activeChatShift.title}</div>
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
                  {/* The conversation is about a specific shift, and half of
                      what gets asked in it ("what time again?", "where?") is
                      answered on that shift's page. Going there should not mean
                      backing out of the room and hunting for it. */}
                  <Btn size="xs" variant="secondary" onClick={() => { setOpenShiftId(activeChatShift.shiftId); setView("shifts"); }} style={{flexShrink:0}}>
                    {t("chat.viewShiftBtn")}
                  </Btn>
                </div>
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
                    const isMe = msg.sender_id === user?.id;
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
                <div style={{display:'flex', gap:8, paddingTop:8, borderTop:`1px solid ${BRAND.border}`}}>
                  <input
                    value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
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
      </div>

      {contractModal && (
        <div style={{position:'fixed', inset:0, background:BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div {...contractDialog} style={{background:BRAND.surfaceElevated, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'80vh', overflowY:'auto'}}>
            <h3 style={{fontSize:FS.lead, fontWeight:700, color:BRAND.text, marginBottom:4}}><InlineIcon icon={Icons.Doc} size={16} />{t("contract.employerTitle")}</h3>
            <p style={{fontSize:FS.meta, color:BRAND.textMuted, marginBottom:16}}>{t("contract.employerSubtitle")}</p>
            <div style={{background:BRAND.grayLight, borderRadius:RADIUS.control, padding:16, fontSize:FS.meta, lineHeight:1.8, color:BRAND.text, marginBottom:16}}>
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
            <p style={{fontSize:FS.meta, color:BRAND.textMuted, marginBottom:12}}>
              {t("contract.confirmSendNote").replace("{name}", contractModal.workerName)}
            </p>
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setContractModal(null)}
                style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, cursor:'pointer', color:BRAND.textMuted}}>
                {t("common.cancel")}
              </button>
              <button onClick={() => {
                toast(t('toast.contractSent'), 'success');
                setContractModal(null);
              }}
                style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background:BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {t("contract.confirmSendBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {disputeModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div {...disputeDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
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
              <button onClick={submitEmployerDispute} disabled={filingDispute || !disputeForm.description.trim()}
                style={{flex:2, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor: filingDispute || !disputeForm.description.trim() ? 'not-allowed' : 'pointer', fontWeight:600, opacity: filingDispute || !disputeForm.description.trim() ? 0.6 : 1}}>
                {filingDispute ? "…" : t("myBids.disputeSubmitBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {ratingModal && (() => {
        const aspects = RATING_ASPECTS[ratingModal.direction];
        const allSet = !aspects.some(a => !ratingForm[a.value]);
        const overall = allSet ? (aspects.reduce((sum, a) => sum + (ratingForm[a.value] || 0), 0) / aspects.length).toFixed(1) : null;
        return (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}}>
          <div {...ratingDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border: `1px solid ${BRAND.border}`}}>
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

      <RatingDetailsModal modal={ratingDetailsModal} onClose={() => setRatingDetailsModal(null)} />

      {viewContractModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setViewContractModal(null)}>
          <div {...viewContractDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:480, width:'100%', maxHeight:'85vh', overflowY:'auto', border:`1px solid ${BRAND.border}`}} onClick={e => e.stopPropagation()}>
            <h3 style={{fontSize:FS.lead, fontWeight:700, color: BRAND.text, marginBottom:4}}>{t("contract.agreementHeading")}</h3>
            <p style={{fontSize:FS.meta, color: BRAND.textMuted, marginBottom:16}}>{selectedShift?.title}</p>
            {(() => {
              const contractRows = buildContractRows(t, {
                contractRef: (viewContractModal.id || "").slice(0, 8).toUpperCase(),
                generatedAt: new Date().toISOString(),
                employerName: employerProfile?.full_name || t("contract.employerOnFile"),
                workerName: viewContractModal.name,
                shiftTitle: selectedShift?.title,
                shiftCategory: selectedShift?.category,
                shiftLocation: selectedShift?.location,
                scheduleText: selectedShift?.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift?.date,
                totalHours: totalOccurrenceHours(selectedShift?.occurrences),
                wageAsk: viewContractModal.wageBid,
                transportAllowance: selectedShift?.transportAllowance,
                dressCode: selectedShift?.dress,
                languages: (selectedShift?.languageRequirements || []).join(', '),
                description: selectedShift?.description,
                termClauses: [1, 2, 3, 4, 5].map(n => t(`contract.employerClause${n}`)),
                platformRoleClause: t("contract.employerClause6"),
                governingLawClause: t("contract.employerClause7"),
                employerSignedAt: viewContractModal.employerSignedAt,
                workerSignedAt: viewContractModal.workerSignedAt,
              });
              return (
            <div style={{background: BRAND.grayLight, borderRadius:RADIUS.control, padding:16, fontSize:FS.meta, lineHeight:1.8, color: BRAND.text, marginBottom:16}}>
              <p>{t("contract.enteredBetween")}</p>
              {renderContractRowsJSX(contractRows)}
            </div>
              );
            })()}
            {!viewContractModal.workerSignedAt && (
              <div style={{ padding:'8px 12px', background: BRAND.amberLight, borderRadius:RADIUS.control, fontSize:FS.meta, color: BRAND.onAmberLight, marginBottom:12 }}>{t("employer.contractAwaitingWorker")}</div>
            )}
            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setViewContractModal(null)}
                style={{flex:1, padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.text, fontWeight:600}}>
                {t("common.close")}
              </button>
              <button onClick={() => {
                const ok = openContractPrintWindow({
                  heading: t("contract.agreementHeading"),
                  subheading: selectedShift?.title || "",
                  rows: buildContractRows(t, {
                    contractRef: (viewContractModal.id || "").slice(0, 8).toUpperCase(),
                    generatedAt: new Date().toISOString(),
                    employerName: employerProfile?.full_name || t("contract.employerOnFile"),
                    workerName: viewContractModal.name,
                    shiftTitle: selectedShift?.title,
                    shiftCategory: selectedShift?.category,
                    shiftLocation: selectedShift?.location,
                    scheduleText: selectedShift?.isMultiDay ? formatOccurrencesSummary(selectedShift.occurrences) : selectedShift?.date,
                    totalHours: totalOccurrenceHours(selectedShift?.occurrences),
                    wageAsk: viewContractModal.wageBid,
                    transportAllowance: selectedShift?.transportAllowance,
                    dressCode: selectedShift?.dress,
                    languages: (selectedShift?.languageRequirements || []).join(', '),
                    description: selectedShift?.description,
                    termClauses: [1, 2, 3, 4, 5].map(n => t(`contract.employerClause${n}`)),
                    platformRoleClause: t("contract.employerClause6"),
                    governingLawClause: t("contract.employerClause7"),
                    employerSignedAt: viewContractModal.employerSignedAt,
                    workerSignedAt: viewContractModal.workerSignedAt,
                  }),
                });
                if (!ok) toast(t("toast.popupBlocked"), "error");
              }}
                style={{flex:1, padding:'10px', borderRadius:RADIUS.control, background: BRAND.primary, color:'#fff', border:'none', cursor:'pointer', fontWeight:600}}>
                {t("contract.printBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {checkinCodeModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setCheckinCodeModal(null)}>
          <div {...checkinCodeDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:360, width:'100%', maxHeight:'85vh', overflowY:'auto', textAlign:'center', border:`1px solid ${BRAND.border}`}} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: FS.card, fontWeight: 700, color: BRAND.text, marginBottom: 4 }}>{t("employer.checkinCodeTitle")}</div>
            <div style={{ fontSize: FS.meta, color: BRAND.textMuted, marginBottom: 20 }}>{checkinCodeModal.title}</div>
            <div style={{ fontSize: FS.display, fontWeight: 800, letterSpacing: 10, fontFamily: "monospace", color: BRAND.primary, marginBottom: 8 }}>
              {checkinCode ?? "······"}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 20 }}>
              <div style={{ position: "relative", width: 22, height: 22, flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 22 22" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="11" cy="11" r="9" fill="none" stroke={BRAND.border} strokeWidth="3" />
                  <circle cx="11" cy="11" r="9" fill="none" stroke={BRAND.primaryOnSurface} strokeWidth="3"
                    strokeDasharray={2 * Math.PI * 9}
                    strokeDashoffset={2 * Math.PI * 9 * (1 - checkinCodeSecondsLeft / 30)}
                    style={{ transition: "stroke-dashoffset 1s linear" }} />
                </svg>
              </div>
              <span style={{ fontSize: FS.meta, color: BRAND.textMuted, fontVariantNumeric: "tabular-nums" }}>
                {t("employer.checkinCodeRotateHint")} ({checkinCodeSecondsLeft}s)
              </span>
            </div>
            <button onClick={refreshCheckinCode}
              style={{width:'100%', padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: 'none', cursor:'pointer', color: BRAND.primaryOnSurface, fontWeight:600, marginBottom: 8}}>
              {t("employer.checkinCodeRefreshBtn")}
            </button>
            <button onClick={() => setCheckinCodeModal(null)}
              style={{width:'100%', padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.text, fontWeight:600}}>
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {workerProfileModal && (
        <div style={{position:'fixed', inset:0, background: BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setWorkerProfileModal(null)}>
          <div {...workerProfileDialog} style={{background: BRAND.surface, borderRadius:RADIUS.card, padding:24, maxWidth:440, width:'100%', maxHeight:'85vh', overflowY:'auto', border:`1px solid ${BRAND.border}`}} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <Avatar name={workerProfileModal.name} size={48} color={BRAND.blue} src={getAvatarUrl(workerProfileModal.avatarUrl)} />
              <div>
                <div style={{ fontSize:FS.card, fontWeight:800, color: BRAND.text }}>{workerProfileModal.name}</div>
                <Badge color={workerProfileModal.kyc === "Advanced" ? "teal" : workerProfileModal.kyc === "Standard" ? "blue" : "gray"} size="xs">KYC: {workerProfileModal.kyc}</Badge>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:16 }}>
              <Stat label={t("employer.colReliability")} value={workerProfileModal.reliability} color={BRAND.green} />
              <div onClick={() => openRatingDetails(workerProfileModal.workerId, 'employer_to_worker', workerProfileModal.name)} style={{ cursor: 'pointer' }}>
                <Stat label={t("employer.colRating")} value={workerProfileModal.rating ? workerProfileModal.rating.toFixed(1) : '—'} color={BRAND.accent} />
              </div>
              <Stat label={t("employer.colBidRate")} value={`RM${workerProfileModal.wageBid}`} color={BRAND.primaryOnSurface} />
            </div>
            <div style={{ background: BRAND.grayLight, borderRadius: RADIUS.control, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 4 }}>{t("sedcard.bioLabel")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5, marginBottom: 10, whiteSpace: "pre-wrap" }}>{workerProfileModal.bio || t("sedcard.notProvided")}</div>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 4 }}>{t("sedcard.languagesLabel")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.text, marginBottom: 10 }}>{(workerProfileModal.languagesSpoken || []).length > 0 ? workerProfileModal.languagesSpoken.join(', ') : t("sedcard.notProvided")}</div>
              <div style={{ fontSize: FS.meta, fontWeight: 700, color: BRAND.textMuted, marginBottom: 4 }}>{t("sedcard.qualificationsLabel")}</div>
              <div style={{ fontSize: FS.meta, color: BRAND.text }}>
                {[
                  ...(workerProfileModal.qualifications || []).map(v => t(SEDCARD_QUALIFICATIONS.find(q => q.value === v)?.labelKey ?? v)),
                  ...(workerProfileModal.qualificationsOther ? [workerProfileModal.qualificationsOther] : []),
                ].join(', ') || t("sedcard.notProvided")}
              </div>
            </div>
            <div style={{ fontSize:FS.meta, fontWeight:700, color: BRAND.text, marginBottom:8 }}>{t("employer.profileHistoryTitle")}</div>
            {workerHistory === null && <div style={{ fontSize:FS.meta, color: BRAND.textMuted }}>{t("chat.loading")}</div>}
            {workerHistory?.length === 0 && <div style={{ fontSize:FS.meta, color: BRAND.textMuted, marginBottom:8 }}>{t("employer.profileNoHistory")}</div>}
            {(workerHistory ?? []).map(h => (
              <div key={h.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:`1px solid ${BRAND.border}` }}>
                <div>
                  <div style={{ fontSize:FS.meta, fontWeight:600, color: BRAND.text }}>{displayProtectedText(h.shift?.title ?? 'Shift')}</div>
                  <div style={{ fontSize:FS.meta, color: BRAND.textMuted }}>{formatShiftDate(h.shift?.start_at)}</div>
                </div>
                <Pill label={h.shift?.status === 'completed' && h.status === 'accepted' ? t("employer.historyCompleted") : h.status} {...statusTone("application", h.shift?.status === 'completed' && h.status === 'accepted' ? "completed" : h.status, "employer")} />
              </div>
            ))}
            <div style={{ fontSize:FS.meta, color: BRAND.textMuted, marginTop:10, marginBottom:14 }}>{t("employer.profileHistoryScopeNote")}</div>
            <button onClick={() => setWorkerProfileModal(null)}
              style={{width:'100%', padding:'10px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background: BRAND.grayLight, cursor:'pointer', color: BRAND.text, fontWeight:600}}>
              {t("common.close")}
            </button>
          </div>
        </div>
      )}

      {noShowTarget && (
        <div style={{ position: "fixed", inset: 0, background: BRAND.overlay, zIndex: Z.modal, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setNoShowTarget(null)}>
          <div {...noShowDialog} style={{ background: BRAND.surface, borderRadius: RADIUS.card, padding: 22, maxWidth: 430, width: "100%", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: FS.card, fontWeight: 800, color: BRAND.red, margin: "0 0 8px" }}>{t("employer.noShowTitle")}</h3>
            <div style={{ fontSize: FS.meta, color: BRAND.text, lineHeight: 1.5, marginBottom: 12 }}>
              {t("employer.noShowBody", { name: noShowTarget.name })}
            </div>
            {/* Said out loud, because the employer is about to affect someone
                else's ability to get work, and because a mistaken report is
                worth pausing over. */}
            <div style={{ border: `1px solid ${BRAND.amber}`, background: BRAND.amberLight, borderRadius: RADIUS.control, padding: 12, marginBottom: 14, fontSize: FS.meta, color: BRAND.onAmberLight, lineHeight: 1.5 }}>
              {t("employer.noShowConsequence")}
            </div>
            <label style={{ display: "block", fontSize: FS.meta, fontWeight: 700, color: BRAND.text, marginBottom: 6 }}>{t("employer.noShowNoteLabel")}</label>
            <textarea
              value={noShowNote}
              onChange={(e) => setNoShowNote(e.target.value)}
              rows={3}
              placeholder={t("employer.noShowNotePlaceholder")}
              style={{ width: "100%", padding: 10, borderRadius: RADIUS.control, border: `1px solid ${BRAND.border}`, background: BRAND.bg, color: BRAND.text, fontFamily: "inherit", fontSize: FS.meta, resize: "vertical", marginBottom: 16 }}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setNoShowTarget(null)} style={{ flex: 1, justifyContent: "center" }}>{t("common.cancel")}</Btn>
              <Btn onClick={confirmNoShow} disabled={reportingNoShow} style={{ flex: 1, justifyContent: "center", background: BRAND.red, borderColor: BRAND.red }}>
                {reportingNoShow ? t("employer.noShowReporting") : t("employer.noShowConfirmBtn")}
              </Btn>
            </div>
          </div>
        </div>
      )}
      {cancelQuote && (() => {
        const rows = cancelQuote.rows;
        const owes = cancelQuote.total > 0;
        return (
        <div style={{position:'fixed', inset:0, background:BRAND.overlay, zIndex: Z.modal, display:'flex', alignItems:'center', justifyContent:'center', padding:16}} onClick={() => setCancelQuote(null)}>
          <div {...cancelQuoteDialog} style={{background:BRAND.surface, borderRadius:RADIUS.card, padding:22, maxWidth:560, width:'100%', maxHeight:'85vh', overflowY:'auto'}} onClick={e => e.stopPropagation()}>
            <h3 style={{fontSize:FS.lead, fontWeight:800, color:BRAND.text, margin:'0 0 4px'}}>{t("employer.cancelQuoteTitle")}</h3>
            <div style={{fontSize:FS.meta, color:BRAND.textMuted, marginBottom:16}}>{cancelQuote.title}</div>

            {cancelQuoteLoading || rows === null ? (
              <div style={{fontSize:FS.meta, color:BRAND.textMuted, padding:'20px 0'}}>{t("employer.cancelQuoteLoading")}</div>
            ) : rows.length === 0 ? (
              <div style={{fontSize:FS.meta, color:BRAND.text, lineHeight:1.6, marginBottom:16}}>
                {t("employer.cancelQuoteNoWorkers")}
              </div>
            ) : (
              <>
                {/* Itemised, because a single total invites the suspicion that
                    it was made up. Each row shows the arithmetic. */}
                <div style={{overflowX:'auto', border:`1px solid ${BRAND.border}`, borderRadius:RADIUS.control, marginBottom:12}}>
                  <table style={{width:'100%', minWidth:420, borderCollapse:'collapse', fontSize:FS.meta}}>
                    <thead>
                      <tr style={{background:BRAND.grayLight}}>
                        {[t("employer.colWorker"), t("employer.cancelQuoteRate"), t("employer.cancelQuoteHours"), t("employer.cancelQuoteShare"), t("employer.cancelQuoteAmount")].map(h => (
                          <th key={h} style={{padding:'9px 12px', textAlign:'left', fontWeight:700, color:BRAND.textMuted, borderBottom:`1px solid ${BRAND.border}`}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.application_id}>
                          <td style={{padding:'9px 12px', color:BRAND.text, borderBottom:`1px solid ${BRAND.border}`}}>{r.worker_name}</td>
                          <td style={{padding:'9px 12px', color:BRAND.textMuted, borderBottom:`1px solid ${BRAND.border}`}}>RM{Number(r.wage_ask).toFixed(2)}/h</td>
                          <td style={{padding:'9px 12px', color:BRAND.textMuted, borderBottom:`1px solid ${BRAND.border}`}}>{Number(r.contracted_hours)}h</td>
                          <td style={{padding:'9px 12px', color:BRAND.textMuted, borderBottom:`1px solid ${BRAND.border}`}}>{Math.round(Number(r.rate) * 100)}%</td>
                          <td style={{padding:'9px 12px', fontWeight:700, color:BRAND.text, borderBottom:`1px solid ${BRAND.border}`}}>RM{Number(r.amount).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10}}>
                  <span style={{fontSize:FS.meta, fontWeight:700, color:BRAND.text}}>{t("employer.cancelQuoteTotal")}</span>
                  <span style={{fontSize:FS.h3, fontWeight:800, color: owes ? BRAND.red : BRAND.text}}>RM{cancelQuote.total.toFixed(2)}</span>
                </div>

                {owes ? (
                  <div style={{border:`1px solid ${BRAND.amber}`, background:BRAND.amberLight, color:BRAND.onAmberLight, borderRadius:RADIUS.control, padding:12, marginBottom:14, fontSize:FS.meta, lineHeight:1.5}}>
                    {t("employer.cancelQuoteShowUpNote", { max: cancelQuote.maxTotal.toFixed(2) })}
                  </div>
                ) : (
                  /* RM0 is the truth today, not an error -- say why, so it does
                     not look like the figure failed to load. */
                  <div style={{border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, color:BRAND.text, borderRadius:RADIUS.control, padding:12, marginBottom:14, fontSize:FS.meta, lineHeight:1.5}}>
                    {t("employer.cancelQuoteNoCharge")}
                  </div>
                )}
              </>
            )}

            {/* An explicit agreement to the amount, not a generic "are you
                sure". Only required when there IS an amount. */}
            {owes && (
              <label style={{display:'flex', alignItems:'flex-start', gap:8, marginBottom:14, cursor:'pointer'}}>
                <input type="checkbox" checked={cancelAccepted} onChange={e => setCancelAccepted(e.target.checked)} style={{marginTop:2}} />
                <span style={{fontSize:FS.meta, color:BRAND.text, lineHeight:1.5}}>
                  {t("employer.cancelQuoteAccept", { total: cancelQuote.total.toFixed(2) })}
                </span>
              </label>
            )}

            <div style={{display:'flex', gap:8}}>
              <button onClick={() => setCancelQuote(null)}
                style={{flex:1, padding:'11px', borderRadius:RADIUS.control, border:`1px solid ${BRAND.border}`, background:BRAND.grayLight, cursor:'pointer', color:BRAND.text, fontFamily:'inherit', fontWeight:600}}>
                {t("employer.cancelQuoteKeep")}
              </button>
              <button
                onClick={() => { doCancelShift(cancelQuote.shiftId); setCancelQuote(null); }}
                disabled={cancellingShift || cancelQuoteLoading || rows === null || (owes && !cancelAccepted)}
                style={{flex:2, padding:'11px', borderRadius:RADIUS.control, background:(owes && !cancelAccepted) || cancelQuoteLoading || rows === null ? BRAND.textMuted : BRAND.red, color:'#fff', border:'none', cursor:(owes && !cancelAccepted) ? 'not-allowed' : 'pointer', fontWeight:700, fontFamily:'inherit'}}>
                {cancellingShift ? t("employer.cancellingShift") : t("employer.cancelQuoteConfirm")}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
};

const EMPLOYER_ROUTES = { dashboard: [], shifts: ["shifts"], postshift: ["post-shift"], bulkupload: ["bulk-upload"], chat: ["chat"], billing: ["billing"], account: ["account"] };

const parseEmployerRoute = (segs) => {
  const view = routeKeyFromSegment(EMPLOYER_ROUTES, segs[0]) ?? "dashboard";
  return {
    view,
    shiftId: view === "shifts" && segs[1] ? decodeSeg(segs[1]) : null,
    chatShiftId: view === "chat" && segs[1] ? decodeSeg(segs[1]) : null,
  };
};
const buildEmployerSegments = ({ view, shiftId, chatShiftId }) => {
  const base = EMPLOYER_ROUTES[view] ?? [view];
  if (view === "shifts" && shiftId) return [...base, encodeURIComponent(shiftId)];
  if (view === "chat" && chatShiftId) return [...base, encodeURIComponent(chatShiftId)];
  return base;
};

export default EmployerPortal;

// Round-trip check for the in-portal address tables in carigaji-app.jsx: every
// page of every portal must build to an address and parse back to the same
// page, in every language, plus legacy (no-language) and unknown paths.
// It slices the pure route helpers out of the source, so it needs no bundler:
//   node scripts/route-check.mjs
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../carigaji-app.jsx", import.meta.url), "utf8");
const between = (a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`markers not found: ${a} .. ${b}`);
  return src.slice(i, j);
};

const prelude =
  "const APP_BASE='/CariGaji';const SHIFT_PATH_SEG='shift';const LANG_CODES=['en','bm','ch'];const DEFAULT_LANG='en';\n" +
  between("const splitLangPath = (pathname", "const langFromPath") +
  between("const withLang = (lang, segments)", "const portalToPath") +
  between("const WORKER_ROUTES", "// History bookkeeping.");

const tests = `
let n = 0, failed = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { failed++; console.log("FAIL", m, JSON.stringify(a), "!=", JSON.stringify(b)); } else n++; };
const path = (lang, portal, segs) => withLang(lang, [portal === "worker" ? null : portal, ...segs]);
const back = (lang, portal, segs) => portalRouteSegments(path(lang, portal, segs), portal);
for (const lang of ["en", "bm", "ch"]) {
  for (const tab of Object.keys(WORKER_ROUTES)) eq(parseWorkerRoute(back(lang, "worker", buildWorkerSegments({ tab, profileTab: "profile" }))).tab, tab, "worker " + lang + " " + tab);
  eq(parseWorkerRoute(back(lang, "worker", buildWorkerSegments({ tab: "profile", profileTab: "account" }))).profileTab, "account", "profile/account");
  const app = parseWorkerRoute(back(lang, "worker", buildWorkerSegments({ tab: "applications", applicationId: "abc-123" })));
  eq([app.tab, app.applicationId], ["applications", "abc-123"], "my-bids/<id>");
  const chat = parseWorkerRoute(back(lang, "worker", buildWorkerSegments({ tab: "chat", chatShiftId: "s 1/x" })));
  eq([chat.tab, chat.chatShiftId], ["chat", "s 1/x"], "chat/<id> with awkward characters");
  const sh = parseWorkerRoute(back(lang, "worker", buildWorkerSegments({ tab: "discover", shiftId: "sh-9" })));
  eq([sh.tab, sh.shiftId], [null, "sh-9"], "shift/<id>");
  for (const view of Object.keys(EMPLOYER_ROUTES)) eq(parseEmployerRoute(back(lang, "employer", buildEmployerSegments({ view }))).view, view, "employer " + lang + " " + view);
  const es = parseEmployerRoute(back(lang, "employer", buildEmployerSegments({ view: "shifts", shiftId: "s-7" })));
  eq([es.view, es.shiftId], ["shifts", "s-7"], "employer shift");
  const ec = parseEmployerRoute(back(lang, "employer", buildEmployerSegments({ view: "chat", chatShiftId: "s-8" })));
  eq([ec.view, ec.chatShiftId], ["chat", "s-8"], "employer chat");
  for (const view of Object.keys(ADMIN_ROUTES)) eq(parseAdminRoute(back(lang, "admin", buildAdminSegments({ view }))).view, view, "admin " + lang + " " + view);
}
eq(parseWorkerRoute(portalRouteSegments("/CariGaji/my-bids", "worker")).tab, "applications", "legacy /my-bids (no language)");
eq(parseWorkerRoute(portalRouteSegments("/CariGaji/en/nonsense", "worker")).tab, "discover", "unknown path -> discover");
eq(parseEmployerRoute(portalRouteSegments("/CariGaji/employer/post-shift", "employer")).view, "postshift", "legacy employer/post-shift");
eq(parseAdminRoute(portalRouteSegments("/CariGaji/en/admin", "admin")).view, "overview", "admin root");
eq(path("en", "employer", buildEmployerSegments({ view: "dashboard" })), "/CariGaji/en/employer", "employer root path");
eq(path("bm", "admin", buildAdminSegments({ view: "kycqueue" })), "/CariGaji/bm/admin/kyc", "admin kyc path");
return { n, failed };
`;

const { n, failed } = new Function(prelude + "\n" + tests)();
if (failed) {
  console.error(`route-check: ${failed} failure(s), ${n} passed`);
  process.exit(1);
}
console.log(`route-check: all ${n} route round-trips passed`);

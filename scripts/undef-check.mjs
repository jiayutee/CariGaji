// Every identifier the app uses must be declared in its file, imported, or a known
// browser global. The app is split into a main file plus lazily loaded portal
// modules (src/portals/); a name that module forgot to import would otherwise
// fail only when a user opens that portal, as a ReferenceError at runtime.
//
//   node scripts/undef-check.mjs            (checks the main file and every portal)
//   node scripts/undef-check.mjs file...    (or specific files)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(root + "/");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const GLOBALS = new Set(("window document navigator console Math Date JSON Object Array Number String Boolean Set Map WeakMap Promise Symbol Error TypeError RegExp parseInt parseFloat isNaN isFinite NaN Infinity undefined setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame fetch URL URLSearchParams FormData File FileReader Blob Image Audio Intl localStorage sessionStorage location history encodeURIComponent decodeURIComponent encodeURI decodeURI atob btoa crypto performance alert confirm prompt Notification ServiceWorkerRegistration PushManager MutationObserver ResizeObserver IntersectionObserver AbortController Event CustomEvent KeyboardEvent PointerEvent MouseEvent HTMLElement Element Node getComputedStyle matchMedia screen innerWidth innerHeight queueMicrotask structuredClone TextEncoder TextDecoder Uint8Array ArrayBuffer Float64Array escape unescape globalThis arguments Reflect Proxy BigInt DOMParser XMLSerializer Headers Request Response WebSocket Worker BroadcastChannel IDBKeyRange indexedDB caches self top parent open close print scrollTo scroll scrollX scrollY pageYOffset pageXOffset visualViewport devicePixelRatio __BRAND_CONFIG__ import").split(" "));
let bad = 0;
const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  "carigaji-app.jsx",
  ...(existsSync(resolve(root, "src/portals")) ? readdirSync(resolve(root, "src/portals")).filter(f => f.endsWith(".jsx")).sort().map(f => `src/portals/${f}`) : []),
];
for (const f of files) {
  const ast = parser.parse(readFileSync(resolve(root, f), "utf8"), { sourceType: "module", plugins: ["jsx"] });
  const missing = new Map();
  traverse(ast, {
    ReferencedIdentifier(p) {
      if (p.isJSXIdentifier() && !/^[A-Z]/.test(p.node.name)) return;
      const n = p.node.name;
      if (p.scope.hasBinding(n) || GLOBALS.has(n)) return;
      (missing.get(n) ?? missing.set(n, []).get(n)).push(p.node.loc.start.line);
    },
  });
  if (missing.size) { bad++; console.log(`${f}: UNDEFINED -> ` + [...missing].map(([n, l]) => `${n} (line ${l[0]})`).join(", ")); }
  else console.log(`${f}: every identifier is declared, imported or a known global`);
}
process.exit(bad ? 1 : 0);

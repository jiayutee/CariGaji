// Rename rehearsal. The product name must live in brand.config.json and nowhere
// else, so a rename is a one-file change that cannot leave the old name behind
// in a page title, manifest, share text, legal copy or push notification.
//
//   node scripts/brand-check.mjs
//
// 1. Builds the app with a made-up name and fails if the CURRENT name (read from
//    brand.config.json, so this keeps working after a rename) survives anywhere
//    in the output.
// 2. Fails if the current name appears in non-comment source of the shipped
//    client files and the user-facing edge functions. An edge-function fallback
//    that must name the product is allowed only with a `brand-ok` annotation.
//    (telegram-webhook is owner-only operator tooling and is not scanned.)
// Case-sensitive on purpose: lowercase internal identifiers (storage keys, cache
// names) are invisible to users and crawlers and are not the display name.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const current = JSON.parse(readFileSync(join(root, "brand.config.json"), "utf8")).name;
const fake = current === "Zorbly" ? "Quillam" : "Zorbly";
let failed = 0;

// ---- 1. rename rehearsal build -------------------------------------------------
const out = mkdtempSync(join(tmpdir(), "brand-check-"));
try {
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
    cwd: root, stdio: "pipe",
    env: { ...process.env, BRAND_NAME: fake, BASE_PATH: "/", SITE_URL: "https://example.invalid", INDEXABLE: "true",
           VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "https://x.invalid", VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? "x" },
  });
} catch (e) {
  console.error("brand-check: the rehearsal build itself failed\n" + (e.stderr?.toString() || e.message));
  process.exit(1);
}
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const hits = [];
for (const file of walk(out)) {
  if (/\.(png|jpg|ico|woff2?)$/i.test(file)) continue;
  const text = readFileSync(file, "utf8");
  let i = -1;
  while ((i = text.indexOf(current, i + 1)) !== -1) hits.push(`${file.slice(out.length + 1)}: ...${text.slice(Math.max(0, i - 30), i + current.length + 30).replace(/\s+/g, " ")}...`);
}
rmSync(out, { recursive: true, force: true });
if (hits.length) { failed++; console.error(`FAIL: "${current}" survives a build renamed to "${fake}" (${hits.length}):\n  ` + hits.slice(0, 15).join("\n  ")); }
else console.log(`ok: a build renamed to "${fake}" contains no trace of "${current}"`);

// ---- 2. source guard (non-comment lines of shipped client files) ---------------
const files = ["index.html", "carigaji-app.jsx", "src/main.jsx", "public/service-worker.js",
  "supabase/functions/send-notification-email/index.ts", "supabase/functions/send-push/index.ts", "supabase/functions/support-chat/index.ts"];
const bad = [];
for (const f of files) {
  readFileSync(join(root, f), "utf8").split("\n").forEach((line, n) => {
    const t = line.trim();
    if (!line.includes(current)) return;
    if (line.includes("brand-ok")) return;   // a deliberate, annotated fallback (edge functions read BRAND_NAME from a secret)
    if (/^(\/\/|\*|\/\*|\{\/\*|<!--)/.test(t) || /\/\/.*$/.test(line) && line.indexOf("//") < line.indexOf(current)) return;
    bad.push(`${f}:${n + 1}: ${t.slice(0, 110)}`);
  });
}
if (bad.length) { failed++; console.error(`FAIL: "${current}" written in source outside comments (use SITE.name / {brand}):\n  ` + bad.join("\n  ")); }
else console.log(`ok: no non-comment source line writes "${current}"`);

process.exit(failed ? 1 : 0);

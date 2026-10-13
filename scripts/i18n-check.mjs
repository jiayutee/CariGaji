// The three UI languages must stay in step: every key present in all of them, and
// every {placeholder} in the English text present in the translation (a missing one
// renders a literal "{count}" or drops a value the sentence needs).
//
// English lives in carigaji-app.jsx (TRANSLATIONS.en); Malay and Chinese are
// loaded on demand from src/i18n/. Run:  node scripts/i18n-check.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(root + "/");
const parser = require("@babel/parser");

const mainSrc = readFileSync(resolve(root, "carigaji-app.jsx"), "utf8");
const ast = parser.parse(mainSrc, { sourceType: "module", plugins: ["jsx"] });
const decl = ast.program.body.find((s) => s.type === "VariableDeclaration" && s.declarations[0].id.name === "TRANSLATIONS");
if (!decl) { console.error("i18n-check: TRANSLATIONS not found in carigaji-app.jsx"); process.exit(1); }
const table = new Function("return " + mainSrc.slice(decl.declarations[0].init.start, decl.declarations[0].init.end))();
const loadFile = (code) => new Function(readFileSync(resolve(root, `src/i18n/${code}.js`), "utf8").replace(/^export default /m, "return "))();
const langs = { en: table.en, bm: loadFile("bm"), ch: loadFile("ch") };

// `s` and `plural` build English plurals ("1 report" / "2 reports"); Chinese has no
// plural form and Malay reduplicates, so a translation legitimately omits them.
// Every other placeholder carries a value the sentence needs and must be present.
const ENGLISH_GRAMMAR_ONLY = new Set(["s", "plural"]);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((n) => !ENGLISH_GRAMMAR_ONLY.has(n)).sort();
let problems = 0;
const report = (msg) => { problems++; if (problems <= 40) console.error("  " + msg); };

for (const code of ["bm", "ch"]) {
  const l = langs[code];
  for (const k of Object.keys(langs.en)) {
    if (!(k in l)) { report(`${code}: missing key ${k}`); continue; }
    const want = placeholders(langs.en[k]).join(","), got = placeholders(l[k]).join(",");
    if (want !== got) report(`${code}: ${k} has placeholders {${got}} but English has {${want}}`);
  }
  for (const k of Object.keys(l)) if (!(k in langs.en)) report(`${code}: key ${k} does not exist in English`);
}
if (problems) { console.error(`i18n-check: ${problems} problem(s)`); process.exit(1); }
console.log(`i18n-check: ${Object.keys(langs.en).length} keys present in en, bm and ch with matching placeholders`);

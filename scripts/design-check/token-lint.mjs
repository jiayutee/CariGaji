#!/usr/bin/env node
// Static half of the design check: reads the source and looks for the two
// mistakes that have actually shipped in this project, both of which are
// invariant violations rather than matters of taste.
//
//   1. A literal colour inside a style object. It cannot respond to the theme,
//      so it is a light-mode island in dark mode. The discover filter panel was
//      written entirely this way and rendered as white boxes on a dark page.
//
//   2. A FIXED-LIGHT surface paired with a THEME-AWARE colour. BRAND.amberLight
//      and friends are literal hex that stay light in both themes, while
//      BRAND.text / textMuted / amber / green flip or were chosen against white.
//      Pairing them gives low contrast in light mode and light-on-light in dark.
//      Each *Light surface has an on*Light partner meant for exactly this.
//
// Run:  node scripts/design-check/token-lint.mjs
// Exits 1 if anything is found, so it can gate a commit later if wanted.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'carigaji-app.jsx';
const src = readFileSync(FILE, 'utf8');

// Fixed-light surfaces and the text colour each one expects.
const FIXED_LIGHT = {
  amberLight: 'onAmberLight',
  redLight: 'onRedLight',
  greenLight: 'onGreenLight',
};
// Colours that must never sit on a fixed-light surface: either they flip with
// the theme, or they are a brand colour chosen against white.
const UNSAFE_ON_FIXED_LIGHT = /BRAND\.(text|textMuted|gray|amber|red|green|blue|primary|accent)\b/;

// Skip the BRAND table itself and the Pill component, whose literals ARE the
// palette definition rather than a use of it.
const skipRanges = [];
const brandStart = src.indexOf('const BRAND = {');
if (brandStart >= 0) skipRanges.push([brandStart, src.indexOf('\n};', brandStart)]);
const pillStart = src.indexOf('const Pill = memo(');
if (pillStart >= 0) skipRanges.push([pillStart, src.indexOf('));', pillStart)]);
const inSkip = (i) => skipRanges.some(([a, b]) => i >= a && i <= b);

const lineOf = (i) => src.slice(0, i).split('\n').length;

// Pull out every style={{ ... }} object, brace-matched so nested template
// literals like `1px solid ${BRAND.border}` do not truncate it.
const styleObjects = [];
const re = /style=\{\{/g;
let m;
while ((m = re.exec(src))) {
  let depth = 2, i = m.index + m[0].length;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  styleObjects.push({ start: m.index, text: src.slice(m.index, i) });
}

const findings = [];

for (const obj of styleObjects) {
  if (inSkip(obj.start)) continue;
  const line = lineOf(obj.start);

  // 1. literal colours.
  //
  // Two shapes are deliberately NOT flagged, because they are correct:
  //   - white or black text on a solid BRAND fill (a primary button's label).
  //     The fill is a fixed brand colour in both themes, so fixed text on it is
  //     right, and "fixing" it would break the button.
  //   - rgba() in boxShadow / gradients / overlays, which are effects rather
  //     than surface or text colours.
  const setsBrandFill = /background(?:Color|Image)?:\s*(?:BRAND\.(primary|primaryDark|green|red|amber|blue|accent|dark)\b|`?linear-gradient)/.test(obj.text);
  const isNeutralLiteral = (lit) => /^#(fff|ffffff|000|000000)$/i.test(lit)
    || /^rgba?\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)/.test(lit);
  const effectOnly = (lit) => {
    const at = obj.text.indexOf(lit);
    const before = obj.text.slice(Math.max(0, at - 90), at);
    return /(boxShadow|textShadow|filter|gradient|outline)[^,]*$/.test(before);
  };
  const hexes = obj.text.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rgbs = obj.text.match(/\brgba?\([^)]*\)/g) || [];
  for (const lit of [...hexes, ...rgbs]) {
    if (effectOnly(lit)) continue;
    if (isNeutralLiteral(lit) && setsBrandFill) continue;
    findings.push({
      rule: 'hardcoded-colour', line,
      detail: `${lit} — use a BRAND token so it follows the theme`,
    });
  }

  // 2. fixed-light surface with a colour that does not belong on it
  for (const [surface, partner] of Object.entries(FIXED_LIGHT)) {
    if (!new RegExp(`background(?:Color)?:\\s*BRAND\\.${surface}\\b`).test(obj.text)) continue;
    const colour = obj.text.match(new RegExp(`color:\\s*(${UNSAFE_ON_FIXED_LIGHT.source})`));
    if (colour) {
      findings.push({
        rule: 'fixed-light-mismatch', line,
        detail: `${colour[1]} on BRAND.${surface} — use BRAND.${partner}`,
      });
    } else if (!new RegExp(`color:\\s*BRAND\\.${partner}\\b`).test(obj.text) && !/color:/.test(obj.text)) {
      findings.push({
        rule: 'fixed-light-inherits', line,
        detail: `BRAND.${surface} with no colour set — inherited text flips, the surface does not; set BRAND.${partner}`,
      });
    }
  }
}

// ── baseline ────────────────────────────────────────────────────────────────
// This file carries a long tail of pre-existing literals. Reporting all of them
// every morning would train everyone to ignore the check, so the run compares
// against an accepted baseline and reports only what is NEW. Keys are hashed
// from the rule and the detail, not the line number, so unrelated edits above
// do not churn the whole file into "new" findings.
const BASELINE = 'scripts/design-check/baseline.json';
const keyOf = (f) => createHash('sha1').update(`${f.rule}::${f.detail}::${f.context}`).digest('hex').slice(0, 12);

for (const f of findings) {
  const at = src.split('\n')[f.line - 1] || '';
  f.context = at.trim().slice(0, 80);
  f.key = keyOf(f);
}

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Accepted pre-existing findings. Delete an entry once it is fixed; regenerate with --baseline after a deliberate sweep.',
    keys: [...new Set(findings.map(f => f.key))].sort(),
  }, null, 2) + '\n');
  console.log(`token-lint: baseline written with ${new Set(findings.map(f => f.key)).size} accepted finding(s)`);
  process.exit(0);
}

const accepted = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).keys) : new Set();
const fresh = findings.filter(f => !accepted.has(f.key));

const byRule = fresh.reduce((a, f) => ({ ...a, [f.rule]: (a[f.rule] || 0) + 1 }), {});
if (!fresh.length) {
  console.log(`token-lint: no new findings (${findings.length} total, ${accepted.size} accepted in baseline, ${styleObjects.length} style objects checked)`);
  process.exit(0);
}
console.log(`token-lint: ${fresh.length} NEW finding(s) — ${JSON.stringify(byRule)}\n`);
for (const f of fresh.sort((a, b) => a.line - b.line)) {
  console.log(`  ${FILE}:${f.line}  [${f.rule}]  ${f.detail}`);
}
console.log(`\n(${accepted.size} pre-existing finding(s) suppressed by ${BASELINE})`);
process.exit(1);

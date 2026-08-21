// Runtime half of the design check. Paste into the browser pane's
// javascript_tool on each screen under test, in BOTH themes.
//
// Static analysis cannot see this: a token is only correct or incorrect once
// it has been resolved against whatever surface it actually landed on, which
// depends on the nesting at runtime. This walks the rendered DOM, resolves the
// real background behind every piece of text, and measures WCAG contrast.
//
// Returns { theme, checked, fails: [...] }. A fail is text below its AA
// threshold -- 3.0 for genuinely large text (>=24px, or >=18.66px bold),
// 4.5 for everything else.
(() => {
  const lum = (c) => {
    const m = c.match(/\d+(\.\d+)?/g);
    if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    if (a === null || b === null) return null;
    return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
  };
  const parse = (c) => {
    const m = (c || '').match(/[\d.]+/g);
    if (!m) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
  };
  // The colour actually behind this text. Semi-transparent layers must be
  // COMPOSITED, not treated as opaque: a chip with rgba(37,99,235,0.1) over a
  // dark card is a faint blue tint, but reading it as solid #2563EB makes blue
  // text on it measure 1.0:1 and the scanner cries wolf. Collect every layer up
  // to the first opaque one, then fold them back down.
  const backdrop = (el) => {
    const layers = [];
    let n = el;
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a === 1) break;
      }
      n = n.parentElement;
    }
    const base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length || layers[layers.length - 1].a < 1) layers.push({ ...base, a: 1 });
    let out = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) {
      const t = layers[i];
      out = {
        r: t.r * t.a + out.r * (1 - t.a),
        g: t.g * t.a + out.g * (1 - t.a),
        b: t.b * t.a + out.b * (1 - t.a),
        a: 1,
      };
    }
    return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
  };
  // A gradient or image behind the text cannot be reduced to one colour, so it
  // is reported rather than scored -- a made-up number is worse than none.
  const hasImageBackdrop = (el) => {
    let n = el;
    while (n) {
      if (getComputedStyle(n).backgroundImage !== 'none') return true;
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a === 1) return false;
      n = n.parentElement;
    }
    return false;
  };

  const fails = [];
  let checked = 0;
  let skippedGradient = 0;
  let skippedEmoji = 0;
  document.querySelectorAll('*').forEach((el) => {
    // Leaf text only: a parent's colour is not what the eye reads.
    if (el.children.length) return;
    const text = (el.textContent || '').trim();
    if (!text) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    // A run with no letters or digits is a glyph, not text: a ✓ bullet, an
    // emoji, a chevron. WCAG 1.4.3 governs text; non-text content falls under
    // 1.4.11 at 3:1, and an emoji carries its own colours so a ratio against
    // its background means nothing at all. Scored at 3.0 and counted
    // separately, so real prose failures are never buried under ✓ and 🍪.
    const isGlyph = !/[\p{L}\p{N}]/u.test(text);
    const isEmoji = /\p{Extended_Pictographic}/u.test(text);
    // WCAG "large" is 24px, or 18.66px when bold. 15px bold is NOT large --
    // that exact misreading is why the wage figure sat at 3.43 for months.
    const threshold = isGlyph ? 3.0 : (size >= 24 || (bold && size >= 18.66) ? 3.0 : 4.5);

    if (hasImageBackdrop(el)) { skippedGradient++; return; }
    if (isEmoji) { skippedEmoji++; return; }
    const r = ratio(cs.color, backdrop(el));
    if (r === null) return;
    checked++;
    if (r < threshold) {
      fails.push({ text: text.slice(0, 44), kind: isGlyph ? 'glyph' : 'text', ratio: r, needs: threshold, size: cs.fontSize, weight: cs.fontWeight, fg: cs.color, bg: backdrop(el) });
    }
  });

  return JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    url: location.pathname + location.hash,
    checked,
    skippedGradient,
    skippedEmoji,
    failCount: fails.length,
    textFailCount: fails.filter((f) => f.kind === 'text').length,
    fails: fails.sort((a, b) => a.ratio - b.ratio).slice(0, 15),
  }, null, 1);
})()

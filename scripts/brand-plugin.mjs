// The ONE place the product name and site address are read. Everything that
// ships to a browser or a crawler (page head, manifest, robots.txt, sitemap,
// and the app's own strings through a build-time constant) derives from here, so
// renaming the product is brand.config.json (or BRAND_NAME / SITE_URL in the
// build environment) and nothing else.
//
// Search safety: nothing is indexable until a real site address is set AND the
// build says so. A build for a temporary host (github.io, pages.dev) therefore
// publishes `noindex` and `Disallow: /`, so no ranking builds up somewhere the
// product will leave. Production sets SITE_URL=https://<domain> INDEXABLE=true.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LANGS = [
  { code: "en", hreflang: "en" },
  { code: "bm", hreflang: "ms" },
  { code: "ch", hreflang: "zh-Hans" },
];

// Pages that are private or per-user: never offered to a search engine, even on
// an indexable build. The app also marks these noindex at runtime.
export const PRIVATE_PREFIXES = ["my-shifts", "chat", "earnings", "profile", "employer", "admin"];

export const loadBrand = (root = process.cwd()) => {
  const file = JSON.parse(readFileSync(resolve(root, "brand.config.json"), "utf8"));
  const name = (process.env.BRAND_NAME || file.name).trim();
  const siteUrl = (process.env.SITE_URL ?? file.siteUrl ?? "").trim().replace(/\/+$/, "");
  return {
    ...file,
    name,
    shortName: (process.env.BRAND_SHORT_NAME || (process.env.BRAND_NAME ? name : file.shortName) || name).trim(),
    legalName: (process.env.BRAND_LEGAL_NAME || (process.env.BRAND_NAME ? name : file.legalName) || name).trim(),
    siteUrl,
    indexable: process.env.INDEXABLE === "true" && Boolean(siteUrl),
  };
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const buildHead = (brand, base) => {
  const title = `Part-Time & Short Shift Jobs in Malaysia | ${brand.name}`;
  const lines = [
    `<meta name="description" content="${esc(brand.descriptionEn)}" />`,
    `<meta name="robots" content="${brand.indexable ? "index, follow, max-image-preview:large" : "noindex, nofollow"}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(brand.name)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(brand.descriptionEn)}" />`,
    `<meta property="og:locale" content="en_MY" />`,
    `<meta name="twitter:card" content="${brand.siteUrl ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(brand.descriptionEn)}" />`,
  ];
  if (brand.siteUrl) {
    // Absolute URL on purpose: social crawlers do not resolve relative ones. The
    // image carries no product name, so a rename never makes it stale.
    const img = `${brand.siteUrl}${base === "/" ? "" : base.replace(/\/$/, "")}/og-image.png`;
    lines.push(`<meta property="og:image" content="${img}" />`, `<meta property="og:image:width" content="1200" />`, `<meta property="og:image:height" content="630" />`, `<meta name="twitter:image" content="${img}" />`);
  }
  if (brand.indexable) {
    const url = (code) => `${brand.siteUrl}${base === "/" ? "" : base.replace(/\/$/, "")}/${code}`;
    lines.push(`<link rel="canonical" href="${url("en")}" />`);
    lines.push(`<meta property="og:url" content="${url("en")}" />`);
    for (const l of LANGS) lines.push(`<link rel="alternate" hreflang="${l.hreflang}" href="${url(l.code)}" />`);
    lines.push(`<link rel="alternate" hreflang="x-default" href="${url("en")}" />`);
    // Entity markup. alternateName carries former names so a rename stays
    // connected to the old one in search.
    const org = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: brand.name, url: `${brand.siteUrl}${base === "/" ? "/" : base}`, inLanguage: ["en", "ms", "zh-Hans"],
          ...(brand.alternateNames?.length ? { alternateName: brand.alternateNames } : {}) },
        { "@type": "Organization", name: brand.name, legalName: brand.legalName, url: `${brand.siteUrl}${base === "/" ? "/" : base}`,
          ...(brand.alternateNames?.length ? { alternateName: brand.alternateNames } : {}),
          ...(brand.supportEmail ? { contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: brand.supportEmail }] } : {}) },
      ],
    };
    lines.push(`<script type="application/ld+json">${JSON.stringify(org).replace(/</g, "\\u003c")}</script>`);
  }
  return { title, tags: lines.map((l) => `    ${l}`).join("\n") };
};

export const robotsTxt = (brand, base) => {
  if (!brand.indexable) return "# Not indexable: this build is for a temporary or private host.\nUser-agent: *\nDisallow: /\n";
  const p = base === "/" ? "" : base.replace(/\/$/, "");
  const rules = LANGS.flatMap((l) => PRIVATE_PREFIXES.map((x) => `Disallow: ${p}/${l.code}/${x}`));
  return ["User-agent: *", "Allow: /", ...rules, `Sitemap: ${brand.siteUrl}${p}/sitemap.xml`, ""].join("\n");
};

export const sitemapXml = (brand, base) => {
  if (!brand.indexable) return null;
  const p = base === "/" ? "" : base.replace(/\/$/, "");
  const loc = (c) => `${brand.siteUrl}${p}/${c}`;
  const alts = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${loc(l.code)}"/>`).concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${loc("en")}"/>`).join("\n");
  const urls = LANGS.map((l) => `  <url>\n    <loc>${loc(l.code)}</loc>\n${alts}\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
};

export const manifestJson = (brand) => JSON.stringify({
  name: brand.name,
  short_name: brand.shortName,
  description: brand.descriptionManifest,
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#F5F7FB",
  theme_color: brand.themeColor,
  orientation: "portrait",
  icons: [
    { src: "./icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "./icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "./icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}, null, 2) + "\n";

export const brandPlugin = () => {
  let base = "/";
  let brand;
  return {
    name: "carigaji-brand",
    config(_, { command }) {
      brand = loadBrand();
      return { define: { __BRAND_CONFIG__: JSON.stringify({ name: brand.name, shortName: brand.shortName, legalName: brand.legalName, supportEmail: brand.supportEmail, siteUrl: brand.siteUrl, indexable: brand.indexable, alternateNames: brand.alternateNames ?? [] }) } };
    },
    configResolved(cfg) { base = cfg.base || "/"; },
    transformIndexHtml(html) {
      const head = buildHead(brand, base);
      return html
        .replace(/%BRAND_NAME%/g, esc(brand.name))
        .replace(/%BRAND_SHORT_NAME%/g, esc(brand.shortName))
        .replace(/%BRAND_THEME_COLOR%/g, esc(brand.themeColor))
        .replace(/%BRAND_TITLE%/g, esc(head.title))
        .replace("<!--BRAND_HEAD-->", head.tags);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.json", source: manifestJson(brand) });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(brand, base) });
      const sm = sitemapXml(brand, base);
      if (sm) this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sm });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0].replace(base === "/" ? /^\// : new RegExp(`^${base}`), "/");
        if (url === "/manifest.json") { res.setHeader("Content-Type", "application/manifest+json"); res.end(manifestJson(brand)); return; }
        if (url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); res.end(robotsTxt(brand, base)); return; }
        next();
      });
    },
  };
};

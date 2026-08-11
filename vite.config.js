import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// GitHub Pages serves static files only -- it has no rewrite rule, so a deep
// link like /CariGaji/employer has no file behind it and Pages answers with
// its 404 handler. Shipping dist/index.html *as* 404.html means that handler
// serves the app itself: the SPA boots, window.location.pathname is still
// "/CariGaji/employer", and portalFromPath() routes it correctly.
//
// It has to be a post-build copy rather than a public/404.html, because
// public/ files are passed through verbatim -- they'd never get the hashed
// <script src="/CariGaji/assets/index-abc123.js"> that Vite injects into
// index.html at build time, so a static copy would break on the next build.
// Assets resolve fine from any URL depth because base is absolute.
const spaFallback404 = () => ({
  name: "carigaji-spa-fallback-404",
  apply: "build",
  closeBundle() {
    const dir = resolve(process.cwd(), "dist");
    const index = resolve(dir, "index.html");
    if (!existsSync(index)) return;
    copyFileSync(index, resolve(dir, "404.html"));
  },
});

export default defineConfig({
  base: "/CariGaji/",
  plugins: [react(), spaFallback404()],
  server: {
    port: Number(process.env.PORT) || 5173,
  },
});
import React from "react";
import ReactDOM from "react-dom/client";
import { applyThemeToDocument, buildThemeVars, getSystemTheme, readThemePreference, resolveThemeMode } from "./lib/theme.js";

const rootElement = document.getElementById("root");
const root = ReactDOM.createRoot(rootElement);
const themePreference = readThemePreference();
const resolvedTheme = resolveThemeMode(themePreference, getSystemTheme());
const themeVars = buildThemeVars(resolvedTheme);

applyThemeToDocument(resolvedTheme);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/CariGaji/service-worker.js", { scope: "/CariGaji/" }).catch((error) => {
      console.error("Service worker registration failed", error);
    });
  });
}

const renderConfigError = (message) => {
  root.render(
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      ...themeVars,
      background: themeVars["--cg-page"],
      color: themeVars["--cg-text"],
    }}>
      <div style={{ maxWidth: 520, background: themeVars["--cg-surface"], border: `1px solid ${themeVars["--cg-border"]}`, borderRadius: 16, padding: 24, boxShadow: `0 12px 40px ${themeVars["--cg-shadow"]}` }}>
        <h1 style={{ margin: "0 0 12px", fontSize: 24, lineHeight: 1.2 }}>CariGaji is not configured</h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: themeVars["--cg-text-muted"] }}>{message}</p>
      </div>
    </div>
  );
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  renderConfigError("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the build environment, then redeploy.");
} else {
  import("../carigaji-app.jsx")
    .then(({ default: CariGaji }) => {
      root.render(
        <React.StrictMode>
          <CariGaji />
        </React.StrictMode>
      );
    })
    .catch((error) => {
      console.error("Failed to load CariGaji app", error);
      renderConfigError("The app failed to load. Check the browser console for details.");
    });
}

const THEME_STORAGE_KEY = "carigaji-theme";

const THEME_PALETTES = {
  light: {
    page: "#F5F7FB",
    surface: "#FFFFFF",
    surfaceMuted: "#F9FAFB",
    surfaceElevated: "#FFFFFF",
    panel: "rgba(255,255,255,0.92)",
    input: "#FFFFFF",
    border: "#E5E7EB",
    text: "#111827",
    textMuted: "#6B7280",
    shadow: "rgba(15,23,42,0.08)",
    overlay: "rgba(17,24,39,0.58)",
  },
  dark: {
    page: "#0B1120",
    surface: "#111827",
    surfaceMuted: "#0F172A",
    surfaceElevated: "#172033",
    panel: "rgba(15,23,42,0.88)",
    input: "#0F172A",
    border: "#243044",
    text: "#E5E7EB",
    textMuted: "#94A3B8",
    shadow: "rgba(0,0,0,0.35)",
    overlay: "rgba(2,6,23,0.72)",
  },
};

export const getSystemTheme = () => {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const readThemePreference = () => {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
};

export const writeThemePreference = (themePreference) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
};

export const resolveThemeMode = (themePreference, systemTheme = getSystemTheme()) => {
  return themePreference === "system" ? systemTheme : themePreference;
};

export const cycleThemePreference = (currentPreference) => {
  if (currentPreference === "system") return "light";
  if (currentPreference === "light") return "dark";
  return "system";
};

export const buildThemeVars = (resolvedTheme) => {
  const palette = THEME_PALETTES[resolvedTheme] || THEME_PALETTES.light;
  return {
    "--cg-page": palette.page,
    "--cg-surface": palette.surface,
    "--cg-surface-muted": palette.surfaceMuted,
    "--cg-surface-elevated": palette.surfaceElevated,
    "--cg-panel": palette.panel,
    "--cg-input": palette.input,
    "--cg-border": palette.border,
    "--cg-text": palette.text,
    "--cg-text-muted": palette.textMuted,
    "--cg-shadow": palette.shadow,
    "--cg-overlay": palette.overlay,
    colorScheme: resolvedTheme,
  };
};

export const applyThemeToDocument = (resolvedTheme) => {
  if (typeof document === "undefined") return;
  const palette = THEME_PALETTES[resolvedTheme] || THEME_PALETTES.light;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  document.documentElement.style.background = palette.page;
  if (document.body) {
    document.body.style.background = palette.page;
    document.body.style.color = palette.text;
  }
};
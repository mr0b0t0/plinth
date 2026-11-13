// Theme: follows the system until the user picks one; the choice persists in localStorage.
// public/theme.js applies it before first paint (keep the key and values in step with it).
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export const THEME_STORAGE_KEY = "plinth-theme";
/** Display names of the two modes. */
export const THEME_NAMES: Record<Theme, string> = { light: "Gallery", dark: "After hours" };

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function systemTheme(): Theme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function getTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function getThemePreference(): ThemePreference {
  return stored() ?? "system";
}

/** Pick a mode and remember it. */
export function setTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  notify();
}

/** Pick a mode, or go back to following the system setting. */
export function setThemePreference(p: ThemePreference): void {
  if (p !== "system") {
    setTheme(p);
    return;
  }
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // ignore
  }
  document.documentElement.setAttribute("data-theme", systemTheme());
  notify();
}

// While following the system, track changes to it.
let watching = false;
function watchSystem(): void {
  if (watching || typeof window === "undefined" || !window.matchMedia) return;
  watching = true;
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (stored()) return;
      document.documentElement.setAttribute("data-theme", systemTheme());
      notify();
    });
  } catch {
    // old browsers: the theme updates on next load
  }
}

function subscribe(l: () => void) {
  watchSystem();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light" as Theme);
  return [theme, setTheme];
}

export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(
    subscribe,
    getThemePreference,
    () => "system" as ThemePreference,
  );
  return [pref, setThemePreference];
}

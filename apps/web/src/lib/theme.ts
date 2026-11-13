// Theme: follows the system until the user picks one; the choice persists in localStorage.
// public/theme.js applies it before first paint.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "plinth-theme";
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getTheme,
    getTheme,
  );
  return [theme, setTheme];
}

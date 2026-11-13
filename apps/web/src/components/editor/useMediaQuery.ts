import { useSyncExternalStore } from "react";

/** Narrowest viewport the editor works at; below it the page says so instead. */
export const EDITOR_MIN_WIDTH = 900;
export const EDITOR_WIDE_QUERY = `(min-width: ${EDITOR_MIN_WIDTH}px)`;

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return true;
  }
}

/** Whether a media query matches, updating when it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      let mql: MediaQueryList;
      try {
        mql = window.matchMedia(query);
      } catch {
        return () => {};
      }
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => matches(query),
    () => true,
  );
}

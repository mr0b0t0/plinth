// Navigation helpers for the account pages: the `?next=` return path and the sign-in redirect.
import { APP_ROUTES } from "@plinth/shared";

/**
 * A `?next=` value we may navigate to after signing in: a same-origin path that starts with one
 * "/" (not "//" or "/\", which browsers read as another host), with no control characters or
 * backslashes. Anything else falls back to the dashboard.
 */
export function safeNext(
  raw: string | null | undefined,
  fallback: string = APP_ROUTES.dashboard,
): string {
  if (!raw || raw.length > 2000) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "\\") return fallback;
  }
  try {
    const base = "http://plinth.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    // Never bounce back into the sign-in pages themselves.
    if (u.pathname === APP_ROUTES.login || u.pathname.startsWith(`${APP_ROUTES.login}/`)) {
      return fallback;
    }
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** The sign-in page, returning to `next` (a path on this app) afterwards. */
export function loginHref(next?: string): string {
  if (!next || next === APP_ROUTES.home) return APP_ROUTES.login;
  return `${APP_ROUTES.login}?next=${encodeURIComponent(next)}`;
}

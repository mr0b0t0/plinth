// Small hooks shared by the account pages.
import { API, APP_ROUTES } from "@plinth/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { navigate, Redirect, useLocation } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import { clearRescueStores } from "../editor/draft.ts";
import { loginHref } from "./nav.ts";

/** Sets document.title to "<title> · Plinth" (or "Plinth"). */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Plinth` : "Plinth";
  }, [title]);
}

/** AppShell's sign-out: end the session, drop the cached user, then go to the sign-in page. */
export function useSignOut(): () => Promise<void> {
  const { refresh } = useSession();
  return useCallback(async () => {
    try {
      await api(API.logout, { method: "POST" });
      // Signed out here on purpose: page edits kept to rescue in this tab go with the session.
      clearRescueStores();
    } catch (e) {
      // The session may already be gone (then what was kept goes too); carry on to the sign-in
      // page either way.
      if (e instanceof ApiRequestError && e.status === 401) clearRescueStores();
    }
    try {
      await refresh();
    } catch {
      // ignore: the sign-in page loads the session again
    }
    navigate(APP_ROUTES.login);
  }, [refresh]);
}

/** A value that follows `value` once it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Signed-in pages: while the session loads, `pending`; with no user, a redirect element to the
 * sign-in page that returns here afterwards; otherwise null.
 */
export function useSignInRedirect(): { pending: boolean; redirect: ReactNode } {
  const { loading, me } = useSession();
  const { href } = useLocation();
  if (loading) return { pending: true, redirect: null };
  if (!me) return { pending: true, redirect: <Redirect to={loginHref(href)} /> };
  return { pending: false, redirect: null };
}

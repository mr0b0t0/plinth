// A small history-API router: path patterns with :params, <Link>, navigate(). Enough for this app
// without a router dependency.
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(l: Listener) {
  listeners.add(l);
  window.addEventListener("popstate", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("popstate", l);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const l of listeners) l();
  window.scrollTo(0, 0);
}

/** Current pathname + search, re-rendering on navigation. */
export function useLocation(): { pathname: string; search: URLSearchParams; href: string } {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.searchParams, href };
}

/** Match "/a/:slug/v/:n" against a pathname. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp(
    `^${pattern.replace(/\/:([a-z_]+)/g, (_, n: string) => {
      names.push(n);
      return "/([^/]+)";
    })}/?$`,
  );
  const m = re.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((n, i) => {
    params[n] = decodeURIComponent(m[i + 1] ?? "");
  });
  return params;
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
}

export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    if (rest.target && rest.target !== "_self") return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return <a href={to} onClick={handle} {...rest} />;
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

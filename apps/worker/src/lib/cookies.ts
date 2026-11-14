// Cookie helpers. App cookies are host-only (no Domain attribute) on APP_HOST, with the `__Host-`
// prefix whenever they are Secure; content cookies are host-only on one artifact's subdomain.
// Nothing ever sets a Domain attribute.
import { COOKIES, HOST_COOKIE_PREFIX } from "@plinth/shared";

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitioned?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const path = o.path ?? "/";
  // A browser silently drops a __Host- cookie that is not Secure or not on Path=/.
  if (name.startsWith(HOST_COOKIE_PREFIX) && (!o.secure || path !== "/")) {
    throw new Error(`${HOST_COOKIE_PREFIX} cookies must be Secure with Path=/`);
  }
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  if (o.httpOnly !== false) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  parts.push(`SameSite=${o.sameSite ?? "Lax"}`);
  if (o.partitioned) parts.push("Partitioned");
  return parts.join("; ");
}

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

/** Secure is always on, except plain-http local development on a non-localhost name. */
export function secureFlag(scheme: "http" | "https", host: string): boolean {
  const hostname = host.replace(/:\d+$/, "");
  return scheme === "https" || hostname === "localhost" || hostname.endsWith(".localhost");
}

export type AppCookie = "session" | "csrf" | "viewer" | "passwordPassPrefix";

/**
 * The name of an app cookie on this instance. `__Host-` prefixed whenever app cookies are Secure
 * (https, and localhost): then no other host, a sibling subdomain on a shared parent domain
 * included, can set or overwrite it. A plain-http instance on another name cannot set Secure
 * cookies, so there the prefix is dropped.
 */
export function appCookieName(
  config: { scheme: "http" | "https"; appHost: string },
  cookie: AppCookie,
): string {
  const name = COOKIES[cookie];
  if (secureFlag(config.scheme, config.appHost)) return name;
  return name.startsWith(HOST_COOKIE_PREFIX) ? name.slice(HOST_COOKIE_PREFIX.length) : name;
}

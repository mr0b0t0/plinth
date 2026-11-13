// Cookie helpers. App cookies are host-only (no Domain attribute) on APP_HOST; content cookies are
// host-only on one artifact's subdomain. Nothing ever sets a Domain attribute.

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitioned?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${o.path ?? "/"}`];
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

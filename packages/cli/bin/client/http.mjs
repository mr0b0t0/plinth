// Requests to a Plinth instance from the client commands: an explicit User-Agent, no redirects
// (a token is only ever sent where it was meant to go), Plinth's error envelope turned into
// ApiError, and the Cloudflare edge block (error code: 1010) recognised before it reads as a
// Plinth error.

export const EXIT = { ok: 0, error: 1, usage: 2, conflict: 3 };

/** A failure the CLI reports as one message and an exit code. */
export class CliError extends Error {
  constructor(message, exitCode = EXIT.error) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * A request that got no usable answer: the connection dropped, or a proxy answered in place of
 * Plinth. It may still have been applied, so the caller checks before it reports a failure.
 */
export class LostResponse extends CliError {}

/** Plinth's `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
}

export const EDGE_DOC = "docs/deploy-checklist.md#edge-security-for-api-clients";

/**
 * The message for a response Cloudflare's edge answered before Plinth ran: a text/plain 403 or 503
 * whose body starts with "error code: 10". Null for anything else.
 */
export function edgeBlockMessage(status, contentType, body) {
  if (status !== 403 && status !== 503) return null;
  if (!/^text\/plain\b/i.test(contentType ?? "")) return null;
  const m = /^error code: (10\d\d)\b/.exec(String(body).trimStart());
  if (!m) return null;
  const what = m[1] === "1010" ? "Browser Integrity Check" : `error code: ${m[1]}`;
  return `Blocked by the Cloudflare edge before Plinth (${what}). The operator should apply ${EDGE_DOC}`;
}

/** A fetch that throws CliError for the edge block and for network failures. */
export function guardedFetch(fetchFn = globalThis.fetch) {
  return async (url, init = {}) => {
    let res;
    try {
      res = await fetchFn(url, { ...init, redirect: "error" });
    } catch (e) {
      throw networkError(url, e);
    }
    if (
      (res.status === 403 || res.status === 503) &&
      !res.headers.get("content-type")?.includes("json")
    ) {
      const body = await res.clone().text();
      const blocked = edgeBlockMessage(res.status, res.headers.get("content-type"), body);
      if (blocked) throw new CliError(blocked);
    }
    return res;
  };
}

function networkError(url, e) {
  const origin = safeOrigin(url);
  const cause = e?.cause?.message ?? e?.message ?? String(e);
  if (/redirect/i.test(cause)) {
    return new CliError(`${origin} answered with a redirect; plinth does not follow redirects`);
  }
  return new LostResponse(`Could not reach ${origin}: ${cause}`);
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url);
  }
}

/** Text another server wrote, safe to print: control characters become spaces. */
export function printable(text) {
  let out = "";
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0) ? " " : ch;
  }
  return out;
}

/** Parse a response: JSON on success, ApiError on Plinth's error envelope, CliError otherwise. */
export async function readJson(res, what) {
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new LostResponse(
      `${what}: the connection broke while the answer arrived (${e?.message ?? e})`,
    );
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (res.ok) {
    if (body === null)
      throw new LostResponse(`${what}: the answer was not JSON (HTTP ${res.status})`);
    return body;
  }
  const err = body?.error;
  if (err && typeof err.code === "string") {
    throw new ApiError(res.status, err.code, String(err.message ?? err.code), err.details);
  }
  const snippet = printable(text.slice(0, 200));
  const message = `${what}: HTTP ${res.status}${snippet ? ` ${snippet}` : ""}`;
  // A 5xx that is not Plinth's own (a proxy timeout, a 502 or 524 from the edge) says nothing
  // about whether Plinth applied the request.
  throw res.status >= 500 ? new LostResponse(message) : new CliError(message);
}

/**
 * A client for one origin. `auth` is { token(): Promise<string|null>, refresh(): Promise<string|null>,
 * signedOut?(): Error } or null for anonymous calls. A 401 refreshes once (OAuth sign-ins only) and
 * retries; when the refresh yields no token, it throws signedOut() (else the 401 as an ApiError).
 */
export function apiClient({ origin, userAgent, auth = null, fetch: fetchFn }) {
  const f = guardedFetch(fetchFn);
  async function call(method, pathname, { json, query } = {}) {
    const url = new URL(`${origin}/api/v1${pathname}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
    const send = async (token) =>
      f(url, {
        method,
        headers: {
          "User-Agent": userAgent,
          Accept: "application/json",
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
    const token = auth ? await auth.token() : null;
    let res = await send(token);
    if (res.status === 401 && auth?.refresh) {
      const next = await auth.refresh();
      if (next) {
        await res.arrayBuffer().catch(() => {});
        res = await send(next);
      } else if (auth.signedOut) {
        // The grant is gone (revoked on the Connections page, or expired): say how to sign in.
        await res.arrayBuffer().catch(() => {});
        throw auth.signedOut();
      }
    }
    return readJson(res, `${method} ${pathname}`);
  }
  return {
    origin,
    get: (p, opts) => call("GET", p, opts),
    post: (p, json) => call("POST", p, { json }),
    put: (p, json) => call("PUT", p, { json }),
  };
}

/** Format an ApiError for a person: the message, then what to do and which files. */
export function describeApiError(e) {
  const lines = [e.message];
  const d = e.details ?? {};
  if (Array.isArray(d.paths)) {
    for (const p of d.paths.slice(0, 20))
      lines.push(`  ${p.path ?? p}${p.reason ? `: ${p.reason}` : ""}`);
  }
  if (Array.isArray(d.largest)) {
    lines.push("  Largest files:");
    for (const p of d.largest) lines.push(`    ${p.path} (${formatBytes(p.size_bytes)})`);
  }
  if (typeof d.path === "string") lines.push(`  File: ${d.path}`);
  if (typeof d.next === "string") lines.push(`Next: ${d.next}`);
  // Messages may echo file names and text from the published files.
  return lines.map(printable).join("\n");
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

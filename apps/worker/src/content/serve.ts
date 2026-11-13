// The content host: user HTML only. Never app pages, never app cookies. Each artifact is its own
// origin (<artifact_id>.CONTENT_HOST). Access needs the host-only content cookie, obtained by
// exchanging a one-time viewer token issued by the app after its access check.
import {
  ARTIFACT_ID_RE,
  CONTENT_RESERVED_PREFIX,
  COOKIES,
  REVIEW_MODE_PARAM,
  TTL,
} from "@plinth/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Bindings, Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type ArtifactRow, artifacts, versions } from "../db/schema.ts";
import { secureFlag, serializeCookie } from "../lib/cookies.ts";
import { parseManifest } from "../services/storage.ts";
import { injectBridge, serveBridgeScript } from "./bridge.ts";
import { applyContentHeaders } from "./csp.ts";
import { servePreviewLoader } from "./preview.ts";
import {
  consumeNonce,
  safeNext,
  signContentCookie,
  verifyContentCookie,
  verifyEnterToken,
} from "./tokens.ts";

export type HostRoute =
  | { kind: "app" }
  | {
      kind: "content";
      artifactId: string /** path inside the artifact, starting with "/" */;
      path: string;
      base: string;
    }
  | { kind: "content-root" }
  | { kind: "unknown" };

/** Route a request by hostname. Content subdomains must be a valid artifact id label. */
export function resolveHost(config: Config, url: URL): HostRoute {
  const host = url.host.toLowerCase();
  if (host === config.appHost) {
    if (config.contentPathFallback) {
      const m = /^\/__content\/([a-z0-9]{20})(\/.*)?$/.exec(url.pathname);
      if (m?.[1])
        return { kind: "content", artifactId: m[1], path: m[2] ?? "/", base: `/__content/${m[1]}` };
    }
    return { kind: "app" };
  }
  if (host === config.contentHost) return { kind: "content-root" };
  const suffix = `.${config.contentHost}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    if (ARTIFACT_ID_RE.test(label))
      return { kind: "content", artifactId: label, path: url.pathname, base: "" };
    // Any other name under the content host is still the content host: never the app.
    return { kind: "content-root" };
  }
  return { kind: "unknown" };
}

function text(
  config: Config,
  status: number,
  body: string,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", ...extra });
  applyContentHeaders(config, headers);
  return new Response(body, { status, headers });
}

function redirect(config: Config, status: 301 | 302, location: string): Response {
  const headers = new Headers({ Location: location });
  applyContentHeaders(config, headers);
  return new Response(null, { status, headers });
}

/**
 * Every value sent for a cookie name. Another artifact cannot set a cookie on this host directly,
 * but where the content host is not on the Public Suffix List a sibling subdomain can set one for
 * the parent domain ("cookie tossing"). Looking at every value means such a cookie can never shadow
 * the real one.
 */
function cookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    out.push(part.slice(i + 1).trim());
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * A request path inside one version, as the manifest key it must match. Null for anything that is
 * not a plain relative path: "..", ".", empty segments ("//"), backslashes, control characters,
 * bad percent-encoding, or the reserved prefix. The manifest lookup is the final gate: the R2 key
 * is built only from a path the manifest lists, so nothing outside the version's prefix is reachable.
 */
export function resolveFilePath(filePath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(filePath);
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(rel)) return null;
  if (!rel.startsWith("/")) return null;
  rel = rel.slice(1);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  if (`/${rel}`.startsWith(CONTENT_RESERVED_PREFIX)) return null;
  return rel;
}

export async function serveContent(
  request: Request,
  env: Bindings,
  config: Config,
  route: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  try {
    return await serve(request, env, config, route);
  } catch (e) {
    // Never show internals (stack traces, SQL) on a content host.
    console.error("content host error:", e instanceof Error ? e.message : "unknown");
    return text(config, 500, "Something went wrong. Try again later.");
  }
}

async function loadArtifact(env: Bindings, artifactId: string): Promise<ArtifactRow | null> {
  const row = await getDb(env.DB)
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), isNull(artifacts.deletedAt)))
    .get();
  return row ?? null;
}

async function serve(
  request: Request,
  env: Bindings,
  config: Config,
  route: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(config, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const url = new URL(request.url);
  const { artifactId, path, base } = route;
  const cookieName = COOKIES.content;
  // In the path fallback all artifacts share the app origin, so cookies are scoped by path.
  const cookiePath = base ? `${base}/` : "/";

  // Static helpers that hold no artifact data.
  if (path === `${CONTENT_RESERVED_PREFIX}bridge.js`) return serveBridgeScript(config);
  if (path === `${CONTENT_RESERVED_PREFIX}preview`) return servePreviewLoader(config);

  if (path === `${CONTENT_RESERVED_PREFIX}enter`) {
    const expired = () => text(config, 403, "This link has expired. Open the artifact again.");
    const token = url.searchParams.get("t") ?? "";
    const payload = await verifyEnterToken(config, token);
    if (!payload || payload.a !== artifactId) return expired();
    // Access changed (visibility, password, grants, takedown, deletion) since the token was issued.
    const current = await loadArtifact(env, artifactId);
    if (!current || current.takenDownAt || current.accessEpoch !== payload.e) return expired();
    if (!(await consumeNonce(env.DB, payload.n, payload.exp))) {
      return text(config, 403, "This link was already used. Open the artifact again.");
    }
    const value = await signContentCookie(config, artifactId, payload.e);
    const next = safeNext(url.searchParams.get("next"));
    const res = redirect(config, 302, `${base}${next}`);
    res.headers.append(
      "Set-Cookie",
      serializeCookie(cookieName, value, {
        httpOnly: true,
        secure: secureFlag(config.scheme, url.host),
        // The artifact is framed by the app (cross-site), so the cookie must be SameSite=None and
        // partitioned (CHIPS) to work where third-party cookies are blocked.
        sameSite: "None",
        partitioned: true,
        path: cookiePath,
        maxAge: TTL.contentCookieS,
      }),
    );
    return res;
  }

  const artifact = await loadArtifact(env, artifactId);
  if (!artifact || artifact.takenDownAt) return text(config, 404, "Not found");

  let allowed = false;
  for (const value of cookieValues(request.headers.get("cookie"), cookieName)) {
    const pass = await verifyContentCookie(config, value);
    if (pass && pass.a === artifactId && pass.e === artifact.accessEpoch) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    // No valid access: send the browser to the app's gate, which comes back with a fresh token.
    const next = `${path}${url.search}`;
    return redirect(
      config,
      302,
      `${config.appOrigin}/open/${artifactId}?next=${encodeURIComponent(next)}`,
    );
  }

  // Resolve version and file path.
  let versionNumber = artifact.currentVersion;
  let filePath = path;
  const vm = /^\/__plinth\/v\/(\d{1,9})(\/.*)?$/.exec(path);
  if (vm) {
    versionNumber = Number(vm[1]);
    filePath = vm[2] ?? "/";
    if (!vm[2]) return redirect(config, 301, `${base}${path}/${url.search}`);
  } else if (path.startsWith(CONTENT_RESERVED_PREFIX)) {
    return text(config, 404, "Not found");
  }
  if (versionNumber < 1 || versionNumber > artifact.currentVersion)
    return text(config, 404, "No such version");

  const rel = resolveFilePath(filePath);
  if (rel === null) return text(config, 400, "Bad path");

  const v = await getDb(env.DB)
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, artifactId), eq(versions.number, versionNumber)))
    .get();
  if (!v) return text(config, 404, "No such version");
  const entry = parseManifest(v.manifest).find((m) => m.path === rel);
  if (!entry) return text(config, 404, "Not found");
  const key = v.r2Prefix + entry.path;
  const obj = request.method === "HEAD" ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!obj) return text(config, 404, "Not found");

  const headers = new Headers({ "Content-Type": entry.content_type, ETag: obj.httpEtag });
  applyContentHeaders(config, headers);
  // Public artifacts (only when the instance allows public visibility) may be indexed.
  if (artifact.visibility === "public" && config.allowPublicVisibility)
    headers.delete("X-Robots-Tag");
  const body = request.method !== "HEAD" && "body" in obj ? (obj as R2ObjectBody).body : null;
  let res = new Response(body, { status: 200, headers });
  if (url.searchParams.has(REVIEW_MODE_PARAM) && entry.content_type.startsWith("text/html")) {
    res = injectBridge(config, res, base);
  }
  return res;
}

/** The bare content host and non-artifact names under it: nothing to see, never app content. */
export function contentRoot(config: Config): Response {
  return text(config, 404, "Plinth content host. Nothing is served here.");
}

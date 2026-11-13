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
import { artifacts, versions } from "../db/schema.ts";
import { parseCookies, secureFlag, serializeCookie } from "../lib/cookies.ts";
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

export async function serveContent(
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

  const db = getDb(env.DB);

  if (path === `${CONTENT_RESERVED_PREFIX}enter`) {
    const token = url.searchParams.get("t") ?? "";
    const payload = await verifyEnterToken(config, token);
    if (!payload || payload.a !== artifactId)
      return text(config, 403, "This link has expired. Open the artifact again.");
    if (!(await consumeNonce(env.DB, payload.n, payload.exp))) {
      return text(config, 403, "This link was already used. Open the artifact again.");
    }
    const value = await signContentCookie(config, artifactId, payload.e);
    const next = safeNext(url.searchParams.get("next"));
    const headers = new Headers({ Location: `${base}${next}` });
    headers.append(
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
    applyContentHeaders(config, headers);
    return new Response(null, { status: 302, headers });
  }

  const artifact = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), isNull(artifacts.deletedAt)))
    .get();
  if (!artifact || artifact.takenDownAt) return text(config, 404, "Not found");

  const cookie = parseCookies(request.headers.get("cookie")).get(cookieName);
  const pass = cookie ? await verifyContentCookie(config, cookie) : null;
  if (!pass || pass.a !== artifactId || pass.e !== artifact.accessEpoch) {
    // No valid access: send the browser to the app's gate, which comes back with a fresh token.
    const next = `${path}${url.search}`;
    const gate = `${config.appOrigin}/open/${artifactId}?next=${encodeURIComponent(next)}`;
    const headers = new Headers({ Location: gate });
    applyContentHeaders(config, headers);
    return new Response(null, { status: 302, headers });
  }

  // Resolve version and file path.
  let versionNumber = artifact.currentVersion;
  let filePath = path;
  const vm = /^\/__plinth\/v\/(\d{1,9})(\/.*)?$/.exec(path);
  if (vm) {
    versionNumber = Number(vm[1]);
    filePath = vm[2] ?? "/";
    if (!vm[2]) {
      const headers = new Headers({ Location: `${base}${path}/${url.search}` });
      applyContentHeaders(config, headers);
      return new Response(null, { status: 301, headers });
    }
  } else if (path.startsWith(CONTENT_RESERVED_PREFIX)) {
    return text(config, 404, "Not found");
  }
  if (versionNumber < 1 || versionNumber > artifact.currentVersion)
    return text(config, 404, "No such version");

  let rel: string;
  try {
    rel = decodeURIComponent(filePath).replace(/^\/+/, "");
  } catch {
    return text(config, 400, "Bad path");
  }
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some((seg) => seg === ".." || seg === "."))
    return text(config, 400, "Bad path");

  const v = await db
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, artifactId), eq(versions.number, versionNumber)))
    .get();
  if (!v) return text(config, 404, "No such version");
  const entry = parseManifest(v.manifest).find((m) => m.path === rel);
  if (!entry) return text(config, 404, "Not found");
  const obj = await env.FILES.get(v.r2Prefix + rel);
  if (!obj) return text(config, 404, "Not found");

  const headers = new Headers({ "Content-Type": entry.content_type, ETag: obj.httpEtag });
  applyContentHeaders(config, headers);
  let res = new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
  if (url.searchParams.has(REVIEW_MODE_PARAM) && entry.content_type.startsWith("text/html")) {
    res = injectBridge(config, res, base);
  }
  return res;
}

/** The bare content host and unknown hosts: nothing to see, and never app content. */
export function contentRoot(config: Config): Response {
  return text(config, 404, "Plinth content host. Nothing is served here.");
}

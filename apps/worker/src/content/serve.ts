// The content host: user HTML only. Never app pages, never app cookies. Each artifact is its own
// origin (<artifact_id>.CONTENT_HOST). Access needs the host-only content cookie, obtained by
// exchanging a one-time viewer token issued by the app after its access check.
import {
  ARTIFACT_ID_RE,
  CONTENT_RESERVED_PREFIX,
  COOKIES,
  type EffectiveRole,
  HOST_COOKIE_PREFIX,
  REVIEW_MODE_PARAM,
  typeDef,
} from "@plinth/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Bindings, Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type ArtifactRow, artifacts, type VersionRow } from "../db/schema.ts";
import { secureFlag, serializeCookie } from "../lib/cookies.ts";
import { openJson, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import type { PageClaim } from "../policy.ts";
import { fileKey, type ManifestEntry } from "../services/storage.ts";
import { isCountableRequest, recordView } from "../services/views.ts";
import { injectBridge, serveBridgeScript } from "./bridge.ts";
import { applyContentHeaders, type ContentCspOptions } from "./csp.ts";
import { DATA_API_PREFIX, serveDataApi } from "./data-api.ts";
import { servePreviewLoader } from "./preview.ts";
import { serveRuntimeScript } from "./runtime.ts";
import {
  consumeNonce,
  IDENTITY_CLAIM_INFO,
  isVersion,
  type PassKind,
  passMaxAgeS,
  safeNext,
  signContentCookie,
  verifyContentCookie,
  verifyEnterToken,
} from "./tokens.ts";
import { rendererRequest, serveRendererFile, serveTypedEntry, unsupportedType } from "./typed.ts";
import { loadVersion } from "./versionCache.ts";

/**
 * Cache-Control for a file of an explicitly versioned URL (/__plinth/v/<n>/...): its bytes can
 * never change. Still private (the content cookie gates every file) and never for HTML, whose
 * response depends on review mode and which is the document a revoked viewer must not keep.
 */
export const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";

/** The strong ETag of a manifest entry: from its server-computed sha256 when it has one. */
export function entryEtag(e: Pick<ManifestEntry, "sha256">): string | null {
  return e.sha256 ? `"sha256-${e.sha256}"` : null;
}

/** Whether an If-None-Match header matches an ETag (weak comparison, as RFC 9110 asks). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => (t.startsWith("W/") ? t.slice(2) : t);
  const want = bare(etag.trim());
  for (const part of header.split(",")) {
    const t = part.trim();
    if (t === "*" || bare(t) === want) return true;
  }
  return false;
}

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
  opts: ContentCspOptions = {},
): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", ...extra });
  applyContentHeaders(config, headers, opts);
  return new Response(body, { status, headers });
}

function redirect(
  config: Config,
  status: 301 | 302,
  location: string,
  opts: ContentCspOptions = {},
): Response {
  const headers = new Headers({ Location: location });
  applyContentHeaders(config, headers, opts);
  return new Response(null, { status, headers });
}

/**
 * The content cookie's name for a request. On an artifact's own subdomain it is `__Host-`
 * prefixed whenever it is Secure: browsers refuse a `__Host-` cookie that has a Domain attribute,
 * so a sibling artifact cannot toss one onto the parent domain (the content host may share a
 * registrable domain with its siblings until its Public Suffix List entry ships). The plain name is
 * kept for the staging path fallback (Path=/__content/<id>/ on the app host, where shared data is
 * off) and for plain-http names, which cannot set Secure cookies.
 */
export function contentCookieName(config: Pick<Config, "appHost" | "scheme">, url: URL): string {
  const host = url.host.toLowerCase();
  if (host === config.appHost || !secureFlag(config.scheme, host)) return COOKIES.content;
  return `${HOST_COOKIE_PREFIX}${COOKIES.content}`;
}

/** At most this many values of the content cookie are checked per request. */
const MAX_PASS_VALUES = 8;

/**
 * Every value sent for a cookie name. Another artifact cannot set a cookie on this host directly,
 * but where the content host is not on the Public Suffix List a sibling subdomain can set one for
 * the parent domain ("cookie tossing") under the plain name. Looking at every value means such a
 * cookie can never shadow the real one.
 */
function cookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    out.push(part.slice(i + 1).trim());
    if (out.length >= MAX_PASS_VALUES) break;
  }
  return out;
}

const CLAIM_ROLES: ReadonlySet<string> = new Set<EffectiveRole>([
  "owner",
  "editor",
  "commenter",
  "viewer",
]);

/**
 * A valid content pass. `capture`: Plinth's thumbnail browser (top-level loads allowed). `preview`:
 * an MCP host's in-chat preview (any framer, read-only); neither ever carries an identity.
 */
type ContentPass = {
  claim: PageClaim | null;
  capture: boolean;
  preview: boolean;
  /** The one version a preview pass opens; null for every other pass. */
  version: number | null;
};

/** One cookie value as a pass for this artifact at its epoch, or null when it is not one. */
async function openPass(
  config: Config,
  artifact: { id: string; accessEpoch: number },
  value: string,
): Promise<ContentPass | null> {
  const pass = await verifyContentCookie(config, value);
  if (!pass || pass.a !== artifact.id || pass.e !== artifact.accessEpoch) return null;
  const capture = pass.c === 1;
  const preview = pass.p === 1;
  if (capture && preview) return null;
  if (preview !== isVersion(pass.v)) return null;
  const version = preview ? (pass.v as number) : null;
  if (pass.x === undefined) return { claim: null, capture, preview, version };
  // Capture and preview passes never carry an identity (issueEnterUrl refuses both).
  if (capture || preview) return null;
  if (typeof pass.x !== "string") return null;
  const opened = await openJson(config.tokenSigningKey, IDENTITY_CLAIM_INFO, artifact.id, pass.x);
  if (!opened || typeof opened !== "object") return null;
  const { m, r } = opened as Record<string, unknown>;
  if (typeof m !== "string" || !m || typeof r !== "string" || !CLAIM_ROLES.has(r)) return null;
  return {
    claim: {
      email: m,
      role: r as EffectiveRole,
      viewerId: await viewerIdFor(config.tokenSigningKey, artifact.id, m),
    },
    capture: false,
    preview: false,
    version: null,
  };
}

const sameClaim = (a: PageClaim | null, b: PageClaim | null) =>
  a === null || b === null ? a === b : a.email === b.email && a.role === b.role;

/**
 * The content pass this request carries for this artifact: a content cookie signed for this
 * artifact at its current access epoch. `claim` is the viewer's identity when the gate sealed one
 * in (identified viewers only), else null. A value whose claim does not open, or opens to the wrong
 * shape, is rejected outright, never downgraded to anonymous. Passes differ by the identity they
 * carry (and a preview pass may be framed by anyone), so a request with two valid passes that
 * disagree on either is ambiguous and has none: the page
 * reloads through the gate rather than act as whoever's pass came first. Null when there is no
 * valid pass.
 */
export async function readContentPass(
  request: Request,
  config: Config,
  artifact: { id: string; accessEpoch: number },
): Promise<ContentPass | null> {
  const name = contentCookieName(config, new URL(request.url));
  let found: ContentPass | null = null;
  for (const value of cookieValues(request.headers.get("cookie"), name)) {
    const pass = await openPass(config, artifact, value);
    if (!pass) continue;
    // A preview pass may be framed by anyone, so it never mixes with another kind.
    if (
      found &&
      (!sameClaim(found.claim, pass.claim) ||
        found.preview !== pass.preview ||
        found.version !== pass.version)
    )
      return null;
    found ??= pass;
  }
  return found;
}

/** Whether this request carries a valid capture pass for the live artifact (top-level loads). */
async function hasCapturePass(
  request: Request,
  env: Bindings,
  config: Config,
  artifactId: string,
): Promise<boolean> {
  if (!request.headers.get("cookie")) return false;
  const artifact = await loadArtifact(env, artifactId);
  if (!artifact || artifact.takenDownAt) return false;
  return (await readContentPass(request, config, artifact))?.capture === true;
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

/**
 * Serve a content-host request. `defer` keeps work alive after the response (the Worker's
 * waitUntil); without it (direct calls in tests) that work is awaited before answering.
 */
export async function serveContent(
  request: Request,
  env: Bindings,
  config: Config,
  route: Extract<HostRoute, { kind: "content" }>,
  defer?: (p: Promise<unknown>) => void,
): Promise<Response> {
  try {
    return await serve(request, env, config, route, defer);
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
  defer?: (p: Promise<unknown>) => void,
): Promise<Response> {
  // Shared data (content/data-api.ts): its own method, caller and JSON checks, never a redirect.
  if (route.path.startsWith(DATA_API_PREFIX)) return serveDataApi(request, env, config, route);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(config, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const url = new URL(request.url);
  const { artifactId, path, base } = route;
  const cookieName = contentCookieName(config, url);
  // In the path fallback all artifacts share the app origin, so cookies are scoped by path.
  const cookiePath = base ? `${base}/` : "/";

  // Artifacts may not install service workers: one would keep serving (and intercept tokens)
  // after a takedown, deletion or access change.
  if (request.headers.get("service-worker") === "script") {
    return text(config, 403, "Service workers are not allowed on artifacts.");
  }

  // Artifacts render only inside the app's frame, where the sandbox and the app's frame-src keep
  // them from navigating away with what a viewer typed. A top-level visit (direct link, popup)
  // goes to the app's artifact page instead. Browsers send Sec-Fetch-Dest; tools that do not
  // (curl, scripts) are served as before. The one exception is Plinth's own thumbnail capture
  // (services/thumbnails.ts): its browser loads the version top-level with a short-lived capture
  // pass that carries no identity and that only an enter token Plinth minted for it can set.
  if (
    request.headers.get("sec-fetch-dest") === "document" &&
    path !== `${CONTENT_RESERVED_PREFIX}enter` &&
    !(await hasCapturePass(request, env, config, artifactId))
  ) {
    return redirect(config, 302, appPageFor(config, artifactId, path, url));
  }

  // Static helpers that hold no artifact data.
  if (path === `${CONTENT_RESERVED_PREFIX}bridge.js`) return serveBridgeScript(config);
  if (path === `${CONTENT_RESERVED_PREFIX}runtime.js`) return serveRuntimeScript(config);
  if (path === `${CONTENT_RESERVED_PREFIX}preview`) return servePreviewLoader(config);
  const renderer = rendererRequest(path);
  if (renderer) return serveRendererFile(request, env, config, renderer.id, renderer.file);

  if (path === `${CONTENT_RESERVED_PREFIX}enter`) {
    const token = url.searchParams.get("t") ?? "";
    const payload = await verifyEnterToken(config, token);
    // A preview's own answers may show inside the MCP host's frame (no frame-ancestors).
    const enterOpts: ContentCspOptions = payload?.p === 1 ? { framing: "any" } : {};
    const expired = () =>
      text(config, 403, "This link has expired. Open the artifact again.", undefined, enterOpts);
    if (!payload || payload.a !== artifactId) return expired();
    // Access changed (visibility, password, grants, takedown, deletion) since the token was issued.
    const current = await loadArtifact(env, artifactId);
    if (!current || current.takenDownAt || current.accessEpoch !== payload.e) return expired();
    if (!(await consumeNonce(env.DB, payload.n, payload.exp))) {
      return text(
        config,
        403,
        "This link was already used. Open the artifact again.",
        undefined,
        enterOpts,
      );
    }
    // The sealed identity claim, if any, moves into the cookie unchanged. Every enter writes a
    // fresh cookie, so an anonymous enter replaces an identified one.
    const x = typeof payload.x === "string" ? payload.x : undefined;
    const capture = payload.c === 1;
    const preview = payload.p === 1;
    if ((capture || preview) && x !== undefined) return expired();
    if (capture && preview) return expired();
    if (preview !== isVersion(payload.v)) return expired();
    // A preview is for an artifact's own subdomain only: never the path fallback on the app host.
    if (preview && base) return expired();
    const kind: PassKind = capture ? "capture" : preview ? "preview" : "view";
    // An open counts (services/views.ts) only for a view pass the gate flagged, from a browser in
    // the app's frame that holds no view pass for this artifact yet (reloads and second tabs
    // within the cookie's lifetime count once). It reads the incoming cookies, before the new one,
    // and never changes the response below.
    let countable = false;
    if (kind === "view" && payload.w === 1 && config.viewCounts && isCountableRequest(request)) {
      const prior = await readContentPass(request, config, current);
      countable = !prior || prior.capture || prior.preview;
    }
    const value = await signContentCookie(
      config,
      artifactId,
      payload.e,
      x,
      kind,
      preview ? (payload.v as number) : undefined,
    );
    const next = safeNext(url.searchParams.get("next"));
    const res = redirect(config, 302, `${base}${next}`, enterOpts);
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
        maxAge: passMaxAgeS(kind),
      }),
    );
    if (countable) {
      const write = recordView(env.DB, artifactId, Date.now());
      if (defer) defer(write);
      else await write;
    }
    return res;
  }

  const artifact = await loadArtifact(env, artifactId);
  if (!artifact || artifact.takenDownAt) {
    // Gone or taken down: also wipe anything this origin stored in the browser. Never in the path
    // fallback, where the origin is the app's own.
    return text(config, 404, "Not found", base ? undefined : { "Clear-Site-Data": '"storage"' });
  }

  const pass = await readContentPass(request, config, artifact);
  if (!pass) {
    // Inside the app's frame the app cannot be framed back (frame-ancestors 'none'): ask for a
    // reload, which fetches a fresh gate and token.
    if (request.headers.get("sec-fetch-dest") === "iframe") {
      return text(
        config,
        401,
        "Your access to this artifact expired. Reload the page to continue.",
      );
    }
    // No valid access: send the browser to the app's gate, which comes back with a fresh token.
    const next = `${path}${url.search}`;
    return redirect(
      config,
      302,
      `${config.appOrigin}/open/${artifactId}?next=${encodeURIComponent(next)}`,
    );
  }

  // An in-chat preview may be framed by the MCP host; every other pass only by the app.
  const framing = pass.preview ? "any" : "app";
  const fail = (status: number, body: string) => text(config, status, body, undefined, { framing });

  // Resolve version and file path.
  let versionNumber = artifact.currentVersion;
  let filePath = path;
  const vm = /^\/__plinth\/v\/(\d{1,9})(\/.*)?$/.exec(path);
  if (vm) {
    versionNumber = Number(vm[1]);
    filePath = vm[2] ?? "/";
    if (!vm[2]) return redirect(config, 301, `${base}${path}/${url.search}`, { framing });
  } else if (path.startsWith(CONTENT_RESERVED_PREFIX)) {
    return fail(404, "Not found");
  }
  // A preview pass opens its one version's URLs and nothing else, not even the current path.
  if (pass.preview && (!vm || versionNumber !== pass.version)) return fail(404, "Not found");
  if (versionNumber < 1 || versionNumber > artifact.currentVersion)
    return fail(404, "No such version");

  const rel = resolveFilePath(filePath);
  if (rel === null) return fail(400, "Bad path");

  const v = await loadVersion(env.DB, artifactId, versionNumber);
  if (!v) return fail(404, "No such version");
  // A typed artifact (a doc): its page is Plinth's shell around the content file; every other
  // path (the content file itself, images) is the version's own file, as for any artifact.
  const def = typeDef(artifact.type);
  if (!def) return unsupportedType(config);
  if (def.renderer && rel === "index.html") {
    // serveTypedEntry reads only the version's prefix (its source file is always under it).
    const version = { r2Prefix: v.r2Prefix } as Pick<VersionRow, "r2Prefix"> as VersionRow;
    return serveTypedEntry(request, env, config, { artifact, version, def, base, url, framing });
  }
  const entry = v.entries.get(rel);
  if (!entry) return fail(404, "Not found");
  let key: string;
  try {
    key = fileKey(artifactId, v, entry);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return fail(404, "Not found");
    throw e;
  }

  const isHtml = entry.content_type.startsWith("text/html");
  const review = url.searchParams.has(REVIEW_MODE_PARAM) && isHtml;
  // Opaque isolation keeps the original caching: R2's tag, no-cache everywhere, no early 304.
  const caching = config.contentIsolation === "origin" && !review;
  const headers = new Headers({ "Content-Type": entry.content_type });
  // A typed artifact's other files (content.md, images) run no script, not even an SVG opened as
  // a document: only the shell runs Plinth's renderer.
  applyContentHeaders(config, headers, def.renderer ? { scripts: "none", framing } : { framing });
  // Public artifacts (only when the instance allows public visibility) may be indexed.
  if (artifact.visibility === "public" && config.allowPublicVisibility)
    headers.delete("X-Robots-Tag");
  // Files of an explicitly versioned URL never change: let the browser keep them (still private).
  if (caching && vm && !isHtml) headers.set("Cache-Control", IMMUTABLE_CACHE);

  // Every access check above has passed. A file with a server-computed hash answers a matching
  // conditional request without touching R2.
  const strong = caching ? entryEtag(entry) : null;
  const ifNoneMatch = request.headers.get("if-none-match");
  if (strong) {
    headers.set("ETag", strong);
    if (etagMatches(ifNoneMatch, strong)) return new Response(null, { status: 304, headers });
  }
  if (caching && !strong && ifNoneMatch) {
    const head = await env.FILES.head(key);
    if (!head) return fail(404, "Not found");
    if (etagMatches(ifNoneMatch, head.httpEtag)) {
      headers.set("ETag", head.httpEtag);
      return new Response(null, { status: 304, headers });
    }
  }
  const obj = request.method === "HEAD" ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!obj) return fail(404, "Not found");
  if (!strong) headers.set("ETag", obj.httpEtag);
  const body = request.method !== "HEAD" && "body" in obj ? (obj as R2ObjectBody).body : null;
  let res = new Response(body, { status: 200, headers });
  if (review) res = injectBridge(config, res, base);
  return res;
}

/** The app page that frames this artifact at the same place: version path or sub-path kept. */
export function appPageFor(config: Config, artifactId: string, path: string, url: URL): string {
  const page = `${config.appOrigin}/a/${artifactId}`;
  const version = /^\/__plinth\/v\/(\d{1,9})\/?$/.exec(path);
  if (version) return `${page}/v/${version[1]}`;
  if (path === "/" || path === "" || path === "/index.html") return page;
  const search = new URLSearchParams(url.search);
  search.delete(REVIEW_MODE_PARAM);
  const rest = search.toString();
  return `${page}?path=${encodeURIComponent(`${path}${rest ? `?${rest}` : ""}`)}`;
}

/** The bare content host and non-artifact names under it: nothing to see, never app content. */
export function contentRoot(config: Config): Response {
  return text(config, 404, "Plinth content host. Nothing is served here.");
}

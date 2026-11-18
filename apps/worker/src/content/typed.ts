// Typed artifacts on the content host (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md).
// A typed artifact (a doc) stores a content file, not index.html. Its page is a fixed Plinth shell
// that embeds the content as escaped JSON and loads the type's renderer from the artifact's own
// origin under /__plinth/types/<id>/. The renderer files are Plinth's own bytes from the web
// build (ASSETS); nothing here runs per-artifact code or loosens the CSP.
import {
  type ArtifactTypeDef,
  CONTENT_RESERVED_PREFIX,
  REVIEW_MODE_PARAM,
  typeDef,
  typedShellHtml,
} from "@plinth/shared";
import type { Bindings, Config } from "../config.ts";
import type { ArtifactRow, VersionRow } from "../db/schema.ts";
import { injectBridge } from "./bridge.ts";
import { applyContentHeaders } from "./csp.ts";

/** Where the web build puts renderer bundles (apps/web/build/renderers.ts, RENDERERS_DIR). */
const RENDERERS_DIR = "__plinth-renderers";
/** ASSETS ignores the host; a reserved TLD keeps the request from ever meaning a real site. */
const ASSETS_ORIGIN = "https://assets.invalid";

/**
 * A request under /__plinth/types/, which is only ever a renderer file: { id, file } from
 * /__plinth/types/<id>/<file> (one segment each; empty strings for any other shape, which is then
 * a 404), or null for a path outside that prefix.
 */
export function rendererRequest(path: string): { id: string; file: string } | null {
  const prefix = `${CONTENT_RESERVED_PREFIX}types/`;
  if (!path.startsWith(prefix)) return null;
  const m = /^([^/]+)\/([^/]+)$/.exec(path.slice(prefix.length));
  return { id: m?.[1] ?? "", file: m?.[2] ?? "" };
}

function notFound(config: Config, body = "Not found"): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyContentHeaders(config, headers);
  return new Response(body, { status: 404, headers });
}

/** Whether an If-None-Match header matches an ETag (weak comparison, RFC 9110 13.1.2). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  const want = opaque(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || opaque(t) === want);
}

/**
 * A renderer file, served without the content cookie (it holds no artifact data, like bridge.js).
 * Only a file the registry lists for a known type is served, and the ASSETS URL is built from the
 * registry, never from the request path. ASSETS falls back to the SPA's index.html for a missing
 * file, so the response must be ok and of the expected type; anything else is a 404.
 * The ETag ASSETS gives the file is passed on, and a matching If-None-Match gets a 304, so the
 * `no-cache` every content response carries revalidates instead of downloading the renderer again
 * on each view and each editor preview render.
 */
export async function serveRendererFile(
  request: Request,
  env: Bindings,
  config: Config,
  id: string,
  file: string,
): Promise<Response> {
  const def = typeDef(id);
  const r = def?.renderer;
  if (!def || !r) return notFound(config);
  const expected = file === r.script ? "text/javascript" : file === r.style ? "text/css" : null;
  if (!expected) return notFound(config);
  const name = file === r.script ? r.script : r.style;
  const res = await env.ASSETS.fetch(`${ASSETS_ORIGIN}/${RENDERERS_DIR}/${def.id}/${name}`);
  const type = (res.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (!res.ok || type !== expected) {
    await res.body?.cancel();
    return notFound(config);
  }
  const headers = new Headers({ "Content-Type": `${expected}; charset=utf-8` });
  applyContentHeaders(config, headers, { publicFile: true });
  const etag = res.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  if (etag && etagMatches(request.headers.get("If-None-Match"), etag)) {
    await res.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    await res.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(res.body, { status: 200, headers });
}

/** The 404 for an artifact whose stored type this instance does not know. */
export function unsupportedType(config: Config): Response {
  return notFound(config, "This artifact's type is not supported by this instance");
}

/**
 * A typed artifact's page: the shell with this version's content embedded, under the strict
 * shell CSP (script-src 'self'). No ETag: the shell depends on the renderer as well as the
 * version, so it is revalidated by content, not by the stored file's tag.
 */
export async function serveTypedEntry(
  request: Request,
  env: Bindings,
  config: Config,
  o: {
    artifact: ArtifactRow;
    version: VersionRow;
    def: ArtifactTypeDef;
    base: string;
    url: URL;
    framing?: "app" | "any";
    /** The artifact's own WebSocket origin, while rooms are active (csp.ts `socket`). */
    socket?: string;
    /**
     * An owner or editor on the current version, with rooms and live editing on: the renderer
     * connects the doc socket (payload `live`). Every other shell has today's bytes.
     */
    live?: "room";
  },
): Promise<Response> {
  const { artifact, version, def, base, url, framing, socket, live } = o;
  const obj = await env.FILES.get(version.r2Prefix + def.sourcePath);
  if (!obj) return notFound(config);
  const html = typedShellHtml(def, {
    title: artifact.title,
    text: await obj.text(),
    base,
    appOrigin: config.appOrigin,
    ...(live ? { live } : {}),
  });
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyContentHeaders(config, headers, { scripts: "self", framing, ...(socket ? { socket } : {}) });
  // Public artifacts (only when the instance allows public visibility) may be indexed.
  if (artifact.visibility === "public" && config.allowPublicVisibility)
    headers.delete("X-Robots-Tag");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  let res = new Response(html, { status: 200, headers });
  if (url.searchParams.has(REVIEW_MODE_PARAM)) res = injectBridge(config, res, base);
  return res;
}

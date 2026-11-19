// Static assets and the SPA on APP_HOST only. The content host never reaches this.
import type { AppContext } from "../api/context.ts";
import { ensureCsrfCookie } from "../api/context.ts";
import { renderShell } from "./discovery.ts";
import { applyAppHeaders } from "./headers.ts";

/** Where the web build puts typed-artifact renderers; they are served only on content hosts. */
const RENDERERS_PREFIX = "/__plinth-renderers/";

/**
 * A path that names a file (its last segment has an extension). The assets binding answers a
 * missing file with the SPA's index.html; for these paths that would be a 200 page standing in for
 * a file that does not exist (`/AGENTS.md`, `/sitemap.xml`), so it becomes a 404 instead.
 */
function isFilePath(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") && path !== "/index.html";
}

export function notFoundText(c: AppContext): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyAppHeaders(c.get("config"), headers);
  headers.set("Cache-Control", "no-store");
  return new Response("Not found\n", { status: 404, headers });
}

export async function serveSpa(c: AppContext): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  // Only the OAuth metadata and the MCP discovery documents (routed before this) are well-known.
  if (path.startsWith("/.well-known/")) return notFoundText(c);
  // Renderer bundles run only on an artifact's content origin (/__plinth/types/<id>/), never here.
  if (path.startsWith(RENDERERS_PREFIX) || path === RENDERERS_PREFIX.slice(0, -1)) {
    return notFoundText(c);
  }

  if (isFilePath(path)) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.ok && (res.headers.get("Content-Type") ?? "").includes("text/html")) {
      return notFoundText(c);
    }
    const out = new Response(res.body, res);
    applyAppHeaders(c.get("config"), out.headers);
    return out;
  }

  // An app route: the SPA's index.html with the agent note. Fetched fresh (no conditional
  // headers), because the page differs from the stored file.
  const res = await c.env.ASSETS.fetch(new Request(new URL("/", url), { method: "GET" }));
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok || !type.includes("text/html")) {
    const out = new Response(res.body, res);
    applyAppHeaders(c.get("config"), out.headers);
    return out;
  }
  const shell = await renderShell(c, await res.text(), path);
  // Fresh headers: the stored file's ETag and cache status do not describe this page.
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyAppHeaders(c.get("config"), headers);
  // Artifact pages depend on the artifact's visibility, so they are never stored; a portal
  // (/p/<share id>) lists what its people may open, so it is never stored or indexed either.
  const portal = path.startsWith("/p/");
  headers.set(
    "Cache-Control",
    path.startsWith("/a/") || path.startsWith("/open/") || portal ? "no-store" : "no-cache",
  );
  if (shell.noindex || portal) headers.set("X-Robots-Tag", "noindex, nofollow");
  ensureCsrfCookie(c, headers);
  return new Response(c.req.method === "HEAD" ? null : shell.html, { status: 200, headers });
}

// Static assets and the SPA on APP_HOST only. The content host never reaches this.
import type { AppContext } from "../api/context.ts";
import { ensureCsrfCookie } from "../api/context.ts";
import { ApiError } from "../lib/errors.ts";
import { applyAppHeaders } from "./headers.ts";

/** Where the web build puts typed-artifact renderers; they are served only on content hosts. */
const RENDERERS_PREFIX = "/__plinth-renderers/";

export async function serveSpa(c: AppContext): Promise<Response> {
  // Renderer bundles run only on an artifact's content origin (/__plinth/types/<id>/), never here.
  if (c.req.path.startsWith(RENDERERS_PREFIX) || c.req.path === RENDERERS_PREFIX.slice(0, -1)) {
    const out = c.json(new ApiError("not_found", "Not found").toBody(), 404);
    applyAppHeaders(c.get("config"), out.headers);
    return out;
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  applyAppHeaders(c.get("config"), out.headers);
  const type = out.headers.get("Content-Type") ?? "";
  if (type.includes("text/html")) {
    out.headers.set("Cache-Control", "no-cache");
    ensureCsrfCookie(c, out.headers);
  }
  return out;
}

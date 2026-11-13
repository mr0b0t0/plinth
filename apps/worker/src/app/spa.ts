// Static assets and the SPA on APP_HOST only. The content host never reaches this.
import type { AppContext } from "../api/context.ts";
import { ensureCsrfCookie } from "../api/context.ts";
import { applyAppHeaders } from "./headers.ts";

export async function serveSpa(c: AppContext): Promise<Response> {
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

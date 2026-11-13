// Editor preview loader (workstream: editor). A static page on the artifact's own subdomain that
// receives HTML from the app by postMessage (origin-checked) and renders it under the content CSP.
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

export function servePreviewLoader(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyContentHeaders(config, headers);
  return new Response(
    "<!doctype html><title>Preview</title><p>Preview is not implemented yet.</p>",
    {
      status: 200,
      headers,
    },
  );
}

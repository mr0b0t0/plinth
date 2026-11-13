// Review-mode bridge for anchoring comments to elements (workstream: comments).
// Injected only when the content URL carries ?plinth-review=1. Talks to the app by postMessage
// with strict origin checks on both sides.
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

/** The bridge script. Placeholder until the comments workstream fills it in. */
export function bridgeScriptSource(_config: Config): string {
  return "/* Plinth review bridge: not implemented yet */\n";
}

export function serveBridgeScript(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/javascript; charset=utf-8" });
  applyContentHeaders(config, headers);
  headers.set("Cache-Control", "no-cache");
  return new Response(bridgeScriptSource(config), { status: 200, headers });
}

/** Add the bridge <script> to an HTML response. Placeholder: returns the response unchanged. */
export function injectBridge(_config: Config, res: Response, _base: string): Response {
  return res;
}

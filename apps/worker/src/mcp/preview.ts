// In-chat previews (docs/spec.md "In-chat previews", docs/security.md#in-chat-previews). Hosts that
// support MCP Apps (github.com/modelcontextprotocol/ext-apps) render a tool's result with the UI
// resource its `_meta.ui.resourceUri` names. publish_artifact, update_artifact and restore_version
// name PREVIEW_RESOURCE_URI: a small page Plinth wrote (never user HTML) that asks the app-only
// preview_artifact tool for a fresh single-use link each time it renders, and frames the published
// version from its own content subdomain. The link never appears in a tool result the model sees.
import { ARTIFACT_IFRAME_SANDBOX } from "@plinth/shared";
import { appUrl, type Config } from "../config.ts";
import { issueEnterUrl } from "../content/tokens.ts";
import { ApiError } from "../lib/errors.ts";
import { requireArtifact, requireVersion } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";

/** The UI resource the publishing tools point at. */
export const PREVIEW_RESOURCE_URI = "ui://plinth/preview.html";

/** The MCP Apps resource type (SEP-1865). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The app-only tool the preview calls. */
export const PREVIEW_TOOL = "preview_artifact";

/**
 * Whether this instance can show previews. The staging path fallback serves artifacts from the
 * app's own origin, which must never be framed by another site, so it has none.
 */
export function previewSupported(config: Pick<Config, "contentPathFallback">): boolean {
  return !config.contentPathFallback;
}

/** `_meta` for the publishing tools: render their result with the preview. */
export const PREVIEW_TOOL_META = { ui: { resourceUri: PREVIEW_RESOURCE_URI } } as const;

/** `_meta` for preview_artifact: callable by the preview only, hidden from the model. */
export const PREVIEW_APP_ONLY_META = {
  ui: { resourceUri: PREVIEW_RESOURCE_URI, visibility: ["app"] },
} as const;

/**
 * The resource's `_meta.ui`: the preview may frame artifact subdomains and nothing else, loads no
 * other resource and connects nowhere (the host enforces this as the preview's CSP).
 */
export function previewResourceMeta(config: Pick<Config, "scheme" | "contentHost">) {
  return {
    ui: {
      csp: { frameDomains: [`${config.scheme}://*.${config.contentHost}`] },
      prefersBorder: true,
    },
  };
}

export interface PreviewLink {
  /** Single-use, 60 seconds: becomes a read-only preview cookie on the artifact's subdomain. */
  preview_url: string;
  id: string;
  title: string;
  version: number;
  /** The artifact's page in the app, for "Open on Plinth". */
  url: string;
}

/**
 * A fresh preview link for one version the caller may view. The pass it becomes carries no
 * identity (even for the owner) and cannot write shared data; the version is pinned, so an old
 * preview in a thread keeps showing what was published then.
 */
export async function previewArtifact(
  ctx: Ctx,
  ref: string,
  version?: number,
): Promise<PreviewLink> {
  if (!previewSupported(ctx.config)) {
    throw new ApiError("feature_disabled", "Previews are not available on this instance");
  }
  const { artifact } = await requireArtifact(ctx, ref, "view");
  const v = await requireVersion(ctx, artifact, version ?? artifact.currentVersion);
  const next = `/__plinth/v/${v.number}/`;
  return {
    preview_url: await issueEnterUrl(ctx.config, artifact, next, undefined, { preview: true }),
    id: artifact.id,
    title: artifact.title,
    version: v.number,
    url: appUrl(ctx.config, `/a/${artifact.slug}/v/${v.number}`),
  };
}

/**
 * The preview page. Self-contained (hosts give it a strict CSP), and it trusts messages only from
 * its parent. It speaks the MCP Apps postMessage protocol directly: ui/initialize, then waits for
 * the tool result, asks preview_artifact for a link, and frames it. "Open on Plinth" asks the host
 * to open the artifact's page (ui/open-link).
 */
export const PREVIEW_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plinth preview</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1b; --muted: #6a6a6a; --line: #e2e2e2; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #1c1c1c; --fg: #ececec; --muted: #9b9b9b; --line: #343434; }
}
:root[data-theme="dark"] { color-scheme: dark; --bg: #1c1c1c; --fg: #ececec; --muted: #9b9b9b; --line: #343434; }
:root[data-theme="light"] { color-scheme: light; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.meta { color: var(--muted); white-space: nowrap; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button:hover { border-color: var(--muted); }
iframe { display: block; width: 100%; height: 560px; border: 0; background: #ffffff; }
.note { margin: 0; padding: 16px 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="bar">
  <span class="title" id="title">Plinth</span>
  <span class="meta" id="meta"></span>
  <button type="button" id="open" hidden>Open on Plinth</button>
</div>
<div id="stage"><p class="note">Waiting for the published page.</p></div>
<script>
(() => {
  "use strict";
  const SANDBOX = ${JSON.stringify(ARTIFACT_IFRAME_SANDBOX)};
  const TOOL = ${JSON.stringify(PREVIEW_TOOL)};
  const $ = (id) => document.getElementById(id);
  const pending = new Map();
  let nextId = 1;
  let pageUrl = null;
  let started = false;

  const post = (msg) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
    });
  const notify = (method, params) => post({ method, params });
  const resize = () =>
    notify("ui/notifications/size-changed", { height: document.documentElement.scrollHeight });

  function note(text) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    $("stage").replaceChildren(p);
    resize();
  }

  function theme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  }

  // A tool result: structuredContent when the server sends it, else the JSON text Plinth returns.
  function parse(result) {
    if (!result || result.isError) return null;
    let r = result.structuredContent;
    if (!r) {
      const t = (result.content || []).find((c) => c && c.type === "text");
      try { r = t ? JSON.parse(t.text) : null; } catch { r = null; }
    }
    return r && typeof r === "object" ? r : null;
  }

  async function show(published) {
    if (started) return;
    started = true;
    $("meta").textContent = published.version ? "v" + published.version : "";
    try {
      const args = { id: published.id };
      if (Number.isInteger(published.version)) args.version = published.version;
      const link = parse(await request("tools/call", { name: TOOL, arguments: args }));
      if (!link || typeof link.preview_url !== "string") throw new Error("no link");
      $("title").textContent = link.title || "Plinth artifact";
      $("meta").textContent = "v" + link.version;
      pageUrl = link.url;
      $("open").hidden = !pageUrl;
      const frame = document.createElement("iframe");
      frame.title = link.title || "Plinth artifact";
      frame.setAttribute("sandbox", SANDBOX);
      frame.referrerPolicy = "no-referrer";
      frame.src = link.preview_url;
      $("stage").replaceChildren(frame);
      resize();
    } catch {
      if (typeof published.url === "string") {
        pageUrl = published.url;
        $("open").hidden = false;
      }
      note("The preview could not load here. Open the page on Plinth instead.");
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(m.error);
      else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case "ui/notifications/tool-result": {
        const r = parse(m.params);
        if (r && typeof r.id === "string") show(r);
        else note("Nothing was published.");
        break;
      }
      case "ui/notifications/tool-cancelled":
        if (!started) note("The publish was cancelled.");
        break;
      case "ui/notifications/host-context-changed":
        theme(m.params && m.params.theme);
        break;
      case "ui/resource-teardown":
      case "ping":
        if (m.id !== undefined) post({ id: m.id, result: {} });
        break;
    }
  });

  $("open").addEventListener("click", () => {
    if (pageUrl) request("ui/open-link", { url: pageUrl }).catch(() => {});
  });

  request("ui/initialize", {
    appCapabilities: {},
    appInfo: { name: "plinth-preview", version: "1.0.0" },
    protocolVersion: "2026-01-26",
  })
    .then((r) => {
      theme(r && r.hostContext && r.hostContext.theme);
      notify("ui/notifications/initialized", {});
      resize();
    })
    .catch(() => note("This app could not start here."));
})();
</script>
</body>
</html>
`;

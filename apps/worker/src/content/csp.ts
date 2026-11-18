// Headers for every response on a content host. The CSP is built from CDN_ALLOWLIST.
import { TYPED_SHELL_SCRIPT_SRC } from "@plinth/shared";
import type { Config } from "../config.ts";

/**
 * Sandbox flags for opaque content isolation (CONTENT_ISOLATION=opaque, and always with the path
 * fallback STAGING_CONTENT_FALLBACK). The CSP `sandbox` directive without allow-same-origin gives
 * every artifact document an opaque origin, even when opened outside the app's frame: artifact
 * script has no document.cookie, no localStorage or IndexedDB and no service workers, so it cannot
 * read or set cookies on a parent domain it shares with the app (cookie tossing), and in the path
 * fallback it cannot use the app origin's cookies or reach into another artifact's frame.
 */
export const OPAQUE_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * Options for one content response's CSP (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md).
 * `scripts: "self"` is for Plinth's own typed-artifact shell: it runs only the renderer from the
 * artifact's own origin, so its script-src is `'self'` and nothing else. `scripts: "none"` is for
 * every other file of a typed artifact (content.md, images): a doc runs no author script, so an
 * SVG image opened as a document cannot run any either. Every other directive, the opaque sandbox
 * included, is the same as for any artifact file.
 */
export interface ContentCspOptions {
  scripts?: "self" | "none";
  /**
   * Who may frame the response. "app" (the default): only the app, `frame-ancestors 'self'
   * <app>`. "any": no frame-ancestors at all, only for a request carrying an in-chat preview pass
   * (docs/security.md#in-chat-previews). An MCP host frames the preview from inside its own
   * sandboxed, opaque-origin frame, which no frame-ancestors source can name, and the pass behind
   * it is read-only, short-lived and carries no identity.
   */
  framing?: "app" | "any";
  /**
   * A public static file Plinth wrote (a renderer's script or style, runtime.js): no artifact
   * data, the same for every artifact, served without a cookie. It gets
   * `Cross-Origin-Resource-Policy: cross-origin`, so a page shown with an opaque origin (an MCP
   * host's sandbox, opaque isolation) can still load it from its own subdomain.
   */
  publicFile?: boolean;
  /**
   * The artifact's own WebSocket origin (`wss://<id>.<CONTENT_HOST>`, `ws://` under
   * PUBLIC_SCHEME=http), added to connect-src for its live room. Set only while rooms are active
   * and only on documents (HTML entries and the typed shell). CSP3 lets 'self' match a same-host
   * wss: URL, but older WebKit did not; naming the artifact's own origin reaches nothing new.
   */
  socket?: string;
}

/**
 * The hosts each CSP directive allows besides the artifact's own origin ('self'), always over
 * https. contentCsp builds the CSP from these, and publish warnings (services/publishCheck.ts) check
 * references against the same lists, so the two never disagree.
 */
export interface ContentSources {
  script: string[];
  style: string[];
  font: string[];
  img: string[];
  media: string[];
  connect: string[];
  frame: string[];
  worker: string[];
  manifest: string[];
  base: string[];
}

export function contentSources(config: Pick<Config, "cdnAllowlist">): ContentSources {
  return {
    script: [...config.cdnAllowlist],
    style: ["fonts.googleapis.com"],
    font: ["fonts.gstatic.com"],
    img: [],
    media: [],
    connect: [],
    frame: [],
    worker: [],
    manifest: [],
    base: [],
  };
}

const https = (hosts: string[]) => hosts.map((h) => ` https://${h}`).join("");

function scriptSrc(sources: ContentSources, scripts: ContentCspOptions["scripts"]): string {
  if (scripts === "self") return TYPED_SHELL_SCRIPT_SRC;
  if (scripts === "none") return "script-src 'none'";
  return `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'${https(sources.script)}`;
}

export function contentCsp(config: Config, opts: ContentCspOptions = {}): string {
  const s = contentSources(config);
  const directives = [
    "default-src 'none'",
    scriptSrc(s, opts.scripts),
    `style-src 'self' 'unsafe-inline'${https(s.style)}`,
    `font-src 'self'${https(s.font)} data:`,
    `img-src 'self'${https(s.img)} data: blob:`,
    `media-src 'self'${https(s.media)} data: blob:`,
    `connect-src 'self'${https(s.connect)}${opts.socket ? ` ${opts.socket}` : ""}`,
    `worker-src 'self'${https(s.worker)} blob:`,
    "child-src 'self' blob:",
    `frame-src 'self'${https(s.frame)} blob:`,
    `manifest-src 'self'${https(s.manifest)}`,
    "object-src 'none'",
    `base-uri 'self'${https(s.base)}`,
    "form-action 'self'",
  ];
  if (opts.framing !== "any") directives.push(`frame-ancestors 'self' ${config.appOrigin}`);
  if (config.contentIsolation === "opaque") directives.push(OPAQUE_SANDBOX);
  return directives.join("; ");
}

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "attribution-reporting=()",
  "autoplay=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "identity-credentials-get=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "otp-credentials=()",
  "payment=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "storage-access=()",
  "usb=()",
  "window-management=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * Cross-Origin-Resource-Policy for content responses. `same-origin` keeps every other origin from
 * loading an artifact's files as images, scripts or styles. An opaque-origin document is
 * same-origin with nothing, so under opaque isolation `same-origin` would block the artifact's own
 * stylesheets, scripts and images too; there it is `cross-origin`. Other sites still get nothing:
 * every file needs the content cookie, which is host-only and partitioned by the top-level site
 * (the app's), and every artifact's CSP limits its own loads to 'self' and the CDN allowlist.
 */
export function contentResourcePolicy(
  config: Config,
  opts: ContentCspOptions = {},
): "same-origin" | "cross-origin" {
  // An MCP host's sandbox gives the previewed document an opaque origin too.
  return config.contentIsolation === "opaque" || opts.framing === "any" || opts.publicFile
    ? "cross-origin"
    : "same-origin";
}

/**
 * Applied to every content-host response, including redirects and errors. Content is not indexed
 * unless the artifact is public (serve.ts removes X-Robots-Tag for public artifact files).
 */
export function applyContentHeaders(
  config: Config,
  headers: Headers,
  opts: ContentCspOptions = {},
): void {
  headers.set("Content-Security-Policy", contentCsp(config, opts));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", contentResourcePolicy(config, opts));
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "private, no-cache");
}

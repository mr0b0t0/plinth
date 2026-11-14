// Headers for every response on a content host. The CSP is built from CDN_ALLOWLIST.
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
 * Options for one content response's CSP. `scripts: "self"` is for Plinth's own typed-artifact
 * shell (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md): it runs only the
 * renderer from the artifact's own origin, so its script-src is `'self'` and nothing else. Every
 * other directive, the opaque sandbox included, is the same as for any artifact file.
 */
export interface ContentCspOptions {
  scripts?: "self";
}

export function contentCsp(config: Config, opts: ContentCspOptions = {}): string {
  const cdn = config.cdnAllowlist.map((h) => `https://${h}`).join(" ");
  const directives = [
    "default-src 'none'",
    opts.scripts === "self"
      ? "script-src 'self'"
      : `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${cdn}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors 'self' ${config.appOrigin}`,
  ];
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
export function contentResourcePolicy(config: Config): "same-origin" | "cross-origin" {
  return config.contentIsolation === "opaque" ? "cross-origin" : "same-origin";
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
  headers.set("Cross-Origin-Resource-Policy", contentResourcePolicy(config));
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "private, no-cache");
}

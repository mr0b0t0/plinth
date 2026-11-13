// Headers for every response on a content host. The CSP is built from CDN_ALLOWLIST.
import type { Config } from "../config.ts";

/**
 * Sandbox flags for the path fallback (STAGING_CONTENT_FALLBACK). There every artifact is served
 * from the app's own origin, so the CSP `sandbox` directive (no allow-same-origin) gives each
 * document an opaque origin: artifact script cannot read the app's cookies, call the API with them,
 * or reach into another artifact's frame. Never used with per-artifact subdomains.
 */
export const FALLBACK_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export function contentCsp(config: Config): string {
  const cdn = config.cdnAllowlist.map((h) => `https://${h}`).join(" ");
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${cdn}`,
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
  if (config.contentPathFallback) directives.push(FALLBACK_SANDBOX);
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
 * Applied to every content-host response, including redirects and errors. Content is not indexed
 * unless the artifact is public (serve.ts removes X-Robots-Tag for public artifact files).
 */
export function applyContentHeaders(config: Config, headers: Headers): void {
  headers.set("Content-Security-Policy", contentCsp(config));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "private, no-cache");
}

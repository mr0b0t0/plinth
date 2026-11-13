// Headers for every response on a content host. The CSP is built from CDN_ALLOWLIST.
import type { Config } from "../config.ts";

export function contentCsp(config: Config): string {
  const cdn = config.cdnAllowlist.map((h) => `https://${h}`).join(" ");
  return [
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
  ].join("; ");
}

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "bluetooth=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "identity-credentials-get=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export function applyContentHeaders(config: Config, headers: Headers): void {
  headers.set("Content-Security-Policy", contentCsp(config));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "private, no-cache");
}

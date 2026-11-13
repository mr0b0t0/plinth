// Security headers for app-host responses (the SPA and its assets).
import type { Config } from "../config.ts";

export function appCsp(config: Config): string {
  const frames = config.contentPathFallback
    ? "'self'"
    : `${config.scheme}://*.${config.contentHost}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Monaco and React inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${frames}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function applyAppHeaders(config: Config, headers: Headers): void {
  headers.set("Content-Security-Policy", appCsp(config));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (config.scheme === "https") headers.set("Strict-Transport-Security", "max-age=31536000");
}

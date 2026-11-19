// Security headers for app-host responses (the SPA and its assets).
import { type Config, dictationActive } from "../config.ts";

export function appCsp(config: Config): string {
  // Artifacts are framed from their own content subdomains only (the path fallback serves them
  // from the app origin under a CSP sandbox; see content/csp.ts).
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

/**
 * The app's Permissions-Policy. It is also the ceiling for every frame on an app page: a feature
 * the app does not allow, no artifact frame can have, whatever its `allow` attribute says. The
 * microphone is allowed only while dictation is active, and then only for the app's own origin
 * (`self`, never the content host, never `*`): the app runs the recognizer, frames keep `allow=""`
 * and the content host keeps microphone=(), so an artifact never reaches the microphone.
 */
export function appPermissionsPolicy(
  config: Pick<Config, "allowDictation" | "contentIsolation">,
): string {
  const mic = dictationActive(config) ? "microphone=(self)" : "microphone=()";
  return `camera=(), ${mic}, geolocation=(), payment=(), usb=()`;
}

export function applyAppHeaders(config: Config, headers: Headers): void {
  headers.set("Content-Security-Policy", appCsp(config));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", appPermissionsPolicy(config));
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // No other site (artifacts included) may embed the app's responses as images, scripts or media.
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (config.scheme === "https") headers.set("Strict-Transport-Security", "max-age=31536000");
}

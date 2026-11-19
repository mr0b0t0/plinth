// Pure helpers for the viewer gate (GET /api/v1/view/:ref and its password/email/code steps).
import { API, type AppConfig, route } from "@plinth/shared";
import { ApiRequestError } from "../../lib/api.ts";

export interface GateQuery {
  /** A specific version (permanent version links). */
  version?: number;
  /** Review mode: the content includes the comment-anchoring bridge. */
  review?: boolean;
  /** A path inside the artifact to land on (direct content links). */
  next?: string;
  /** `next` was carried from an older version: the gate lands on the root if it is gone. */
  carried?: boolean;
}

/** The query string the gate endpoints read (GET and the POST steps take the same one). */
export function gateQueryString(q: GateQuery = {}): string {
  const p = new URLSearchParams();
  if (q.version !== undefined) p.set("version", String(q.version));
  if (q.review) p.set("review", "1");
  if (q.next) p.set("next", q.next);
  if (q.next && q.carried) p.set("carried", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

type GateStep = "view" | "viewPassword" | "viewEmail" | "viewCode";

/** Path under /api/v1 for one gate step, with the query. */
export function gatePath(step: GateStep, ref: string, q: GateQuery = {}): string {
  return `${route(API[step], { ref })}${gateQueryString(q)}`;
}

/** Parse a positive version number from a route param; undefined when absent or invalid. */
export function parseVersion(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

/**
 * The content origin an enter URL points at (the artifact's own subdomain, or the app origin in
 * the staging path fallback). Falls back to building it from the config.
 */
export function contentOriginOf(
  enterUrl: string,
  artifactId: string,
  config: AppConfig | null,
): string {
  try {
    return new URL(enterUrl).origin;
  } catch {
    if (!config) return "";
    return config.content_path_fallback
      ? config.app_origin
      : `${config.content_protocol}//${artifactId}.${config.content_host}`;
  }
}

/** Absolute app link to an artifact (what Share copies). */
export function shareLink(appOrigin: string, slug: string, version?: number): string {
  const base = `${appOrigin.replace(/\/$/, "")}/a/${encodeURIComponent(slug)}`;
  return version === undefined ? base : `${base}/v/${version}`;
}

/** Turn a failed gate step into a sentence for the form. */
export function gateErrorMessage(err: unknown, step: "password" | "email" | "code"): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "rate_limited") {
      return step === "password"
        ? "Too many attempts. Wait a while, then try again."
        : "Too many requests. Wait a while, then try again.";
    }
    if (step === "password" && err.code === "forbidden") return "That password is not right.";
    if (step === "code" && err.code === "forbidden")
      return "That code did not work. Check it, or ask for a new one.";
    if (err.code === "invalid_input") {
      if (step === "email") return "Enter a valid email address.";
      if (step === "code") return "Enter the six digits from the email.";
      return "Enter the password.";
    }
    if (err.code === "not_found") return "This artifact is no longer available.";
  }
  return "Something went wrong. Try again.";
}

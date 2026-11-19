// Page requests (docs/spec.md "Page requests"): a page that declares `requests` lets the person
// viewing it hand a piece of work to the owner's agent. A request is a root comment of kind
// `page_request` with exactly one mention task, so it lands in the same pull queue as `@claude`
// comments. Pure code, used by the Worker, the page runtime's tests and the web app.
import { z } from "zod";
import { type MentionState, PAGE_REQUEST_TO_RE } from "./constants.ts";
import { type Capabilities, dataObjectWithin } from "./data.ts";

export { PAGE_REQUEST_TO_RE, REQUESTS_TO_META } from "./constants.ts";

/** Fixed rules (the env-var limits are PAGE_REQUEST_DEFAULTS, within PAGE_REQUEST_BOUNDS). */
export const PAGE_REQUEST_LIMITS = {
  /** A request's text, after trimming. */
  maxBodyChars: 4000,
  /** The JSON object a page may attach, in UTF-8 bytes of its JSON. */
  maxDataBytes: 8192,
  /** Open (pending or claimed) requests one person may have on one artifact. */
  maxOpenPerRequester: 3,
  /** Requests GET /requests returns, newest first. */
  listed: 20,
  /** Agent answers returned per request, the newest ones, oldest first. */
  answers: 5,
  /** JSON body cap on POST /requests, whatever Content-Length says. */
  bodyCapBytes: 32 * 1024,
  /** Seconds a refused request is told to wait when an open-request cap is full. */
  openRetryAfterS: 600,
} as const;

/** Defaults of the PAGE_REQUESTS_* env vars. */
export const PAGE_REQUEST_DEFAULTS = {
  perViewerPerHour: 10,
  perArtifactPerHour: 60,
  maxOpenPerArtifact: 25,
} as const;

/** Inclusive bounds of the PAGE_REQUESTS_* env vars. */
export const PAGE_REQUEST_BOUNDS = {
  perViewerPerHour: [1, 100],
  perArtifactPerHour: [1, 1000],
  maxOpenPerArtifact: [1, 500],
} as const satisfies Record<keyof typeof PAGE_REQUEST_DEFAULTS, readonly [number, number]>;

/**
 * The body of POST /__plinth/api/v1/requests. Strict: an author, role, target connection or state
 * field is refused, so the server alone stamps who filed it and where it goes.
 */
export const pageRequestInput = z.strictObject({
  body: z.string().trim().min(1).max(PAGE_REQUEST_LIMITS.maxBodyChars),
  data: dataObjectWithin(PAGE_REQUEST_LIMITS.maxDataBytes).optional(),
  to: z.string().regex(PAGE_REQUEST_TO_RE).optional(),
});
export type PageRequestInput = z.infer<typeof pageRequestInput>;

/** The page's declared default target (plinth-requests-to), or null. */
export function requestTarget(caps: Capabilities | null): string | null {
  return caps?.requests === true ? (caps.requestsTo[0] ?? null) : null;
}

/** Why page requests are not available to this page (GET /requests answers it). */
export type PageRequestUnavailableReason =
  | "opaque_isolation"
  | "disabled"
  | "not_declared"
  | "preview"
  | "not_identified";

export type PageRequestState = MentionState;

/** One answer the owner's agent wrote. No author field of any kind. */
export interface PageRequestAnswer {
  body: string;
  created_at: string;
}

/**
 * One request as its requester's page sees it. It carries no author of anything: no email, name,
 * label or role of anyone (the page learns who is viewing only through the data session, and who
 * wrote a document only through shared data with `viewer`). Bodies are untrusted text: render them
 * with textContent.
 */
export interface PageRequest {
  id: string;
  state: PageRequestState;
  /** The thread was resolved (dismissed or withdrawn). Who resolved it is not said. */
  resolved: boolean;
  /** The target the page chose, as "@claude". */
  to: string;
  /** The page's own text. */
  body: string;
  /** The page's own data, or null. */
  data: Record<string, unknown> | null;
  /** The version current when it was filed. */
  version: number;
  /** The version the agent published for it, if any. */
  result_version: number | null;
  created_at: string;
  completed_at: string | null;
  /** Answers written by the owner's agents (policy.ts pageSeesAnswer), oldest first. */
  answers: PageRequestAnswer[];
}

/** GET /__plinth/api/v1/requests. Always 200 once the caller checks pass. */
export type PageRequestsInfo =
  | { available: false; reason: PageRequestUnavailableReason }
  | {
      available: true;
      reason: null;
      /**
       * The caller's own right (owner, editor or commenter). Like the data session's viewer role,
       * it is about the viewer themselves, not anyone else.
       */
      can_file: boolean;
      /** The declared default target, or null. */
      to: string | null;
      limits: {
        max_body_chars: number;
        max_data_bytes: number;
        per_hour: number;
        max_open: number;
      };
      requests: PageRequest[];
    };

/**
 * What the viewer is told about page requests (GET /view/:ref): present only while page requests
 * are active, on an HTML artifact whose current version declares `requests`, for an identified
 * viewer. The email goes to the app, never to the framed page.
 */
export interface ViewGateRequests {
  /** This viewer may file (the owner, an editor or a commenter). */
  can_file: boolean;
  /** The email requests are filed under: the one sealed into this viewer's content pass. */
  email: string;
}

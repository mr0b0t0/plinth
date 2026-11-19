// The page-requests routes of the data API (docs/spec.md "Page requests"), under
// /__plinth/api/v1/requests. They are rows of DATA_API_ROUTES (content/data-api.ts) with their own
// steps, as the live room's and the files' are: the dispatcher runs checks 1 to 4 (method,
// x-plinth-data, fetch metadata, exact Origin, which POST must send) and the JSON type of check 6
// before any handler here, so no request route can skip them. Then, in this order:
//   1. availability: ALLOW_PAGE_REQUESTS with origin isolation (pageRequestsActive);
//   2. the artifact, with its type, current version, epoch and current version's declaration;
//   3. the content pass for it at its current epoch: a JSON 401, never the gate redirect;
//   4. the pass kind: an in-chat preview is `preview`, a thumbnail capture or a pass without a
//      claim is `not_identified`;
//   5. the declaration (`requests`, HTML only);
//   6. policy (policy.ts pageRequestAccess); a POST without the filing right is 403 cannot_file;
//   7. only now the body (JSON only, capped at PAGE_REQUEST_LIMITS.bodyCapBytes while reading),
//      parsed strictly;
//   8. the service (services/pageRequests.ts): rate limits, the target, the guarded insert; or
//      the caller's own requests through pageSeesRequest and pageSeesAnswer.
// While requests are unavailable, GET /requests answers 200 `{ available: false, reason }`, a POST
// 403 feature_disabled and GET /requests/<id> 404, each with the reason. Bodies and data are never
// logged.
import {
  type ArtifactType,
  PAGE_REQUEST_LIMITS,
  type PageRequestsInfo,
  type PageRequestUnavailableReason,
  pageRequestInput,
  requestTarget,
} from "@plinth/shared";
import { pageRequestsActive } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { type PageClaim, type PageRequestAccess, pageRequestAccess } from "../policy.ts";
import { versionCapabilities } from "../services/artifacts.ts";
import {
  fileRequest,
  getOwnRequest,
  listOwnRequests,
  type RequestTarget,
} from "../services/pageRequests.ts";
import { type OwnRouteCtx, parseBody, readJsonBody, respond } from "./data-api.ts";
import { passKindOf } from "./files.ts";
import { readContentPass } from "./serve.ts";

/** A request id: the shape newId() makes, and nothing else reaches a query. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function matchRequests(seg: string[]): Record<string, string> | null {
  return seg.length === 1 && seg[0] === "requests" ? {} : null;
}

export function matchRequest(seg: string[]): Record<string, string> | null {
  return seg.length === 2 && seg[0] === "requests" && REQUEST_ID_RE.test(seg[1] ?? "")
    ? { id: seg[1] as string }
    : null;
}

/** Check 6 for a POST: a JSON body, refused past the cap whether or not a length was sent. */
export function readRequestBody(request: Request): Promise<unknown> {
  return readJsonBody(request, PAGE_REQUEST_LIMITS.bodyCapBytes);
}

interface Caller {
  target: RequestTarget;
  claim: PageClaim;
  access: PageRequestAccess;
}

/** Steps 1 to 6: the caller, or why page requests are unavailable to it. */
async function requestsCaller(c: OwnRouteCtx): Promise<Caller | PageRequestUnavailableReason> {
  if (!pageRequestsActive(c.config)) {
    return c.config.contentIsolation === "origin" ? "disabled" : "opaque_isolation";
  }
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.owner_id, a.type, a.current_version, a.access_epoch, a.taken_down_at,
            v.capabilities
       FROM artifacts a
       LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
      WHERE a.id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(c.artifactId)
    .first<{
      id: string;
      owner_id: string;
      type: string;
      current_version: number;
      access_epoch: number;
      taken_down_at: string | null;
      capabilities: string | null;
    }>();
  if (!row || row.taken_down_at) throw new ApiError("not_found", "Not found");
  const pass = await readContentPass(c.request, c.config, {
    id: row.id,
    accessEpoch: row.access_epoch,
  });
  if (!pass) {
    throw new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }
  const kind = passKindOf(pass);
  if (kind === "preview") return "preview";
  if (kind === "capture" || !pass.claim) return "not_identified";
  const caps = versionCapabilities(row);
  if (row.type !== "html" || caps?.requests !== true) return "not_declared";
  const access = pageRequestAccess(pass.claim, caps, {
    active: true,
    type: row.type as ArtifactType,
    pass: kind,
  });
  if (!access.readOwn) return "not_declared";
  return {
    target: {
      id: row.id,
      ownerId: row.owner_id,
      currentVersion: row.current_version,
      accessEpoch: row.access_epoch,
      caps,
    },
    claim: pass.claim,
    access,
  };
}

const unavailableError = (method: string, reason: PageRequestUnavailableReason) =>
  method === "GET"
    ? new ApiError("not_found", "Not found", { reason })
    : new ApiError("feature_disabled", "Requests are not available on this page", { reason });

/** GET /requests (the caller's own, and whether they may file) and POST /requests (file one). */
export async function requestsRoute(c: OwnRouteCtx): Promise<Response> {
  const k = await requestsCaller(c);
  if (typeof k === "string") {
    if (c.request.method === "GET") {
      return respond(c.config, 200, { available: false, reason: k } satisfies PageRequestsInfo);
    }
    throw unavailableError(c.request.method, k);
  }
  if (c.request.method === "POST") {
    if (!k.access.file) {
      throw new ApiError(
        "forbidden",
        "Only people who can comment can send requests from this page",
        {
          reason: "cannot_file",
        },
      );
    }
    const input = parseBody(pageRequestInput, await c.readBody());
    const filed = await fileRequest(c.env.DB, c.config, k.target, k.claim, k.access, input);
    return respond(c.config, 201, filed);
  }
  const info: PageRequestsInfo = {
    available: true,
    reason: null,
    can_file: k.access.file,
    to: requestTarget(k.target.caps),
    limits: {
      max_body_chars: PAGE_REQUEST_LIMITS.maxBodyChars,
      max_data_bytes: PAGE_REQUEST_LIMITS.maxDataBytes,
      per_hour: c.config.pageRequests.perViewerPerHour,
      max_open: PAGE_REQUEST_LIMITS.maxOpenPerRequester,
    },
    requests: await listOwnRequests(c.env.DB, k.target, k.claim, k.access),
  };
  return respond(c.config, 200, info);
}

/** GET /requests/<id>: one of the caller's own, else 404 whether or not it exists. */
export async function requestRoute(c: OwnRouteCtx): Promise<Response> {
  const k = await requestsCaller(c);
  if (typeof k === "string") throw unavailableError("GET", k);
  const one = await getOwnRequest(c.env.DB, k.target, k.claim, k.access, c.params.id as string);
  if (!one) throw new ApiError("not_found", "Request not found");
  return respond(c.config, 200, one);
}

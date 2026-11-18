// The shared-data API on an artifact's own content origin: /__plinth/api/v1/... (docs/spec.md
// "Shared data and viewer identity"). The page calls it with fetch from its own origin, so the
// CSP's connect-src 'self' already allows it: no CORS, no app cookies, no new CSP sources.
//
// The content host stops being GET-only here, and every artifact framed by the app shares one
// partitioned cookie jar with a SameSite=None content cookie, so another artifact could otherwise
// make credentialed requests to this one. The checks below, in this order, are load-bearing:
//   1. method: GET, POST, PUT, DELETE only; OPTIONS and the rest get 405 and no CORS headers, so
//      every cross-origin preflight fails;
//   2. the x-plinth-data header, which is not CORS-safelisted (forms, beacons, <img>, <script>
//      and navigations cannot send it, and a cross-origin fetch with it needs that preflight);
//   3. fetch metadata, when sent: Sec-Fetch-Site same-origin, Sec-Fetch-Dest empty, never a
//      navigation;
//   4. Origin, when sent, exactly this artifact's content origin ("null" refused);
//   5. availability (opaque isolation or ALLOW_SHARED_DATA off);
//   6. JSON bodies only, size-capped while reading, strict shapes (no author fields);
//   7. the artifact, with its current version's declaration;
//   8. the content pass (cookie for this artifact at its current epoch); a JSON 401, never the
//      gate redirect;
//   9. the declaration (`data`);
//  10. policy (policy.ts, through services/data.ts), rate limits, quotas, the guarded write.
// Bodies and document contents are never logged.
import { CONTENT_DATA_HEADER, CONTENT_RESERVED_PREFIX, dataObjectSchema } from "@plinth/shared";
import { z } from "zod";
import { type Bindings, type Config, contentOrigin, sharedDataActive } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { pageDataAccess } from "../policy.ts";
import { versionCapabilities } from "../services/artifacts.ts";
import {
  changes,
  createDoc,
  type DataTarget,
  type DataWriter,
  deleteDoc,
  getDoc,
  listDocs,
  putDoc,
  resolveDocId,
  session,
  toPageDoc,
  unavailableReason,
} from "../services/data.ts";
import { applyContentHeaders } from "./csp.ts";
import type { HostRoute } from "./serve.ts";
import { readContentPass } from "./serve.ts";

export const DATA_API_PREFIX = `${CONTENT_RESERVED_PREFIX}api/`;
const V1 = `${CONTENT_RESERVED_PREFIX}api/v1/`;
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

const postBody = z.strictObject({ data: dataObjectSchema });
const putBody = z.strictObject({
  data: dataObjectSchema,
  if_rev: z.number().int().min(0).optional(),
});

function respond(config: Config, status: number, body: unknown, extra?: Record<string, string>) {
  const headers = new Headers(extra);
  applyContentHeaders(config, headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function errorResponse(config: Config, e: ApiError): Response {
  const extra: Record<string, string> = {};
  const d = e.details as { retry_after?: number } | undefined;
  if (e.code === "rate_limited" && d?.retry_after) extra["Retry-After"] = String(d.retry_after);
  return respond(config, e.status, e.toBody(), extra);
}

const refuse = (message: string) => new ApiError("forbidden", message);

type Route =
  | { kind: "session" }
  | { kind: "changes" }
  | { kind: "collection"; collection: string }
  | { kind: "doc"; collection: string; docId: string };

const ROUTE_METHODS: Record<Route["kind"], ReadonlySet<string>> = {
  session: new Set(["GET"]),
  changes: new Set(["GET"]),
  collection: new Set(["GET", "POST"]),
  doc: new Set(["GET", "PUT", "DELETE"]),
};

function parseRoute(path: string): Route | null {
  if (!path.startsWith(V1)) return null;
  const parts = path.slice(V1.length).split("/");
  const seg: string[] = [];
  for (const p of parts) {
    try {
      seg.push(decodeURIComponent(p));
    } catch {
      throw new ApiError("invalid_input", "Bad path");
    }
  }
  if (seg.length === 1 && seg[0] === "session") return { kind: "session" };
  if (seg.length === 1 && seg[0] === "changes") return { kind: "changes" };
  if (seg[0] === "data" && seg.length === 2 && seg[1])
    return { kind: "collection", collection: seg[1] };
  if (seg[0] === "data" && seg.length === 3 && seg[1] && seg[2])
    return { kind: "doc", collection: seg[1], docId: seg[2] };
  return null;
}

/** Checks 2 to 4: the request must come from this artifact's own page, by fetch. */
function checkCaller(request: Request, config: Config, artifactId: string): void {
  const h = request.headers;
  if (h.get(CONTENT_DATA_HEADER) !== "1") throw refuse(`Missing ${CONTENT_DATA_HEADER} header`);
  const site = h.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw refuse("Cross-origin requests are refused");
  const dest = h.get("sec-fetch-dest");
  if (dest !== null && dest !== "empty") throw refuse("Only fetch requests are allowed");
  if (h.get("sec-fetch-mode") === "navigate") throw refuse("Navigations are refused");
  const origin = h.get("origin");
  if (origin !== null && origin !== contentOrigin(config, artifactId)) {
    throw refuse("Cross-origin requests are refused");
  }
}

/** Check 6: a JSON body, refused past `cap` bytes whether or not a length was sent. */
async function readJsonBody(request: Request, cap: number): Promise<unknown> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError("invalid_input", "Send a JSON body with Content-Type: application/json");
  }
  const tooLarge = () => new ApiError("payload_too_large", "The request body is too large");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > cap)) {
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ApiError("invalid_input", "The body is not valid JSON");
  }
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ApiError("invalid_input", `${where}${issue?.message ?? "Invalid body"}`);
  }
  return r.data;
}

function intParam(v: string | null, name: string, min: number, max: number): number | undefined {
  if (v === null) return undefined;
  const n = /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= min && n <= max)) throw new ApiError("invalid_input", `${name}: ${min} to ${max}`);
  return n;
}

/** Check 7: the artifact and its current version's declaration, in one query. */
async function loadTarget(env: Bindings, artifactId: string) {
  const row = await env.DB.prepare(
    `SELECT a.id, a.owner_id, a.access_epoch, a.taken_down_at, v.capabilities
       FROM artifacts a
       LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
      WHERE a.id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(artifactId)
    .first<{
      id: string;
      owner_id: string;
      access_epoch: number;
      taken_down_at: string | null;
      capabilities: string | null;
    }>();
  if (!row || row.taken_down_at) return null;
  return {
    id: row.id,
    accessEpoch: row.access_epoch,
    target: {
      id: row.id,
      ownerId: row.owner_id,
      caps: versionCapabilities(row),
    } satisfies DataTarget,
  };
}

export async function serveDataApi(
  request: Request,
  env: Bindings,
  config: Config,
  route: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  try {
    return await handle(request, env, config, route);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(config, e);
    console.error("data api error:", e instanceof Error ? e.message : "unknown");
    return respond(config, 500, new ApiError("internal", "Something went wrong").toBody());
  }
}

async function handle(
  request: Request,
  env: Bindings,
  config: Config,
  { artifactId, path }: Extract<HostRoute, { kind: "content" }>,
): Promise<Response> {
  const method = request.method;
  const notAllowed = () => {
    const e = new ApiError("invalid_input", "Method not allowed");
    return respond(config, 405, e.toBody(), { Allow: "GET, POST, PUT, DELETE" });
  };
  // 1. Method.
  if (!METHODS.has(method)) return notAllowed();
  // 2 to 4. Caller.
  checkCaller(request, config, artifactId);
  const route = parseRoute(path);
  if (!route) throw new ApiError("not_found", "Not found");
  if (!ROUTE_METHODS[route.kind].has(method)) return notAllowed();

  // 5. Availability, before any cookie: under opaque isolation there are none.
  const off = unavailableReason(config, null, { assumeDeclared: true });
  if (off) {
    if (route.kind === "session") return respond(config, 200, { available: false, reason: off });
    throw new ApiError("feature_disabled", "Shared data is not available here", { reason: off });
  }

  // 6. Body.
  let body: unknown;
  if (method === "POST" || method === "PUT") {
    body = await readJsonBody(request, config.data.maxDocBytes + 1024);
  }

  // 7. Artifact.
  const loaded = await loadTarget(env, artifactId);
  if (!loaded) throw new ApiError("not_found", "Not found");
  const { target } = loaded;

  // 8. Access.
  const pass = await readContentPass(request, config, loaded);
  if (!pass) {
    throw new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }

  // 9. Declaration. An in-chat preview (an MCP host's frame, any framer) never reads or writes
  // shared data: its pass carries no identity and is meant for one look at the page.
  const reason = pass.preview ? "preview" : unavailableReason(config, target.caps);
  if (reason) {
    if (route.kind === "session") return respond(config, 200, { available: false, reason });
    const message =
      reason === "preview"
        ? "Shared data is not available in a preview"
        : "This page does not use shared data";
    throw new ApiError("feature_disabled", message, { reason });
  }

  // 10. Policy, then the service (rate limits, quotas, guarded writes).
  const { claim } = pass;
  const access = pageDataAccess(claim, target.caps, sharedDataActive(config));
  if (!access.read) throw new ApiError("feature_disabled", "Shared data is not available here");
  const writer: DataWriter | null =
    access.write && claim
      ? { email: claim.email, role: claim.role, viewerId: claim.viewerId, via: "page" }
      : null;
  const d1 = env.DB;
  const url = new URL(request.url);
  const view = (row: Parameters<typeof toPageDoc>[0]) => toPageDoc(row, claim, access.seeIdentity);

  switch (route.kind) {
    case "session":
      return respond(config, 200, await session(d1, config, target, claim));
    case "changes":
      return respond(config, 200, await changes(d1, target.id));
    case "collection": {
      if (method === "POST") {
        const { data } = parseBody(postBody, body);
        return respond(
          config,
          201,
          view(await createDoc(d1, config, target, writer, route.collection, data)),
        );
      }
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && cursor.length > 400) throw new ApiError("invalid_input", "Bad cursor");
      const page = await listDocs(d1, target.id, route.collection, {
        limit: intParam(url.searchParams.get("limit"), "limit", 1, 200) ?? 50,
        cursor,
      });
      return respond(config, 200, { docs: page.docs.map(view), next_cursor: page.next_cursor });
    }
    case "doc": {
      if (method === "GET") {
        const docId = resolveDocId(route.docId, claim?.viewerId ?? null);
        const row = docId ? await getDoc(d1, target.id, route.collection, docId) : null;
        if (!row) throw new ApiError("not_found", "Document not found");
        return respond(config, 200, view(row));
      }
      if (method === "PUT") {
        const { data, if_rev } = parseBody(putBody, body);
        const r = await putDoc(
          d1,
          config,
          target,
          writer,
          route.collection,
          route.docId,
          data,
          if_rev,
        );
        return respond(config, r.created ? 201 : 200, view(r.doc));
      }
      const ifRev = intParam(url.searchParams.get("if_rev"), "if_rev", 1, 999_999_999);
      await deleteDoc(d1, config, target, writer, route.collection, route.docId, ifRev);
      return respond(config, 204, null);
    }
  }
}

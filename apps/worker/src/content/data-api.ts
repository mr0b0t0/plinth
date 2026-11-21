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
//   6. the artifact, with its current version's declaration and type;
//   7. JSON bodies only, size-capped while reading at that type's document cap plus 1 KiB (a
//      whiteboard's DATA_BOARD_MAX_DOC_BYTES, else DATA_MAX_DOC_BYTES), strict shapes (no author
//      fields);
//   8. the content pass (cookie for this artifact at its current epoch); a JSON 401, never the
//      gate redirect;
//   9. the declaration (`data`);
//  10. policy (policy.ts, through services/data.ts), rate limits, quotas, the guarded write.
// Bodies and document contents are never logged. Routes are entries of DATA_API_ROUTES, and the
// dispatcher runs these checks before any handler, so a route cannot skip them.
//
// GET /__plinth/api/v1/people and /people/<u_id> (who has access, owners and editors on a page that
// declares `data viewer people`) run checks 1 to 10, then their own steps in content/people.ts.
//
// GET /__plinth/api/v1/room (live rooms, #36) shares checks 1 to 4, then branches to roomInfo()
// in content/room.ts, which has its own availability, artifact, pass and policy steps: a page
// that declares only `room` has no shared data, and rooms may be on where shared data is off.
import { waitUntil } from "cloudflare:workers";
import {
  CONTENT_DATA_HEADER,
  CONTENT_RESERVED_PREFIX,
  dataObjectSchema,
  type PageDoc,
} from "@plinth/shared";
import { z } from "zod";
import {
  type Bindings,
  type Config,
  contentOrigin,
  dataLimitsFor,
  sharedDataActive,
} from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { type PageClaim, pageDataAccess } from "../policy.ts";
import { notifyViewers } from "../rooms/notify.ts";
import { servedVersionWriters, versionCapabilities } from "../services/artifacts.ts";
import {
  changes,
  createDoc,
  type DataTarget,
  type DataWriter,
  deleteDoc,
  getDoc,
  listDocs,
  pageNames,
  putDoc,
  resolveDocId,
  type StoredDoc,
  session,
  toPageDoc,
  unavailableReason,
} from "../services/data.ts";
import { applyContentHeaders } from "./csp.ts";
import { getPersonRoute, listPeopleRoute } from "./people.ts";
import { roomInfo } from "./room.ts";
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

/** The decoded path segments after /__plinth/api/v1/, or null outside it. */
function pathSegments(path: string): string[] | null {
  if (!path.startsWith(V1)) return null;
  const seg: string[] = [];
  for (const p of path.slice(V1.length).split("/")) {
    try {
      seg.push(decodeURIComponent(p));
    } catch {
      throw new ApiError("invalid_input", "Bad path");
    }
  }
  return seg;
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

/**
 * Check 7: the artifact and its current version's declaration, in one query, and on a page that
 * declares `people` the writers of every version this origin serves (policy.ts peopleListOffered:
 * any of them may be the code calling, since all share the origin and the pass).
 */
async function loadTarget(env: Bindings, artifactId: string) {
  const row = await env.DB.prepare(
    `SELECT a.id, a.owner_id, a.type, a.access_epoch, a.taken_down_at, v.capabilities
       FROM artifacts a
       LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
      WHERE a.id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(artifactId)
    .first<{
      id: string;
      owner_id: string;
      type: string;
      access_epoch: number;
      taken_down_at: string | null;
      capabilities: string | null;
    }>();
  if (!row || row.taken_down_at) return null;
  const caps = versionCapabilities(row);
  return {
    id: row.id,
    accessEpoch: row.access_epoch,
    target: {
      id: row.id,
      ownerId: row.owner_id,
      caps,
      writers: caps?.people ? await servedVersionWriters(env.DB, row.id) : null,
      type: row.type,
    } satisfies DataTarget,
  };
}

// ---------- routes ----------

/** What a handler on the shared-data pipeline gets, after checks 1 to 10 passed. */
export interface DataRouteCtx {
  request: Request;
  env: Bindings;
  config: Config;
  method: string;
  url: URL;
  params: Record<string, string>;
  /** The parsed JSON body (check 6) for POST and PUT, else undefined. */
  body: unknown;
  target: DataTarget;
  claim: PageClaim | null;
  access: ReturnType<typeof pageDataAccess>;
  /** The page writer, or null for a read-only caller. */
  writer: DataWriter | null;
  /** A document as this reader sees it, with its authors' names when it may see authors. */
  view: (row: StoredDoc) => Promise<PageDoc>;
  /** Documents as this reader sees them, with one names read for all of them. */
  views: (rows: readonly StoredDoc[]) => Promise<PageDoc[]>;
}

/** What a handler with its own steps gets, after checks 1 to 4 (and 6) passed. */
export interface OwnRouteCtx {
  request: Request;
  env: Bindings;
  config: Config;
  artifactId: string;
  params: Record<string, string>;
  /** The parsed JSON body (check 6) for POST and PUT, else undefined. */
  body: unknown;
}

interface RouteBase {
  kind: string;
  /** The route's params from the decoded segments after v1/, or null when it does not match. */
  match: (seg: string[]) => Record<string, string> | null;
  methods: readonly string[];
  /** An example path after v1/, for the test that runs every check on every route. */
  example: string;
  /** Refuse a request without an Origin header, even a read (check 4 always refuses a wrong one). */
  requireOrigin?: boolean;
}

/**
 * One entry of the route table. `data` routes run every check, 1 to 10, before the handler;
 * `reportsUnavailable` answers 200 `{ available: false, reason }` instead of refusing when shared
 * data is off or not declared (the session). `own` routes run checks 1 to 4 (and 6 for a body)
 * in the dispatcher, then take their own availability, artifact, pass and policy steps: the live
 * room, which has no shared data and may be on where shared data is off.
 */
export type DataApiRoute =
  | (RouteBase & {
      pipeline: "data";
      reportsUnavailable?: boolean;
      handler: (c: DataRouteCtx) => Promise<Response>;
    })
  | (RouteBase & { pipeline: "own"; handler: (c: OwnRouteCtx) => Promise<Response> });

const one = (name: string) => (seg: string[]) =>
  seg.length === 1 && seg[0] === name ? ({} as Record<string, string>) : null;

/**
 * Every route under /__plinth/api/v1/, one per entry. A feature adds its route here and never
 * re-implements or skips the dispatcher's checks.
 */
export const DATA_API_ROUTES: readonly DataApiRoute[] = [
  {
    kind: "session",
    match: one("session"),
    methods: ["GET"],
    example: "session",
    pipeline: "data",
    reportsUnavailable: true,
    handler: async (c) =>
      respond(c.config, 200, await session(c.env.DB, c.config, c.target, c.claim)),
  },
  {
    kind: "room",
    match: one("room"),
    methods: ["GET"],
    example: "room",
    pipeline: "own",
    handler: async (c) =>
      respond(c.config, 200, await roomInfo(c.request, c.env, c.config, c.artifactId)),
  },
  {
    kind: "changes",
    match: one("changes"),
    methods: ["GET"],
    example: "changes",
    pipeline: "data",
    handler: async (c) => respond(c.config, 200, await changes(c.env.DB, c.target.id)),
  },
  {
    kind: "collection",
    match: (seg) =>
      seg[0] === "data" && seg.length === 2 && seg[1] ? { collection: seg[1] } : null,
    methods: ["GET", "POST"],
    example: "data/tasks",
    pipeline: "data",
    handler: collectionRoute,
  },
  {
    kind: "doc",
    match: (seg) =>
      seg[0] === "data" && seg.length === 3 && seg[1] && seg[2]
        ? { collection: seg[1], docId: seg[2] }
        : null,
    methods: ["GET", "PUT", "DELETE"],
    example: "data/tasks/a1",
    pipeline: "data",
    handler: docRoute,
  },
  {
    kind: "people",
    match: one("people"),
    methods: ["GET"],
    example: "people",
    pipeline: "data",
    handler: async (c) => respond(c.config, 200, await listPeopleRoute(c)),
  },
  {
    kind: "person",
    match: (seg) => (seg[0] === "people" && seg.length === 2 && seg[1] ? { id: seg[1] } : null),
    methods: ["GET"],
    example: "people/u_0123456789abcdef01234567",
    pipeline: "data",
    handler: async (c) => respond(c.config, 200, await getPersonRoute(c)),
  },
];

function matchRoute(path: string): { route: DataApiRoute; params: Record<string, string> } | null {
  const seg = pathSegments(path);
  if (!seg) return null;
  for (const route of DATA_API_ROUTES) {
    const params = route.match(seg);
    if (params) return { route, params };
  }
  return null;
}

async function collectionRoute(c: DataRouteCtx): Promise<Response> {
  const collection = c.params.collection as string;
  if (c.method === "POST") {
    const { data } = parseBody(postBody, c.body);
    return respond(
      c.config,
      201,
      await c.view(await createDoc(c.env.DB, c.config, c.target, c.writer, collection, data)),
    );
  }
  const cursor = c.url.searchParams.get("cursor");
  if (cursor !== null && cursor.length > 400) throw new ApiError("invalid_input", "Bad cursor");
  const page = await listDocs(c.env.DB, c.target.id, collection, {
    limit: intParam(c.url.searchParams.get("limit"), "limit", 1, 200) ?? 50,
    cursor,
  });
  return respond(c.config, 200, {
    docs: await c.views(page.docs),
    next_cursor: page.next_cursor,
  });
}

async function docRoute(c: DataRouteCtx): Promise<Response> {
  const collection = c.params.collection as string;
  const rawId = c.params.docId as string;
  const d1 = c.env.DB;
  if (c.method === "GET") {
    const docId = resolveDocId(rawId, c.claim?.viewerId ?? null);
    const row = docId ? await getDoc(d1, c.target.id, collection, docId) : null;
    if (!row) throw new ApiError("not_found", "Document not found");
    return respond(c.config, 200, await c.view(row));
  }
  if (c.method === "PUT") {
    const { data, if_rev } = parseBody(putBody, c.body);
    const r = await putDoc(d1, c.config, c.target, c.writer, collection, rawId, data, if_rev);
    return respond(c.config, r.created ? 201 : 200, await c.view(r.doc));
  }
  const ifRev = intParam(c.url.searchParams.get("if_rev"), "if_rev", 1, 999_999_999);
  await deleteDoc(d1, c.config, c.target, c.writer, collection, rawId, ifRev);
  return respond(c.config, 204, null);
}

// ---------- the dispatcher ----------

/**
 * Keep work alive after the response: the request's own waitUntil (cloudflare:workers), so the
 * content host's dispatch keeps its signature. Outside a request (never in production), the
 * promise simply runs on.
 */
function afterResponse(p: Promise<unknown>): void {
  try {
    waitUntil(p);
  } catch {
    p.catch(() => undefined);
  }
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

/** Checks 1 to 10, in order, for every route; then the route's handler. */
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
  const matched = matchRoute(path);
  if (!matched) throw new ApiError("not_found", "Not found");
  const { route, params } = matched;
  if (!route.methods.includes(method)) return notAllowed();
  if (route.requireOrigin && request.headers.get("origin") === null) {
    throw refuse("Cross-origin requests are refused");
  }

  // A route with its own steps after the caller checks (the live room, content/room.ts).
  if (route.pipeline === "own") {
    let body: unknown;
    if (method === "POST" || method === "PUT") {
      body = await readJsonBody(request, config.data.maxDocBytes + 1024);
    }
    return route.handler({ request, env, config, artifactId, params, body });
  }

  // 5. Availability, before any cookie: under opaque isolation there are none.
  const off = unavailableReason(config, null, { assumeDeclared: true });
  if (off) {
    if (route.reportsUnavailable) return respond(config, 200, { available: false, reason: off });
    throw new ApiError("feature_disabled", "Shared data is not available here", { reason: off });
  }

  // 6. Artifact.
  const loaded = await loadTarget(env, artifactId);
  if (!loaded) throw new ApiError("not_found", "Not found");
  const { target } = loaded;

  // 7. Body, up to the artifact's document cap (a whiteboard's is larger) plus 1 KiB.
  let body: unknown;
  if (method === "POST" || method === "PUT") {
    body = await readJsonBody(request, dataLimitsFor(config, target.type).maxDocBytes + 1024);
  }

  // 8. Access.
  const pass = await readContentPass(request, config, loaded);
  if (!pass) {
    throw new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }

  // 9. Declaration. An in-chat preview (an MCP host's frame, any framer) never reads or writes
  // shared data: its pass carries no identity and is meant for one look at the page. Nor does the
  // thumbnail capture of a version whose writer may not read the data (policy.captureReadsData).
  const reason = pass.preview
    ? "preview"
    : pass.noData
      ? "capture"
      : unavailableReason(config, target.caps);
  if (reason) {
    if (route.reportsUnavailable) return respond(config, 200, { available: false, reason });
    const message =
      reason === "preview"
        ? "Shared data is not available in a preview"
        : reason === "capture"
          ? "Shared data is not available in this capture"
          : "This page does not use shared data";
    throw new ApiError("feature_disabled", message, { reason });
  }

  // 10. Policy, then the service (rate limits, quotas, guarded writes).
  const { claim } = pass;
  const access = pageDataAccess(claim, target.caps, sharedDataActive(config), target.type, pass);
  if (!access.read) throw new ApiError("feature_disabled", "Shared data is not available here");
  const writer: DataWriter | null =
    access.write && claim
      ? { email: claim.email, role: claim.role, viewerId: claim.viewerId, via: "page" }
      : null;
  const res = await route.handler({
    request,
    env,
    config,
    method,
    url: new URL(request.url),
    params,
    body,
    target,
    claim,
    access,
    writer,
    view: async (row) => (await views([row]))[0] as PageDoc,
    views,
  });
  // A write that landed: the page's other open views re-read their data (live views). Only the
  // signal travels; each view reads the data again through this API, with all of its checks.
  if (method !== "GET" && res.ok) {
    notifyViewers({ env, config, waitUntil: afterResponse }, target.id, "data");
  }
  return res;

  async function views(rows: readonly StoredDoc[]): Promise<PageDoc[]> {
    const names = await pageNames(env.DB, rows, access.seeIdentity);
    return rows.map((row) => toPageDoc(row, claim, access.seeIdentity, names));
  }
}

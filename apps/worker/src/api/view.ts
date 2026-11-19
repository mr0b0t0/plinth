// The viewer gate on APP_HOST. Decides whether the caller may open an artifact (policy.ts), asks
// for a password or an email when needed, and hands out a one-time token for the content host.
import {
  capabilityList,
  type DictationAccess,
  type DictationOwner,
  type EffectiveRole,
  hasPageCapabilities,
  RATE_LIMITS,
  REVIEW_MODE_PARAM,
  TTL,
  typeDef,
  type ViewGate,
  type ViewGateData,
  type ViewGateFiles,
  type ViewGateLive,
  type ViewGatePeople,
  type ViewGateRequests,
  type ViewGateVoice,
  viewerCodeInput,
  viewerEmailInput,
  viewerPasswordInput,
} from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveViewerSession } from "../auth/principal.ts";
import {
  contentOrigin,
  dictationActive,
  filesActive,
  identityClaimsActive,
  liveEditMode,
  liveViewsActive,
  pageRequestsActive,
  roomsActive,
  sharedDataActive,
} from "../config.ts";
import { resolveFilePath } from "../content/serve.ts";
import { issueEnterUrl, safeNext, type ViewerIdentity } from "../content/tokens.ts";
import { type ArtifactRow, users, versions } from "../db/schema.ts";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import { signToken, verifyPassword, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import {
  type Decision,
  dictationAccess,
  liveViewAccess,
  type Principal,
  pageDataAccess,
  pageFileAccess,
  pageRequestAccess,
  peopleListOffered,
} from "../policy.ts";
import { decideFor, findArtifact, grantFor, versionCapabilities } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { gateSources } from "../services/dataSources.ts";
import { readLiveDraftInfo } from "../services/live.ts";
import { sessionCookie } from "../services/sessions.ts";
import { parseManifest } from "../services/storage.ts";
import { namesByEmail } from "../services/users.ts";
import { requestViewerCode, verifyViewerCode } from "../services/viewers.ts";
import { countsAsView } from "../services/views.ts";
import {
  type AppContext,
  type AppEnv,
  type PasswordPassPayload,
  parseBody,
  serviceCtx,
} from "./context.ts";

export const viewApi = new Hono<AppEnv>();

const stub = (a: ArtifactRow) => ({ id: a.id, slug: a.slug, title: a.title });

export interface GateOptions {
  version?: number;
  review?: boolean;
  /** A path inside the artifact to land on (from a direct content link). */
  next?: string;
  /**
   * `next` is a place carried from an older version (live views, the runtime's `update:ok`): when
   * the current version has no file there, land on the root instead.
   */
  carried?: boolean;
}

/** Compute the gate for the current principal. Issues a one-time enter URL when allowed. */
export async function computeGate(
  ctx: Ctx,
  ref: string,
  opts: GateOptions = {},
): Promise<ViewGate> {
  const a = await findArtifact(ctx, ref);
  if (!a || a.currentVersion < 1) return { status: "not_found" };
  // The content host never serves a taken-down artifact, so nobody gets a token for one (admins
  // review the source through the API instead).
  if (a.takenDownAt) return { status: "taken_down", artifact: stub(a) };
  const d = await decideFor(ctx, a, "view");
  if (!d.allow) {
    switch (d.reason) {
      case "taken_down":
        return { status: "taken_down", artifact: stub(a) };
      case "password_required":
        return { status: "password_required", artifact: stub(a) };
      case "email_required":
        return { status: "email_required", artifact: stub(a) };
      case "forbidden":
        // Signed in (or confirmed) as an email that is not on the allowlist: let them try another.
        return a.visibility === "allowlist"
          ? { status: "email_required", artifact: stub(a) }
          : { status: "not_found" };
      default:
        return { status: "not_found" };
    }
  }
  const version =
    opts.version && opts.version >= 1 && opts.version <= a.currentVersion
      ? opts.version
      : a.currentVersion;
  let next = opts.next
    ? safeNext(opts.next)
    : version === a.currentVersion && !opts.version
      ? "/"
      : `/__plinth/v/${version}/`;
  if (opts.carried && opts.next && !(await currentServes(ctx, a, next))) next = "/";
  // A page that declares `comments` anchors its own comments and never loads in review mode, so
  // the bridge is never injected next to it, whatever the app asked for.
  const review = opts.review === true && !(await pageCommentsDeclared(ctx, a));
  // Decided here, recorded by the content host when the token is redeemed (services/views.ts).
  const countView = countsAsView(ctx, d, { ...opts, review }, next);
  if (review) {
    // The flag goes in the query, before any fragment.
    const hashAt = next.indexOf("#");
    const [path, hash] = hashAt < 0 ? [next, ""] : [next.slice(0, hashAt), next.slice(hashAt)];
    next = `${path}${path.includes("?") ? "&" : "?"}${REVIEW_MODE_PARAM}=1${hash}`;
  }
  const owner = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, a.ownerId))
    .get();
  const identity = await identityFor(ctx, a, d);
  // Each part adds its own optional fields, in list order, after the fields every gate has.
  const parts: GateFields = {};
  for (const part of GATE_PARTS) Object.assign(parts, await part({ ctx, a, d, opts, identity }));
  return {
    status: "ok",
    artifact: {
      ...stub(a),
      type: a.type,
      current_version: a.currentVersion,
      version,
      visibility: a.visibility,
      owner_name: owner?.name ?? null,
    },
    enter_url: await issueEnterUrl(ctx.config, a, next, identity, { countView }),
    role: d.role,
    ...parts,
  };
}

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** The optional fields of an ok gate: each comes from one gate part. */
type GateFields = Partial<Omit<OkGate, "status" | "artifact" | "enter_url" | "role">>;

/** What every gate part gets: the allowed decision, the request's options and the identity. */
export interface GatePartInput {
  ctx: Ctx;
  a: ArtifactRow;
  d: Extract<Decision, { allow: true }>;
  opts: GateOptions;
  identity: ViewerIdentity | undefined;
}

/** One gate part: its own optional fields of an ok gate, or nothing. */
export type GatePart = (input: GatePartInput) => Promise<GateFields | undefined>;

/**
 * The parts of an ok gate, one per line, run in this order. A feature adds its part (a sibling
 * optional field such as `comments` or `files`) and its line here; it never changes another
 * part's output.
 */
export const GATE_PARTS: readonly GatePart[] = [
  async ({ ctx, a, identity }) => {
    const data = await gateData(ctx, a, identity);
    return data ? { data } : undefined;
  },
  async ({ ctx, a, d, opts }) => {
    const live = await gateLive(ctx, a, d, opts);
    return live ? { live } : undefined;
  },
  async ({ ctx, a, identity }) => {
    const people = await gatePeople(ctx, a, identity);
    return people ? { people } : undefined;
  },
  async ({ ctx, a }) =>
    (await pageCommentsDeclared(ctx, a)) ? { page_comments: true } : undefined,
  async ({ ctx, a, d }) => {
    const voice = await gateVoice(ctx, a, d);
    return voice ? { voice } : undefined;
  },
  async ({ ctx, a, d }) => (gateWatch(ctx, a, d) ? { watch: true as const } : undefined),
  async ({ ctx, a }) => ((await holdDeclared(ctx, a)) ? { hold: true as const } : undefined),
  async ({ ctx, a, identity }) => {
    const files = await gateFiles(ctx, a, identity);
    return files ? { files } : undefined;
  },
  // Where the figures come from (services/dataSources.ts gateSources): only for an artifact with a
  // data source, whatever its page declares and in every isolation mode.
  async ({ ctx, a }) => {
    const sources = await gateSources(ctx.env.DB, a.id);
    return sources ? { sources } : undefined;
  },
  async ({ ctx, a, identity }) => {
    const requests = await gateRequests(ctx, a, identity);
    return requests ? { requests } : undefined;
  },
];

// ---------- page requests ----------

/**
 * Tell the viewer the page can file requests in their name, and as which email: only while page
 * requests are active, on an HTML artifact whose current version declares `requests`, for a viewer
 * the gate sealed an identity for. Whether they may file is policy.ts pageRequestAccess, as the
 * content host decides it. The email goes to the app, never to the framed page.
 */
async function gateRequests(
  ctx: Ctx,
  a: ArtifactRow,
  identity: ViewerIdentity | undefined,
): Promise<ViewGateRequests | undefined> {
  if (!identity || !pageRequestsActive(ctx.config) || a.type !== "html") return undefined;
  const declared = await currentCapsOnce(ctx, a);
  if (declared?.requests !== true) return undefined;
  const claim = {
    ...identity,
    viewerId: await viewerIdFor(ctx.config.tokenSigningKey, a.id, identity.email),
  };
  const access = pageRequestAccess(claim, declared, { active: true, type: a.type, pass: "view" });
  return { can_file: access.file, email: identity.email };
}

// ---------- files people add to a page ----------

/**
 * What the viewer is told about the files people add to the page: only for an HTML artifact whose
 * current version declares `files`, while ALLOW_FILES is on. Whether this viewer may upload is
 * decided by policy.ts pageFileAccess, as the content host decides it.
 */
async function gateFiles(
  ctx: Ctx,
  a: ArtifactRow,
  identity: ViewerIdentity | undefined,
): Promise<ViewGateFiles | undefined> {
  if (!ctx.config.allowFiles || a.type !== "html") return undefined;
  let caps = currentCaps.get(a);
  if (!caps) {
    caps = readCurrentCaps(ctx, a);
    currentCaps.set(a, caps);
  }
  const declared = await caps;
  if (declared?.files !== true) return undefined;
  const available = filesActive(ctx.config);
  const claim =
    identity && available
      ? {
          ...identity,
          viewerId: await viewerIdFor(ctx.config.tokenSigningKey, a.id, identity.email),
        }
      : null;
  return {
    available,
    can_upload: pageFileAccess(claim, declared, available, "view").upload,
    uploaders_shown: declared.viewer === true,
  };
}

// ---------- live views ----------

/**
 * Whether the app should open the watch socket (docs/spec.md "Live views"): anyone this gate lets
 * in, never an agent, while live views are active; pinned version links too, so they can say a
 * newer version exists. The declaration matters only for the data right, which the socket's
 * handshake decides, so nothing is read here.
 */
function gateWatch(ctx: Ctx, a: ArtifactRow, d: Extract<Decision, { allow: true }>): boolean {
  return liveViewAccess(ctx.principal, d, null, {
    active: liveViewsActive(ctx.config, ctx.env),
    sharedData: sharedDataActive(ctx.config),
    type: a.type,
  }).watch;
}

// ---------- live views: applying a new version ----------

/**
 * Whether a newer version waits while the viewer is using the page (docs/spec.md "Live views", the
 * hold rule): an HTML artifact whose current version declares `hold`, while ALLOW_LIVE_VIEWS is on.
 * The switch alone counts, not the ROOMS binding: the app learns of versions by polling too. The
 * current version's declaration is the shown one's, since only a page that follows the current
 * version is ever replaced.
 */
async function holdDeclared(ctx: Ctx, a: ArtifactRow): Promise<boolean> {
  if (!ctx.config.allowLiveViews || a.type !== "html") return false;
  return (await currentCapsOnce(ctx, a))?.hold === true;
}

/**
 * Whether the content host serves a file of the current version at `next` (a path from
 * `safeNext`), by the same rules it uses (serve.ts): a typed artifact's own page, or a path the
 * manifest lists. A place carried from an older version that the current one lacks (a client-side
 * route, a page renamed or removed) would land on the content host's "Not found".
 */
async function currentServes(ctx: Ctx, a: ArtifactRow, next: string): Promise<boolean> {
  const rel = resolveFilePath(next.split(/[?#]/, 1)[0] ?? "");
  if (rel === null) return false;
  if (typeDef(a.type)?.renderer && rel === "index.html") return true;
  const row = await ctx.db
    .select({ manifest: versions.manifest })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  return row ? parseManifest(row.manifest).some((e) => e.path === rel) : false;
}

// ---------- comments from the page ----------

const currentCaps = new WeakMap<ArtifactRow, ReturnType<typeof readCurrentCaps>>();

async function readCurrentCaps(ctx: Ctx, a: ArtifactRow) {
  const row = await ctx.db
    .select({ capabilities: versions.capabilities })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  return versionCapabilities(row);
}

/**
 * Whether the page may open the comment composer with its own anchors (`plinth.comments`): an
 * HTML artifact whose current version declares `comments`. The current version's declaration
 * governs, whichever version is being opened. Read once per gate (the row object is the key).
 */
async function pageCommentsDeclared(ctx: Ctx, a: ArtifactRow): Promise<boolean> {
  if (a.type !== "html") return false;
  return (await currentCapsOnce(ctx, a))?.comments === true;
}

/** The current version's declaration, read once per gate (the row object is the key). */
function currentCapsOnce(ctx: Ctx, a: ArtifactRow): ReturnType<typeof readCurrentCaps> {
  let caps = currentCaps.get(a);
  if (!caps) {
    caps = readCurrentCaps(ctx, a);
    currentCaps.set(a, caps);
  }
  return caps;
}

/**
 * The identity sealed into the enter token for shared data and rooms: only for identified viewers
 * (the owner, or a person with a grant, signed in or confirmed by code), never agents, never link
 * viewers or admins without a role, and only while either is active (on, origin isolation).
 * The email is the owner's own, or the one that holds the strongest grant.
 */
async function identityFor(
  ctx: Ctx,
  a: ArtifactRow,
  d: Extract<Decision, { allow: true }>,
): Promise<ViewerIdentity | undefined> {
  const p = ctx.principal;
  if (d.role === null || (p.kind !== "user" && p.kind !== "viewer")) return undefined;
  if (!identityClaimsActive(ctx.config, ctx.env)) return undefined;
  // `account`: signed in, not confirmed by code. Only then may a doc editor edit on the page.
  const account = p.kind === "user" ? { account: true } : {};
  if (d.role === "owner") return { email: p.email, role: "owner", ...account };
  const g = await grantFor(ctx, a);
  return g ? { email: g.email, role: g.role, ...account } : undefined;
}

/**
 * On-page editing of a doc (#36): owners and editors on the current version, while live editing is
 * on under origin isolation; one D1 read for the unsaved draft. Undefined in every other case.
 */
async function gateLive(
  ctx: Ctx,
  a: ArtifactRow,
  d: Extract<Decision, { allow: true }>,
  opts: GateOptions,
): Promise<ViewGateLive | undefined> {
  if (!typeDef(a.type)?.liveEdit || a.takenDownAt) return undefined;
  if (d.role !== "owner" && d.role !== "editor") return undefined;
  if (opts.version !== undefined) return undefined;
  const p = ctx.principal;
  if (p.kind !== "user" && p.kind !== "viewer") return undefined;
  const mode = liveEditMode(ctx.config, ctx.env);
  if (!mode) return undefined;
  return {
    mode,
    ...(p.kind === "viewer" ? { sign_in: true as const } : {}),
    draft: await readLiveDraftInfo(ctx.env.DB, a.id),
  };
}

/**
 * What the live viewer tells the person about the page's shared data, and about who its live room
 * shows them as: only when declared. A page that declares `room viewer` shows each identified
 * viewer's email to the page and to everyone else in the room, so the viewer is told, with or
 * without shared data (docs/security.md, "Page code harvests viewer emails").
 */
async function gateData(
  ctx: Ctx,
  a: ArtifactRow,
  identity: ViewerIdentity | undefined,
): Promise<ViewGateData | undefined> {
  // The current version's declaration governs, whichever version is being opened.
  const row = await ctx.db
    .select({ capabilities: versions.capabilities })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  const caps = versionCapabilities(row);
  const roomEmail =
    identity &&
    caps?.room === true &&
    caps.viewer &&
    hasPageCapabilities(typeDef(a.type)) &&
    roomsActive(ctx.config, ctx.env)
      ? identity.email
      : undefined;
  // A page that declares only `room` (without `viewer`) keeps no shared data and shows nobody's
  // email: nothing to tell the viewer here.
  if (caps?.data !== true && !roomEmail) return undefined;
  const capabilities = capabilityList(caps);
  const available = sharedDataActive(ctx.config);
  // The identity may be sealed for rooms alone; the data notice counts it only with shared data.
  const claim =
    identity && available
      ? {
          ...identity,
          viewerId: await viewerIdFor(ctx.config.tokenSigningKey, a.id, identity.email),
        }
      : null;
  return {
    available,
    capabilities,
    identified: claim !== null,
    can_write: pageDataAccess(claim, caps, available, a.type).write,
    // The viewer is told which email the page sees (their own, or the one holding the grant).
    ...(claim && caps?.viewer && caps.data ? { email: claim.email } : {}),
    ...(roomEmail ? { room_email: roomEmail } : {}),
  };
}

/**
 * What the live viewer tells an identified viewer about names and the people list (docs/spec.md
 * "Who is viewing"): the display name the page sees beside their email (exactly where the data
 * block names that email: `email` with shared data, `room_email` in a live room), and whether the
 * page lets its owner and editors list everyone it is shared with, the viewer's own address
 * included. Link viewers get nothing, and cause no read.
 */
async function gatePeople(
  ctx: Ctx,
  a: ArtifactRow,
  identity: ViewerIdentity | undefined,
): Promise<ViewGatePeople | undefined> {
  if (!identity) return undefined;
  const row = await ctx.db
    .select({ capabilities: versions.capabilities })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  const caps = versionCapabilities(row);
  if (caps?.viewer !== true) return undefined;
  const data = sharedDataActive(ctx.config) && caps.data;
  const room =
    caps.room && hasPageCapabilities(typeDef(a.type)) && roomsActive(ctx.config, ctx.env);
  if (!data && !room) return undefined;
  const name = (await namesByEmail(ctx.env.DB, [identity.email])).get(identity.email) ?? null;
  const out: ViewGatePeople = {
    ...(name ? { name } : {}),
    // Exactly when anyone (the page, agents, REST) can read the list: policy.ts peopleListOffered.
    ...(peopleListOffered(caps, sharedDataActive(ctx.config)) ? { list: true as const } : {}),
  };
  return out.name || out.list ? out : undefined;
}

/**
 * Dictation on the page (docs/spec.md "Voice: dictation and text to speech"): only when the current
 * version of an HTML page declares `dictation`, whichever version is being opened, and only while
 * ALLOW_DICTATION is on (off, nothing is read and the app answers `disabled` from its config).
 * Identified means the owner or a grant holder, signed in or confirmed by code: the same people
 * who write shared data or join a room. Anonymous link viewers and admins without a role are not.
 */
async function gateVoice(
  ctx: Ctx,
  a: ArtifactRow,
  d: Extract<Decision, { allow: true }>,
): Promise<ViewGateVoice | undefined> {
  const v = await voiceAccess(ctx, a, d);
  if (!v) return undefined;
  if (!v.dictation.available || !v.identity) return { dictation: v.dictation };
  // The app binds this browser's consent to the viewer's id on this page, so the next person on a
  // shared browser is asked again. The owner's email is not here: the consent dialog fetches it
  // (GET /view/:ref/dictation) only when it opens.
  const viewerId = await viewerIdFor(ctx.config.tokenSigningKey, a.id, v.identity.email);
  return { dictation: v.dictation, viewer_id: viewerId };
}

/** The page's dictation declaration and this viewer's access to it; undefined when not declared. */
async function voiceAccess(
  ctx: Ctx,
  a: ArtifactRow,
  d: Extract<Decision, { allow: true }>,
): Promise<
  | { dictation: DictationAccess; identity: { email: string; role: EffectiveRole } | null }
  | undefined
> {
  if (!ctx.config.allowDictation || a.type !== "html") return undefined;
  const row = await ctx.db
    .select({ capabilities: versions.capabilities })
    .from(versions)
    .where(and(eq(versions.artifactId, a.id), eq(versions.number, a.currentVersion)))
    .get();
  const caps = versionCapabilities(row);
  if (caps?.dictation !== true) return undefined;
  const p = ctx.principal;
  const identity =
    d.role !== null && (p.kind === "user" || p.kind === "viewer")
      ? { email: p.email, role: d.role }
      : null;
  const dictation = dictationAccess(identity, caps, {
    active: dictationActive(ctx.config),
    isolation: ctx.config.contentIsolation,
    type: a.type,
  });
  return { dictation, identity };
}

/**
 * The owner's email for the dictation consent dialog, or null. The dialog names who wrote the page
 * by it, which the owner cannot pick freely as they can a display name. Only viewers who may
 * dictate get it (the owner and the people the owner granted access by email), and the app asks
 * only when the dialog opens, never on a plain page load.
 */
async function dictationOwner(ctx: Ctx, ref: string): Promise<DictationOwner | null> {
  const a = await findArtifact(ctx, ref);
  if (!a || a.currentVersion < 1 || a.takenDownAt) return null;
  const d = await decideFor(ctx, a, "view");
  if (!d.allow) return null;
  const v = await voiceAccess(ctx, a, d);
  if (!v?.dictation.available || !v.identity) return null;
  if (d.role === "owner") return { owner_email: v.identity.email };
  const owner = await ctx.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, a.ownerId))
    .get();
  return owner ? { owner_email: owner.email } : null;
}

function gateOptions(q: (k: string) => string | undefined): GateOptions {
  const v = Number(q("version"));
  return {
    version: Number.isInteger(v) && v > 0 ? v : undefined,
    review: q("review") === "1",
    next: q("next"),
    carried: q("carried") === "1",
  };
}

/**
 * The gate for this request. A signed-in person whose own email is not listed may also hold a
 * viewer session for an email that is (confirmed by code in this browser); either identity may
 * open the artifact. The viewer identity is used for this gate only, and the identity claim for
 * shared data carries the email of whichever principal produced the ok gate.
 */
async function gateForRequest(c: AppContext, ref: string, opts: GateOptions): Promise<ViewGate> {
  const ctx = serviceCtx(c);
  const gate = await computeGate(ctx, ref, opts);
  if (gate.status !== "email_required") return gate;
  const viewer = await otherViewer(c, ctx);
  if (!viewer) return gate;
  const alt = await computeGate({ ...ctx, principal: viewer }, ref, opts);
  return alt.status === "ok" ? alt : gate;
}

/**
 * The viewer session this browser also holds, for a signed-in person, when it is for another
 * email (confirmed by code in this browser); null otherwise.
 */
async function otherViewer(c: AppContext, ctx: Ctx): Promise<Principal | null> {
  if (ctx.principal.kind !== "user") return null;
  const cookie = c.get("cookies").get(appCookieName(ctx.config, "viewer"));
  const viewer = cookie ? await resolveViewerSession(ctx.db, cookie) : null;
  if (viewer?.kind !== "viewer" || viewer.email === ctx.principal.email) return null;
  return viewer;
}

viewApi.get("/view/:ref", async (c) => {
  const gate = await gateForRequest(
    c,
    c.req.param("ref"),
    gateOptions((k) => c.req.query(k)),
  );
  c.header("Cache-Control", "no-store");
  return c.json(gate);
});

/**
 * Dictation: the owner's email for the consent dialog, for the same principal the gate would use.
 * 404 for anyone who may not dictate on the page, the same answer as for a missing artifact.
 */
viewApi.get("/view/:ref/dictation", async (c) => {
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  let owner = await dictationOwner(ctx, ref);
  if (!owner) {
    const viewer = await otherViewer(c, ctx);
    if (viewer) owner = await dictationOwner({ ...ctx, principal: viewer }, ref);
  }
  c.header("Cache-Control", "no-store");
  if (!owner) throw new ApiError("not_found", "Artifact not found");
  return c.json(owner);
});

/**
 * Allowlist: ask for a code. The answer is the same whether or not the email is listed, so the
 * allowlist cannot be read through this endpoint. 404 only if the artifact is not an allowlist one.
 */
viewApi.post("/view/:ref/email", async (c) => {
  const { email } = await parseBody(c, viewerEmailInput);
  await requestViewerCode(serviceCtx(c), c.req.param("ref"), email);
  return c.json({ ok: true });
});

/**
 * Allowlist: confirm the code and return the gate for that email. A listed email starts a viewer
 * session; the owner's own email signs the owner in to the app.
 */
viewApi.post("/view/:ref/code", async (c) => {
  const { email, code } = await parseBody(c, viewerCodeInput);
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  const result = await verifyViewerCode(ctx, ref, email, code);
  const config = c.get("config");
  let principal: Principal;
  if (result.kind === "user") {
    c.header("Set-Cookie", sessionCookie(config, result.value), { append: true });
    principal = {
      kind: "user",
      userId: result.user.id,
      email: result.user.email,
      isAdmin: config.adminEmails.includes(result.user.email),
    };
  } else {
    c.header(
      "Set-Cookie",
      serializeCookie(appCookieName(config, "viewer"), result.value, {
        httpOnly: true,
        secure: secureFlag(config.scheme, config.appHost),
        sameSite: "Lax",
        maxAge: TTL.viewerSessionS,
      }),
      { append: true },
    );
    principal = { kind: "viewer", email };
  }
  const gate = await computeGate(
    { ...ctx, principal },
    ref,
    gateOptions((k) => c.req.query(k)),
  );
  return c.json(gate);
});

viewApi.post("/view/:ref/password", async (c) => {
  const ctx = serviceCtx(c);
  const { password } = await parseBody(c, viewerPasswordInput);
  const a = await findArtifact(ctx, c.req.param("ref"));
  if (a?.visibility !== "password" || !a.passwordHash)
    throw new ApiError("not_found", "Artifact not found");
  const limit = await hit(
    c.env.DB,
    `pw:${a.id}:${ctx.ip ?? "unknown"}`,
    RATE_LIMITS.passwordAttemptsPerArtifactPerIpPerHour,
    3600,
  );
  const overall = await hit(
    c.env.DB,
    `pw:${a.id}:all`,
    RATE_LIMITS.passwordAttemptsPerArtifactPerHour,
    3600,
  );
  if (!limit.allowed || !overall.allowed) {
    throw new ApiError("rate_limited", "Too many password attempts. Try again later.", {
      retry_after: Math.max(limit.retryAfter, overall.retryAfter),
    });
  }
  if (!(await verifyPassword(password, a.passwordHash))) {
    throw new ApiError("forbidden", "Wrong password", { reason: "wrong_password" });
  }
  const config = c.get("config");
  const value = await signToken(config.tokenSigningKey, {
    k: "pw",
    a: a.id,
    e: a.accessEpoch,
    exp: Date.now() + TTL.passwordPassS * 1000,
  } satisfies PasswordPassPayload);
  c.header(
    "Set-Cookie",
    serializeCookie(`${appCookieName(config, "passwordPassPrefix")}${a.id}`, value, {
      httpOnly: true,
      secure: secureFlag(config.scheme, config.appHost),
      sameSite: "Lax",
      maxAge: TTL.passwordPassS,
    }),
    { append: true },
  );
  const passes = new Map(ctx.passwordPasses);
  passes.set(a.id, a.accessEpoch);
  const gate = await computeGate(
    { ...ctx, passwordPasses: passes },
    a.id,
    gateOptions((k) => c.req.query(k)),
  );
  return c.json(gate);
});

export { contentOrigin };

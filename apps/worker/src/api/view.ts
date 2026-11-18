// The viewer gate on APP_HOST. Decides whether the caller may open an artifact (policy.ts), asks
// for a password or an email when needed, and hands out a one-time token for the content host.
import {
  capabilityList,
  RATE_LIMITS,
  REVIEW_MODE_PARAM,
  TTL,
  typeDef,
  type ViewGate,
  type ViewGateData,
  type ViewGateLive,
  viewerCodeInput,
  viewerEmailInput,
  viewerPasswordInput,
} from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveViewerSession } from "../auth/principal.ts";
import {
  contentOrigin,
  identityClaimsActive,
  liveEditMode,
  roomsActive,
  sharedDataActive,
} from "../config.ts";
import { issueEnterUrl, safeNext, type ViewerIdentity } from "../content/tokens.ts";
import { type ArtifactRow, users, versions } from "../db/schema.ts";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import { signToken, verifyPassword, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { type Decision, type Principal, pageDataAccess } from "../policy.ts";
import { decideFor, findArtifact, grantFor, versionCapabilities } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { readLiveDraftInfo } from "../services/live.ts";
import { sessionCookie } from "../services/sessions.ts";
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
  async ({ ctx, a }) =>
    (await pageCommentsDeclared(ctx, a)) ? { page_comments: true } : undefined,
];

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
  let caps = currentCaps.get(a);
  if (!caps) {
    caps = readCurrentCaps(ctx, a);
    currentCaps.set(a, caps);
  }
  return (await caps)?.comments === true;
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
  const g = await grantFor(ctx, a.id);
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
    a.type === "html" &&
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
    can_write: pageDataAccess(claim, caps, available).write,
    // The viewer is told which email the page sees (their own, or the one holding the grant).
    ...(claim && caps?.viewer && caps.data ? { email: claim.email } : {}),
    ...(roomEmail ? { room_email: roomEmail } : {}),
  };
}

function gateOptions(q: (k: string) => string | undefined): GateOptions {
  const v = Number(q("version"));
  return {
    version: Number.isInteger(v) && v > 0 ? v : undefined,
    review: q("review") === "1",
    next: q("next"),
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
  if (gate.status !== "email_required" || ctx.principal.kind !== "user") return gate;
  const cookie = c.get("cookies").get(appCookieName(ctx.config, "viewer"));
  const viewer = cookie ? await resolveViewerSession(ctx.db, cookie) : null;
  if (viewer?.kind !== "viewer" || viewer.email === ctx.principal.email) return gate;
  const alt = await computeGate({ ...ctx, principal: viewer }, ref, opts);
  return alt.status === "ok" ? alt : gate;
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

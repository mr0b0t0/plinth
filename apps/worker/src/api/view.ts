// The viewer gate on APP_HOST. Decides whether the caller may open an artifact (policy.ts), asks
// for a password or an email when needed, and hands out a one-time token for the content host.
import {
  capabilityList,
  RATE_LIMITS,
  REVIEW_MODE_PARAM,
  TTL,
  type ViewGate,
  type ViewGateData,
  viewerCodeInput,
  viewerEmailInput,
  viewerPasswordInput,
} from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveViewerSession } from "../auth/principal.ts";
import { contentOrigin, sharedDataActive } from "../config.ts";
import { issueEnterUrl, safeNext, type ViewerIdentity } from "../content/tokens.ts";
import { type ArtifactRow, users, versions } from "../db/schema.ts";
import { appCookieName, secureFlag, serializeCookie } from "../lib/cookies.ts";
import { signToken, verifyPassword, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { type Decision, pageDataAccess } from "../policy.ts";
import { decideFor, findArtifact, grantFor, versionCapabilities } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { requestViewerCode, verifyViewerCode } from "../services/viewers.ts";
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
  if (opts.review) {
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
  const data = await gateData(ctx, a, identity);
  return {
    status: "ok",
    artifact: {
      ...stub(a),
      current_version: a.currentVersion,
      version,
      visibility: a.visibility,
      owner_name: owner?.name ?? null,
    },
    enter_url: await issueEnterUrl(ctx.config, a, next, identity),
    role: d.role,
    ...(data ? { data } : {}),
  };
}

/**
 * The identity sealed into the enter token for shared data: only for identified viewers (the
 * owner, or a person with a grant, signed in or confirmed by code), never agents, never link
 * viewers or admins without a role, and only while shared data is active (on, origin isolation).
 * The email is the owner's own, or the one that holds the strongest grant.
 */
async function identityFor(
  ctx: Ctx,
  a: ArtifactRow,
  d: Extract<Decision, { allow: true }>,
): Promise<ViewerIdentity | undefined> {
  const p = ctx.principal;
  if (d.role === null || (p.kind !== "user" && p.kind !== "viewer")) return undefined;
  if (!sharedDataActive(ctx.config)) return undefined;
  if (d.role === "owner") return { email: p.email, role: "owner" };
  const g = await grantFor(ctx, a.id);
  return g ? { email: g.email, role: g.role } : undefined;
}

/** What the live viewer tells the person about the page's shared data; only when declared. */
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
  const capabilities = capabilityList(caps);
  if (capabilities.length === 0) return undefined;
  const available = sharedDataActive(ctx.config);
  const claim = identity
    ? { ...identity, viewerId: await viewerIdFor(ctx.config.tokenSigningKey, a.id, identity.email) }
    : null;
  return {
    available,
    capabilities,
    identified: claim !== null,
    can_write: pageDataAccess(claim, caps, available).write,
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

/** Allowlist: confirm the code, start a viewer session, and return the gate for that email. */
viewApi.post("/view/:ref/code", async (c) => {
  const { email, code } = await parseBody(c, viewerCodeInput);
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  const value = await verifyViewerCode(ctx, ref, email, code);
  const config = c.get("config");
  c.header(
    "Set-Cookie",
    serializeCookie(appCookieName(config, "viewer"), value, {
      httpOnly: true,
      secure: secureFlag(config.scheme, config.appHost),
      sameSite: "Lax",
      maxAge: TTL.viewerSessionS,
    }),
    { append: true },
  );
  const gate = await computeGate(
    { ...ctx, principal: { kind: "viewer", email } },
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

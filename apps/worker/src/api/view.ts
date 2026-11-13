// The viewer gate on APP_HOST. Decides whether the caller may open an artifact (policy.ts), asks
// for a password or an email when needed, and hands out a one-time token for the content host.
import {
  COOKIES,
  RATE_LIMITS,
  REVIEW_MODE_PARAM,
  TTL,
  type ViewGate,
  viewerPasswordInput,
} from "@plinth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { contentOrigin } from "../config.ts";
import { issueEnterUrl, safeNext } from "../content/tokens.ts";
import { type ArtifactRow, users } from "../db/schema.ts";
import { secureFlag, serializeCookie } from "../lib/cookies.ts";
import { signToken, verifyPassword } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { decideFor, findArtifact } from "../services/artifacts.ts";
import type { Ctx } from "../services/context.ts";
import { type AppEnv, type PasswordPassPayload, parseBody, serviceCtx } from "./context.ts";

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
  if (opts.review) next += `${next.includes("?") ? "&" : "?"}${REVIEW_MODE_PARAM}=1`;
  const owner = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, a.ownerId))
    .get();
  return {
    status: "ok",
    artifact: {
      ...stub(a),
      current_version: a.currentVersion,
      version,
      visibility: a.visibility,
      owner_name: owner?.name ?? null,
    },
    enter_url: await issueEnterUrl(ctx.config, a, next),
    role: d.role,
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

viewApi.get("/view/:ref", async (c) => {
  const gate = await computeGate(
    serviceCtx(c),
    c.req.param("ref"),
    gateOptions((k) => c.req.query(k)),
  );
  c.header("Cache-Control", "no-store");
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
  if (!limit.allowed) {
    throw new ApiError("rate_limited", "Too many password attempts. Try again later.", {
      retry_after: limit.retryAfter,
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
    serializeCookie(`${COOKIES.passwordPassPrefix}${a.id}`, value, {
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

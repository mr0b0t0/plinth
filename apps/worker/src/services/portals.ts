// Portals (docs/spec.md "Category sharing and personal categories"): the page at /p/<share id> that
// lists the artifacts of a shared category its people may open. People only, never agents (a
// grantee's agent sees shared artifacts through list_artifacts). Someone without a grant confirms
// their email by code first, as on an allowlist artifact: the same answer whether or not the
// address holds a grant, the same rate limits, single-use hashed codes bound to the share. The
// viewer session it starts names no artifact: policy checks the email's grants on every artifact,
// so the person then opens each listed artifact without a second code.
import {
  type ArtifactSummary,
  type CategoryRole,
  LIMITS,
  type PortalGate,
  type PortalSummary,
  pageDisplayName,
  RATE_LIMITS,
  TTL,
} from "@plinth/shared";
import { eq, inArray } from "drizzle-orm";
import { maySignIn } from "../auth/login.ts";
import { type ArtifactRow, artifacts, type UserRow, users } from "../db/schema.ts";
import { createEmailAdapter } from "../email/index.ts";
import { hmacHex, newId, newSixDigitCode, timingSafeEqual } from "../lib/crypto.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { isoIn, nowIso } from "../lib/time.ts";
import { decide, decidePortal, type Principal } from "../policy.ts";
import { factsOf, grantEmails, toSummary } from "./artifacts.ts";
import { refuseBoundToken } from "./categoryShares.ts";
import type { Ctx } from "./context.ts";
import { createUserSession } from "./sessions.ts";
import { getUserById } from "./users.ts";
import { createViewerSession, MAX_VIEWER_CODE_ATTEMPTS, type ViewerCodeResult } from "./viewers.ts";

const HOUR = 3600;

interface ShareSql {
  id: string;
  owner_id: string;
  category_key: string;
  title: string;
}

async function loadShare(ctx: Ctx, id: string): Promise<ShareSql | null> {
  if (!ctx.config.allowCategorySharing) return null;
  return ctx.env.DB.prepare(
    "SELECT id, owner_id, category_key, title FROM category_shares WHERE id = ?1",
  )
    .bind(id)
    .first<ShareSql>();
}

/** The strongest grant among `emails` on the share, with the email holding it. */
async function shareGrant(
  ctx: Ctx,
  shareId: string,
  emails: readonly string[],
  own: string | null,
): Promise<{ role: CategoryRole; email: string } | null> {
  if (emails.length === 0) return null;
  const marks = emails.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await ctx.env.DB.prepare(
    `SELECT role, email FROM category_grants WHERE share_id = ?1 AND email IN (${marks})`,
  )
    .bind(shareId, ...emails)
    .all<{ role: CategoryRole; email: string }>();
  let best: { role: CategoryRole; email: string } | null = null;
  for (const r of results) {
    if (
      !best ||
      (r.role === "commenter" && best.role === "viewer") ||
      (r.role === best.role && r.email === own)
    )
      best = r;
  }
  return best;
}

/**
 * The share's artifacts a grantee may open: the owner's live, published, not taken down artifacts
 * reviewed as shared into this very share while it holds their key. The SQL mirrors policy.ts
 * categoryRoleOf; each row then passes decide("view") with the same facts.
 */
async function portalRows(ctx: Ctx, share: ShareSql): Promise<ArtifactRow[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM artifacts
      WHERE owner_id = ?1 AND category_key = ?2 AND category_review = 'shared'
        AND category_review_share = ?3 AND deleted_at IS NULL AND taken_down_at IS NULL
        AND current_version >= 1
      ORDER BY updated_at DESC LIMIT ?4`,
  )
    .bind(share.owner_id, share.category_key, share.id, LIMITS.maxPortalItems)
    .all<{ id: string }>();
  if (results.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(artifacts)
    .where(
      inArray(
        artifacts.id,
        results.map((r) => r.id),
      ),
    )
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return results.flatMap((r) => byId.get(r.id) ?? []);
}

/**
 * GET /portals: the collections shared with the caller (a session or a confirmed viewer). The SQL
 * finds the shares whose grants hold the caller's emails; each one is then listed only if
 * policy.ts decidePortal lets the caller open it with that grant, as GET /portals/:id decides.
 */
export async function listPortals(ctx: Ctx): Promise<PortalSummary[]> {
  refuseBoundToken(ctx.principal);
  if (!ctx.config.allowCategorySharing) return [];
  const { emails } = grantEmails(ctx);
  if (emails.length === 0) return [];
  const marks = emails.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await ctx.env.DB.prepare(
    `SELECT s.id AS id, s.title AS title, s.owner_id AS owner_id, u.name AS owner_name,
            (SELECT max(CASE g.role WHEN 'commenter' THEN 2 ELSE 1 END) FROM category_grants g
              WHERE g.share_id = s.id AND g.email IN (${marks})) AS rank,
            (SELECT count(*) FROM artifacts a
              WHERE a.owner_id = s.owner_id AND a.category_key = s.category_key
                AND a.category_review = 'shared' AND a.category_review_share = s.id
                AND a.deleted_at IS NULL AND a.taken_down_at IS NULL AND a.current_version >= 1)
              AS count
       FROM category_shares s JOIN users u ON u.id = s.owner_id
      WHERE s.id IN (SELECT share_id FROM category_grants WHERE email IN (${marks}))
      ORDER BY s.title`,
  )
    .bind(...emails)
    .all<PortalSummary & { owner_id: string; rank: number | null }>();
  return results.flatMap((r) => {
    const role: CategoryRole | null = r.rank === 2 ? "commenter" : r.rank === 1 ? "viewer" : null;
    const d = decidePortal(
      ctx.principal,
      { ownerId: r.owner_id },
      role,
      ctx.config.allowCategorySharing,
    );
    if (!d.allow) return [];
    return [
      {
        id: r.id,
        title: r.title,
        // The name cleaned on read (displayName.ts pageDisplayName), as everywhere else it shows.
        owner_name: pageDisplayName(r.owner_name),
        count: Math.min(r.count, LIMITS.maxPortalItems),
      },
    ];
  });
}

/**
 * GET /portals/:id: the portal for the caller. 404 for an unknown id or with sharing off;
 * `email_required` for an existing share and a caller without a grant (anonymous, or another
 * email); `ok` with the items for a grantee, and for the owner as a preview.
 */
export async function portalGate(ctx: Ctx, id: string): Promise<PortalGate> {
  refuseBoundToken(ctx.principal);
  const share = await loadShare(ctx, id);
  if (!share) throw notFound("Portal");
  const { own, emails } = grantEmails(ctx);
  const grant = ctx.principal.kind === "agent" ? null : await shareGrant(ctx, id, emails, own);
  const d = decidePortal(ctx.principal, { ownerId: share.owner_id }, grant?.role ?? null, true);
  if (!d.allow) {
    if (d.reason === "not_found") throw notFound("Portal");
    return { status: "email_required", portal: { id } };
  }
  const owner = await getUserById(ctx.db, share.owner_id);
  if (!owner) throw notFound("Portal");
  // The principal the grant belongs to: a signed-in person may hold the grant through a viewer
  // email confirmed in this browser, as the artifact gate allows.
  const as: Principal =
    d.role === "owner" || !grant || grant.email === own
      ? ctx.principal
      : { kind: "viewer", email: grant.email };
  const asCtx: Ctx = { ...ctx, principal: as, viewerEmail: null };
  const items: ArtifactSummary[] = [];
  const rows = await portalRows(ctx, share);
  const counts = await versionCounts(
    ctx,
    rows.map((r) => r.id),
  );
  const direct = await directGrants(
    ctx,
    rows.map((r) => r.id),
    grant?.email ?? null,
  );
  for (const a of rows) {
    const v = decide(as, "view", factsOf(a), {
      grantRole: direct.get(a.id) ?? null,
      categoryGrant: grant
        ? {
            shareId: share.id,
            shareOwnerId: share.owner_id,
            shareKey: share.category_key,
            role: grant.role,
          }
        : null,
      categorySharing: ctx.config.allowCategorySharing,
      passwordPassed: false,
      publicEnabled: ctx.config.allowPublicVisibility,
    });
    if (!v.allow) continue;
    items.push(toSummary(asCtx, a, owner, counts.get(a.id) ?? 0, v.role));
  }
  return {
    status: "ok",
    portal: {
      id: share.id,
      title: share.title,
      owner_name: pageDisplayName(owner.name),
      role: d.role,
    },
    items,
  };
}

async function versionCounts(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { results } = await ctx.env.DB.prepare(
    `SELECT artifact_id AS id, count(*) AS n FROM versions
      WHERE artifact_id IN (SELECT value FROM json_each(?1)) GROUP BY artifact_id`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; n: number }>();
  return new Map(results.map((r) => [r.id, r.n]));
}

async function directGrants(
  ctx: Ctx,
  ids: string[],
  email: string | null,
): Promise<Map<string, "viewer" | "commenter" | "editor">> {
  if (ids.length === 0 || !email) return new Map();
  const { results } = await ctx.env.DB.prepare(
    `SELECT artifact_id AS id, role FROM access_grants
      WHERE email = ?1 AND artifact_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(email, JSON.stringify(ids))
    .all<{ id: string; role: "viewer" | "commenter" | "editor" }>();
  return new Map(results.map((r) => [r.id, r.role]));
}

// ---------- the email code flow ----------

/** Codes are hashed with SESSION_SECRET as a pepper and bound to the share and the email. */
function codeHash(ctx: Ctx, shareId: string, email: string, code: string): Promise<string> {
  return hmacHex(ctx.config.sessionSecret, `viewer-code\nportal:${shareId}\n${email}\n${code}`);
}

/** Who an email is on this share: its owner, a grant holder, or nobody. Both lookups always run. */
async function portalHolder(
  ctx: Ctx,
  share: ShareSql,
  email: string,
): Promise<{ kind: "owner"; user: UserRow } | { kind: "listed" } | null> {
  const [owner, grant] = await Promise.all([
    getUserById(ctx.db, share.owner_id),
    shareGrant(ctx, share.id, [email], email),
  ]);
  if (owner && owner.email === email && maySignIn(ctx.config, email)) {
    return { kind: "owner", user: owner };
  }
  return grant ? { kind: "listed" } : null;
}

const ipKey = (ctx: Ctx) => ctx.ip ?? "unknown";

/**
 * POST /portals/:id/email: send a code if the email holds a grant on the share or is its owner's.
 * The answer is the same either way, and the limits count both alike (the same counters as the
 * allowlist code flow), so the people on a share cannot be probed. Mailed after the response.
 */
export async function requestPortalCode(ctx: Ctx, id: string, email: string): Promise<void> {
  refuseBoundToken(ctx.principal);
  const share = await loadShare(ctx, id);
  if (!share) throw notFound("Portal");
  const tooMany = "Too many codes requested. Try again later.";
  await enforce(
    ctx.env.DB,
    `viewer-code:ip:${ipKey(ctx)}`,
    RATE_LIMITS.loginPerIpPerHour,
    HOUR,
    tooMany,
  );
  await enforce(
    ctx.env.DB,
    `viewer-code:email:${email}`,
    RATE_LIMITS.viewerCodesPerEmailPerHour,
    HOUR,
    tooMany,
  );
  if (!(await portalHolder(ctx, share, email))) return;
  ctx.waitUntil(
    sendPortalCode(ctx, share, email).catch((e: unknown) => {
      console.error("portal code email failed:", e instanceof Error ? e.message : "unknown");
    }),
  );
}

async function sendPortalCode(ctx: Ctx, share: ShareSql, email: string): Promise<void> {
  const now = nowIso();
  // Only the newest code works.
  await ctx.env.DB.prepare(
    `UPDATE login_codes SET consumed_at = ?1
      WHERE email = ?2 AND purpose = 'viewer' AND share_id = ?3 AND artifact_id IS NULL
        AND consumed_at IS NULL`,
  )
    .bind(now, email, share.id)
    .run();
  const code = newSixDigitCode();
  await ctx.env.DB.prepare(
    `INSERT INTO login_codes (id, email, purpose, artifact_id, share_id, code_hash, link_token_hash,
       attempts, expires_at, consumed_at, created_at)
     VALUES (?1, ?2, 'viewer', NULL, ?3, ?4, NULL, 0, ?5, NULL, ?6)`,
  )
    .bind(
      newId(),
      email,
      share.id,
      await codeHash(ctx, share.id, email, code),
      isoIn(TTL.viewerCodeMs),
      now,
    )
    .run();
  const owner = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, share.owner_id))
    .get();
  const minutes = Math.round(TTL.viewerCodeMs / 60000);
  // Neither the share's title nor the category name: only who shared it.
  const ownerName = pageDisplayName(owner?.name);
  const who = ownerName ? `${ownerName} shared` : "someone shared";
  await createEmailAdapter(ctx.config, ctx.env).send({
    to: email,
    subject: "Your Plinth viewing code",
    text: [
      `Someone asked to open a collection ${who} on Plinth with this email address.`,
      "",
      `Your code is ${code}. It works once and expires in ${minutes} minutes.`,
      "",
      "If this was not you, ignore this email.",
    ].join("\n"),
  });
}

/**
 * POST /portals/:id/code: check a code and start a session: an app session for the share's owner,
 * a viewer session for a grant holder. Every failure looks the same (wrong, expired or used code,
 * too many attempts, or an email whose grant was removed since the code was sent).
 */
export async function verifyPortalCode(
  ctx: Ctx,
  id: string,
  email: string,
  code: string,
): Promise<ViewerCodeResult> {
  refuseBoundToken(ctx.principal);
  const share = await loadShare(ctx, id);
  if (!share) throw notFound("Portal");
  const tooMany = "Too many attempts. Try again later.";
  await enforce(
    ctx.env.DB,
    `viewer-verify:ip:${ipKey(ctx)}`,
    RATE_LIMITS.loginPerIpPerHour,
    HOUR,
    tooMany,
  );
  await enforce(
    ctx.env.DB,
    `viewer-verify:email:${email}`,
    RATE_LIMITS.codeAttemptsPerEmailPerHour,
    HOUR,
    tooMany,
  );
  const invalid = new ApiError(
    "forbidden",
    "That code is wrong or has expired. Ask for a new one.",
    { reason: "invalid_code" },
  );
  const row = await ctx.env.DB.prepare(
    `SELECT id, code_hash FROM login_codes
      WHERE email = ?1 AND purpose = 'viewer' AND share_id = ?2 AND artifact_id IS NULL
        AND consumed_at IS NULL AND expires_at > ?3
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email, share.id, nowIso())
    .first<{ id: string; code_hash: string }>();
  if (!row) throw invalid;
  // Count the attempt first, atomically, so parallel guesses cannot exceed the cap.
  const counted = await ctx.env.DB.prepare(
    "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND consumed_at IS NULL RETURNING attempts",
  )
    .bind(row.id, MAX_VIEWER_CODE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!counted) throw invalid;
  if (!timingSafeEqual(await codeHash(ctx, share.id, email, code), row.code_hash)) throw invalid;
  const consumed = await ctx.env.DB.prepare(
    "UPDATE login_codes SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
  )
    .bind(row.id, nowIso())
    .run();
  if ((consumed.meta.changes ?? 0) === 0) throw invalid;
  // The owner may have removed the person since the code was sent.
  const holder = await portalHolder(ctx, share, email);
  if (!holder) throw invalid;
  if (holder.kind === "owner") {
    return {
      kind: "user",
      value: await createUserSession(ctx.db, holder.user.id),
      user: holder.user,
    };
  }
  return { kind: "viewer", value: await createViewerSession(ctx, email) };
}

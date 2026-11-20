// Recording artifact opens (docs/spec.md "Artifact stats"). The gate decides whether an open counts,
// seals a one-bit `w` flag into the enter token and, beside it, the sealed opener (who is opening:
// an account, a confirmed email or an anonymous visitor, and the role). The content host's enter
// exchange records one artifact_opens row after every access check, at most once per browser per
// content pass. No IP address or user agent is stored. The hourly cron folds opens older than
// VIEW_LOG_RETENTION_DAYS into artifact_view_totals (counts only) and deletes them.
import {
  CONTENT_RESERVED_PREFIX,
  type EffectiveRole,
  type OpenRole,
  type Visibility,
} from "@plinth/shared";
import { type Bindings, parseViewLogRetentionDays } from "../config.ts";
import type { Opener } from "../content/tokens.ts";
import { isAdmin } from "../policy.ts";
import type { Ctx } from "./context.ts";

const DAY_MS = 86_400_000;

/** The UTC day of a timestamp, as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Whether the gate's ok answer should count as an open when its enter token is redeemed. Runs only
 * after the view decision allowed, and never widens access. Not counted: counting off, agents
 * (verifying a publish), the owner, an admin without a role (even on public pages), review mode,
 * an explicit version (history, compare, /a/:slug/v/:n) and Plinth's own paths (the editor preview,
 * /__plinth/v/<n>/).
 */
export function countsAsView(
  ctx: Pick<Ctx, "config" | "principal">,
  d: { role: EffectiveRole | null },
  opts: { version?: number; review?: boolean },
  next: string,
): boolean {
  if (!ctx.config.viewCounts) return false;
  const p = ctx.principal;
  if (p.kind === "agent") return false;
  if (d.role === "owner") return false;
  if (d.role === null && p.kind === "user" && isAdmin(p)) return false;
  if (opts.review) return false;
  if (opts.version !== undefined) return false;
  if (next.startsWith(CONTENT_RESERVED_PREFIX)) return false;
  return true;
}

/** How someone without a grant reached a page: its visibility, as a role label. */
const NO_GRANT_ROLE: Record<Visibility, OpenRole> = {
  public: "public",
  unlisted: "link",
  password: "password",
  // Only an admin reaches an allowlist page without a grant, and an admin without a role never
  // counts; the label is here for completeness.
  allowlist: "viewer",
};

/**
 * Who is opening, for a counted open (countsAsView held). Anyone signed in is recorded as their
 * account, whatever the visibility. A viewer confirmed by code is recorded by email only when it
 * holds a grant on this artifact (an allowlisted email); otherwise, like everyone else, as an
 * anonymous visitor.
 */
export function openerFor(
  principal: Ctx["principal"],
  role: EffectiveRole | null,
  visibility: Visibility,
): Opener {
  const r: OpenRole = role === null || role === "owner" ? NO_GRANT_ROLE[visibility] : role;
  if (principal.kind === "user") return { kind: "user", userId: principal.userId, role: r };
  if (principal.kind === "viewer" && role !== null)
    return { kind: "email", email: principal.email, role: r };
  return { kind: "anonymous", role: r };
}

/**
 * User agents that announce a crawler, an unfurler, a headless browser or a script. A bot names
 * itself with a product token ("Googlebot/2.1", "Slackbot-LinkExpanding") or a contact URL
 * ("+https://..."); a bare "bot" is not enough, since phone models such as "CUBOT" contain it.
 */
const BOT_UA =
  /[a-z]bot\/|slackbot|telegrambot|\+https?:\/\/|crawl|spider|slurp|headless|lighthouse|bingpreview|facebookexternalhit|embedly|^whatsapp\/|python-requests|^curl\/|^wget\/|go-http-client/i;

/** Whether a user agent looks like a bot. An empty one does. Read in memory only, never stored. */
export function looksLikeBot(userAgent: string | null): boolean {
  if (!userAgent?.trim()) return true;
  return BOT_UA.test(userAgent);
}

/** Whether an enter request comes from a browser loading the page in the app's frame. */
export function isCountableRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-dest") !== "iframe") return false;
  return !looksLikeBot(request.headers.get("user-agent"));
}

/** One counted open as it is written. `opener` null: the token carried none (`unknown`). */
export interface OpenRecord {
  artifactId: string;
  version: number;
  opener: Opener | null;
  /** The browser's visitor id; stored for anonymous visitors only. */
  visitor: string | null;
  nowMs: number;
}

/**
 * Write one counted open. Never throws: a failed write (the artifact erased in between, D1
 * unavailable) must not fail the open, and the log line carries no id, email or token.
 */
export async function recordOpen(db: D1Database, r: OpenRecord): Promise<void> {
  const o = r.opener;
  try {
    await db
      .prepare(
        `INSERT INTO artifact_opens
           (artifact_id, version, opened_at, viewer_kind, user_id, email, visitor, role)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        r.artifactId,
        r.version,
        new Date(r.nowMs).toISOString(),
        o?.kind ?? "unknown",
        o?.kind === "user" ? o.userId : null,
        o?.kind === "email" ? o.email : null,
        o?.kind === "anonymous" ? r.visitor : null,
        o?.role ?? null,
      )
      .run();
  } catch {
    console.error("view count failed");
  }
}

/**
 * Fold opens older than `retentionDays` into one all-time count per artifact and delete them, in
 * one transaction: counts move, who opened goes. A second run finds nothing to fold. The cutoff is
 * a UTC midnight, so a day is folded whole. The WHERE clause also keeps SQLite from reading ON
 * CONFLICT as a join constraint (upsert after SELECT).
 */
export async function foldOpens(
  db: D1Database,
  retentionDays: number,
  nowMs: number,
): Promise<void> {
  const cutoff = `${utcDay(nowMs - retentionDays * DAY_MS)}T00:00:00.000Z`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO artifact_view_totals (artifact_id, views, first_day)
           SELECT artifact_id, count(*), substr(min(opened_at), 1, 10) FROM artifact_opens
            WHERE opened_at < ?1 GROUP BY artifact_id
           ON CONFLICT (artifact_id) DO UPDATE SET views = views + excluded.views,
             first_day = min(first_day, excluded.first_day)`,
      )
      .bind(cutoff),
    db.prepare("DELETE FROM artifact_opens WHERE opened_at < ?1").bind(cutoff),
  ]);
}

/**
 * VIEW_LOG_RETENTION_DAYS for the cron, read on its own. Null when it is set to something the
 * Worker refuses: then nothing is folded, since guessing a shorter window would delete opens.
 */
export function viewRetentionDays(env: Bindings): number | null {
  try {
    return parseViewLogRetentionDays(env as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
}

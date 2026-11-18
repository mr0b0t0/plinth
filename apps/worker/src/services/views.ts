// Artifact open counts (docs/spec.md "Admin stats and view counts"). The gate decides whether an
// open counts and seals a one-bit `w` flag into the enter token; the content host's enter exchange
// records it after every access check, at most once per browser per content pass. Only an
// aggregate number per artifact per UTC day is stored: never who opened it.
import { CONTENT_RESERVED_PREFIX, type EffectiveRole } from "@plinth/shared";
import { isAdmin } from "../policy.ts";
import type { Ctx } from "./context.ts";

/** Days kept as daily rows; older days fold into artifact_view_totals (the longest trend window). */
export const VIEW_DAYS_KEPT = 90;

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

/**
 * Add one open to an artifact's count for today (UTC). Never throws: a failed count (the artifact
 * erased in between, D1 unavailable) must not fail the open, and the log carries no id or token.
 */
export async function recordView(db: D1Database, artifactId: string, nowMs: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?1, ?2, 1)
         ON CONFLICT (artifact_id, day) DO UPDATE SET views = views + 1`,
      )
      .bind(artifactId, utcDay(nowMs))
      .run();
  } catch {
    console.error("view count failed");
  }
}

/**
 * Fold daily rows older than VIEW_DAYS_KEPT into one total per artifact, in one transaction. It
 * moves counts, never drops them, and a second run finds nothing to fold. The WHERE clause also
 * keeps SQLite from reading ON CONFLICT as a join constraint (upsert after SELECT).
 */
export async function foldViewDays(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = utcDay(nowMs - VIEW_DAYS_KEPT * DAY_MS);
  await db.batch([
    db
      .prepare(
        `INSERT INTO artifact_view_totals (artifact_id, views, first_day)
           SELECT artifact_id, sum(views), min(day) FROM artifact_view_days WHERE day < ?1
           GROUP BY artifact_id
           ON CONFLICT (artifact_id) DO UPDATE SET views = views + excluded.views,
             first_day = min(first_day, excluded.first_day)`,
      )
      .bind(cutoff),
    db.prepare("DELETE FROM artifact_view_days WHERE day < ?1").bind(cutoff),
  ]);
}

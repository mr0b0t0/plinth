// Invitation emails (docs/spec.md "Invitation emails"). When an owner adds people to an artifact
// (the sharing list or set_visibility's allowlist) or to a shared category and the request asked
// to `notify`, each person the change gave access to gets one email from the instance's email
// provider, on the owner's behalf: '<owner> shared "<title>" with you', the link and the role.
//
// Bounds, in this order, per person: only a new grant (an address that held none before the
// change), never the owner's own address, policy.ts mayEmailInvitations (asked, the owner acting,
// a verified owner, not taken down), one email per artifact or share and address within a day
// (`already_emailed`), RATE_LIMITS.invitationsPerChange, invitationsPerOwnerPerDay and
// invitationsPerRecipientPerDay. The counters live in `rate_limits` under keys that hold a hash of
// the address, never the address, read in one query and written in one batch whatever the number
// of people; the hourly cron removes them after two days (pruneInvitationMarks). Titles and names
// are never logged.
import { type InvitationReport, pageDisplayName, RATE_LIMITS, type Role } from "@plinth/shared";
import { appUrl } from "../config.ts";
import type { UserRow } from "../db/schema.ts";
import { createEmailAdapter } from "../email/index.ts";
import { invitationEmail } from "../email/templates.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { forbidden } from "../lib/errors.ts";
import { mayEmailInvitations } from "../policy.ts";
import type { Ctx } from "./context.ts";

const DAY_S = 86_400;
/** Every invitation counter's key starts with this (pruneInvitationMarks). */
const KEY_PREFIX = "invite:";

export interface Invitee {
  email: string;
  role: Role;
}

export type InvitationTarget =
  | { kind: "artifact"; id: string; slug: string; title: string; takenDown: boolean }
  /** A category share: `title` is the name its people see; the link is its portal. */
  | { kind: "category"; id: string; title: string };

/** The people in `after` whose address held no grant `before` the change, without the owner. */
export function newInvitees(
  before: Iterable<string>,
  after: readonly Invitee[],
  ownerEmail: string | null,
): Invitee[] {
  const had = new Set(before);
  const seen = new Set<string>();
  const out: Invitee[] = [];
  for (const p of after) {
    if (had.has(p.email) || p.email === ownerEmail || seen.has(p.email)) continue;
    seen.add(p.email);
    out.push(p);
  }
  return out;
}

/** The hash an address's counters are keyed by. */
export const invitationAddressHash = async (email: string) =>
  (await sha256Hex(`invite\n${email}`)).slice(0, 32);

/** Add one to each key's counter in this window, creating it at 1. */
const COUNT_EACH = `INSERT INTO rate_limits (key, window_start, count)
  SELECT value, ?2, 1 FROM json_each(?1) WHERE true
  ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1`;

/**
 * Email the people a sharing change added, as far as the bounds allow. Undefined when the request
 * did not ask (`notify` false), so results without it keep their shape. Counters are written
 * before the result returns; the messages go out after the response (waitUntil), and a provider
 * failure is logged without the address, the title or the message.
 */
export async function sendInvitations(
  ctx: Ctx,
  opts: {
    notify: boolean;
    owner: UserRow | null | undefined;
    target: InvitationTarget;
    invitees: readonly Invitee[];
  },
): Promise<InvitationReport | undefined> {
  if (!opts.notify) return undefined;
  const report: InvitationReport = { emailed: [], skipped: [] };
  const { owner, target } = opts;
  if (!owner || opts.invitees.length === 0) return report;
  const may = mayEmailInvitations({
    notify: opts.notify,
    principal: ctx.principal,
    ownerId: owner.id,
    ownerVerified: owner.emailVerifiedAt !== null,
    takenDown: target.kind === "artifact" && target.takenDown,
  });
  if (!may.allow) {
    // The routes are the owner's alone, so another caller never gets this far.
    if (may.reason === "not_owner" || may.reason === "not_requested") throw forbidden();
    for (const p of opts.invitees) report.skipped.push({ email: p.email, reason: may.reason });
    return report;
  }

  const DB = ctx.env.DB;
  const nowS = Math.floor(Date.now() / 1000);
  const today = nowS - (nowS % DAY_S);
  const yesterday = today - DAY_S;
  const ownerKey = `${KEY_PREFIX}owner:${owner.id}`;
  const scope = `${KEY_PREFIX}sent:${target.kind === "artifact" ? "a" : "s"}:${target.id}:`;
  const people = await Promise.all(
    opts.invitees.map(async (p) => {
      const h = await invitationAddressHash(p.email);
      return { ...p, mark: `${scope}${h}`, to: `${KEY_PREFIX}to:${h}` };
    }),
  );

  // One read for every counter this change may touch, today's and yesterday's.
  const keys = [ownerKey, ...people.flatMap((p) => [p.mark, p.to])];
  const { results } = await DB.prepare(
    `SELECT key, window_start, count FROM rate_limits
      WHERE key IN (SELECT value FROM json_each(?1)) AND window_start IN (?2, ?3)`,
  )
    .bind(JSON.stringify(keys), today, yesterday)
    .all<{ key: string; window_start: number; count: number }>();
  const counts = new Map(results.map((r) => [`${r.key}\n${r.window_start}`, r.count]));
  const count = (key: string, window: number) => counts.get(`${key}\n${window}`) ?? 0;

  let ownerSent = count(ownerKey, today);
  const chosen: typeof people = [];
  for (const p of people) {
    // The mark of the previous day counts too, so "within a day" never resets at midnight UTC.
    if (count(p.mark, today) + count(p.mark, yesterday) > 0) {
      report.skipped.push({ email: p.email, reason: "already_emailed" });
    } else if (chosen.length >= RATE_LIMITS.invitationsPerChange) {
      report.skipped.push({ email: p.email, reason: "change_limit" });
    } else if (ownerSent >= RATE_LIMITS.invitationsPerOwnerPerDay) {
      report.skipped.push({ email: p.email, reason: "owner_limit" });
    } else if (count(p.to, today) >= RATE_LIMITS.invitationsPerRecipientPerDay) {
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
    } else {
      ownerSent += 1;
      chosen.push(p);
    }
  }
  if (chosen.length === 0) return report;

  // Mark them in one statement. A mark that is not new was written by another save a moment ago,
  // so two saves at once still send one email.
  const marked = await DB.prepare(`${COUNT_EACH} RETURNING key, count`)
    .bind(JSON.stringify(chosen.map((p) => p.mark)), today)
    .all<{ key: string; count: number }>();
  const first = new Set(marked.results.filter((r) => r.count === 1).map((r) => r.key));
  const sending = chosen.filter((p) => first.has(p.mark));
  for (const p of chosen) {
    if (!first.has(p.mark)) report.skipped.push({ email: p.email, reason: "already_emailed" });
  }
  if (sending.length === 0) return report;
  await DB.batch([
    DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3`,
    ).bind(ownerKey, today, sending.length),
    DB.prepare(COUNT_EACH).bind(JSON.stringify(sending.map((p) => p.to)), today),
  ]);

  const link =
    target.kind === "artifact"
      ? appUrl(ctx.config, `/a/${target.slug}`)
      : appUrl(ctx.config, `/p/${target.id}`);
  const ownerName = pageDisplayName(owner.name);
  const messages = sending.map((p) => {
    report.emailed.push(p.email);
    return invitationEmail({
      to: p.email,
      kind: target.kind,
      ownerEmail: owner.email,
      ownerName,
      title: target.title,
      role: p.role,
      link,
    });
  });
  ctx.waitUntil(
    (async () => {
      const adapter = createEmailAdapter(ctx.config, ctx.env);
      const sent = await Promise.allSettled(messages.map((m) => adapter.send(m)));
      const failed = sent.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        const reason = (failed[0] as PromiseRejectedResult).reason;
        const why = reason instanceof Error ? reason.message : "unknown";
        console.error(`invitation email: ${failed.length} of ${sent.length} failed: ${why}`);
      }
    })().catch(() => {
      console.error("invitation email: the email provider is not configured");
    }),
  );
  return report;
}

/** The hourly cron: invitation counters whose window ended more than two days ago. */
export async function pruneInvitationMarks(d1: D1Database, at: number): Promise<void> {
  const nowS = Math.floor(at / 1000);
  await d1
    .prepare("DELETE FROM rate_limits WHERE key LIKE ?1 AND window_start < ?2")
    .bind(`${KEY_PREFIX}%`, nowS - 2 * DAY_S)
    .run();
}

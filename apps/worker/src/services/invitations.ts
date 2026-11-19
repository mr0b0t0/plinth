// Invitation emails (docs/spec.md "Invitation emails"). When an owner adds people to an artifact
// (the sharing list or set_visibility's allowlist) or to a shared category and the request asked
// to `notify`, each person the change gave access to gets one email from the instance's email
// provider, on the owner's behalf: '<owner> shared "<title>" with you', the link and the role.
//
// Bounds, in this order, per person: only a new grant (an address that held none before the
// change), never the owner's own address, policy.ts mayEmailInvitations (asked, the owner acting,
// a verified owner, not taken down), one email per artifact or share and address within a day
// (`already_emailed`), RATE_LIMITS.invitationsPerChange, invitationsPerOwnerPerDay,
// invitationsPerRecipientPerDay and invitationsPerOwnerPerRecipientPerDay. The counters live in
// `rate_limits` under keys that hold a hash of the address, never the address. One query reads
// them; then each limit is reserved before anything is sent (raise the counter, check the count it
// returns, give back what was not used), so parallel changes cannot pass a limit. The number of
// statements does not grow with the number of people; the hourly cron removes the counters after
// two days (pruneInvitationMarks). Titles and names are never logged.
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
      return {
        ...p,
        mark: `${scope}${h}`,
        to: `${KEY_PREFIX}to:${h}`,
        pair: `${KEY_PREFIX}pair:${owner.id}:${h}`,
      };
    }),
  );
  type Person = (typeof people)[number];

  // One read for every counter this change may touch, today's and yesterday's. It picks who to
  // try and gives the usual reasons; the reservations below are what actually holds the limits.
  const keys = [ownerKey, ...people.flatMap((p) => [p.mark, p.to, p.pair])];
  const { results } = await DB.prepare(
    `SELECT key, window_start, count FROM rate_limits
      WHERE key IN (SELECT value FROM json_each(?1)) AND window_start IN (?2, ?3)`,
  )
    .bind(JSON.stringify(keys), today, yesterday)
    .all<{ key: string; window_start: number; count: number }>();
  const counts = new Map(results.map((r) => [`${r.key}\n${r.window_start}`, r.count]));
  const count = (key: string, window: number) => counts.get(`${key}\n${window}`) ?? 0;
  const recipientFull = (p: Person, at: (key: string) => number) =>
    at(p.to) > RATE_LIMITS.invitationsPerRecipientPerDay ||
    at(p.pair) > RATE_LIMITS.invitationsPerOwnerPerRecipientPerDay;

  let ownerSent = count(ownerKey, today);
  const chosen: Person[] = [];
  for (const p of people) {
    // The mark of the previous day counts too, so "within a day" never resets at midnight UTC.
    if (count(p.mark, today) + count(p.mark, yesterday) > 0) {
      report.skipped.push({ email: p.email, reason: "already_emailed" });
    } else if (chosen.length >= RATE_LIMITS.invitationsPerChange) {
      report.skipped.push({ email: p.email, reason: "change_limit" });
    } else if (ownerSent >= RATE_LIMITS.invitationsPerOwnerPerDay) {
      report.skipped.push({ email: p.email, reason: "owner_limit" });
    } else if (recipientFull(p, (key) => count(key, today) + 1)) {
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
    } else {
      ownerSent += 1;
      chosen.push(p);
    }
  }
  if (chosen.length === 0) return report;

  // Reserve, then check, like lib/ratelimit.ts hit(): every counter is raised in one statement
  // and the count it returns decides, so changes running at the same time can never send more
  // than a limit allows. What a person was not sent is given back at the end.
  const giveBack: string[] = [];
  let ownerGiveBack = 0;
  const reserved = await DB.prepare(`${COUNT_EACH} RETURNING key, count`)
    .bind(JSON.stringify(chosen.flatMap((p) => [p.to, p.pair])), today)
    .all<{ key: string; count: number }>();
  const after = new Map(reserved.results.map((r) => [r.key, r.count]));
  const recipientOk: Person[] = [];
  for (const p of chosen) {
    if (recipientFull(p, (key) => after.get(key) ?? Number.POSITIVE_INFINITY)) {
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
      giveBack.push(p.to, p.pair);
    } else recipientOk.push(p);
  }

  let marking: Person[] = [];
  if (recipientOk.length > 0) {
    const n = recipientOk.length;
    const row = await DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3 RETURNING count`,
    )
      .bind(ownerKey, today, n)
      .first<{ count: number }>();
    const before = (row?.count ?? Number.POSITIVE_INFINITY) - n;
    const room = Math.max(0, Math.min(n, RATE_LIMITS.invitationsPerOwnerPerDay - before));
    marking = recipientOk.slice(0, room);
    ownerGiveBack += n - room;
    for (const p of recipientOk.slice(room)) {
      report.skipped.push({ email: p.email, reason: "owner_limit" });
      giveBack.push(p.to, p.pair);
    }
  }

  // Mark them in one statement. A mark that is not new was written by another save a moment ago,
  // so two saves at once still send one email, and this one gives its reservations back.
  let sending: Person[] = [];
  if (marking.length > 0) {
    const marked = await DB.prepare(`${COUNT_EACH} RETURNING key, count`)
      .bind(JSON.stringify(marking.map((p) => p.mark)), today)
      .all<{ key: string; count: number }>();
    const first = new Set(marked.results.filter((r) => r.count === 1).map((r) => r.key));
    sending = marking.filter((p) => first.has(p.mark));
    for (const p of marking) {
      if (first.has(p.mark)) continue;
      report.skipped.push({ email: p.email, reason: "already_emailed" });
      giveBack.push(p.to, p.pair);
      ownerGiveBack += 1;
    }
  }

  const returns: D1PreparedStatement[] = [];
  if (giveBack.length > 0) {
    returns.push(
      DB.prepare(
        `UPDATE rate_limits SET count = MAX(count - 1, 0)
          WHERE window_start = ?2 AND key IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(giveBack), today),
    );
  }
  if (ownerGiveBack > 0) {
    returns.push(
      DB.prepare(
        `UPDATE rate_limits SET count = MAX(count - ?3, 0) WHERE key = ?1 AND window_start = ?2`,
      ).bind(ownerKey, today, ownerGiveBack),
    );
  }
  if (returns.length > 0) await DB.batch(returns);
  if (sending.length === 0) return report;

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

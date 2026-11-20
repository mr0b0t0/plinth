// Invitation emails (docs/spec.md "Invitation emails"). When an owner adds people to an artifact
// (the sharing list or set_visibility's allowlist) or to a shared category and the request asked
// to `notify`, each person the change gave access to gets one email from the instance's email
// provider, on the owner's behalf: '<owner> shared "<title>" with you', the link and the role.
//
// Bounds, in this order, per person: only a new grant (an address that held none before the
// change), never the owner's own address, policy.ts mayEmailInvitations (asked, the owner acting,
// a verified owner, not taken down), the operator's switch (INVITATION_EMAILS_PER_DAY=0 is off),
// one email per artifact or share and address within a day (`already_emailed`),
// RATE_LIMITS.invitationsPerChange, INVITATION_EMAILS_PER_OWNER_PER_DAY, the instance's
// INVITATION_EMAILS_PER_DAY (every owner together, so invitations cannot use up the provider quota
// sign-in and viewing codes need), invitationsPerRecipientPerDay and
// invitationsPerOwnerPerRecipientPerDay. The counters live in `rate_limits` under keys that hold a
// hash of the address, never the address. One query reads them; then each limit is reserved before
// anything is sent (raise the counter, check the count it returns, give back what was not used),
// so parallel changes cannot pass a limit. The number of statements does not grow with the number
// of people; the hourly cron removes the counters after two days (pruneInvitationMarks). Titles
// and names are never logged. The messages go to the provider after the response, in batch
// requests or one at a time, never all at once (deliverInvitations), and an invitation the
// provider refused gets its mark and counters back.
import {
  type InvitationReport,
  type InvitationSkipReason,
  pageDisplayName,
  RATE_LIMITS,
  type Role,
} from "@plinth/shared";
import { appUrl, invitationEmailsActive } from "../config.ts";
import type { UserRow } from "../db/schema.ts";
import {
  createEmailAdapter,
  type EmailAdapter,
  type EmailMessage,
  EmailSendError,
} from "../email/index.ts";
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
 * failure is logged without the address, the title or the message. What the provider refused is
 * given back then, so `emailed` names who was handed over, not who the provider took.
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
  // With invitation emails off on this instance, nobody is emailed whatever else holds.
  const off = !invitationEmailsActive(ctx.config);
  if (off || !may.allow) {
    let reason: InvitationSkipReason = "invitations_off";
    if (!may.allow) {
      // The routes are the owner's alone, so another caller never gets this far.
      if (may.reason === "not_owner" || may.reason === "not_requested") throw forbidden();
      if (!off) reason = may.reason;
    }
    for (const p of opts.invitees) report.skipped.push({ email: p.email, reason });
    return report;
  }

  const limits = ctx.config.invitations;
  const DB = ctx.env.DB;
  const nowS = Math.floor(Date.now() / 1000);
  const today = nowS - (nowS % DAY_S);
  const yesterday = today - DAY_S;
  const ownerKey = `${KEY_PREFIX}owner:${owner.id}`;
  /** Every owner's invitations together, against INVITATION_EMAILS_PER_DAY. */
  const instanceKey = `${KEY_PREFIX}instance`;
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
  const keys = [ownerKey, instanceKey, ...people.flatMap((p) => [p.mark, p.to, p.pair])];
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
  let instanceSent = count(instanceKey, today);
  const chosen: Person[] = [];
  for (const p of people) {
    // The mark of the previous day counts too, so "within a day" never resets at midnight UTC.
    if (count(p.mark, today) + count(p.mark, yesterday) > 0) {
      report.skipped.push({ email: p.email, reason: "already_emailed" });
    } else if (chosen.length >= RATE_LIMITS.invitationsPerChange) {
      report.skipped.push({ email: p.email, reason: "change_limit" });
    } else if (ownerSent >= limits.perOwnerPerDay) {
      report.skipped.push({ email: p.email, reason: "owner_limit" });
    } else if (instanceSent >= limits.perDay) {
      report.skipped.push({ email: p.email, reason: "instance_limit" });
    } else if (recipientFull(p, (key) => count(key, today) + 1)) {
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
    } else {
      ownerSent += 1;
      instanceSent += 1;
      chosen.push(p);
    }
  }
  if (chosen.length === 0) return report;

  // Reserve, then check, like lib/ratelimit.ts hit(): every counter is raised in one statement
  // and the count it returns decides, so changes running at the same time can never send more
  // than a limit allows. What a person was not sent is given back at the end.
  const giveBack: string[] = [];
  /** Reservations to give back on both day counters, the owner's and the instance's. */
  let dayGiveBack = 0;
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
    // The owner's and the instance's day counters are raised by the number left, in one batch;
    // the smaller room left under either limit is how many go on.
    const n = recipientOk.length;
    const raise = (key: string) =>
      DB.prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3 RETURNING count`,
      ).bind(key, today, n);
    const [ownerRow, instanceRow] = await DB.batch<{ count: number }>([
      raise(ownerKey),
      raise(instanceKey),
    ]);
    const roomUnder = (rows: D1Result<{ count: number }> | undefined, limit: number) => {
      const before = (rows?.results[0]?.count ?? Number.POSITIVE_INFINITY) - n;
      return Math.max(0, Math.min(n, limit - before));
    };
    const ownerRoom = roomUnder(ownerRow, limits.perOwnerPerDay);
    const instanceRoom = roomUnder(instanceRow, limits.perDay);
    const room = Math.min(ownerRoom, instanceRoom);
    const reason = ownerRoom <= instanceRoom ? "owner_limit" : "instance_limit";
    marking = recipientOk.slice(0, room);
    dayGiveBack += n - room;
    for (const p of recipientOk.slice(room)) {
      report.skipped.push({ email: p.email, reason });
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
      dayGiveBack += 1;
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
  if (dayGiveBack > 0) {
    returns.push(
      DB.prepare(
        `UPDATE rate_limits SET count = MAX(count - ?3, 0)
          WHERE key IN (?1, ?4) AND window_start = ?2`,
      ).bind(ownerKey, today, dayGiveBack, instanceKey),
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
      let delivery: Delivery;
      try {
        delivery = await deliverInvitations(createEmailAdapter(ctx.config, ctx.env), messages);
      } catch {
        console.error("invitation email: the email provider is not configured");
        delivery = { refused: messages.map((_, i) => i), unknown: [], why: null };
      }
      const { refused, unknown, why } = delivery;
      if (refused.length + unknown.length > 0 && why !== null) {
        console.error(
          `invitation email: ${refused.length + unknown.length} of ${messages.length} not sent: ${why}`,
        );
      }
      // The provider did not take these, so nothing reached them: their mark and every counter
      // they reserved go back, and adding the person again can email them. A send whose outcome is
      // unknown (no answer, or a 5xx) keeps its counters, since it may have gone.
      const back = refused.map((i) => sending[i]).filter((p): p is Person => p !== undefined);
      if (back.length === 0) return;
      await DB.batch([
        DB.prepare(
          `UPDATE rate_limits SET count = MAX(count - 1, 0)
            WHERE window_start = ?2 AND key IN (SELECT value FROM json_each(?1))`,
        ).bind(JSON.stringify(back.flatMap((p) => [p.mark, p.to, p.pair])), today),
        DB.prepare(
          `UPDATE rate_limits SET count = MAX(count - ?3, 0)
            WHERE key IN (?1, ?4) AND window_start = ?2`,
        ).bind(ownerKey, today, back.length, instanceKey),
      ]);
    })().catch(() => {
      console.error("invitation email: the counters of unsent invitations were not given back");
    }),
  );
  return report;
}

/** How often a request the provider refused for its rate (HTTP 429) is tried again. */
const RATE_RETRIES = 2;
/** The longest wait before trying again, whatever `Retry-After` says (waitUntil is bounded). */
const RATE_WAIT_MAX_S = 5;

export interface Delivery {
  /** Indexes of the messages the provider refused (an HTTP 4xx answer): they were not sent. */
  refused: number[];
  /** Indexes whose outcome is unknown (no answer, or an HTTP 5xx): they may have been sent. */
  unknown: number[];
  /** The first failure's message, already redacted by the adapter. */
  why: string | null;
}

/**
 * Hand invitations to the provider without a burst. Providers limit requests per second (Resend's
 * default is a few per team), and sign-in and viewing codes share that limit, so the messages go in
 * batch requests where the adapter has a batch endpoint and one at a time otherwise, never in
 * parallel. A 429 is tried again after `Retry-After` (1 s when it does not say, at most
 * RATE_WAIT_MAX_S), RATE_RETRIES times; when that does not clear it, the rest are not tried and
 * count as refused.
 */
export async function deliverInvitations(
  adapter: EmailAdapter,
  messages: readonly EmailMessage[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Delivery> {
  const out: Delivery = { refused: [], unknown: [], why: null };
  const size = adapter.sendBatch ? Math.max(1, adapter.batchMax ?? 1) : 1;
  for (let start = 0; start < messages.length; start += size) {
    const group = messages.slice(start, start + size);
    const indexes = group.map((_, i) => start + i);
    for (let tries = 0; ; tries++) {
      try {
        if (adapter.sendBatch) await adapter.sendBatch(group);
        else if (group[0]) await adapter.send(group[0]);
        break;
      } catch (e) {
        const status = e instanceof EmailSendError ? e.status : null;
        if (status === 429 && tries < RATE_RETRIES) {
          const waitS = Math.min(
            Math.max((e as EmailSendError).retryAfterS ?? 1, 0),
            RATE_WAIT_MAX_S,
          );
          await sleep(waitS * 1000);
          continue;
        }
        out.why ??= e instanceof Error ? e.message : "unknown";
        if (status === 429) {
          // Still over the provider's rate: stop here rather than keep it busy.
          for (let i = start; i < messages.length; i++) out.refused.push(i);
          return out;
        }
        const refused = status !== null && status >= 400 && status < 500;
        (refused ? out.refused : out.unknown).push(...indexes);
        break;
      }
    }
  }
  return out;
}

/** The hourly cron: invitation counters whose window ended more than two days ago. */
export async function pruneInvitationMarks(d1: D1Database, at: number): Promise<void> {
  const nowS = Math.floor(at / 1000);
  await d1
    .prepare("DELETE FROM rate_limits WHERE key LIKE ?1 AND window_start < ?2")
    .bind(`${KEY_PREFIX}%`, nowS - 2 * DAY_S)
    .run();
}

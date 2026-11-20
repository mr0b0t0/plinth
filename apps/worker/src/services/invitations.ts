// Invitation emails (docs/spec.md "Invitation emails"). When an owner adds people to an artifact
// (the sharing list or set_visibility's allowlist) or to a shared category and the request asked
// to `notify`, each person the change gave access to gets one email from the instance's email
// provider, on the owner's behalf: '<owner> shared "<title>" with you', the link and the role.
//
// Bounds, in this order, per person: only a new grant (an address that held none before the
// change), never the owner's own address, policy.ts mayEmailInvitations (asked, the owner acting,
// a verified owner, not taken down), the operator's switch (config.ts invitationEmailsActive), one
// email per artifact or share and mailbox within a day (`already_emailed`),
// RATE_LIMITS.invitationsPerChange, INVITATION_EMAILS_PER_OWNER_PER_DAY, the instance's
// INVITATION_EMAILS_PER_DAY (every owner together, so invitations cannot use up the provider quota
// sign-in and viewing codes need), the person's own opt-out (`opted_out`: invitation_opt_outs, set
// on the app's /invitation-emails page after signing in as that address), then
// invitationsPerRecipientPerDay and invitationsPerOwnerPerRecipientPerDay. An opted-out person is
// never emailed, but the answer costs the owner what an email would (a place in the change and one
// of the owner's day), so owners cannot test addresses for free; it is only given once those two
// limits and the instance's leave room. Every counter and the opt-out are keyed by a hash of the
// address's mailbox (invitationMailbox), never the address, so `bo+1@` or `b.o@gmail.com` is the
// same inbox as `bo@`. One query reads them; then each limit is reserved before anything is sent
// (raise the counter, check the count it returns, give back what was not used), so parallel
// changes cannot pass a limit. The number of statements does not grow with the number of people;
// the hourly cron removes the counters after two days (pruneInvitationMarks). Titles and names are
// never logged. The messages go to the provider after the response, in batch requests or one at a
// time, never all at once (deliverInvitations), and an invitation the provider refused gets its
// mark and counters back.
import {
  APP_ROUTES,
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
import { nowIso } from "../lib/time.ts";
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

/** Domains where dots in the local part are ignored, so `b.o@` and `bo@` are one inbox. */
const DOTLESS_DOMAINS: Readonly<Record<string, string>> = {
  "gmail.com": "gmail.com",
  "googlemail.com": "gmail.com",
};

/**
 * The inbox an address reaches, as far as invitations go: lowercased, a `+tag` dropped from the
 * local part, and for Gmail the dots too (googlemail.com is gmail.com). It is only ever hashed,
 * for the opt-out and the invitation counters, so that variants of one inbox share them. Folding
 * two different inboxes together can only suppress an invitation, never send one.
 */
export function invitationMailbox(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1).replace(/\.+$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  const dotless = DOTLESS_DOMAINS[domain];
  if (dotless) {
    local = local.replaceAll(".", "") || local;
    domain = dotless;
  }
  return `${local}@${domain}`;
}

/** The hash an address's opt-out and counters are keyed by: its mailbox's, never the address. */
export const invitationAddressHash = async (email: string) =>
  (await sha256Hex(`invite\n${invitationMailbox(email)}`)).slice(0, 32);

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
  const hashed = await Promise.all(
    opts.invitees.map(async (p) => {
      const h = await invitationAddressHash(p.email);
      return {
        ...p,
        hash: h,
        mark: `${scope}${h}`,
        to: `${KEY_PREFIX}to:${h}`,
        pair: `${KEY_PREFIX}pair:${owner.id}:${h}`,
      };
    }),
  );
  type Person = (typeof hashed)[number];
  // Two addresses of one mailbox in one change (`bo@` and `bo+1@`) are one person: the first is
  // tried, and the others get its outcome at the end (`already_emailed` when it was emailed).
  const firstOf = new Map<string, string>();
  const people: Person[] = [];
  const sameInbox: { email: string; first: string }[] = [];
  for (const p of hashed) {
    const first = firstOf.get(p.hash);
    if (first === undefined) {
      firstOf.set(p.hash, p.email);
      people.push(p);
    } else sameInbox.push({ email: p.email, first });
  }
  const finish = () => {
    for (const d of sameInbox) {
      const skip = report.skipped.find((s) => s.email === d.first);
      report.skipped.push({ email: d.email, reason: skip ? skip.reason : "already_emailed" });
    }
    return report;
  };

  // One round trip reads who turned invitations off and every counter this change may touch,
  // today's and yesterday's. It picks who to try and gives the usual reasons; the reservations
  // below are what actually holds the limits.
  const keys = [ownerKey, instanceKey, ...people.flatMap((p) => [p.mark, p.to, p.pair])];
  const [optedOut, counted] = await DB.batch([
    DB.prepare(
      `SELECT address_hash AS h FROM invitation_opt_outs
        WHERE address_hash IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(people.map((p) => p.hash))),
    DB.prepare(
      `SELECT key, window_start, count FROM rate_limits
        WHERE key IN (SELECT value FROM json_each(?1)) AND window_start IN (?2, ?3)`,
    ).bind(JSON.stringify(keys), today, yesterday),
  ]);
  const optedOutHashes = new Set(((optedOut?.results ?? []) as { h: string }[]).map((r) => r.h));
  const results = (counted?.results ?? []) as {
    key: string;
    window_start: number;
    count: number;
  }[];
  const counts = new Map(results.map((r) => [`${r.key}\n${r.window_start}`, r.count]));
  const count = (key: string, window: number) => counts.get(`${key}\n${window}`) ?? 0;
  const recipientFull = (p: Person, at: (key: string) => number) =>
    at(p.to) > RATE_LIMITS.invitationsPerRecipientPerDay ||
    at(p.pair) > RATE_LIMITS.invitationsPerOwnerPerRecipientPerDay;

  // `probe`: an opted-out person. Never emailed and never on their own counters, but the answer
  // takes a place in the change and one of the owner's day, as an email would, and is only given
  // when those and the instance's limit leave room: otherwise `opted_out` would tell any owner,
  // for free, which addresses have signed in here.
  let ownerSent = count(ownerKey, today);
  let instanceSent = count(instanceKey, today);
  const chosen: (Person & { probe: boolean })[] = [];
  for (const p of people) {
    if (count(p.mark, today) + count(p.mark, yesterday) > 0) {
      // The mark of the previous day counts too, so "within a day" never resets at midnight UTC.
      report.skipped.push({ email: p.email, reason: "already_emailed" });
    } else if (chosen.length >= RATE_LIMITS.invitationsPerChange) {
      report.skipped.push({ email: p.email, reason: "change_limit" });
    } else if (ownerSent >= limits.perOwnerPerDay) {
      report.skipped.push({ email: p.email, reason: "owner_limit" });
    } else if (instanceSent >= limits.perDay) {
      report.skipped.push({ email: p.email, reason: "instance_limit" });
    } else if (optedOutHashes.has(p.hash)) {
      ownerSent += 1;
      chosen.push({ ...p, probe: true });
    } else if (recipientFull(p, (key) => count(key, today) + 1)) {
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
    } else {
      ownerSent += 1;
      instanceSent += 1;
      chosen.push({ ...p, probe: false });
    }
  }
  if (chosen.length === 0) return finish();

  // Reserve, then check, like lib/ratelimit.ts hit(): every counter is raised in one statement
  // and the count it returns decides, so changes running at the same time can never send more
  // than a limit allows. What a person was not sent is given back at the end.
  const giveBack: string[] = [];
  /** Reservations to give back on the owner's and on the instance's day counter. */
  let ownerGiveBack = 0;
  let instanceGiveBack = 0;
  const senders = chosen.filter((p) => !p.probe);
  const recipientFailed = new Set<Person>();
  if (senders.length > 0) {
    const reserved = await DB.prepare(`${COUNT_EACH} RETURNING key, count`)
      .bind(JSON.stringify(senders.flatMap((p) => [p.to, p.pair])), today)
      .all<{ key: string; count: number }>();
    const after = new Map(reserved.results.map((r) => [r.key, r.count]));
    for (const p of senders) {
      if (!recipientFull(p, (key) => after.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      report.skipped.push({ email: p.email, reason: "recipient_limit" });
      giveBack.push(p.to, p.pair);
      recipientFailed.add(p);
    }
  }
  const queue = chosen.filter((p) => !recipientFailed.has(p));

  // The owner's day counter is raised by everyone left (an opted-out answer costs one too), the
  // instance's by the emails among them, in one batch; the room left under each decides, in order.
  const marking: Person[] = [];
  if (queue.length > 0) {
    const nOwner = queue.length;
    const nInstance = queue.filter((p) => !p.probe).length;
    const raise = (key: string, n: number) =>
      DB.prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3 RETURNING count`,
      ).bind(key, today, n);
    const [ownerRow, instanceRow] = await DB.batch<{ count: number }>([
      raise(ownerKey, nOwner),
      ...(nInstance > 0 ? [raise(instanceKey, nInstance)] : []),
    ]);
    const roomUnder = (rows: D1Result<{ count: number }> | undefined, n: number, limit: number) => {
      const before = (rows?.results[0]?.count ?? Number.POSITIVE_INFINITY) - n;
      return Math.max(0, Math.min(n, limit - before));
    };
    const ownerRoom = roomUnder(ownerRow, nOwner, limits.perOwnerPerDay);
    const instanceRoom = nInstance > 0 ? roomUnder(instanceRow, nInstance, limits.perDay) : 0;
    let ownerUsed = 0;
    let instanceUsed = 0;
    for (const p of queue) {
      const reason =
        ownerUsed >= ownerRoom
          ? "owner_limit"
          : !p.probe && instanceUsed >= instanceRoom
            ? "instance_limit"
            : null;
      if (reason !== null) {
        report.skipped.push({ email: p.email, reason });
        ownerGiveBack += 1;
        if (!p.probe) {
          instanceGiveBack += 1;
          giveBack.push(p.to, p.pair);
        }
        continue;
      }
      ownerUsed += 1;
      if (p.probe) {
        // Their own choice: what it cost stays used.
        report.skipped.push({ email: p.email, reason: "opted_out" });
      } else {
        instanceUsed += 1;
        marking.push(p);
      }
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
      instanceGiveBack += 1;
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
  const dayBack = (key: string, n: number) =>
    DB.prepare(
      "UPDATE rate_limits SET count = MAX(count - ?3, 0) WHERE key = ?1 AND window_start = ?2",
    ).bind(key, today, n);
  if (ownerGiveBack > 0) returns.push(dayBack(ownerKey, ownerGiveBack));
  if (instanceGiveBack > 0) returns.push(dayBack(instanceKey, instanceGiveBack));
  if (returns.length > 0) await DB.batch(returns);
  if (sending.length === 0) return finish();

  const link =
    target.kind === "artifact"
      ? appUrl(ctx.config, `/a/${target.slug}`)
      : appUrl(ctx.config, `/p/${target.id}`);
  const ownerName = pageDisplayName(owner.name);
  const optOutLink = appUrl(ctx.config, APP_ROUTES.invitationEmails);
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
      optOutLink,
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
  return finish();
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

/**
 * Whether `email` (the signed-in person's own address) gets invitation emails: true unless its
 * holder turned them off. Read and changed only through the /me/invitation-emails routes, which
 * take the address from the session, never from the request.
 */
export async function receivesInvitations(d1: D1Database, email: string): Promise<boolean> {
  const row = await d1
    .prepare("SELECT 1 AS x FROM invitation_opt_outs WHERE address_hash = ?1")
    .bind(await invitationAddressHash(email))
    .first<{ x: number }>();
  return row === null;
}

/** Turn invitation emails to `email` off (`receive` false) or back on. Idempotent. */
export async function setReceivesInvitations(
  d1: D1Database,
  email: string,
  receive: boolean,
): Promise<void> {
  const h = await invitationAddressHash(email);
  if (receive) {
    await d1.prepare("DELETE FROM invitation_opt_outs WHERE address_hash = ?1").bind(h).run();
    return;
  }
  await d1
    .prepare(
      "INSERT INTO invitation_opt_outs (address_hash, created_at) VALUES (?1, ?2) ON CONFLICT (address_hash) DO NOTHING",
    )
    .bind(h, nowIso())
    .run();
}

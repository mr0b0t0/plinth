// Read emails the console provider stored in the dev outbox (ENVIRONMENT=development, DEV_OUTBOX).
import type { APIRequestContext } from "@playwright/test";
import { API_BASE } from "./api.ts";

export interface OutboxItem {
  to: string;
  subject: string;
  text: string;
  created_at: string;
}

export interface MailOptions {
  /** Only emails created at or after this ISO time. */
  since?: string;
  /** How long to poll before failing. Default 10 s. */
  timeoutMs?: number;
  /** Only emails this accepts (for example, skip an invitation while waiting for a code). */
  match?: (m: OutboxItem) => boolean;
}

/** Sign-in and viewing-code emails ("Your Plinth sign-in code: ...", "Your Plinth viewing code"). */
const isCodeEmail = (m: OutboxItem) => /^Your .*\bcode\b/.test(m.subject);

/** All outbox emails to an address, newest first. */
export async function outbox(request: APIRequestContext, to: string): Promise<OutboxItem[]> {
  const res = await request.get(`${API_BASE}/__dev/outbox`, { params: { to } });
  if (!res.ok()) throw new Error(`GET /__dev/outbox failed: ${res.status()}`);
  return ((await res.json()) as { items: OutboxItem[] }).items;
}

/** The newest email to an address, polling until one arrives. */
export async function latestEmail(
  request: APIRequestContext,
  to: string,
  opts: MailOptions = {},
): Promise<OutboxItem> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const item = (await outbox(request, to)).find(
      (m) => (!opts.since || m.created_at >= opts.since) && (!opts.match || opts.match(m)),
    );
    if (item) return item;
    if (Date.now() > deadline) throw new Error(`No email to ${to} in the dev outbox`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The six-digit code in the newest code email to an address. Other emails (an invitation the owner
 * sent when adding the address) are passed over, so a test never reads one as the code.
 */
export async function latestCode(
  request: APIRequestContext,
  to: string,
  opts: MailOptions = {},
): Promise<string> {
  const mail = await latestEmail(request, to, { match: isCodeEmail, ...opts });
  const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
  if (!code) throw new Error(`No six-digit code in the email to ${to}: ${mail.subject}`);
  return code;
}

/** The first http(s) link in the newest email to an address. */
export async function latestLink(
  request: APIRequestContext,
  to: string,
  opts: MailOptions = {},
): Promise<string> {
  const mail = await latestEmail(request, to, opts);
  const link = /https?:\/\/[^\s<>"]+/.exec(mail.text)?.[0];
  if (!link) throw new Error(`No link in the email to ${to}: ${mail.subject}`);
  return link;
}

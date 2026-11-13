// Email adapter. EMAIL_PROVIDER picks the implementation: sendgrid, resend or console.
// Only the console adapter ever logs message text (it exists to print sign-in links locally, and
// config.ts refuses it in production). The HTTP adapters never log or rethrow anything that could
// carry the API key or the message body.
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { devOutbox } from "../db/schema.ts";
import { newId } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Raised when a provider refuses a message. Carries the HTTP status only, never the body. */
export class EmailSendError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
  ) {
    super(
      status === null
        ? `${provider}: request failed`
        : `${provider}: provider answered HTTP ${status}`,
    );
  }
}

/** Split `Name <addr@host>` (EMAIL_FROM) into its parts. A bare address has no name. */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(from);
  if (m?.[2]) {
    const name = (m[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
    return name ? { email: m[2], name } : { email: m[2] };
  }
  return { email: from.trim() };
}

/** Development: prints the message to the log; optionally keeps it in D1 for local tests. */
export class ConsoleEmailAdapter implements EmailAdapter {
  readonly name = "console";
  constructor(private readonly outbox: D1Database | null) {}
  async send(m: EmailMessage): Promise<void> {
    console.log(`[email:console] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}`);
    if (this.outbox) {
      await getDb(this.outbox)
        .insert(devOutbox)
        .values({
          id: newId(),
          toEmail: m.to,
          subject: m.subject,
          text: m.text,
          createdAt: nowIso(),
        })
        .run();
    }
  }
}

/** SendGrid v3 Mail Send: POST /v3/mail/send, bearer API key, 202 on success. */
export class SendGridEmailAdapter implements EmailAdapter {
  readonly name = "sendgrid";
  static readonly endpoint = "https://api.sendgrid.com/v3/mail/send";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}
  async send(m: EmailMessage): Promise<void> {
    // text/plain must come before text/html in SendGrid's content array.
    const content = [{ type: "text/plain", value: m.text }];
    if (m.html) content.push({ type: "text/html", value: m.html });
    const body = {
      personalizations: [{ to: [{ email: m.to }] }],
      from: parseFrom(this.from),
      subject: m.subject,
      content,
      // Sign-in links must reach the user unchanged; click tracking would rewrite them.
      tracking_settings: { click_tracking: { enable: false, enable_text: false } },
    };
    await post(this.name, this.fetchFn, SendGridEmailAdapter.endpoint, this.apiKey, body);
  }
}

/** Resend: POST /emails, bearer API key, 200 with an id on success. */
export class ResendEmailAdapter implements EmailAdapter {
  readonly name = "resend";
  static readonly endpoint = "https://api.resend.com/emails";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}
  async send(m: EmailMessage): Promise<void> {
    const body: Record<string, unknown> = {
      from: this.from,
      to: [m.to],
      subject: m.subject,
      text: m.text,
    };
    if (m.html) body.html = m.html;
    await post(this.name, this.fetchFn, ResendEmailAdapter.endpoint, this.apiKey, body);
  }
}

async function post(
  provider: string,
  fetchFn: FetchFn,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The underlying error may echo the request; do not pass it on.
    throw new EmailSendError(provider, null);
  }
  // Drain the body so the connection is released; its content is never surfaced.
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new EmailSendError(provider, res.status);
}

export function createEmailAdapter(config: Config, env: { DB: D1Database }): EmailAdapter {
  switch (config.emailProvider) {
    case "sendgrid":
      if (!config.sendgridApiKey) throw new Error("SENDGRID_API_KEY is not set");
      return new SendGridEmailAdapter(config.sendgridApiKey, config.emailFrom);
    case "resend":
      if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not set");
      return new ResendEmailAdapter(config.resendApiKey, config.emailFrom);
    case "console":
      return new ConsoleEmailAdapter(config.devOutbox ? env.DB : null);
  }
}

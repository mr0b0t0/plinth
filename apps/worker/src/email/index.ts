// Email adapter. EMAIL_PROVIDER picks the implementation: sendgrid, resend or console.
// (workstream: accounts — adds the SendGrid and Resend implementations.)
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

export function createEmailAdapter(config: Config, env: { DB: D1Database }): EmailAdapter {
  switch (config.emailProvider) {
    case "console":
      return new ConsoleEmailAdapter(config.devOutbox ? env.DB : null);
    default:
      throw new Error(`Email provider ${config.emailProvider} is not implemented yet`);
  }
}

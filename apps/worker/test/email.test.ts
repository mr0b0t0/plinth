import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDevOutbox } from "../src/api/auth.ts";
import {
  ConsoleEmailAdapter,
  createEmailAdapter,
  EmailSendError,
  parseFrom,
  ResendEmailAdapter,
  SendGridEmailAdapter,
} from "../src/email/index.ts";
import { loginEmail } from "../src/email/templates.ts";
import { config, db, uniqueEmail } from "./helpers.ts";

const message = {
  to: "reader@example.com",
  subject: "Your code",
  text: "code: 123456",
  html: "<p>code: 123456</p>",
};

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Stub the global fetch at the HTTP layer and record what the adapter sent. */
function stubFetch(status: number, responseBody = "{}") {
  const calls: Captured[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: (await req.json()) as Record<string, unknown>,
    });
    return new Response(responseBody, { status });
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email adapters", () => {
  it("SendGrid: POST /v3/mail/send with a bearer key and the v3 body", async () => {
    const { calls } = stubFetch(202);
    const key = "SG.secret-key-value";
    await new SendGridEmailAdapter(key, "Plinth <noreply@plinth.example>").send(message);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.method).toBe("POST");
    expect(c?.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(c?.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(c?.headers.get("content-type")).toBe("application/json");
    expect(c?.body).toMatchObject({
      personalizations: [{ to: [{ email: "reader@example.com" }] }],
      from: { email: "noreply@plinth.example", name: "Plinth" },
      subject: "Your code",
      content: [
        { type: "text/plain", value: "code: 123456" },
        { type: "text/html", value: "<p>code: 123456</p>" },
      ],
    });
  });

  it("Resend: POST /emails with a bearer key and from/to/subject/text/html", async () => {
    const { calls } = stubFetch(200, '{"id":"abc"}');
    const key = "re_secret_key_value";
    await new ResendEmailAdapter(key, "Plinth <noreply@plinth.example>").send(message);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.method).toBe("POST");
    expect(c?.url).toBe("https://api.resend.com/emails");
    expect(c?.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(c?.body).toEqual({
      from: "Plinth <noreply@plinth.example>",
      to: ["reader@example.com"],
      subject: "Your code",
      text: "code: 123456",
      html: "<p>code: 123456</p>",
    });
  });

  it("provider errors carry the status only, never the key or the provider's body", async () => {
    const key = "SG.do-not-leak-this";
    stubFetch(401, `{"errors":[{"message":"bad key ${key}"}]}`);
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const e = await new SendGridEmailAdapter(key, "a@b.example")
      .send(message)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EmailSendError);
    expect((e as Error).message).toContain("401");
    expect((e as Error).message).not.toContain(key);
    expect(JSON.stringify(e)).not.toContain(key);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`network down ${key}`));
    const e2 = await new ResendEmailAdapter(key, "a@b.example")
      .send(message)
      .catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(EmailSendError);
    expect((e2 as Error).message).not.toContain(key);
  });

  it("the console adapter writes to the dev outbox", async () => {
    const to = uniqueEmail("console");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await new ConsoleEmailAdapter(env.DB).send({ ...message, to });
    expect(log).toHaveBeenCalledOnce();
    const out = await readDevOutbox(config(), db(), to);
    expect(out?.items).toEqual([
      { to, subject: "Your code", text: "code: 123456", created_at: expect.any(String) },
    ]);
  });

  it("EMAIL_PROVIDER picks the implementation", () => {
    const base = config();
    expect(createEmailAdapter(base, env).name).toBe("console");
    expect(
      createEmailAdapter({ ...base, emailProvider: "sendgrid", sendgridApiKey: "SG.x" }, env).name,
    ).toBe("sendgrid");
    expect(
      createEmailAdapter({ ...base, emailProvider: "resend", resendApiKey: "re_x" }, env).name,
    ).toBe("resend");
  });

  it("parses EMAIL_FROM and escapes the HTML body", () => {
    expect(parseFrom("Plinth <no@x.example>")).toEqual({ email: "no@x.example", name: "Plinth" });
    expect(parseFrom("no@x.example")).toEqual({ email: "no@x.example" });
    const m = loginEmail({
      to: "a@b.c",
      link: 'https://x/?a="<b>',
      code: "123456",
      minutes: 15,
    });
    expect(m.html).not.toContain('"<b>');
    expect(m.html).toContain("&quot;&lt;b&gt;");
    expect(m.text).toContain("123456");
  });
});

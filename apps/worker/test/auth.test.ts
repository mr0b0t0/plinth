import { env } from "cloudflare:workers";
import { COOKIES, CSRF_HEADER, RATE_LIMITS } from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { readDevOutbox } from "../src/api/auth.ts";
import {
  type LoginDeps,
  MAX_CODE_ATTEMPTS,
  requestLogin,
  verifyLoginCode,
  verifyMagicLink,
} from "../src/auth/login.ts";
import type { Config } from "../src/config.ts";
import { loginCodes, sessions, users } from "../src/db/schema.ts";
import type { EmailAdapter, EmailMessage } from "../src/email/index.ts";
import { hashToken } from "../src/lib/crypto.ts";
import { APP, call, config, db, json, uniqueEmail } from "./helpers.ts";

const CSRF = "csrf-anon-0123456789abcdef";

/** An anonymous browser: CSRF cookie and header, same-origin. */
function anon(extra: Record<string, string> = {}) {
  return {
    Cookie: `${COOKIES.csrf}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
    Origin: APP,
    "Content-Type": "application/json",
    ...extra,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = anon()) =>
  call(path, { method: "POST", headers, body: JSON.stringify(body) });

async function outbox(to: string) {
  const res = await call(`/api/v1/__dev/outbox?to=${encodeURIComponent(to)}`);
  expect(res.status).toBe(200);
  return (await json(res)).items as { to: string; subject: string; text: string }[];
}

/** Request a login and read the code and link token from the dev outbox. */
async function requestAndRead(email: string, headers = anon()) {
  const res = await post("/api/v1/auth/login", { email }, headers);
  expect(res.status).toBe(200);
  const [latest] = await outbox(email);
  if (!latest) throw new Error("no email in the outbox");
  const code = /code: (\d{6})/.exec(latest.text)?.[1] ?? "";
  const token = /\/login\/magic\?token=([A-Za-z0-9%_-]+)/.exec(latest.text)?.[1] ?? "";
  return { code, token: decodeURIComponent(token), text: latest.text };
}

function sessionFrom(res: Response): { value: string; setCookie: string } {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${COOKIES.session}=([^;]*)`).exec(setCookie);
  return { value: m?.[1] ?? "", setCookie };
}

describe("people sign-in", () => {
  it("sends a code and a magic link; the code signs in with a host-only session cookie", async () => {
    const email = uniqueEmail("login");
    const { code, token, text } = await requestAndRead(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(token.length).toBeGreaterThan(30);
    expect(text).toContain(`${APP}/login/magic?token=`);

    // Nothing stored in the clear.
    const row = await db().select().from(loginCodes).where(eq(loginCodes.email, email)).get();
    expect(row?.codeHash).not.toContain(code);
    expect(row?.linkTokenHash).toBe(await hashToken(token));
    // No account until verification.
    expect(await db().select().from(users).where(eq(users.email, email)).get()).toBeUndefined();

    const res = await post("/api/v1/auth/verify-code", { email, code });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, user: { email } });
    const { value, setCookie } = sessionFrom(res);
    expect(value.length).toBeGreaterThan(30);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);

    // The database holds the hash of the cookie, not the cookie.
    const s = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, await hashToken(value)))
      .get();
    expect(s?.kind).toBe("user");
    expect(await db().select().from(sessions).where(eq(sessions.id, value)).get()).toBeUndefined();

    const me = await call("/api/v1/me", { headers: { Cookie: `${COOKIES.session}=${value}` } });
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ email });
    const user = await db().select().from(users).where(eq(users.email, email)).get();
    expect(user?.emailVerifiedAt).toBeTruthy();
  });

  it("refuses a wrong code, a reused code and an expired code", async () => {
    const email = uniqueEmail("codes");
    const { code } = await requestAndRead(email);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await post("/api/v1/auth/verify-code", { email, code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("set-cookie") ?? "").not.toContain(COOKIES.session);

    expect((await post("/api/v1/auth/verify-code", { email, code })).status).toBe(200);
    const reused = await post("/api/v1/auth/verify-code", { email, code });
    expect(reused.status).toBe(400);

    const email2 = uniqueEmail("expired");
    const r2 = await requestAndRead(email2);
    await db()
      .update(loginCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginCodes.email, email2))
      .run();
    expect((await post("/api/v1/auth/verify-code", { email: email2, code: r2.code })).status).toBe(
      400,
    );
    expect((await post("/api/v1/auth/verify-link", { token: r2.token })).status).toBe(400);
  });

  it("burns a code after too many wrong guesses", async () => {
    const email = uniqueEmail("guess");
    const { code } = await requestAndRead(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect((await post("/api/v1/auth/verify-code", { email, code: wrong })).status).toBe(400);
    }
    expect((await post("/api/v1/auth/verify-code", { email, code })).status).toBe(400);
  });

  it("a new email supersedes the previous code", async () => {
    const email = uniqueEmail("twice");
    const first = await requestAndRead(email);
    const second = await requestAndRead(email);
    expect((await post("/api/v1/auth/verify-link", { token: first.token })).status).toBe(400);
    expect((await post("/api/v1/auth/verify-code", { email, code: second.code })).status).toBe(200);
  });

  it("magic link works once, and a GET of the link never consumes it", async () => {
    const email = uniqueEmail("magic");
    const { token } = await requestAndRead(email);
    // An email scanner prefetching the link: the SPA page, nothing signs in or burns the token.
    const prefetch = await call(`/login/magic?token=${encodeURIComponent(token)}`);
    expect(prefetch.headers.get("set-cookie") ?? "").not.toContain(`${COOKIES.session}=`);
    const row = await db()
      .select()
      .from(loginCodes)
      .where(eq(loginCodes.linkTokenHash, await hashToken(token)))
      .get();
    expect(row?.consumedAt).toBeNull();

    const ok = await post("/api/v1/auth/verify-link", { token });
    expect(ok.status).toBe(200);
    expect(sessionFrom(ok).value).not.toBe("");
    const again = await post("/api/v1/auth/verify-link", { token });
    expect(again.status).toBe(400);
  });

  it("answers the same for existing and unknown addresses (no enumeration)", async () => {
    const existing = uniqueEmail("exists");
    const r = await requestAndRead(existing);
    expect((await post("/api/v1/auth/verify-code", { email: existing, code: r.code })).status).toBe(
      200,
    );
    const a = await post("/api/v1/auth/login", { email: existing });
    const b = await post("/api/v1/auth/login", { email: uniqueEmail("nobody") });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
  });

  it("rate limits sign-in emails per address and per IP", async () => {
    const email = uniqueEmail("rl");
    for (let i = 0; i < RATE_LIMITS.loginPerEmailPerHour; i++) {
      expect((await post("/api/v1/auth/login", { email })).status).toBe(200);
    }
    const limited = await post("/api/v1/auth/login", { email });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    const ip = "203.0.113.77";
    for (let i = 0; i < RATE_LIMITS.loginPerIpPerHour; i++) {
      const res = await post(
        "/api/v1/auth/login",
        { email: uniqueEmail("ip") },
        anon({ "cf-connecting-ip": ip }),
      );
      expect(res.status).toBe(200);
    }
    const ipLimited = await post(
      "/api/v1/auth/login",
      { email: uniqueEmail("ip") },
      anon({ "cf-connecting-ip": ip }),
    );
    expect(ipLimited.status).toBe(429);
    // Another IP is unaffected.
    const other = await post(
      "/api/v1/auth/login",
      { email: uniqueEmail("ip") },
      anon({ "cf-connecting-ip": "203.0.113.78" }),
    );
    expect(other.status).toBe(200);
  });

  it("rate limits code attempts per address", async () => {
    const email = uniqueEmail("attempts");
    for (let i = 0; i < RATE_LIMITS.codeAttemptsPerEmailPerHour; i++) {
      await post("/api/v1/auth/verify-code", { email, code: "123456" });
    }
    expect((await post("/api/v1/auth/verify-code", { email, code: "123456" })).status).toBe(429);
  });

  it("login endpoints need the CSRF cookie and header", async () => {
    const email = uniqueEmail("csrf");
    const noCsrf = await call("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ email }),
    });
    expect(noCsrf.status).toBe(403);
    const crossSite = await post(
      "/api/v1/auth/login",
      { email },
      anon({ Origin: "https://evil.example" }),
    );
    expect(crossSite.status).toBe(403);
    expect(await outbox(email)).toHaveLength(0);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const email = uniqueEmail("logout");
    const { code } = await requestAndRead(email);
    const { value } = sessionFrom(await post("/api/v1/auth/verify-code", { email, code }));
    const cookie = `${COOKIES.session}=${value}; ${COOKIES.csrf}=${CSRF}`;
    const out = await post("/api/v1/auth/logout", {}, anon({ Cookie: cookie }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(new RegExp(`${COOKIES.session}=;.*Max-Age=0`));
    const s = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, await hashToken(value)))
      .get();
    expect(s).toBeUndefined();
    const me = await call("/api/v1/me", { headers: { Cookie: `${COOKIES.session}=${value}` } });
    expect(me.status).toBe(401);
  });
});

describe("single-user mode", () => {
  function deps(sent: EmailMessage[], overrides: Partial<Config>): LoginDeps {
    const mailer: EmailAdapter = {
      name: "capture",
      async send(m) {
        sent.push(m);
      },
    };
    return { config: { ...config(), ...overrides }, db: db(), d1: env.DB, mailer, ip: null };
  }

  it("only the admin email can sign in; others get the same answer and no email", async () => {
    const admin = uniqueEmail("admin");
    const other = uniqueEmail("stranger");
    const sent: EmailMessage[] = [];
    const d = deps(sent, { singleUserMode: true, adminEmails: [admin] });

    await expect(requestLogin(d, other)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(
      await db().select().from(loginCodes).where(eq(loginCodes.email, other)).get(),
    ).toBeUndefined();

    await requestLogin(d, admin);
    expect(sent).toHaveLength(1);
    const code = /code: (\d{6})/.exec(sent[0]?.text ?? "")?.[1] ?? "";
    const user = await verifyLoginCode(d, admin, code);
    expect(user.email).toBe(admin);
    expect(user.isAdmin).toBe(true);
  });

  it("a code row for another address is refused (defense in depth)", async () => {
    const admin = uniqueEmail("admin");
    const other = uniqueEmail("stranger");
    const sent: EmailMessage[] = [];
    // Issue the code while sign-up is open, then switch to single-user mode.
    await requestLogin(deps(sent, {}), other);
    const text = sent[0]?.text ?? "";
    const code = /code: (\d{6})/.exec(text)?.[1] ?? "";
    const token = decodeURIComponent(/token=([^\s]+)/.exec(text)?.[1] ?? "");
    const single = deps(sent, { singleUserMode: true, adminEmails: [admin] });
    await expect(verifyMagicLink(single, token)).rejects.toThrow();
    await expect(verifyLoginCode(single, other, code)).rejects.toThrow();
    expect(await db().select().from(users).where(eq(users.email, other)).get()).toBeUndefined();
    const row = await db()
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, other)))
      .get();
    expect(row?.consumedAt).toBeNull();
  });
});

describe("dev outbox", () => {
  it("lists emails newest first in development", async () => {
    const email = uniqueEmail("outbox");
    await post("/api/v1/auth/login", { email });
    await post("/api/v1/auth/login", { email });
    const items = await outbox(email);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ to: email });
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["created_at", "subject", "text", "to"]);
    const rows = await db().select().from(loginCodes).where(eq(loginCodes.email, email)).all();
    const live = rows.find((r) => r.consumedAt === null);
    // Newest first: the first item's code is the live one.
    const newestCode = /code: (\d{6})/.exec(items[0]?.text ?? "")?.[1] ?? "";
    expect(live).toBeTruthy();
    expect((await post("/api/v1/auth/verify-code", { email, code: newestCode })).status).toBe(200);
  });

  it("is not served unless DEV_OUTBOX is on in development", async () => {
    expect(config().devOutbox).toBe(true);
    const prod = { ...config(), devOutbox: false };
    expect(await readDevOutbox(prod, db(), "a@example.com")).toBeNull();
    const { parseConfig } = await import("../src/config.ts");
    const vars = {
      APP_HOST: "app.localhost:8787",
      CONTENT_HOST: "content.localhost:8787",
      SESSION_SECRET: "s".repeat(40),
      TOKEN_SIGNING_KEY: "t".repeat(40),
      DEV_OUTBOX: "true",
    };
    expect(parseConfig({ ...vars, ENVIRONMENT: "staging" }).devOutbox).toBe(false);
    expect(parseConfig({ ...vars, ENVIRONMENT: "development", DEV_OUTBOX: "" }).devOutbox).toBe(
      false,
    );
    expect(parseConfig({ ...vars, ENVIRONMENT: "development" }).devOutbox).toBe(true);
  });
});

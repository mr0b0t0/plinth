// The review account's password sign-in (REVIEW_LOGIN_EMAIL and REVIEW_LOGIN_PASSWORD_HASH,
// src/auth/review-login.ts): a 404 unless configured, one ordinary account only, the same answer
// for a wrong email and a wrong password, per-address limits and an instance-wide lockout, and the
// OAuth consent flow carrying on after it as after any other sign-in.
import { env } from "cloudflare:workers";
import { COOKIES, CSRF_HEADER, RATE_LIMITS } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviewLoginConfigProblem } from "../scripts/deploy-lib.mjs";
// @ts-expect-error plain ESM script without types
import { reviewLoginHash } from "../scripts/review-login-hash.mjs";
import { verifyReviewLogin } from "../src/auth/review-login.ts";
import { type Config, ConfigError, parseConfig } from "../src/config.ts";
import { sessions, users } from "../src/db/schema.ts";
import { hashPassword, hashToken, verifyPassword } from "../src/lib/crypto.ts";
import { APP, call, config, db, fetchWith, json, uniqueEmail } from "./helpers.ts";

const PASSWORD = "correct horse battery staple 42";
const CSRF = "csrf-anon-0123456789abcdef";
const REDIRECT = "http://127.0.0.1:43123/callback";

let hash = "";
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});
// The lockout counter is instance-wide; start every test from zero.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'login:review:%'").run();
});

const reviewVars = (email: string) => ({
  REVIEW_LOGIN_EMAIL: email,
  REVIEW_LOGIN_PASSWORD_HASH: hash,
});

function anon(extra: Record<string, string> = {}) {
  return {
    Cookie: `${COOKIES.csrf}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
    Origin: APP,
    "Content-Type": "application/json",
    ...extra,
  };
}

function signIn(
  vars: Record<string, string> | null,
  body: unknown,
  headers: Record<string, string> = anon(),
) {
  const init = { method: "POST", headers, body: JSON.stringify(body) };
  return vars
    ? fetchWith(vars, "/api/v1/auth/review-login", init)
    : call("/api/v1/auth/review-login", init);
}

/** The session cookie a sign-in set, as a Cookie header pair. */
function sessionPair(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const pair = set.split(";")[0] ?? "";
  expect(pair.startsWith(`${COOKIES.session}=`)).toBe(true);
  return pair;
}

describe("review login is off unless configured", () => {
  it("answers 404 on the API and the page, and says so in /config", async () => {
    const api = await signIn(null, { email: "review@example.com", password: PASSWORD });
    expect(api.status).toBe(404);
    expect((await call("/login/review")).status).toBe(404);
    expect((await json(await call("/api/v1/config"))).review_login).toBe(false);
    expect(config().reviewLogin).toBeNull();
  });

  it("stays off with only one of the two settings (deleting the secret turns it off)", async () => {
    const onlyEmail = { REVIEW_LOGIN_EMAIL: "review@example.com" };
    expect((await fetchWith(onlyEmail, "/login/review")).status).toBe(404);
    const onlyHash = { REVIEW_LOGIN_PASSWORD_HASH: hash };
    const res = await signIn(onlyHash, { email: "review@example.com", password: PASSWORD });
    expect(res.status).toBe(404);
  });

  it("serves the page and flags it in /config when on", async () => {
    const vars = reviewVars(uniqueEmail("review"));
    const page = await fetchWith(vars, "/login/review");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await json(await fetchWith(vars, "/api/v1/config"))).review_login).toBe(true);
  });
});

describe("review login settings", () => {
  const base = { ...env } as unknown as Record<string, unknown>;

  it("refuses an ADMIN_EMAIL address, in any case", () => {
    expect(() =>
      parseConfig({
        ...base,
        ADMIN_EMAIL: "admin@example.com",
        REVIEW_LOGIN_EMAIL: "Admin@Example.com",
        REVIEW_LOGIN_PASSWORD_HASH: hash,
      }),
    ).toThrow(/must not be an ADMIN_EMAIL address/);
  });

  it("refuses single-user mode, a malformed hash and a weaker hash", async () => {
    expect(() =>
      parseConfig({
        ...base,
        SINGLE_USER_MODE: "true",
        ADMIN_EMAIL: "admin@example.com",
        EMAIL_PROVIDER: "console",
        REVIEW_LOGIN_EMAIL: "review@example.com",
        REVIEW_LOGIN_PASSWORD_HASH: hash,
      }),
    ).toThrow(/SINGLE_USER_MODE/);
    for (const bad of [
      "secret",
      `pbkdf2-sha256$1000$${hash.split("$")[2]}$${hash.split("$")[3]}`,
    ]) {
      expect(() =>
        parseConfig({
          ...base,
          REVIEW_LOGIN_EMAIL: "review@example.com",
          REVIEW_LOGIN_PASSWORD_HASH: bad,
        }),
      ).toThrow(ConfigError);
    }
    expect(() =>
      parseConfig({
        ...base,
        REVIEW_LOGIN_EMAIL: "not-an-email",
        REVIEW_LOGIN_PASSWORD_HASH: hash,
      }),
    ).toThrow(/not an email address/);
  });

  it("is refused before a deploy when it names an admin or a single-user instance", () => {
    const cfg = (vars: Record<string, string>) => ({ vars });
    expect(reviewLoginConfigProblem(cfg({}))).toBeNull();
    expect(
      reviewLoginConfigProblem(
        cfg({ REVIEW_LOGIN_EMAIL: "review@example.com", ADMIN_EMAIL: "a@x.io" }),
      ),
    ).toBeNull();
    expect(
      reviewLoginConfigProblem(
        cfg({ REVIEW_LOGIN_EMAIL: "A@X.io", ADMIN_EMAIL: "other@x.io, a@x.io" }),
      ),
    ).toMatch(/ADMIN_EMAIL address/);
    expect(
      reviewLoginConfigProblem(
        cfg({ REVIEW_LOGIN_EMAIL: "review@x.io", SINGLE_USER_MODE: "true", ADMIN_EMAIL: "a@x.io" }),
      ),
    ).toMatch(/single-user/);
  });

  it("the hash script writes what the Worker accepts and verifies", async () => {
    const out: string = await reviewLoginHash(PASSWORD);
    expect(out).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(PASSWORD, out)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}!`, out)).toBe(false);
    expect(
      parseConfig({
        ...base,
        REVIEW_LOGIN_EMAIL: "review@example.com",
        REVIEW_LOGIN_PASSWORD_HASH: out,
      }).reviewLogin?.passwordHash,
    ).toBe(out);
    await expect(reviewLoginHash("too short")).rejects.toThrow(/at least 16/);
  });
});

describe("review login", () => {
  it("signs the review account in as an ordinary, unverified user with a session cookie", async () => {
    const email = uniqueEmail("review");
    const res = await signIn(reviewVars(email), { email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user.email).toBe(email);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain("HttpOnly");
    const value = sessionPair(res).slice(COOKIES.session.length + 1);
    const row = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, await hashToken(value)))
      .get();
    expect(row?.userId).toBe(body.user.id);
    const user = await db().select().from(users).where(eq(users.email, email)).get();
    expect(user?.isAdmin).toBe(false);
    // A password proves nothing about the mailbox.
    expect(user?.emailVerifiedAt).toBeNull();
    const me = await call("/api/v1/me", { headers: { Cookie: sessionPair(res) } });
    expect(me.status).toBe(200);
    expect((await json(me)).is_admin).toBe(false);
  });

  it("gives the same answer for a wrong email and a wrong password, and sets no cookie", async () => {
    const email = uniqueEmail("review");
    const vars = reviewVars(email);
    const wrongEmail = await signIn(vars, { email: uniqueEmail("other"), password: PASSWORD });
    const wrongPassword = await signIn(vars, { email, password: `${PASSWORD}x` });
    for (const res of [wrongEmail, wrongPassword]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie") ?? "").not.toContain(`${COOKIES.session}=`);
    }
    expect((await json(wrongEmail)).error).toEqual((await json(wrongPassword)).error);
  });

  it("needs the CSRF header like every other sign-in", async () => {
    const email = uniqueEmail("review");
    const res = await signIn(
      reviewVars(email),
      { email, password: PASSWORD },
      { Origin: APP, "Content-Type": "application/json" },
    );
    expect(res.status).toBe(403);
  });

  it("limits attempts from one address", async () => {
    const email = uniqueEmail("review");
    const vars = reviewVars(email);
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < RATE_LIMITS.reviewLoginAttemptsPerIpPerHour; i++) {
      const res = await signIn(vars, { email, password: "wrong" }, anon(ip));
      expect(res.status).toBe(400);
    }
    const blocked = await signIn(vars, { email, password: PASSWORD }, anon(ip));
    expect(blocked.status).toBe(429);
  });

  it("locks for everyone after too many wrong passwords, even with the right one", async () => {
    const email = uniqueEmail("review");
    const vars = reviewVars(email);
    for (let i = 0; i < RATE_LIMITS.reviewLoginFailuresPerHour; i++) {
      // Spread over addresses: the lockout is instance-wide, so this cannot get around it.
      const res = await signIn(
        vars,
        { email, password: "wrong" },
        anon({ "cf-connecting-ip": `198.51.100.${i}` }),
      );
      expect(res.status).toBe(400);
    }
    const locked = await signIn(vars, { email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.message).toMatch(/locked/);
  });

  it("refuses an admin address even if the settings were never validated", async () => {
    const email = uniqueEmail("admin");
    const unchecked = {
      ...config(),
      adminEmails: [email],
      reviewLogin: { email, passwordHash: hash },
    } as Config;
    await expect(
      verifyReviewLogin({ config: unchecked, db: db(), d1: env.DB, ip: null }, email, PASSWORD),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await db().select().from(users).where(eq(users.email, email)).get()).toBeUndefined();
  });

  it("carries an OAuth consent request on, as after any other sign-in", async () => {
    const email = uniqueEmail("review");
    const vars = reviewVars(email);
    const reg = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Reviewer client", redirect_uris: [REDIRECT] }),
    });
    const client = await json(reg);
    const verifier = "v".repeat(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const authorize = await call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "review-state",
        resource: `${APP}/mcp`,
      })}`,
    );
    expect(authorize.status).toBe(302);
    const consentPage = new URL(authorize.headers.get("location") ?? "");
    const requestId = consentPage.searchParams.get("request") ?? "";
    // Signed out, the consent request needs a sign-in first.
    expect((await call(`/api/v1/oauth/requests/${requestId}`)).status).toBe(401);

    const signedIn = await signIn(vars, { email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    const cookie = `${sessionPair(signedIn)}; ${COOKIES.csrf}=${CSRF}`;
    const info = await call(`/api/v1/oauth/requests/${requestId}`, { headers: { Cookie: cookie } });
    expect(info.status).toBe(200);
    const consent = await call("/api/v1/oauth/consent", {
      method: "POST",
      headers: {
        Cookie: cookie,
        [CSRF_HEADER]: CSRF,
        Origin: APP,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        label: "Review",
        client_type: "other",
        approve: true,
      }),
    });
    expect(consent.status).toBe(200);
    const back = new URL((await json(consent)).redirect_to);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("review-state");
  });
});

// Allowlist viewers: confirm an email by a one-time code, which signs the address in to the app
// (its account created on first use), then open every artifact that email is listed on. Where the
// instance does not let the address sign in (single-user mode) the code starts a viewer session
// instead. A non-listed email never gets a session, and the API never reveals the list.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RATE_LIMITS } from "@plinth/shared";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { artifacts, devOutbox, loginCodes, sessions, users } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken } from "../src/lib/crypto.ts";
import { MAX_VIEWER_CODE_ATTEMPTS } from "../src/services/viewers.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  createUser,
  db,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";

/** Run a request through the Worker's fetch handler and wait for its waitUntil work (email). */
async function run(
  path: string,
  init: RequestInit = {},
  vars: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${APP}${path}`;
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

let ipCounter = 0;
/** Anonymous browser: CSRF cookie and header, and its own client IP for rate limits. */
function browser(extraCookie = "") {
  ipCounter += 1;
  const cookie = ["__Host-plinth_csrf=viewer-csrf", extraCookie].filter(Boolean).join("; ");
  return {
    Cookie: cookie,
    "x-plinth-csrf": "viewer-csrf",
    Origin: APP,
    "Content-Type": "application/json",
    "cf-connecting-ip": `198.51.100.${ipCounter % 250}`,
  };
}

const post = (
  path: string,
  headers: Record<string, string>,
  body: unknown,
  vars: Record<string, string> = {},
) => run(path, { method: "POST", headers, body: JSON.stringify(body) }, vars);

async function allowlisted(emails: string[]) {
  const a = await agent();
  const { body } = await publish(a.auth, {
    title: "Private board deck",
    html: "<!doctype html><p>allowlisted content</p>",
    visibility: "allowlist",
    emails,
  });
  return { owner: a, artifact: body as { id: string; slug: string } };
}

async function outboxFor(email: string) {
  return db()
    .select()
    .from(devOutbox)
    .where(eq(devOutbox.toEmail, email))
    .orderBy(desc(devOutbox.createdAt))
    .all();
}

async function codeFor(email: string): Promise<string> {
  const [mail] = await outboxFor(email);
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no code mailed to ${email}`);
  return code;
}

/** Ask for a code and confirm it. Returns the response of the confirm call. */
async function confirm(
  ref: string,
  email: string,
  headers: Record<string, string> = browser(),
  vars: Record<string, string> = {},
) {
  expect((await post(`/api/v1/view/${ref}/email`, headers, { email }, vars)).status).toBe(200);
  return post(`/api/v1/view/${ref}/code`, headers, { email, code: await codeFor(email) }, vars);
}

/** The first cookie a response sets, as `name=value` (the session a code started). */
const viewerCookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** A single-user instance whose admin is `admin`: other addresses may not sign in there. */
const singleUser = (admin: string) => ({
  SINGLE_USER_MODE: "true",
  ADMIN_EMAIL: admin,
});

async function sessionRow(cookie: string) {
  const value = cookie.split("=")[1] ?? "";
  return db()
    .select()
    .from(sessions)
    .where(eq(sessions.id, await hashToken(value)))
    .get();
}

const userByEmail = (email: string) =>
  db().select().from(users).where(eq(users.email, email)).get();

describe("allowlist viewers", () => {
  it("a listed email gets a code, confirms it, is signed in with a new account, and opens the artifact", async () => {
    const email = uniqueEmail("listed");
    const { artifact } = await allowlisted([email]);

    const anon = await json(await call(`/api/v1/view/${artifact.slug}`));
    expect(anon).toEqual({
      status: "email_required",
      artifact: { id: artifact.id, slug: artifact.slug, title: "Private board deck" },
    });

    const headers = browser();
    const ask = await post(`/api/v1/view/${artifact.slug}/email`, headers, { email });
    expect(ask.status).toBe(200);
    expect(await json(ask)).toEqual({ ok: true });
    const mails = await outboxFor(email);
    expect(mails).toHaveLength(1);
    // The code signs the address in, so the email is a sign-in email: it says so in the subject
    // and first, warns never to pass the code on, and quotes the sharer's title after the code,
    // named as theirs.
    expect(mails[0]?.subject).toBe("Your Plinth sign-in code");
    const text = mails[0]?.text ?? "";
    expect(text.split("\n")[0]).toBe(
      "This code signs you in to Plinth with this address, and creates a Plinth account for it if it has none.",
    );
    expect(text).toContain(
      "Enter it only on app.localhost:8787, on the page where you asked for it. Never give it to anyone or reply with it: whoever enters it is signed in as you.",
    );
    expect(text).toContain(
      `The page's title, written by whoever shared it and not by Plinth, is "Private board deck".`,
    );
    expect(text.indexOf("Private board deck")).toBeGreaterThan(text.indexOf("Your code is"));
    expect(text.indexOf("Private board deck")).toBeGreaterThan(text.indexOf("Never give it"));
    // No account exists until the code is confirmed.
    expect(await userByEmail(email)).toBeUndefined();

    // The code is stored hashed, bound to the artifact, with the viewer purpose.
    const code = await codeFor(email);
    const row = await db()
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), eq(loginCodes.purpose, "viewer")))
      .get();
    expect(row?.artifactId).toBe(artifact.id);
    expect(row?.codeHash).not.toContain(code);
    expect(Date.parse(row?.expiresAt ?? "") - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);

    const ok = await post(`/api/v1/view/${artifact.slug}/code`, headers, { email, code });
    expect(ok.status).toBe(200);
    const gate = await json(ok);
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("viewer");
    expect(gate.enter_url.startsWith(`${contentOrigin(artifact.id)}/__plinth/enter?t=`)).toBe(true);

    // A normal app session, exactly as signing in sets it; no viewer cookie.
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-plinth_session=[^;]+;/);
    expect(setCookie).not.toMatch(/plinth_viewer/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; SameSite=Lax/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Domain=/i);

    // The account exists now, verified, and the session row (stored by hash only) is its.
    const user = await userByEmail(email);
    expect(user?.emailVerifiedAt).toBeTruthy();
    expect(user?.isAdmin).toBe(false);
    const s = await sessionRow(viewerCookieOf(ok));
    expect(s).toMatchObject({ kind: "user", userId: user?.id, viewerEmail: null });
    const me = await call("/api/v1/me", { headers: { Cookie: viewerCookieOf(ok) } });
    expect(me.status).toBe(200);
    expect((await json(me)).email).toBe(email);

    // With the cookie, the gate opens on later visits and the content host serves the artifact.
    const again = await json(
      await call(`/api/v1/view/${artifact.slug}`, { headers: { Cookie: viewerCookieOf(ok) } }),
    );
    expect(again.status).toBe("ok");
    const enter = await call(again.enter_url);
    expect(enter.status).toBe(302);
    const contentCookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await call(`${contentOrigin(artifact.id)}/`, {
      headers: { Cookie: contentCookie },
    });
    expect(await page.text()).toContain("allowlisted content");
  });

  it("answers a non-listed email exactly like a listed one, sends nothing, and never confirms it", async () => {
    const listed = uniqueEmail("listed");
    const stranger = uniqueEmail("stranger");
    const { artifact } = await allowlisted([listed]);

    const a = await post(`/api/v1/view/${artifact.id}/email`, browser(), { email: listed });
    const b = await post(`/api/v1/view/${artifact.id}/email`, browser(), { email: stranger });
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
    expect(await outboxFor(stranger)).toHaveLength(0);

    // Every possible failure for the stranger looks like a wrong code.
    const res = await post(`/api/v1/view/${artifact.id}/code`, browser(), {
      email: stranger,
      code: "123456",
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.details).toEqual({ reason: "invalid_code" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await userByEmail(stranger)).toBeUndefined();
  });

  it("a non-listed email cannot get a session even with a valid code row for it", async () => {
    // Simulate the worst case: a code row exists for an email that was never (or is no longer)
    // listed. Verification re-checks the grant, so no session is created.
    const listed = uniqueEmail("listed");
    const { owner, artifact } = await allowlisted([listed]);
    const headers = browser();
    await post(`/api/v1/view/${artifact.id}/email`, headers, { email: listed });
    const code = await codeFor(listed);
    // The owner removes the email before the viewer types the code.
    await call(`/api/v1/artifacts/${artifact.id}/visibility`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "allowlist", emails: [uniqueEmail("other")] }),
    });
    const res = await post(`/api/v1/view/${artifact.id}/code`, headers, { email: listed, code });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    const rows = await db().select().from(sessions).where(eq(sessions.viewerEmail, listed)).all();
    expect(rows).toHaveLength(0);
    // Nor an account: one is created only for a code that opens something.
    expect(await userByEmail(listed)).toBeUndefined();
  });

  it("a code works once", async () => {
    const email = uniqueEmail("once");
    const { artifact } = await allowlisted([email]);
    const headers = browser();
    expect((await confirm(artifact.id, email, headers)).status).toBe(200);
    const code = await codeFor(email);
    const replay = await post(`/api/v1/view/${artifact.id}/code`, headers, { email, code });
    expect(replay.status).toBe(403);
  });

  it(`a code stops working after ${MAX_VIEWER_CODE_ATTEMPTS} wrong guesses`, async () => {
    const email = uniqueEmail("guess");
    const { artifact } = await allowlisted([email]);
    const headers = browser();
    await post(`/api/v1/view/${artifact.id}/email`, headers, { email });
    const code = await codeFor(email);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < MAX_VIEWER_CODE_ATTEMPTS; i++) {
      const r = await post(`/api/v1/view/${artifact.id}/code`, headers, { email, code: wrong });
      expect(r.status).toBe(403);
    }
    const right = await post(`/api/v1/view/${artifact.id}/code`, headers, { email, code });
    expect(right.status).toBe(403);
    expect(right.headers.get("set-cookie")).toBeNull();
    expect(await userByEmail(email)).toBeUndefined();
  });

  it("an expired code is refused, and only the newest code works", async () => {
    const email = uniqueEmail("expiry");
    const { artifact } = await allowlisted([email]);
    const headers = browser();
    await post(`/api/v1/view/${artifact.id}/email`, headers, { email });
    const first = await codeFor(email);
    await post(`/api/v1/view/${artifact.id}/email`, headers, { email });
    const second = await codeFor(email);
    if (first !== second) {
      const old = await post(`/api/v1/view/${artifact.id}/code`, headers, { email, code: first });
      expect(old.status).toBe(403);
    }
    await db()
      .update(loginCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginCodes.email, email))
      .run();
    const late = await post(`/api/v1/view/${artifact.id}/code`, headers, { email, code: second });
    expect(late.status).toBe(403);
  });

  it("code requests are rate limited per email, listed or not, and per IP", async () => {
    const listed = uniqueEmail("rl");
    const stranger = uniqueEmail("rl-stranger");
    const { artifact } = await allowlisted([listed]);
    for (const email of [listed, stranger]) {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push(
          (await post(`/api/v1/view/${artifact.id}/email`, browser(), { email })).status,
        );
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    }
    expect(await outboxFor(listed)).toHaveLength(5);

    const sameIp = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await post(`/api/v1/view/${artifact.id}/email`, sameIp, {
        email: uniqueEmail("ip"),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("guesses at a viewing code share the sign-in code's per-address budget, both ways", async () => {
    const { artifact } = await allowlisted([uniqueEmail("budget-other")]);
    const limit = RATE_LIMITS.codeAttemptsPerEmailPerHour;

    // Wrong viewing codes use up the address's sign-in guesses too.
    const viewerFirst = uniqueEmail("budget-viewer");
    for (let i = 0; i < limit; i++) {
      await post(`/api/v1/view/${artifact.id}/code`, browser(), {
        email: viewerFirst,
        code: "000000",
      });
    }
    const signIn = await post("/api/v1/auth/verify-code", browser(), {
      email: viewerFirst,
      code: "000000",
    });
    expect(signIn.status).toBe(429);

    // And wrong sign-in codes leave no extra guesses at the gate: a listed address with a fresh,
    // correct viewing code is refused once its sign-in budget is spent.
    const loginFirst = uniqueEmail("budget-login");
    const listed = await allowlisted([loginFirst]);
    const headers = browser();
    expect(
      (await post(`/api/v1/view/${listed.artifact.id}/email`, headers, { email: loginFirst }))
        .status,
    ).toBe(200);
    for (let i = 0; i < limit; i++) {
      await post("/api/v1/auth/verify-code", browser(), { email: loginFirst, code: "000000" });
    }
    const gate = await post(`/api/v1/view/${listed.artifact.id}/code`, headers, {
      email: loginFirst,
      code: await codeFor(loginFirst),
    });
    expect(gate.status).toBe(429);
    expect(gate.headers.get("set-cookie") ?? "").not.toMatch(/plinth_session|plinth_viewer/);
    expect(await userByEmail(loginFirst)).toBeUndefined();
  });

  it("only allowlist artifacts take viewer codes", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const r = await post(`/api/v1/view/${p.id}/email`, browser(), { email: uniqueEmail() });
    expect(r.status).toBe(404);
    const missing = await post(`/api/v1/view/no-such-artifact/email`, browser(), {
      email: uniqueEmail(),
    });
    expect(missing.status).toBe(404);
  });

  it("a signed-in user whose email is listed opens the artifact without a code", async () => {
    const user = await createUser();
    const { artifact } = await allowlisted([user.email]);
    const s = await browserSession(user.id);
    const gate = await json(await call(`/api/v1/view/${artifact.id}`, { headers: s.headers }));
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("viewer");
  });

  it("a signed-in user who is not listed is asked for an email", async () => {
    const user = await createUser();
    const { artifact } = await allowlisted([uniqueEmail()]);
    const s = await browserSession(user.id);
    const gate = await json(await call(`/api/v1/view/${artifact.id}`, { headers: s.headers }));
    expect(gate.status).toBe("email_required");
  });

  it("a signed-in user who confirms a different, listed email is signed in with that one instead", async () => {
    const user = await createUser();
    const listed = uniqueEmail("work");
    const { artifact } = await allowlisted([listed]);
    const s = await browserSession(user.id);
    const headers = { ...browser(), ...s.headers, "Content-Type": "application/json" };
    const ok = await confirm(artifact.id, listed, headers);
    expect((await json(ok)).status).toBe("ok");
    const cookie = viewerCookieOf(ok);
    expect(cookie).toMatch(/^__Host-plinth_session=/);
    const me = await call("/api/v1/me", { headers: { Cookie: cookie } });
    expect((await json(me)).email).toBe(listed);
    // The session it replaced is over, as signing out would end it.
    expect((await call("/api/v1/me", { headers: { Cookie: s.headers.Cookie ?? "" } })).status).toBe(
      401,
    );
    expect(
      (await json(await call(`/api/v1/view/${artifact.id}`, { headers: { Cookie: cookie } })))
        .status,
    ).toBe("ok");
  });

  it("an address that already has an account is signed in to that account", async () => {
    const existing = await createUser();
    const { artifact } = await allowlisted([existing.email]);
    const ok = await confirm(artifact.id, existing.email);
    expect((await json(ok)).role).toBe("viewer");
    expect(await sessionRow(viewerCookieOf(ok))).toMatchObject({
      kind: "user",
      userId: existing.id,
    });
    const all = await db().select().from(users).where(eq(users.email, existing.email)).all();
    expect(all).toHaveLength(1);
  });

  it("the artifact shows in the invitee's list of artifacts shared with them (the dashboard)", async () => {
    const email = uniqueEmail("dash");
    const { artifact } = await allowlisted([email]);
    const ok = await confirm(artifact.id, email);
    const list = await json(
      await call("/api/v1/artifacts", { headers: { Cookie: viewerCookieOf(ok) } }),
    );
    const row = (list.items as { id: string; role: string }[]).find((i) => i.id === artifact.id);
    expect(row?.role).toBe("viewer");
  });

  it("an editor confirmed by code may edit a doc on its page: the code signed them in", async () => {
    const { docSetup, grant } = await import("./room-helpers.ts");
    const { id } = await docSetup();
    const email = uniqueEmail("coded-editor");
    await grant(id, email, "editor");
    await db().update(artifacts).set({ visibility: "allowlist" }).where(eq(artifacts.id, id)).run();
    const ok = await confirm(id, email);
    const gate = await json(ok);
    expect(gate.role).toBe("editor");
    expect(gate.live).toEqual({ mode: "room", draft: null });
  });

  it("a viewer session started before codes signed people in keeps working until it expires", async () => {
    const email = uniqueEmail("legacy");
    const { artifact } = await allowlisted([email]);
    const value = `plinth_vs_legacy${Date.now()}${Math.random().toString(36).slice(2)}`;
    await db()
      .insert(sessions)
      .values({
        id: await hashToken(value),
        kind: "viewer",
        viewerEmail: email,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();
    const cookie = { Cookie: `__Host-plinth_viewer=${value}` };
    expect(
      (await json(await call(`/api/v1/view/${artifact.id}`, { headers: cookie }))).status,
    ).toBe("ok");
    await db()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(sessions.id, await hashToken(value)))
      .run();
    expect(
      (await json(await call(`/api/v1/view/${artifact.id}`, { headers: cookie }))).status,
    ).toBe("email_required");
  });

  it("one confirmed email opens every artifact it is listed on, and nothing else", async () => {
    const email = uniqueEmail("multi");
    const { artifact: first } = await allowlisted([email]);
    const { artifact: second } = await allowlisted([email, uniqueEmail()]);
    const { artifact: other } = await allowlisted([uniqueEmail()]);
    const ok = await confirm(first.id, email);
    const cookie = { Cookie: viewerCookieOf(ok) };
    expect((await json(await call(`/api/v1/view/${second.id}`, { headers: cookie }))).status).toBe(
      "ok",
    );
    expect((await json(await call(`/api/v1/view/${other.id}`, { headers: cookie }))).status).toBe(
      "email_required",
    );
  });
});

describe("where the address may not sign in (single-user mode): a viewer session", () => {
  it("a listed email confirms its code and gets a viewer session, not an account", async () => {
    const vars = singleUser(uniqueEmail("admin"));
    const email = uniqueEmail("listed");
    const { artifact } = await allowlisted([email]);
    const headers = browser();
    expect((await post(`/api/v1/view/${artifact.id}/email`, headers, { email }, vars)).status).toBe(
      200,
    );
    const [mail] = await outboxFor(email);
    expect(mail?.subject).toBe("Your Plinth viewing code");
    expect(mail?.text).toContain(
      `Someone asked to open "Private board deck" on Plinth with this email address.`,
    );
    expect(mail?.text).not.toContain("signs you in");
    const ok = await post(
      `/api/v1/view/${artifact.id}/code`,
      headers,
      { email, code: await codeFor(email) },
      vars,
    );
    expect(ok.status).toBe(200);
    const gate = await json(ok);
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("viewer");

    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-plinth_viewer=plinth_vs_[A-Za-z0-9]+;/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; SameSite=Lax/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; Max-Age=604800/);
    expect(setCookie).not.toMatch(/Domain=/i);

    // The session row is a viewer session for the email, stored by hash only; no account.
    expect(await sessionRow(viewerCookieOf(ok))).toMatchObject({
      kind: "viewer",
      viewerEmail: email,
      userId: null,
    });
    expect(await userByEmail(email)).toBeUndefined();

    const again = await run(
      `/api/v1/view/${artifact.slug}`,
      { headers: { Cookie: viewerCookieOf(ok) } },
      vars,
    );
    expect((await json(again)).status).toBe("ok");
  });

  it("a viewer session is not an account: it cannot use account endpoints or write", async () => {
    const vars = singleUser(uniqueEmail("admin"));
    const email = uniqueEmail("viewer-only");
    const { artifact } = await allowlisted([email]);
    const ok = await confirm(artifact.id, email, browser(), vars);
    const cookie = viewerCookieOf(ok);
    expect(cookie).toMatch(/^__Host-plinth_viewer=/);
    expect((await run("/api/v1/me", { headers: { Cookie: cookie } }, vars)).status).toBe(401);
    const edit = await run(
      `/api/v1/artifacts/${artifact.id}`,
      {
        method: "PUT",
        headers: { ...browser(cookie), Cookie: `${cookie}; __Host-plinth_csrf=viewer-csrf` },
        body: JSON.stringify({ html: "<p>defaced</p>" }),
      },
      vars,
    );
    expect([401, 403, 404]).toContain(edit.status);
  });

  it("the signed-in admin can confirm a different, listed email and stays signed in", async () => {
    const admin = await createUser(uniqueEmail("admin"));
    const vars = singleUser(admin.email);
    const listed = uniqueEmail("work");
    const { artifact } = await allowlisted([listed]);
    const s = await browserSession(admin.id);
    const headers = { ...browser(), ...s.headers, "Content-Type": "application/json" };
    const ok = await confirm(artifact.id, listed, headers, vars);
    expect((await json(ok)).status).toBe("ok");
    expect(viewerCookieOf(ok)).toMatch(/^__Host-plinth_viewer=/);
    const both = `${s.headers.Cookie}; ${viewerCookieOf(ok)}`;
    const gate = await json(
      await run(`/api/v1/view/${artifact.id}`, { headers: { Cookie: both } }, vars),
    );
    expect(gate.status).toBe("ok");
    const me = await run("/api/v1/me", { headers: { Cookie: both } }, vars);
    expect((await json(me)).email).toBe(admin.email);
  });

  it("an editor confirmed by code there watches a doc and is asked to sign in (account_required)", async () => {
    const vars = singleUser(uniqueEmail("admin"));
    const { docSetup, grant } = await import("./room-helpers.ts");
    const { id } = await docSetup();
    const email = uniqueEmail("coded-editor");
    await grant(id, email, "editor");
    await db().update(artifacts).set({ visibility: "allowlist" }).where(eq(artifacts.id, id)).run();
    const gate = await json(await confirm(id, email, browser(), vars));
    expect(gate.role).toBe("editor");
    expect(gate.live).toEqual({ mode: "room", sign_in: true, draft: null });
  });
});

describe("the owner at their own allowlist gate", () => {
  it("gets a code by email, like a listed address, with the same answer as anyone else", async () => {
    const listed = uniqueEmail("listed");
    const stranger = uniqueEmail("stranger");
    const { owner, artifact } = await allowlisted([listed]);

    const a = await post(`/api/v1/view/${artifact.id}/email`, browser(), {
      email: owner.user.email,
    });
    const b = await post(`/api/v1/view/${artifact.id}/email`, browser(), { email: listed });
    const c = await post(`/api/v1/view/${artifact.id}/email`, browser(), { email: stranger });
    const bodies = [await a.text(), await b.text(), await c.text()];
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(new Set(bodies).size).toBe(1);
    expect(await outboxFor(owner.user.email)).toHaveLength(1);
    expect(await outboxFor(stranger)).toHaveLength(0);
  });

  it("confirming the code signs the owner in to the app and opens the artifact as owner", async () => {
    const { owner, artifact } = await allowlisted([uniqueEmail("listed")]);
    const ok = await confirm(artifact.id, owner.user.email);
    expect(ok.status).toBe(200);
    const gate = await json(ok);
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("owner");

    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-plinth_session=[^;]+;/);
    expect(setCookie).not.toMatch(/plinth_viewer/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).not.toMatch(/Domain=/i);

    const cookie = (setCookie.split(";")[0] ?? "").trim();
    const value = cookie.split("=")[1] ?? "";
    const s = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, await hashToken(value)))
      .get();
    expect(s).toMatchObject({ kind: "user", userId: owner.user.id, viewerEmail: null });

    const me = await call("/api/v1/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect((await json(me)).email).toBe(owner.user.email);
  });

  it("a code for one artifact's owner does not sign in through another owner's artifact", async () => {
    const { owner } = await allowlisted([uniqueEmail()]);
    const { artifact: other } = await allowlisted([uniqueEmail()]);
    expect(
      (await post(`/api/v1/view/${other.id}/email`, browser(), { email: owner.user.email })).status,
    ).toBe(200);
    expect(await outboxFor(owner.user.email)).toHaveLength(0);
  });
});

describe("the gate's live field: on-page editing of a doc (#36)", () => {
  const gateOf = async (
    id: string,
    headers: Record<string, string> = {},
    vars: Record<string, unknown> = {},
    query = "",
  ) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://app.localhost:8787/api/v1/view/${id}${query}`, { headers }),
      { ...env, ...vars } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res.json() as Promise<Record<string, any>>;
  };

  it("owners and editors on the current version get it; commenters, viewers, HTML and pinned versions do not", async () => {
    const { docSetup, person, setup } = await import("./room-helpers.ts");
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const commenter = await person(id, "commenter");
    expect((await gateOf(id, ownerP.session.headers)).live).toEqual({ mode: "room", draft: null });
    expect((await gateOf(id, ed.session.headers)).live).toEqual({ mode: "room", draft: null });
    expect((await gateOf(id, commenter.session.headers)).live).toBeUndefined();
    expect((await gateOf(id, ownerP.session.headers, {}, "?version=1")).live).toBeUndefined();
    const html = await setup();
    expect((await gateOf(html.id, html.ownerP.session.headers)).live).toBeUndefined();
  });

  it("names the mode: solo without rooms, none without live editing or under opaque isolation", async () => {
    const { docSetup } = await import("./room-helpers.ts");
    const { id, ownerP } = await docSetup();
    const h = ownerP.session.headers;
    expect((await gateOf(id, h, { ALLOW_ROOMS: "false" })).live).toEqual({
      mode: "solo",
      draft: null,
    });
    expect((await gateOf(id, h, { ALLOW_LIVE_EDITING: "false" })).live).toBeUndefined();
    expect((await gateOf(id, h, { CONTENT_ISOLATION: "opaque" })).live).toBeUndefined();
  });

  it("tells editors about an unsaved draft, with whose edit it was", async () => {
    const { docSetup } = await import("./room-helpers.ts");
    const { id, ownerP } = await docSetup();
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, updated_by_user, created_at, updated_at)
       VALUES (?1, 1, 'x', 1, 3, ?2, ?3, ?3)`,
    )
      .bind(id, ownerP.userId, at)
      .run();
    expect((await gateOf(id, ownerP.session.headers)).live).toEqual({
      mode: "room",
      draft: {
        base_version: 1,
        dirty: true,
        conflict_version: null,
        updated_at: at,
        updated_by_email: ownerP.email,
      },
    });
  });

  it("an editor confirmed by code (no account) must sign in to edit, and the claim has no account flag", async () => {
    const { docSetup, grant } = await import("./room-helpers.ts");
    const { verifyEnterToken } = await import("../src/content/tokens.ts");
    const { openJson } = await import("../src/lib/crypto.ts");
    const { id } = await docSetup();
    const email = uniqueEmail("coded-editor");
    await grant(id, email, "editor");
    const value = `v_${Math.random().toString(36).slice(2)}${Date.now()}`;
    await db()
      .insert(sessions)
      .values({
        id: await hashToken(value),
        kind: "viewer",
        viewerEmail: email,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();
    const { appCookieName } = await import("../src/lib/cookies.ts");
    const gate = await gateOf(id, { Cookie: `${appCookieName(config(), "viewer")}=${value}` });
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("editor");
    expect(gate.live).toEqual({ mode: "room", sign_in: true, draft: null });
    const token = new URL(gate.enter_url).searchParams.get("t") ?? "";
    const payload = await verifyEnterToken(config(), token);
    const claim = await openJson(
      config().tokenSigningKey,
      "plinth identity claim v1",
      id,
      String(payload?.x),
    );
    expect(claim).toEqual({ m: email, r: "editor" });
  });

  it("a page whose room shows viewers' emails tells them so, with or without shared data", async () => {
    const { person, roomPage, setup } = await import("./room-helpers.ts");
    // room viewer, no data: the room stamps each peer's email.
    const { id: roomOnly } = await setup(roomPage({ viewer: true }));
    const ed = await person(roomOnly, "viewer");
    const data = (await gateOf(roomOnly, ed.session.headers)).data;
    expect(data).toMatchObject({ capabilities: ["viewer", "room"], room_email: ed.email });
    expect(data.email).toBeUndefined();
    // Rooms off: the room shows nothing, so there is nothing to say.
    expect(
      (await gateOf(roomOnly, ed.session.headers, { ALLOW_ROOMS: "false" })).data,
    ).toBeUndefined();
    // room without viewer: nobody's email, no notice.
    const { id: anonymous } = await setup(roomPage({ viewer: false }));
    const v = await person(anonymous, "viewer");
    expect((await gateOf(anonymous, v.session.headers)).data).toBeUndefined();
    // data viewer room with shared data off: still told about the room.
    const { id: board } = await setup(roomPage({ viewer: true, data: true }));
    const b = await person(board, "editor");
    const off = (await gateOf(board, b.session.headers, { ALLOW_SHARED_DATA: "false" })).data;
    expect(off).toMatchObject({ available: false, room_email: b.email });
  });
});

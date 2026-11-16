// Allowlist viewers: confirm an email by a one-time code, then open every artifact that email is
// listed on. A non-listed email never gets a viewer session, and the API never reveals the list.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { devOutbox, loginCodes, sessions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken } from "../src/lib/crypto.ts";
import { MAX_VIEWER_CODE_ATTEMPTS } from "../src/services/viewers.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  contentOrigin,
  createUser,
  db,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";

/** Run a request through the Worker's fetch handler and wait for its waitUntil work (email). */
async function run(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${APP}${path}`;
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    env as never,
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

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  run(path, { method: "POST", headers, body: JSON.stringify(body) });

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
async function confirm(ref: string, email: string, headers = browser()) {
  expect((await post(`/api/v1/view/${ref}/email`, headers, { email })).status).toBe(200);
  return post(`/api/v1/view/${ref}/code`, headers, { email, code: await codeFor(email) });
}

const viewerCookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("allowlist viewers", () => {
  it("a listed email gets a code, confirms it, and opens the artifact", async () => {
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
    expect(mails[0]?.text).toContain("Private board deck");

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

    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-plinth_viewer=plinth_vs_[A-Za-z0-9]+;/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; SameSite=Lax/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; Max-Age=604800/);
    expect(setCookie).not.toMatch(/Domain=/i);

    // The session row is a viewer session for the email, stored by hash only.
    const value = viewerCookieOf(ok).split("=")[1] ?? "";
    const s = await db()
      .select()
      .from(sessions)
      .where(eq(sessions.id, await hashToken(value)))
      .get();
    expect(s).toMatchObject({ kind: "viewer", viewerEmail: email, userId: null });

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

  it("a signed-in user can confirm a different, listed email by code in the same browser", async () => {
    const user = await createUser();
    const listed = uniqueEmail("work");
    const { artifact } = await allowlisted([listed]);
    const s = await browserSession(user.id);
    const headers = { ...browser(), ...s.headers, "Content-Type": "application/json" };
    const ok = await confirm(artifact.id, listed, headers);
    expect((await json(ok)).status).toBe("ok");
    const both = `${s.headers.Cookie}; ${viewerCookieOf(ok)}`;
    const gate = await json(
      await call(`/api/v1/view/${artifact.id}`, { headers: { Cookie: both } }),
    );
    expect(gate.status).toBe("ok");
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

  it("a viewer session is not an account: it cannot use account endpoints or write", async () => {
    const email = uniqueEmail("viewer-only");
    const { artifact } = await allowlisted([email]);
    const ok = await confirm(artifact.id, email);
    const cookie = viewerCookieOf(ok);
    expect((await call("/api/v1/me", { headers: { Cookie: cookie } })).status).toBe(401);
    const edit = await call(`/api/v1/artifacts/${artifact.id}`, {
      method: "PUT",
      headers: { ...browser(cookie), Cookie: `${cookie}; __Host-plinth_csrf=viewer-csrf` },
      body: JSON.stringify({ html: "<p>defaced</p>" }),
    });
    expect([401, 403, 404]).toContain(edit.status);
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

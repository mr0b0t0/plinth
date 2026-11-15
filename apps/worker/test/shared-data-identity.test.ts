// Viewer identity for shared data: the sealed claim travels from the gate through the enter token
// into the content cookie, only for identified viewers (owner and grant holders), and only when
// shared data is on with origin isolation. Design: docs/superpowers/specs/2026-11-14-shared-state-design.md
// section 2.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Role, ViewGate } from "@plinth/shared";
import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { computeGate } from "../src/api/view.ts";
import { contentCookieName, readContentPass } from "../src/content/serve.ts";
import {
  IDENTITY_CLAIM_INFO,
  signContentCookie,
  verifyContentCookie,
  verifyEnterToken,
} from "../src/content/tokens.ts";
import { accessGrants, artifacts, devOutbox, reports } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { fromBase64url, newId, openJson, sealJson, viewerIdFor } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import type { Principal } from "../src/policy.ts";
import type { Ctx } from "../src/services/context.ts";
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

const SECRET = "test-token-signing-key-0123456789abcdef012345";
const DECLARED = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<p>poll</p>`;

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

let ip = 0;
function browser(extraCookie = "") {
  ip += 1;
  return {
    Cookie: ["__Host-plinth_csrf=identity-csrf", extraCookie].filter(Boolean).join("; "),
    "x-plinth-csrf": "identity-csrf",
    Origin: APP,
    "Content-Type": "application/json",
    "cf-connecting-ip": `203.0.113.${ip % 250}`,
  };
}

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  run(path, { method: "POST", headers, body: JSON.stringify(body) });

async function codeFor(email: string): Promise<string> {
  const [mail] = await db()
    .select()
    .from(devOutbox)
    .where(eq(devOutbox.toEmail, email))
    .orderBy(desc(devOutbox.createdAt))
    .all();
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no code mailed to ${email}`);
  return code;
}

async function confirmByCode(ref: string, email: string, headers = browser()) {
  expect((await post(`/api/v1/view/${ref}/email`, headers, { email })).status).toBe(200);
  return post(`/api/v1/view/${ref}/code`, headers, { email, code: await codeFor(email) });
}

const viewerCookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function pub(visibility: string, extra: Record<string, unknown> = {}) {
  const owner = await agent();
  const { body } = await publish(owner.auth, { html: DECLARED, visibility, ...extra });
  return { owner, artifact: body as { id: string; slug: string } };
}

async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

function ctxFor(
  principal: Principal,
  overrides: Partial<ReturnType<typeof config>> = {},
  viewerEmail: string | null = null,
): Ctx {
  return {
    env: env as unknown as Ctx["env"],
    config: { ...config(), ...overrides },
    db: db(),
    principal,
    passwordPasses: new Map(),
    viewerEmail,
    ip: null,
    waitUntil: () => undefined,
  };
}

const userP = (u: { id: string; email: string }, isAdmin = false): Principal => ({
  kind: "user",
  userId: u.id,
  email: u.email,
  isAdmin,
});

type OkGate = Extract<ViewGate, { status: "ok" }>;

function asOk(gate: ViewGate): OkGate {
  if (gate.status !== "ok") throw new Error(`gate ${gate.status}`);
  return gate;
}

/** The enter token's payload. */
async function enterPayload(gate: ViewGate) {
  const ok = asOk(gate);
  const token = new URL(ok.enter_url).searchParams.get("t") ?? "";
  const p = await verifyEnterToken(config(), token);
  if (!p) throw new Error("enter token did not verify");
  return { token, payload: p };
}

/** The claim inside the enter token, opened, or null when there is none. */
async function claimIn(gate: ViewGate) {
  const { payload } = await enterPayload(gate);
  if (payload.x === undefined) return null;
  return openJson(SECRET, IDENTITY_CLAIM_INFO, payload.a, payload.x);
}

/** Exchange the gate's enter URL and read the content pass the cookie carries. */
async function passFrom(gate: ViewGate) {
  const ok = asOk(gate);
  const enter = await call(ok.enter_url);
  expect(enter.status).toBe(302);
  const setCookie = enter.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const pass = await passFor(ok.artifact.id, cookie);
  return { cookie, setCookie, pass };
}

async function passFor(artifactId: string, cookie: string) {
  const row = await db().select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
  if (!row) throw new Error("no artifact");
  const req = new Request(`${contentOrigin(artifactId)}/`, { headers: { Cookie: cookie } });
  return readContentPass(req, config(), row);
}

const gateHttp = async (ref: string, headers?: Record<string, string>) =>
  json<ViewGate>(await call(`/api/v1/view/${ref}`, { headers }));

// ---------- sealing ----------

describe("sealJson / openJson", () => {
  const INFO = IDENTITY_CLAIM_INFO;
  it("round-trips, with a fresh IV each time", async () => {
    const obj = { m: "a@example.com", r: "viewer" };
    const s1 = await sealJson(SECRET, INFO, "artifact-a", obj);
    const s2 = await sealJson(SECRET, INFO, "artifact-a", obj);
    expect(s1).not.toBe(s2);
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await openJson(SECRET, INFO, "artifact-a", s1)).toEqual(obj);
    expect(await openJson(SECRET, INFO, "artifact-a", s2)).toEqual(obj);
    expect(s1).not.toContain("example");
  });

  it("refuses tampering, another info string, another AAD and another key", async () => {
    const s = await sealJson(SECRET, INFO, "artifact-a", { m: "a@example.com", r: "owner" });
    const bytes = fromBase64url(s);
    for (const i of [0, 11, 12, bytes.length - 1]) {
      const t = new Uint8Array(bytes);
      t[i] = (t[i] ?? 0) ^ 1;
      let bin = "";
      for (const b of t) bin += String.fromCharCode(b);
      const tampered = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await openJson(SECRET, INFO, "artifact-a", tampered), `byte ${i}`).toBeNull();
    }
    expect(await openJson(SECRET, "plinth identity claim v2", "artifact-a", s)).toBeNull();
    expect(await openJson(SECRET, INFO, "artifact-b", s)).toBeNull();
    expect(
      await openJson("another-signing-key-0123456789abcdef0123456", INFO, "artifact-a", s),
    ).toBeNull();
    for (const junk of ["", "a", "!!!!", "A".repeat(20), s.slice(0, 20)])
      expect(await openJson(SECRET, INFO, "artifact-a", junk), junk).toBeNull();
  });

  it("viewerIdFor is u_ plus 24 hex, stable, and differs per artifact and per email", async () => {
    const a = await viewerIdFor(SECRET, "artifact-a", "x@example.com");
    expect(a).toMatch(/^u_[0-9a-f]{24}$/);
    expect(await viewerIdFor(SECRET, "artifact-a", "x@example.com")).toBe(a);
    expect(await viewerIdFor(SECRET, "artifact-b", "x@example.com")).not.toBe(a);
    expect(await viewerIdFor(SECRET, "artifact-a", "y@example.com")).not.toBe(a);
    expect(
      await viewerIdFor("another-key-0123456789abcdef0123456789abc", "artifact-a", "x@example.com"),
    ).not.toBe(a);
  });
});

// ---------- who gets a claim ----------

describe("identity claim: issued for identified viewers", () => {
  it("the signed-in owner, with the owner's email", async () => {
    const { owner, artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    const s = await browserSession(owner.user.id);
    const gate = await gateHttp(artifact.id, s.headers);
    expect(await claimIn(gate)).toEqual({ m: owner.user.email, r: "owner" });
    const { pass } = await passFrom(gate);
    expect(pass).toEqual({
      claim: {
        email: owner.user.email,
        role: "owner",
        viewerId: await viewerIdFor(SECRET, artifact.id, owner.user.email),
      },
      capture: false,
    });
  });

  for (const role of ["viewer", "commenter", "editor"] as const) {
    it(`a signed-in ${role} grant holder`, async () => {
      const { artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
      const user = await createUser();
      await grant(artifact.id, user.email, role);
      const s = await browserSession(user.id);
      const gate = await gateHttp(artifact.id, s.headers);
      expect(asOk(gate).role).toBe(role);
      expect(await claimIn(gate)).toEqual({ m: user.email, r: role });
      const { pass } = await passFrom(gate);
      expect(pass?.claim).toMatchObject({ email: user.email, role });
    });

    it(`a ${role} confirmed by email code, on the code response and on later visits`, async () => {
      const email = uniqueEmail(`code-${role}`);
      const { artifact } = await pub("allowlist", { emails: [email] });
      await grant(artifact.id, email, role);
      const ok = await confirmByCode(artifact.id, email);
      expect(ok.status).toBe(200);
      const gate = await json<ViewGate>(ok);
      expect(await claimIn(gate)).toEqual({ m: email, r: role });
      const again = await gateHttp(artifact.id, { Cookie: viewerCookieOf(ok) });
      expect(await claimIn(again)).toEqual({ m: email, r: role });
      const { pass } = await passFrom(again);
      expect(pass?.claim).toMatchObject({ email, role });
    });
  }

  it("a grant holder on an unlisted artifact is identified too", async () => {
    const { artifact } = await pub("unlisted");
    const user = await createUser();
    await grant(artifact.id, user.email, "commenter");
    const s = await browserSession(user.id);
    expect(await claimIn(await gateHttp(artifact.id, s.headers))).toEqual({
      m: user.email,
      r: "commenter",
    });
  });

  it("the alternate viewer path carries the email that holds the grant", async () => {
    const user = await createUser();
    const listed = uniqueEmail("work");
    const { artifact } = await pub("allowlist", { emails: [listed] });
    const s = await browserSession(user.id);
    const ok = await confirmByCode(artifact.id, listed, {
      ...browser(),
      ...s.headers,
      "Content-Type": "application/json",
    });
    expect((await json<ViewGate>(ok)).status).toBe("ok");
    const both = `${s.headers.Cookie}; ${viewerCookieOf(ok)}`;
    const gate = await gateHttp(artifact.id, { Cookie: both });
    expect(await claimIn(gate)).toEqual({ m: listed, r: "viewer" });

    // Directly: a user principal whose own email is not listed, with the confirmed viewer email.
    const direct = await computeGate(ctxFor(userP(user), {}, listed), artifact.id);
    expect(await claimIn(direct)).toEqual({ m: listed, r: "viewer" });
  });

  it("with grants on both emails, the stronger one's email is used", async () => {
    const user = await createUser();
    const other = uniqueEmail("alt");
    const { artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    await grant(artifact.id, user.email, "viewer");
    await grant(artifact.id, other, "editor");
    const gate = await computeGate(ctxFor(userP(user), {}, other), artifact.id);
    expect(asOk(gate).role).toBe("editor");
    expect(await claimIn(gate)).toEqual({ m: other, r: "editor" });
    await grant(artifact.id, user.email, "editor");
    const tie = await computeGate(ctxFor(userP(user), {}, other), artifact.id);
    expect(await claimIn(tie)).toEqual({ m: user.email, r: "editor" });
  });
});

describe("identity claim: nobody else gets one", () => {
  it("unlisted and public link viewers, and signed-in people without a grant", async () => {
    const { artifact } = await pub("unlisted");
    expect(await claimIn(await gateHttp(artifact.id))).toBeNull();
    const stranger = await createUser();
    const s = await browserSession(stranger.id);
    const gate = await gateHttp(artifact.id, s.headers);
    expect(asOk(gate).role).toBeNull();
    expect(await claimIn(gate)).toBeNull();
    const { pass } = await passFrom(gate);
    expect(pass).toEqual({ claim: null, capture: false });

    await db()
      .update(artifacts)
      .set({ visibility: "public" })
      .where(eq(artifacts.id, artifact.id))
      .run();
    for (const cfg of [{}, { allowPublicVisibility: true }]) {
      const g = await computeGate(ctxFor({ kind: "anonymous" }, cfg), artifact.id);
      expect(g.status).toBe("ok");
      expect(await claimIn(g)).toBeNull();
    }
  });

  it("password viewers", async () => {
    const { artifact } = await pub("password", { password: "secret99" });
    const res = await post(`/api/v1/view/${artifact.id}/password`, browser(), {
      password: "secret99",
    });
    expect(res.status).toBe(200);
    const gate = await json<ViewGate>(res);
    expect(gate.status).toBe("ok");
    expect(await claimIn(gate)).toBeNull();
  });

  it("an admin reviewing a report", async () => {
    const { artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    await db()
      .insert(reports)
      .values({ id: newId(), artifactId: artifact.id, reason: "spam", createdAt: nowIso() })
      .run();
    const adminUser = await createUser();
    const gate = await computeGate(ctxFor(userP(adminUser, true)), artifact.id);
    expect(gate.status).toBe("ok");
    expect(asOk(gate).role).toBeNull();
    expect(await claimIn(gate)).toBeNull();
  });

  it("agents, the owner's included", async () => {
    const { owner, artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    const gate = await gateHttp(artifact.id, owner.auth);
    expect(asOk(gate).role).toBe("owner");
    expect(await claimIn(gate)).toBeNull();
    const direct = await computeGate(
      ctxFor({
        kind: "agent",
        userId: owner.user.id,
        email: owner.user.email,
        connectionId: owner.connectionId,
        connectionLabel: "Test token",
        clientType: "other",
        scopes: new Set(["artifacts:read", "artifacts:write"]),
      }),
      artifact.id,
    );
    expect(await claimIn(direct)).toBeNull();
  });

  it("ALLOW_SHARED_DATA=false and opaque isolation", async () => {
    const { owner, artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    const p = userP(owner.user);
    expect(await claimIn(await computeGate(ctxFor(p), artifact.id))).not.toBeNull();
    expect(
      await claimIn(await computeGate(ctxFor(p, { allowSharedData: false }), artifact.id)),
    ).toBeNull();
    const opaque = await computeGate(ctxFor(p, { contentIsolation: "opaque" }), artifact.id);
    expect(opaque.status).toBe("ok");
    expect(await claimIn(opaque)).toBeNull();
  });
});

// ---------- the claim's journey ----------

describe("identity claim: tokens and cookies", () => {
  it("neither the enter URL nor its decoded token contains the email", async () => {
    const email = uniqueEmail("secretperson");
    const { artifact } = await pub("allowlist", { emails: [email] });
    const ok = await confirmByCode(artifact.id, email);
    const gate = asOk(await json<ViewGate>(ok));
    expect(await claimIn(gate)).toEqual({ m: email, r: "viewer" });
    const local = email.split("@")[0] ?? "";
    expect(gate.enter_url).not.toContain(local);
    expect(decodeURIComponent(gate.enter_url)).not.toContain(local);
    const { token } = await enterPayload(gate);
    const decoded = token
      .split(".")
      .map((part) => new TextDecoder().decode(fromBase64url(part)))
      .join("|");
    expect(decoded).not.toContain(local);
    expect(decoded).not.toContain("example.com");
    // The cookie carries the same sealed value, also without the email.
    const { cookie } = await passFrom(gate);
    const value = cookie.split("=").slice(1).join("=");
    const cookieDecoded = new TextDecoder().decode(fromBase64url(value.split(".")[0] ?? ""));
    expect(cookieDecoded).not.toContain(local);
    const content = await verifyContentCookie(config(), value);
    expect(content?.x).toBe((await enterPayload(gate)).payload.x);
  });

  it("a cookie whose x fails to open is rejected, never downgraded", async () => {
    const { owner, artifact } = await pub("unlisted");
    const row = await db().select().from(artifacts).where(eq(artifacts.id, artifact.id)).get();
    const epoch = row?.accessEpoch ?? 0;
    const cookieName = "__Host-plinth_content";
    const garbage = await signContentCookie(config(), artifact.id, epoch, "not-a-sealed-value");
    expect(await passFor(artifact.id, `${cookieName}=${garbage}`)).toBeNull();
    // A claim sealed for another artifact (AAD mismatch) inside a cookie signed for this one.
    const foreign = await sealJson(SECRET, IDENTITY_CLAIM_INFO, "aaaaaaaaaaaaaaaaaaaa", {
      m: owner.user.email,
      r: "owner",
    });
    const moved = await signContentCookie(config(), artifact.id, epoch, foreign);
    expect(await passFor(artifact.id, `${cookieName}=${moved}`)).toBeNull();
    // A claim that opens but has the wrong shape.
    const odd = await sealJson(SECRET, IDENTITY_CLAIM_INFO, artifact.id, { m: 1, r: "boss" });
    const shaped = await signContentCookie(config(), artifact.id, epoch, odd);
    expect(await passFor(artifact.id, `${cookieName}=${shaped}`)).toBeNull();
    // The file is not served with such a cookie.
    const res = await call(`${contentOrigin(artifact.id)}/`, {
      headers: { Cookie: `${cookieName}=${garbage}`, "sec-fetch-dest": "iframe" },
    });
    expect(res.status).toBe(401);
    // A good cookie next to the bad one still works.
    const good = await signContentCookie(config(), artifact.id, epoch);
    expect(await passFor(artifact.id, `${cookieName}=${garbage}; ${cookieName}=${good}`)).toEqual({
      claim: null,
      capture: false,
    });
  });

  it("an epoch bump ends the pass and its claim", async () => {
    const { owner, artifact } = await pub("allowlist", { emails: [uniqueEmail()] });
    const s = await browserSession(owner.user.id);
    const { cookie, pass } = await passFrom(await gateHttp(artifact.id, s.headers));
    expect(pass?.claim?.role).toBe("owner");
    const page = await call(`${contentOrigin(artifact.id)}/`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("poll");
    const res = await call(`/api/v1/artifacts/${artifact.id}/visibility`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "unlisted" }),
    });
    expect(res.status).toBe(200);
    expect(await passFor(artifact.id, cookie)).toBeNull();
    const after = await call(`${contentOrigin(artifact.id)}/`, {
      headers: { Cookie: cookie, "sec-fetch-dest": "iframe" },
    });
    expect(after.status).toBe(401);
  });

  it("an anonymous enter overwrites an identified cookie", async () => {
    const { owner, artifact } = await pub("unlisted");
    const s = await browserSession(owner.user.id);
    const identified = await passFrom(await gateHttp(artifact.id, s.headers));
    expect(identified.pass?.claim?.email).toBe(owner.user.email);
    const anonymous = await passFrom(await gateHttp(artifact.id));
    expect(anonymous.pass).toEqual({ claim: null, capture: false });
    // Same name, path and host: the browser replaces the first cookie with the second.
    const attrs = (sc: string) =>
      sc
        .split(";")
        .slice(1)
        .map((x) => x.trim())
        .filter((x) => !/^Max-Age/i.test(x) && !/^Expires/i.test(x));
    expect(anonymous.cookie.split("=")[0]).toBe(identified.cookie.split("=")[0]);
    expect(attrs(anonymous.setCookie)).toEqual(attrs(identified.setCookie));
    expect(anonymous.setCookie).not.toMatch(/Domain=/i);
  });
});

// ---------- cookie tossing ----------

/** A request to the page API the way the runtime makes it, with the given Cookie header. */
const sessionWith = (artifactId: string, cookie: string) =>
  run(`${contentOrigin(artifactId)}/__plinth/api/v1/session`, {
    headers: {
      "x-plinth-data": "1",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie,
    },
  });

describe("identity claim: a tossed pass cannot stand in for the viewer's", () => {
  it("is named __Host- on an artifact subdomain; plain in the path fallback and on plain http", () => {
    const c = config();
    const id = "a".repeat(20);
    expect(contentCookieName(c, new URL(`${contentOrigin(id)}/`))).toBe("__Host-plinth_content");
    expect(contentCookieName(c, new URL(`${APP}/__content/${id}/`))).toBe("plinth_content");
    expect(
      contentCookieName(
        { appHost: "app.example.test", scheme: "http" },
        new URL(`http://${id}.content.example.test/`),
      ),
    ).toBe("plinth_content");
  });

  it("a valid pass under the plain name (one a sibling could toss) is ignored", async () => {
    // The attacker is a link viewer: their pass is valid for this artifact and epoch.
    const { owner, artifact } = await pub("unlisted");
    const attacker = await passFrom(await gateHttp(artifact.id));
    const s = await browserSession(owner.user.id);
    const victim = await passFrom(await gateHttp(artifact.id, s.headers));
    expect(attacker.cookie.startsWith("__Host-plinth_content=")).toBe(true);
    const tossed = `plinth_content=${attacker.cookie.split("=").slice(1).join("=")}`;
    // A tossed copy (longer path, so listed first) next to the real one: the real one counts.
    const both = `${tossed}; ${victim.cookie}`;
    expect((await passFor(artifact.id, both))?.claim?.email).toBe(owner.user.email);
    const session = await json(await sessionWith(artifact.id, both));
    expect(session).toMatchObject({
      available: true,
      can_write: true,
      viewer: { email: owner.user.email, role: "owner" },
    });
    // Alone, the plain name opens nothing.
    expect(await passFor(artifact.id, tossed)).toBeNull();
    expect((await sessionWith(artifact.id, tossed)).status).toBe(401);
    // Eight junk values under the plain name do not hide the real pass either.
    const junk = Array.from({ length: 8 }, (_, i) => `plinth_content=junk${i}`).join("; ");
    expect((await passFor(artifact.id, `${junk}; ${victim.cookie}`))?.claim?.role).toBe("owner");
  });

  it("two valid passes that disagree on who is viewing are ambiguous: no pass, 401", async () => {
    const { owner, artifact } = await pub("unlisted");
    const anon = await passFrom(await gateHttp(artifact.id));
    const s = await browserSession(owner.user.id);
    const ownerPass = await passFrom(await gateHttp(artifact.id, s.headers));
    const editor = await createUser();
    await grant(artifact.id, editor.email, "editor");
    const es = await browserSession(editor.id);
    const editorPass = await passFrom(await gateHttp(artifact.id, es.headers));
    for (const [a, b] of [
      [anon.cookie, ownerPass.cookie],
      [ownerPass.cookie, anon.cookie],
      [editorPass.cookie, ownerPass.cookie],
    ] as const) {
      const header = `${a}; ${b}`;
      expect(await passFor(artifact.id, header)).toBeNull();
      const res = await sessionWith(artifact.id, header);
      expect(res.status).toBe(401);
      expect((await json(res)).error).toMatchObject({
        code: "unauthorized",
        details: { reason: "expired" },
      });
      // Files too: the frame is asked to reload through the gate.
      const page = await run(`${contentOrigin(artifact.id)}/`, {
        headers: { Cookie: header, "sec-fetch-dest": "iframe" },
      });
      expect(page.status).toBe(401);
    }
    // The same identity twice (two passes minted for one person) is not ambiguous.
    const again = await passFrom(await gateHttp(artifact.id, s.headers));
    expect((await passFor(artifact.id, `${again.cookie}; ${ownerPass.cookie}`))?.claim?.email).toBe(
      owner.user.email,
    );
  });
});

// ---------- ViewGate.data ----------

describe("ViewGate.data", () => {
  it("absent when the current version declares nothing", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const s = await browserSession(a.user.id);
    expect("data" in asOk(await gateHttp(body.id, s.headers))).toBe(false);
    expect("data" in asOk(await gateHttp(body.id))).toBe(false);
  });

  it("identified owner with data and viewer", async () => {
    const { owner, artifact } = await pub("unlisted");
    const s = await browserSession(owner.user.id);
    expect(asOk(await gateHttp(artifact.id, s.headers)).data).toEqual({
      available: true,
      capabilities: ["data", "viewer"],
      identified: true,
      can_write: true,
      email: owner.user.email,
    });
  });

  it("names the email that holds the grant, and none without the viewer capability", async () => {
    const user = await createUser();
    const listed = uniqueEmail("notice");
    const { artifact } = await pub("allowlist", { emails: [listed] });
    const s = await browserSession(user.id);
    const ok = await confirmByCode(artifact.id, listed, {
      ...browser(),
      ...s.headers,
      "Content-Type": "application/json",
    });
    expect(asOk(await json<ViewGate>(ok)).data).toMatchObject({ identified: true, email: listed });

    const owner = await agent();
    const { body } = await publish(owner.auth, {
      html: '<!doctype html><meta name="plinth-capabilities" content="data"><p>x</p>',
    });
    const os = await browserSession(owner.user.id);
    const dataOnly = asOk(await gateHttp(body.id, os.headers)).data;
    expect(dataOnly).toMatchObject({ identified: true, can_write: true });
    expect(dataOnly && "email" in dataOnly).toBe(false);
  });

  it("anonymous link viewer reads but cannot write", async () => {
    const { artifact } = await pub("unlisted");
    expect(asOk(await gateHttp(artifact.id)).data).toEqual({
      available: true,
      capabilities: ["data", "viewer"],
      identified: false,
      can_write: false,
    });
  });

  it("viewer capability alone declares nothing: no data block, no email", async () => {
    const owner = await agent();
    const { body } = await publish(owner.auth, {
      html: '<!doctype html><meta name="plinth-capabilities" content="viewer"><p>x</p>',
    });
    const s = await browserSession(owner.user.id);
    const gate = asOk(await gateHttp(body.id, s.headers));
    expect("data" in gate).toBe(false);
    expect(JSON.stringify(gate)).not.toContain(owner.user.email);
  });

  it("unavailable when switched off or under opaque isolation", async () => {
    const { owner, artifact } = await pub("unlisted");
    const p = userP(owner.user);
    for (const cfg of [{ allowSharedData: false }, { contentIsolation: "opaque" as const }]) {
      expect(asOk(await computeGate(ctxFor(p, cfg), artifact.id)).data).toEqual({
        available: false,
        capabilities: ["data", "viewer"],
        identified: false,
        can_write: false,
      });
    }
  });

  it("follows the current version, even when an older one is opened", async () => {
    const { owner, artifact } = await pub("unlisted");
    const up = await call(`/api/v1/artifacts/${artifact.id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><p>no data now</p>", base_version: 1 }),
    });
    expect(up.status).toBe(200);
    const s = await browserSession(owner.user.id);
    const old = await json<ViewGate>(
      await call(`/api/v1/view/${artifact.id}?version=1`, { headers: s.headers }),
    );
    expect(asOk(old).artifact.version).toBe(1);
    expect("data" in asOk(old)).toBe(false);
  });
});

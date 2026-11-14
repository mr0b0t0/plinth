import { COOKIES, CSRF_HEADER, RATE_LIMITS, type Role } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { accessGrants, sessions } from "../src/db/schema.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  createUser,
  db,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";

const CSRF = "csrf-test-token-0123456789";

async function grant(artifactId: string, email: string, role: Role) {
  await db().insert(accessGrants).values({ artifactId, email, role, createdAt: nowIso() }).run();
}

/** A confirmed allowlist viewer without an account (app-host viewer cookie). */
async function viewerSession(email: string) {
  const value = newToken("v_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      viewerEmail: email,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  return {
    Cookie: `${COOKIES.viewer}=${value}; ${COOKIES.csrf}=${CSRF}`,
    [CSRF_HEADER]: CSRF,
    Origin: APP,
  };
}

/** No credentials, but a valid CSRF pair, so the request reaches authorization. */
const anonymous = { Cookie: `${COOKIES.csrf}=${CSRF}`, [CSRF_HEADER]: CSRF, Origin: APP };

/** A signed-in person with a role (or none) on the artifact. */
async function person(artifactId: string, role: Role | null) {
  const user = await createUser();
  if (role) await grant(artifactId, user.email, role);
  return { user, headers: (await browserSession(user.id)).headers };
}

function postComment(headers: Record<string, string>, ref: string, body: Record<string, unknown>) {
  return call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchComment(headers: Record<string, string>, id: string, status: string) {
  return call(`/api/v1/comments/${id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

async function listComments(headers: Record<string, string>, ref: string) {
  const res = await call(`/api/v1/artifacts/${ref}/comments`, { headers });
  return { res, body: await json(res) };
}

describe("comments: create, list, thread, resolve", () => {
  it("owner comments, replies thread one level deep, list is threaded oldest first", async () => {
    const owner = await agent({ label: "Work Claude" });
    const { body: p } = await publish(owner.auth);
    const ownerBrowser = await browserSession(owner.user.id);

    const r1 = await postComment(ownerBrowser.headers, p.slug, { body: "First thread" });
    expect(r1.status).toBe(201);
    const c1 = await json(r1);
    expect(c1).toMatchObject({
      artifact_id: p.id,
      version_number: 1,
      parent_id: null,
      body: "First thread",
      status: "open",
      anchor: null,
      mentions: [],
      author: { email: owner.user.email, connection_id: null },
    });

    const c2 = await json(await postComment(ownerBrowser.headers, p.id, { body: "Second thread" }));
    const reply = await json(
      await postComment(ownerBrowser.headers, p.slug, { body: "Reply", parent_id: c1.id }),
    );
    expect(reply.parent_id).toBe(c1.id);
    // A reply to a reply joins the root's thread.
    const nested = await json(
      await postComment(ownerBrowser.headers, p.slug, { body: "Nested", parent_id: reply.id }),
    );
    expect(nested.parent_id).toBe(c1.id);
    // An agent can comment too, as its connection.
    const byAgent = await json(
      await postComment(owner.auth, p.slug, { body: "From the agent", parent_id: c2.id }),
    );
    expect(byAgent.author).toMatchObject({
      label: "Work Claude",
      connection_id: owner.connectionId,
    });

    const { res, body } = await listComments(ownerBrowser.headers, p.slug);
    expect(res.status).toBe(200);
    expect(body.items.map((c: { body: string }) => c.body)).toEqual([
      "First thread",
      "Reply",
      "Nested",
      "Second thread",
      "From the agent",
    ]);
  });

  it("anchors are validated and stored as given; version_number must exist", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const anchor = { selector: "main > h1:nth-of-type(1)", text: "<b>Hello</b>", x: 0.25, y: 1 };
    const c = await json(await postComment(owner.auth, p.slug, { body: "Pinned", anchor }));
    expect(c.anchor).toEqual(anchor);
    const bad = await postComment(owner.auth, p.slug, {
      body: "x",
      anchor: { selector: "h1", x: 2 },
    });
    expect(bad.status).toBe(400);
    const longSel = await postComment(owner.auth, p.slug, {
      body: "x",
      anchor: { selector: "a".repeat(1001) },
    });
    expect(longSel.status).toBe(400);
    expect((await postComment(owner.auth, p.slug, { body: "x", version_number: 2 })).status).toBe(
      404,
    );
    expect((await postComment(owner.auth, p.slug, { body: "   " })).status).toBe(400);
  });

  it("stores bodies verbatim and returns them as JSON data, never as HTML", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const body = `<script>alert(1)</script> [x](javascript:alert(1)) "quotes" & 'apos'`;
    const res = await postComment(owner.auth, p.slug, { body });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await json(res)).body).toBe(body);
  });

  it("parent_id must be a comment on the same artifact", async () => {
    const owner = await agent();
    const { body: a } = await publish(owner.auth);
    const { body: b } = await publish(owner.auth);
    const onA = await json(await postComment(owner.auth, a.slug, { body: "on A" }));
    const res = await postComment(owner.auth, b.slug, { body: "x", parent_id: onA.id });
    expect(res.status).toBe(404);
    expect((await postComment(owner.auth, b.slug, { body: "x", parent_id: "nope" })).status).toBe(
      404,
    );
  });

  it("resolve and reopen a thread; resolving a reply resolves its root", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const root = await json(await postComment(owner.auth, p.slug, { body: "Thread" }));
    const reply = await json(
      await postComment(owner.auth, p.slug, { body: "Reply", parent_id: root.id }),
    );
    const resolved = await patchComment(owner.auth, root.id, "resolved");
    expect(resolved.status).toBe(200);
    expect((await json(resolved)).status).toBe("resolved");
    const reopened = await json(await patchComment(owner.auth, reply.id, "open"));
    expect(reopened).toMatchObject({ id: root.id, status: "open" });
    expect((await patchComment(owner.auth, root.id, "closed")).status).toBe(400);
    expect((await patchComment(owner.auth, "missing", "resolved")).status).toBe(404);
  });
});

describe("comments: who may comment", () => {
  it("editor and commenter may comment and resolve; a viewer-role grant may only read", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist" });
    const root = await json(await postComment(owner.auth, p.slug, { body: "Owner thread" }));

    for (const role of ["editor", "commenter"] as const) {
      const { user, headers } = await person(p.id, role);
      const res = await postComment(headers, p.slug, { body: `As ${role}` });
      expect(res.status, role).toBe(201);
      expect((await json(res)).author.email).toBe(user.email);
      expect((await patchComment(headers, root.id, "resolved")).status, role).toBe(200);
    }

    const viewer = await person(p.id, "viewer");
    const denied = await postComment(viewer.headers, p.slug, { body: "As viewer" });
    expect(denied.status).toBe(403);
    expect((await patchComment(viewer.headers, root.id, "open")).status).toBe(403);
    const { res, body } = await listComments(viewer.headers, p.slug);
    expect(res.status).toBe(200);
    expect(body.items.length).toBe(3);
  });

  it("anonymous gets 401; a stranger gets 404 on an allowlisted artifact", async () => {
    const owner = await agent();
    const { body: open } = await publish(owner.auth);
    expect((await postComment(anonymous, open.slug, { body: "hi" })).status).toBe(401);

    const { body: closed } = await publish(owner.auth, { visibility: "allowlist" });
    const root = await json(await postComment(owner.auth, closed.slug, { body: "Private" }));
    const stranger = await person(closed.id, null);
    expect((await postComment(stranger.headers, closed.slug, { body: "hi" })).status).toBe(404);
    expect((await listComments(stranger.headers, closed.slug)).res.status).toBe(404);
    expect((await patchComment(stranger.headers, root.id, "resolved")).status).toBe(404);
    const reply = await call(`/api/v1/comments/${root.id}/reply`, {
      method: "POST",
      headers: { ...stranger.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(reply.status).toBe(404);
    const strangerAgent = await agent();
    expect((await postComment(strangerAgent.auth, closed.slug, { body: "hi" })).status).toBe(404);
  });

  it("a signed-in person without a role on an unlisted artifact can read but not comment", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const stranger = await person(p.id, null);
    expect((await listComments(stranger.headers, p.slug)).res.status).toBe(200);
    expect((await postComment(stranger.headers, p.slug, { body: "hi" })).status).toBe(403);
  });

  it("a password-pass viewer has no email and cannot comment", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "password", password: "letmein1" });
    const pw = await call(`/api/v1/view/${p.slug}/password`, {
      method: "POST",
      headers: { ...anonymous, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "letmein1" }),
    });
    expect(pw.status).toBeLessThan(400);
    const passCookie = (pw.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(passCookie).toMatch(/^__Host-plinth_pw_/);
    const headers = { ...anonymous, Cookie: `${anonymous.Cookie}; ${passCookie}` };
    expect((await listComments(headers, p.slug)).res.status).toBe(200);
    expect((await postComment(headers, p.slug, { body: "hi" })).status).toBe(401);
  });

  it("a confirmed allowlist viewer with the commenter role can comment by email", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist" });
    const email = uniqueEmail("client");
    await grant(p.id, email, "commenter");
    const headers = await viewerSession(email);
    const res = await postComment(headers, p.slug, { body: "Looks good" });
    expect(res.status).toBe(201);
    expect((await json(res)).author).toMatchObject({ email, connection_id: null, label: email });

    const other = await viewerSession(uniqueEmail("viewer"));
    expect((await postComment(other, p.slug, { body: "hi" })).status).toBe(404);
    const listedViewer = uniqueEmail("listed");
    await grant(p.id, listedViewer, "viewer");
    expect(
      (await postComment(await viewerSession(listedViewer), p.slug, { body: "hi" })).status,
    ).toBe(403);
  });

  it("link viewers without a role do not see commenters' email addresses", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    const ownerBrowser = await browserSession(owner.user.id);
    await postComment(ownerBrowser.headers, p.slug, { body: "hello" });
    const anon = await listComments({}, p.slug);
    expect(anon.res.status).toBe(200);
    expect(anon.body.items[0].author.email).toBeNull();
    expect(anon.body.items[0].author.label).not.toContain("@");
    const own = await listComments(owner.auth, p.slug);
    expect(own.body.items[0].author.email).toBe(owner.user.email);
  });
});

describe("comments: rate limit", () => {
  it(`allows ${RATE_LIMITS.commentsPerUserPerHour} comments per user per hour, then 429`, async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    for (let i = 0; i < RATE_LIMITS.commentsPerUserPerHour; i++) {
      const res = await postComment(owner.auth, p.id, { body: `c${i}` });
      expect(res.status).toBe(201);
    }
    const over = await postComment(owner.auth, p.id, { body: "one too many" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    // The limit is per person: a session for the same user shares it, another user does not.
    const browser = await browserSession(owner.user.id);
    expect((await postComment(browser.headers, p.id, { body: "x" })).status).toBe(429);
    const other = await agent();
    const { body: q } = await publish(other.auth);
    expect((await postComment(other.auth, q.id, { body: "x" })).status).toBe(201);
  });
});

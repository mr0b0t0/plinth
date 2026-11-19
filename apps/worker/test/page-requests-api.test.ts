// Page requests on the content host (docs/spec.md "Page requests"): GET and POST
// /__plinth/api/v1/requests and GET /requests/<id>, with the data API's caller checks (and an Origin
// required on POST), availability, passes, the declaration, policy, targets, limits, races, and
// what the page may read back: only its viewer's own requests and the owner's agents' answers, with
// no author of anything.
import { env } from "cloudflare:workers";
import { PAGE_REQUEST_LIMITS, readStoredCapabilities } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import { users } from "../src/db/schema.ts";
import { fileRequest } from "../src/services/pageRequests.ts";
import {
  agent,
  browserSession,
  contentOrigin,
  db,
  enterContent,
  json,
  publish,
  uniqueEmail,
  versionRow,
} from "./helpers.ts";
import {
  agentOf,
  appHeaders,
  commentRow,
  cookieFor,
  DATA_ONLY,
  epochOf,
  errOf,
  file,
  gateFor,
  grant,
  mine,
  NO_TARGET_PAGE,
  ON,
  person,
  REQUESTS_PAGE,
  requestsApi,
  rest,
  run,
  setup,
  taskOf,
  viewerCookie,
} from "./page-requests-helpers.ts";

const noCors = (res: Response) => {
  for (const [k] of res.headers) expect(k.startsWith("access-control-"), k).toBe(false);
};

describe("page requests: the caller checks", () => {
  it("refuses a missing header, cross-site metadata, navigations and wrong or absent Origins", async () => {
    const { id, ownerP } = await setup();
    const body = { body: "Add the Q3 numbers" };
    for (const [what, over] of [
      ["no x-plinth-data", { "x-plinth-data": null }],
      ["same-site", { "sec-fetch-site": "same-site" }],
      ["cross-site", { "sec-fetch-site": "cross-site" }],
      ["a document destination", { "sec-fetch-dest": "document" }],
      ["a navigation", { "sec-fetch-mode": "navigate" }],
      ["no Origin", { origin: null }],
      ["an opaque Origin", { origin: "null" }],
      ["a sibling artifact's Origin", { origin: contentOrigin("b".repeat(20)) }],
      ["the app's Origin", { origin: "http://app.localhost:8787" }],
    ] as const) {
      const res = await requestsApi(id, "", { cookie: ownerP.cookie, body, headers: over });
      expect(res.status, what).toBe(403);
      noCors(res);
    }
    // A GET with a wrong Origin is refused too; without one it is served.
    const wrong = await requestsApi(id, "", {
      cookie: ownerP.cookie,
      headers: { origin: contentOrigin("b".repeat(20)) },
    });
    expect(wrong.status).toBe(403);
    expect((await requestsApi(id, "", { cookie: ownerP.cookie })).status).toBe(200);
    // The exact Origin files.
    expect((await file(id, ownerP.cookie, body)).res.status).toBe(201);
    expect((await requestsApi(id, "", { cookie: ownerP.cookie, method: "OPTIONS" })).status).toBe(
      405,
    );
  });

  it("takes only a strict JSON body within the cap", async () => {
    const { id, ownerP } = await setup();
    const text = await requestsApi(id, "", {
      cookie: ownerP.cookie,
      body: JSON.stringify({ body: "x" }),
      headers: { "content-type": "text/plain" },
    });
    expect(text.status).toBe(400);
    const big = JSON.stringify({
      body: "x",
      data: { s: "y".repeat(PAGE_REQUEST_LIMITS.bodyCapBytes) },
    });
    expect((await requestsApi(id, "", { cookie: ownerP.cookie, body: big })).status).toBe(413);
    // Without a Content-Length: a stream past the cap is refused while reading.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const streamed = await requestsApi(id, "", {
      cookie: ownerP.cookie,
      body: stream,
      headers: { "content-length": null },
    });
    expect(streamed.status).toBe(413);
    for (const extra of [
      { author_email: "boss@example.com" },
      { state: "done" },
      { target_connection: "c1" },
      { role: "owner" },
    ]) {
      const r = await file(id, ownerP.cookie, { body: "hi", ...extra });
      expect(r.res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await file(id, ownerP.cookie, { body: "   " })).res.status).toBe(400);
    expect(
      (await file(id, ownerP.cookie, { body: "x".repeat(PAGE_REQUEST_LIMITS.maxBodyChars + 1) }))
        .res.status,
    ).toBe(400);
    const deep: Record<string, unknown> = {};
    let at = deep;
    for (let i = 0; i < 20; i++) {
      at.n = {};
      at = at.n as Record<string, unknown>;
    }
    expect((await file(id, ownerP.cookie, { body: "hi", data: deep })).res.status).toBe(400);
    expect(
      (await file(id, ownerP.cookie, { body: "hi", data: { s: "z".repeat(9000) } })).res.status,
    ).toBe(400);
  });
});

describe("page requests: availability, declaration and passes", () => {
  it("is disabled by default, off under opaque isolation, and works with shared data and rooms off", async () => {
    const { id, ownerP } = await setup();
    const off = await mine(id, ownerP.cookie, { ALLOW_PAGE_REQUESTS: "false" });
    expect(off.res.status).toBe(200);
    expect(off.json).toEqual({ available: false, reason: "disabled" });
    const filed = await file(id, ownerP.cookie, { body: "hi" }, { ALLOW_PAGE_REQUESTS: "false" });
    expect(filed.res.status).toBe(403);
    expect(filed.json.error.details.reason).toBe("disabled");
    // Default env: ALLOW_PAGE_REQUESTS is not set to true in the test wrangler vars.
    const def = await requestsApi(id, "", { cookie: ownerP.cookie, vars: {} });
    expect(def.status).toBe(200);

    const opaque = await mine(id, ownerP.cookie, { CONTENT_ISOLATION: "opaque" });
    expect(opaque.json).toEqual({ available: false, reason: "opaque_isolation" });

    const vars = { ALLOW_SHARED_DATA: "false", ALLOW_ROOMS: "false" };
    const { id: id2, ownerP: o2 } = await setupWith(vars);
    const ok = await file(id2, o2.cookie, { body: "hi" }, vars);
    expect(ok.res.status, JSON.stringify(ok.json)).toBe(201);
  });

  it("a requests-only declaration is stored, read back and available (no data, no room)", async () => {
    const stored = readStoredCapabilities(
      '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":["claude"]}',
    );
    expect(stored).toMatchObject({
      data: false,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      requests: true,
      requestsTo: ["claude"],
    });
    const { id, ownerP } = await setup();
    const v = await versionRow(id, 1);
    expect(v?.capabilities).toBe(
      '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":["claude"]}',
    );
    const r = await mine(id, ownerP.cookie);
    expect(r.json).toMatchObject({ available: true, can_file: true, to: "claude", requests: [] });
    // The data session and the room say not_declared; the gate has no data block.
    const session = await run(`${contentOrigin(id)}/__plinth/api/v1/session`, {
      headers: { "x-plinth-data": "1", cookie: ownerP.cookie },
    });
    expect(await json(session)).toEqual({ available: false, reason: "not_declared" });
    const room = await run(`${contentOrigin(id)}/__plinth/api/v1/room`, {
      headers: { "x-plinth-data": "1", cookie: ownerP.cookie },
    });
    expect((await json(room)).reason).toBe("not_declared");
    const gate = await gateFor(id, ownerP.headers);
    expect(gate.data).toBeUndefined();
    expect(gate.requests).toEqual({ can_file: true, email: ownerP.email });
  });

  it("answers JSON 401 without a pass, and not_identified for an anonymous link viewer", async () => {
    const { id } = await setup(REQUESTS_PAGE, "unlisted");
    const none = await requestsApi(id, "");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toMatch(/^application\/json/);
    const anon = await cookieFor(id);
    expect((await mine(id, anon)).json).toEqual({ available: false, reason: "not_identified" });
    const filed = await file(id, anon, { body: "hi" });
    expect(filed.res.status).toBe(403);
    expect(filed.json.error.details.reason).toBe("not_identified");
  });

  it("answers preview for an in-chat preview pass and not_identified for a capture pass", async () => {
    const { id } = await setup();
    const config = parseConfig({ ...env, ...ON } as unknown as Record<string, unknown>);
    const epoch = await epochOf(id);
    const name = contentCookieName(config, new URL(contentOrigin(id)));
    const preview = await signContentCookie(config, id, epoch, undefined, "preview", 1);
    const capture = await signContentCookie(config, id, epoch, undefined, "capture");
    expect((await mine(id, `${name}=${preview}`)).json).toEqual({
      available: false,
      reason: "preview",
    });
    expect((await mine(id, `${name}=${capture}`)).json).toEqual({
      available: false,
      reason: "not_identified",
    });
  });

  it("not_declared without `requests`, for data only, and for a doc; the current version governs", async () => {
    const { owner, id, ownerP } = await setup(DATA_ONLY);
    expect((await mine(id, ownerP.cookie)).json).toEqual({
      available: false,
      reason: "not_declared",
    });
    const doc = await publish(owner.auth, {
      type: "doc",
      html: undefined,
      content: '# Ask\n\n<meta name="plinth-capabilities" content="requests">',
      visibility: "allowlist",
    });
    const docCookie = await cookieFor(doc.body.id, ownerP.headers);
    expect((await mine(doc.body.id, docCookie)).json.reason).toBe("not_declared");
    // A new version that declares requests makes it available; the current version governs.
    await update(owner.auth, id, REQUESTS_PAGE);
    expect((await mine(id, ownerP.cookie)).json.available).toBe(true);
    await update(owner.auth, id, DATA_ONLY);
    expect((await mine(id, ownerP.cookie)).json.reason).toBe("not_declared");
  });
});

/** Publish the next version of an artifact (update_artifact over REST). */
async function update(auth: Record<string, string>, id: string, html: string) {
  const cur = await json(await run(`/api/v1/artifacts/${id}`, { headers: auth }));
  const res = await run(`/api/v1/artifacts/${id}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ html, base_version: cur.current_version }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

async function setupWith(vars: Record<string, string>) {
  const owner = await agent({ clientType: "claude" });
  const { body } = await publish(owner.auth, { html: REQUESTS_PAGE, visibility: "allowlist" });
  const s = await browserSession(owner.user.id);
  const { cookie } = await enterContent(body.id, { headers: s.headers, vars: { ...ON, ...vars } });
  if (!cookie) throw new Error("no cookie");
  return { id: body.id as string, ownerP: { cookie, email: owner.user.email } };
}

describe("page requests: who files, and where it goes", () => {
  it("owner, editor and commenter file; a viewer-role person may not but lists []", async () => {
    const { id, ownerP } = await setup();
    for (const p of [ownerP, await person(id, "editor"), await person(id, "commenter")]) {
      const r = await file(id, p.cookie, { body: `from ${p.email}` });
      expect(r.res.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json).toMatchObject({ state: "pending", to: "@claude", version: 1, answers: [] });
    }
    const viewer = await person(id, "viewer");
    const refused = await file(id, viewer.cookie, { body: "hi" });
    expect(refused.res.status).toBe(403);
    expect(refused.json.error.details.reason).toBe("cannot_file");
    expect((await mine(id, viewer.cookie)).json).toMatchObject({
      available: true,
      can_file: false,
      requests: [],
    });
    const gate = await gateFor(id, viewer.headers);
    expect(gate.requests).toEqual({ can_file: false, email: viewer.email });
  });

  it("resolves targets by the mention rules; no target and unknown handles are refused", async () => {
    const { owner, id, ownerP } = await setup(NO_TARGET_PAGE);
    const none = await file(id, ownerP.cookie, { body: "hi" });
    expect(none.res.status).toBe(400);
    expect(none.json.error.details.reason).toBe("no_target");
    const claude = await file(id, ownerP.cookie, { body: "hi @codex", to: "claude" });
    expect(claude.res.status).toBe(201);
    const t = await taskOf(claude.json.id);
    expect(t).toMatchObject({ target_client_type: "claude", target_connection: null });
    // "@codex" in the body creates no second task.
    const all = await env.DB.prepare(
      "SELECT count(*) AS n FROM mention_tasks WHERE comment_id = ?1",
    )
      .bind(claude.json.id)
      .first<{ n: number }>();
    expect(all?.n).toBe(1);
    // A handle of the owner's connection ("Build bot" -> build-bot).
    const handle = await file(id, ownerP.cookie, { body: "hi", to: "build-bot" });
    expect(handle.res.status).toBe(201);
    expect((await taskOf(handle.json.id))?.target_connection).toBe(owner.connectionId);
    // Another user's handle, and a revoked one: unknown_agent.
    const other = await agent({ label: "Stranger bot" });
    expect(other.user.id).not.toBe(owner.user.id);
    const stranger = await file(id, ownerP.cookie, { body: "hi", to: "stranger-bot" });
    expect(stranger.json.error.details.reason).toBe("unknown_agent");
    const revoked = await agentOf(owner.user.id, "Old bot");
    await env.DB.prepare("UPDATE agent_connections SET revoked_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), revoked.connectionId)
      .run();
    const r2 = await file(id, ownerP.cookie, { body: "hi", to: "old-bot" });
    expect(r2.json.error.details.reason).toBe("unknown_agent");
  });

  it("never reads a target name off Object.prototype", async () => {
    const { owner, id, ownerP } = await setup(NO_TARGET_PAGE);
    for (const to of ["constructor", "tostring", "hasownproperty", "valueof"]) {
      const r = await file(id, ownerP.cookie, { body: "hi", to });
      expect(r.res.status, to).toBe(400);
      expect(r.json.error.details.reason, to).toBe("unknown_agent");
    }
    // The owner's connection with that handle is reachable like any other.
    const conn = await agentOf(owner.user.id, "Constructor");
    const r = await file(id, ownerP.cookie, { body: "hi", to: "constructor" });
    expect(r.res.status).toBe(201);
    expect(await taskOf(r.json.id)).toMatchObject({
      target_connection: conn.connectionId,
      target_client_type: null,
    });
  });

  it("stamps the claim's email and the owner's id, never the body's claims", async () => {
    const { id, ownerP } = await setup();
    const r = await file(id, ownerP.cookie, { body: "hi", data: { q: 3 } });
    const row = await commentRow(r.json.id);
    expect(row).toMatchObject({
      kind: "page_request",
      author_email: ownerP.email,
      author_user_id: ownerP.userId,
      author_connection: null,
      parent_id: null,
      anchor: null,
      request_data: '{"q":3}',
    });
    expect(r.json.data).toEqual({ q: 3 });
  });
});

describe("page requests: limits and races", () => {
  it("caps open requests per requester and per artifact; done or withdrawn frees a slot", async () => {
    const vars = { PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT: "4" };
    const { id, ownerP } = await setup();
    const c1 = await person(id, "commenter");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await file(id, c1.cookie, { body: `r${i}` }, vars);
      expect(r.res.status).toBe(201);
      ids.push(r.json.id);
    }
    const fourth = await file(id, c1.cookie, { body: "r3" }, vars);
    expect(fourth.res.status).toBe(429);
    expect(fourth.json.error.details.reason).toBe("open_requester");
    expect(fourth.res.headers.get("retry-after")).toBe(String(PAGE_REQUEST_LIMITS.openRetryAfterS));
    // Withdrawing one (resolving it in the app) frees a slot.
    const w = await rest(`/comments/${ids[0]}`, c1.headers, "PATCH", { status: "resolved" });
    expect(w.res.status).toBe(200);
    expect((await taskOf(ids[0] as string))?.state).toBe("failed");
    expect((await file(id, c1.cookie, { body: "r4" }, vars)).res.status).toBe(201);
    // The artifact is now at 3 open; one more from the owner reaches 4, then open_artifact.
    expect((await file(id, ownerP.cookie, { body: "o1" }, vars)).res.status).toBe(201);
    const full = await file(id, ownerP.cookie, { body: "o2" }, vars);
    expect(full.res.status).toBe(429);
    expect(full.json.error.details.reason).toBe("open_artifact");
  });

  it("limits requests per requester and per artifact per hour", async () => {
    const { id } = await setup();
    const c1 = await person(id, "commenter");
    const vars = { PAGE_REQUESTS_PER_VIEWER_PER_HOUR: "2" };
    for (let i = 0; i < 2; i++) {
      const r = await file(id, c1.cookie, { body: `r${i}` }, vars);
      expect(r.res.status).toBe(201);
      await rest(`/comments/${r.json.id}`, c1.headers, "PATCH", { status: "resolved" });
    }
    const third = await file(id, c1.cookie, { body: "r2" }, vars);
    expect(third.res.status).toBe(429);
    expect(third.json.error.details.reason).toBe("per_viewer");
    expect(Number(third.res.headers.get("retry-after"))).toBeGreaterThan(0);

    const art = { PAGE_REQUESTS_PER_ARTIFACT_PER_HOUR: "3" };
    const { id: id2 } = await setup();
    const people = [
      await person(id2, "commenter"),
      await person(id2, "commenter"),
      await person(id2, "commenter"),
    ];
    for (const p of people)
      expect((await file(id2, p.cookie, { body: "x" }, art)).res.status).toBe(201);
    const over = await file(id2, people[0]?.cookie as string, { body: "y" }, art);
    expect(over.json.error.details.reason).toBe("per_artifact");
  });

  it("the guarded insert writes nothing at a moved epoch or on a taken-down artifact", async () => {
    const { owner, id, ownerP } = await setup();
    const config = parseConfig({ ...env, ...ON } as unknown as Record<string, unknown>);
    const claim = { email: ownerP.email, role: "owner" as const, viewerId: "u_x" };
    const access = { file: true, readOwn: true };
    const caps = readStoredCapabilities(
      '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":["claude"]}',
    );
    const epoch = await epochOf(id);
    const target = { id, ownerId: owner.user.id, currentVersion: 1, accessEpoch: epoch - 1, caps };
    const before = await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE artifact_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    await expect(
      fileRequest(env.DB, config, target, claim, access, { body: "x" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), id)
      .run();
    await expect(
      fileRequest(env.DB, config, { ...target, accessEpoch: epoch }, claim, access, { body: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const after = await env.DB.prepare("SELECT count(*) AS n FROM comments WHERE artifact_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const tasks = await env.DB.prepare(
      "SELECT count(*) AS n FROM mention_tasks WHERE artifact_id = ?1",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(tasks?.n).toBe(0);
    // And over HTTP: the taken-down artifact is 404.
    expect((await file(id, ownerP.cookie, { body: "x" })).res.status).toBe(404);
  });
});

describe("page requests: the page reads only its own, with no author of anything", () => {
  it("lists only the caller's own requests, newest first, and 404s everything else alike", async () => {
    const { id, ownerP } = await setup();
    const c1 = await person(id, "commenter");
    const c2 = await person(id, "commenter");
    const a = await file(id, c1.cookie, { body: "first" });
    const b = await file(id, c1.cookie, { body: "second" });
    const other = await file(id, c2.cookie, { body: "theirs" });
    const plain = await rest(`/artifacts/${id}/comments`, c1.headers, "POST", {
      body: "a comment",
    });
    const reply = await rest(`/artifacts/${id}/comments`, c1.headers, "POST", {
      body: "a reply",
      parent_id: a.json.id,
    });
    const list = await mine(id, c1.cookie);
    expect(list.json.requests.map((r: { id: string }) => r.id)).toEqual([b.json.id, a.json.id]);
    expect((await requestsApi(id, `/${a.json.id}`, { cookie: c1.cookie })).status).toBe(200);
    const bodies: string[] = [];
    for (const rid of [other.json.id, plain.json.id, reply.json.id, "abcdefghij0123456789"]) {
      const res = await requestsApi(id, `/${rid}`, { cookie: c1.cookie });
      expect(res.status, rid).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await mine(id, ownerP.cookie)).json.requests).toEqual([]);
    // A bad id shape never reaches a query: 404 from the route table.
    expect((await requestsApi(id, "/a%20b", { cookie: c1.cookie })).status).toBe(404);
  });

  it("answers are the owner's agents' only, oldest first, and nobody is named", async () => {
    const { owner, id, ownerP } = await setup(
      REQUESTS_PAGE.replace('content="requests"', 'content="data viewer requests"'),
    );
    await db().update(users).set({ name: "Olga Owner" }).where(eq(users.id, owner.user.id)).run();
    const requester = await person(id, "commenter");
    const filed = await file(id, requester.cookie, { body: "Please add Q3" });
    const rid = filed.json.id as string;
    // An editor confirmed by code replies in the app.
    const editorEmail = uniqueEmail("editor");
    await grant(id, editorEmail, "editor");
    const ed = appHeaders(await viewerCookie(editorEmail));
    expect(
      (
        await rest(`/artifacts/${id}/comments`, ed, "POST", {
          body: "EDITOR-HUMAN",
          parent_id: rid,
        })
      ).res.status,
    ).toBe(201);
    // The requester and the owner reply in the app.
    await rest(`/artifacts/${id}/comments`, requester.headers, "POST", {
      body: "REQUESTER-HUMAN",
      parent_id: rid,
    });
    await rest(`/artifacts/${id}/comments`, ownerP.headers, "POST", {
      body: "OWNER-HUMAN",
      parent_id: rid,
    });
    // An editor's own agent replies.
    const editorUser = await person(id, "editor");
    const edAgent = await agentOf(editorUser.userId, "Editor bot");
    expect(
      (await rest(`/comments/${rid}/reply`, edAgent.auth, "POST", { body: "EDITOR-AGENT" })).res
        .status,
    ).toBe(201);
    // The owner's agents reply: "Build bot", and one labelled like an address.
    await rest(`/comments/${rid}/reply`, owner.auth, "POST", { body: "ANSWER-ONE" });
    const second = await agentOf(owner.user.id, "bob@example.com");
    await rest(`/comments/${rid}/reply`, second.auth, "POST", { body: "ANSWER-TWO" });

    for (const decl of ["requests", "requests viewer", "data viewer requests"]) {
      await update(
        owner.auth,
        id,
        REQUESTS_PAGE.replace('content="requests"', `content="${decl}"`),
      );
      const cookie = await cookieFor(id, requester.headers);
      const list = await mine(id, cookie);
      const one = await requestsApi(id, `/${rid}`, { cookie });
      for (const text of [JSON.stringify(list.json), await one.text()]) {
        const [req] = JSON.parse(text).requests ?? [JSON.parse(text)];
        expect(req.answers, decl).toEqual([
          { body: "ANSWER-ONE", created_at: expect.any(String) },
          { body: "ANSWER-TWO", created_at: expect.any(String) },
        ]);
        for (const a of req.answers) expect(Object.keys(a).sort()).toEqual(["body", "created_at"]);
        for (const secret of [
          editorEmail,
          editorUser.email,
          requester.email,
          ownerP.email,
          "bob@example.com",
          "Olga Owner",
          "Build bot",
          "Editor bot",
          "EDITOR-HUMAN",
          "REQUESTER-HUMAN",
          "OWNER-HUMAN",
          "EDITOR-AGENT",
        ]) {
          expect(text, `${decl}: ${secret}`).not.toContain(secret);
        }
        const outside = text.replace("Please add Q3", "").replace(/ANSWER-(ONE|TWO)/g, "");
        for (const word of ["Owner", "Editor", "Agent", "You", "owner", "editor", "commenter"]) {
          expect(outside, `${decl}: ${word}`).not.toContain(word);
        }
      }
    }
  });

  it("files under the confirmed viewer email, which the app matches with both identities", async () => {
    const { id, slug, ownerP } = await setup();
    const x = await person(id, "viewer");
    const yEmail = uniqueEmail("alt");
    await grant(id, yEmail, "commenter");
    const yCookie = await viewerCookie(yEmail);
    const sessionCookie = x.headers.Cookie?.split("; ")[0] as string;
    const both = appHeaders(sessionCookie, yCookie);
    const cookie = await cookieFor(id, both);
    const filed = await file(id, cookie, { body: "as Y" });
    expect(filed.res.status, JSON.stringify(filed.json)).toBe(201);
    expect((await commentRow(filed.json.id))?.author_email).toBe(yEmail);
    // With both identities the app lists and withdraws it.
    const listed = await rest(`/artifacts/${slug}/comments`, both);
    expect(listed.json.items.map((c: { id: string }) => c.id)).toContain(filed.json.id);
    // With only X's session it is hidden and 404.
    const onlyX = appHeaders(sessionCookie);
    const hidden = await rest(`/artifacts/${slug}/comments`, onlyX);
    expect(hidden.json.items.map((c: { id: string }) => c.id)).not.toContain(filed.json.id);
    expect(
      (await rest(`/comments/${filed.json.id}`, onlyX, "PATCH", { status: "resolved" })).res.status,
    ).toBe(404);
    const w = await rest(`/comments/${filed.json.id}`, both, "PATCH", { status: "resolved" });
    expect(w.res.status).toBe(200);
    expect((await taskOf(filed.json.id))?.state).toBe("failed");
    // The owner sees it all along.
    const ownerList = await rest(`/artifacts/${slug}/comments`, ownerP.headers);
    expect(ownerList.json.items.map((c: { id: string }) => c.id)).toContain(filed.json.id);
  });

  it("the gate tells the viewer which email, only when active, declared and identified", async () => {
    const { id, ownerP } = await setup();
    const g = await gateFor(id, ownerP.headers);
    expect(g.requests).toEqual({ can_file: true, email: ownerP.email });
    expect((await gateFor(id, ownerP.headers, { ALLOW_PAGE_REQUESTS: "false" })).requests).toBe(
      undefined,
    );
    expect((await gateFor(id, ownerP.headers, { CONTENT_ISOLATION: "opaque" })).requests).toBe(
      undefined,
    );
    const { id: plain, ownerP: o2 } = await setup(DATA_ONLY);
    expect((await gateFor(plain, o2.headers)).requests).toBeUndefined();
    const { id: open } = await setup(REQUESTS_PAGE, "unlisted");
    const anon = await gateFor(open, {});
    expect(anon.status).toBe("ok");
    expect(anon.requests).toBeUndefined();
    expect(errOf).toBeTypeOf("function");
  });
});

// Tokens limited to one artifact (issue #51, docs/spec.md "Publishing from CI"), over REST and MCP:
// who may create one, what it may do on its artifact (view and publish versions, nothing else),
// that every other artifact is a 404 whatever the token's scopes, what metadata it sees, and that
// removing the person's grant, deleting the artifact or erasing the owner ends it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { eraseUserSql } from "../scripts/admin-lib.mjs";
import { resolveBearer } from "../src/auth/principal.ts";
import { agentConnections, mentionTasks } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import acme from "./fixtures/design-systems/acme.json";
import {
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  fetchWith,
  json,
  mcpClient,
  publish,
  serviceCtxFor,
  tool,
} from "./helpers.ts";
import { api, errOf, peoplePage, setName } from "./people-helpers.ts";
import { cookieFor, grant, upgrade } from "./room-helpers.ts";

const DATA_PAGE = `<!doctype html><title>Report</title>
<meta name="plinth-capabilities" content="data">
<p>A report with shared data</p>`;

async function signedIn(userId: string) {
  const s = await browserSession(userId);
  return { ...s.headers, "Content-Type": "application/json" };
}

/** An owner (session and account-wide token) with a bound artifact and a second one. */
async function setup(opts: { visibility?: string } = {}) {
  const owner = await agent();
  const h = await signedIn(owner.user.id);
  const visibility = opts.visibility ?? "allowlist";
  const bound = await publish(owner.auth, {
    title: "Coverage report",
    html: DATA_PAGE,
    visibility,
    category: "Reports",
  });
  expect(bound.res.status).toBe(201);
  const other = await publish(owner.auth, { title: "Other page", visibility });
  expect(other.res.status).toBe(201);
  // The page has shared data, so data_usage would be set for an owner's account-wide token.
  const w = await call(`/api/v1/artifacts/${bound.body.id}/data`, {
    method: "POST",
    headers: { ...owner.auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      ops: [{ op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 }],
    }),
  });
  expect(w.status).toBe(200);
  return {
    owner,
    h,
    id: bound.body.id as string,
    slug: bound.body.slug as string,
    other: other.body,
  };
}

async function createBound(
  h: Record<string, string>,
  artifact: string,
  extra: Record<string, unknown> = {},
) {
  const res = await call("/api/v1/connections", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ label: "CI: report", artifact, ...extra }),
  });
  return { res, body: await json(res) };
}

async function boundToken(h: Record<string, string>, artifact: string, scopes?: string[]) {
  const { res, body } = await createBound(h, artifact, scopes ? { scopes } : {});
  expect(res.status, JSON.stringify(body)).toBe(201);
  return {
    token: body.token as string,
    connectionId: body.connection.id as string,
    auth: { Authorization: `Bearer ${body.token}` },
  };
}

const jsonHeaders = (auth: Record<string, string>) => ({
  ...auth,
  "Content-Type": "application/json",
});

async function req(
  method: string,
  path: string,
  auth: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await call(`/api/v1${path}`, {
    method,
    headers: jsonHeaders(auth),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("creating a token limited to one artifact", () => {
  it("the owner gets one with artifacts:read and artifacts:write by default", async () => {
    const { h, id, slug } = await setup();
    const { res, body } = await createBound(h, slug);
    expect(res.status).toBe(201);
    expect(body.connection).toMatchObject({
      kind: "token",
      client_type: "other",
      scopes: ["artifacts:read", "artifacts:write"],
      artifact: { id, slug, title: "Coverage report" },
    });
    const row = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, body.connection.id))
      .get();
    expect(row?.artifactId).toBe(id);
  });

  it("an editor may make one; a commenter gets 403, a stranger 404", async () => {
    const { h, id } = await setup();
    const editor = await createUser();
    const commenter = await createUser();
    const share = await req("PUT", `/artifacts/${id}/sharing`, h, {
      grants: [
        { email: editor.email, role: "editor" },
        { email: commenter.email, role: "commenter" },
      ],
    });
    expect(share.status).toBe(200);
    expect((await createBound(await signedIn(editor.id), id)).res.status).toBe(201);
    expect((await createBound(await signedIn(commenter.id), id)).res.status).toBe(403);
    const stranger = await createUser();
    const s = await createBound(await signedIn(stranger.id), id);
    expect(s.res.status).toBe(404);
    const missing = await createBound(await signedIn(stranger.id), "no-such-slug");
    expect(missing.res.status).toBe(404);
    expect(missing.body).toEqual(s.body);
  });

  it("refuses mentions, and a list without artifacts:read", async () => {
    const { h, id } = await setup();
    for (const scopes of [
      ["artifacts:read", "mentions"],
      ["artifacts:write"],
      ["artifacts:read", "artifacts:write", "mentions"],
    ]) {
      const { res, body } = await createBound(h, id, { scopes });
      expect(res.status, scopes.join(" ")).toBe(400);
      expect(body.error).toMatchObject({ code: "invalid_input", details: { field: "scopes" } });
    }
    const readOnly = await createBound(h, id, { scopes: ["artifacts:read"] });
    expect(readOnly.res.status).toBe(201);
    expect(readOnly.body.connection.scopes).toEqual(["artifacts:read"]);
  });

  it("an agent cannot create one (people only, as every token)", async () => {
    const { owner, id } = await setup();
    const r = await req("POST", "/connections", owner.auth, { label: "x", artifact: id });
    expect(r.status).toBe(403);
  });
});

describe("using a token limited to one artifact", () => {
  it("reads its artifact without the category or data usage; every other artifact is a 404", async () => {
    const { owner, h, id, other } = await setup();
    const t = await boundToken(h, id);
    const got = await req("GET", `/artifacts/${id}`, t.auth);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, role: "owner", category: null, data_usage: null });
    // The owner's account-wide token still sees both (no regression from the policy gate).
    const wide = await req("GET", `/artifacts/${id}`, owner.auth);
    expect(wide.body.category).toBe("Reports");
    expect(wide.body.data_usage).toEqual({ docs: 1, bytes: expect.any(Number) });

    const otherRead = await req("GET", `/artifacts/${other.id}`, t.auth);
    const missing = await req("GET", "/artifacts/no-such-slug", t.auth);
    expect(otherRead.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(otherRead.body).toEqual(missing.body);
    expect((await req("GET", `/artifacts/${other.id}/versions`, t.auth)).status).toBe(404);
  });

  it("sees the owner and the version authors as a link viewer does: no email or ids", async () => {
    const { owner, h, id } = await setup();
    const editor = await createUser();
    const share = await req("PUT", `/artifacts/${id}/sharing`, h, {
      grants: [{ email: editor.email, role: "editor" }],
    });
    expect(share.status).toBe(200);
    // A version published from the app by the editor, so the list names a person, not a token.
    const fromApp = await req("PUT", `/artifacts/${id}`, await signedIn(editor.id), {
      html: DATA_PAGE.replace("A report", "Edited in the app"),
      base_version: 1,
    });
    expect(fromApp.status, JSON.stringify(fromApp.body)).toBe(200);
    for (const person of [h, await signedIn(editor.id)]) {
      const t = await boundToken(person, id);
      const got = await req("GET", `/artifacts/${id}`, t.auth);
      expect(got.status).toBe(200);
      expect(got.body.owner).toEqual({ id: null, email: null, name: owner.user.name ?? null });
      const list = await req("GET", "/artifacts", t.auth);
      expect(list.body.items[0].owner).toEqual(got.body.owner);
      const versions = await req("GET", `/artifacts/${id}/versions`, t.auth);
      expect(versions.status).toBe(200);
      const byNumber = (n: number) =>
        versions.body.items.find((v: { number: number }) => v.number === n);
      expect(byNumber(2).author).toEqual({
        kind: "user",
        label: editor.email.split("@")[0],
        user_id: null,
        connection_id: null,
        // An editor wrote it: no owner's mark (from ids, never from the label).
        is_owner: false,
      });
      expect(byNumber(1).author).toMatchObject({
        kind: "connection",
        label: "Test token",
        user_id: null,
        connection_id: null,
      });
      const put = await req("PUT", `/artifacts/${id}`, t.auth, {
        html: DATA_PAGE.replace("A report", `Build ${t.connectionId}`),
        base_version: got.body.version,
      });
      expect(put.status).toBe(200);
      for (const body of [got.body, list.body, versions.body, put.body]) {
        expect(JSON.stringify(body)).not.toContain(owner.user.email);
        expect(JSON.stringify(body)).not.toContain(editor.email);
      }
    }
    // Account-wide tokens and sessions still see who the people are.
    const wide = await req("GET", `/artifacts/${id}`, owner.auth);
    expect(wide.body.owner).toMatchObject({ id: owner.user.id, email: owner.user.email });
    const wideVersions = await req("GET", `/artifacts/${id}/versions`, owner.auth);
    const v2 = wideVersions.body.items.find((v: { number: number }) => v.number === 2);
    expect(v2.author).toMatchObject({
      label: editor.email,
      user_id: editor.id,
    });
  });

  it("a read-only bound token gets 404, never 403, for a write on another artifact", async () => {
    const { h, id, other } = await setup();
    const t = await boundToken(h, id, ["artifacts:read"]);
    const put = await req("PUT", `/artifacts/${other.id}`, t.auth, { html: "<p>x</p>" });
    expect(put.status).toBe(404);
    expect((await req("DELETE", `/artifacts/${other.id}`, t.auth)).status).toBe(404);
    expect(
      (await req("PUT", `/artifacts/${other.id}/visibility`, t.auth, { visibility: "unlisted" }))
        .status,
    ).toBe(404);
    // On its own artifact the scope applies.
    const own = await req("PUT", `/artifacts/${id}`, t.auth, { html: "<p>x</p>" });
    expect(own.status).toBe(403);
    expect(own.body.error.details?.reason).toBeUndefined();
  });

  it("publishes new versions of its artifact, under the token's label", async () => {
    const { h, id, other } = await setup();
    const t = await boundToken(h, id);
    const put = await req("PUT", `/artifacts/${id}`, t.auth, {
      html: DATA_PAGE.replace("A report", "The next report"),
      base_version: 1,
      note: "Build 2 (abc1234)",
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ id, version: 2 });
    expect(put.body.category).toBeUndefined();
    const versions = await req("GET", `/artifacts/${id}/versions`, t.auth);
    expect(versions.body.items[0]).toMatchObject({
      number: 2,
      note: "Build 2 (abc1234)",
      author: { kind: "connection", label: "CI: report" },
    });
    expect((await req("PUT", `/artifacts/${other.id}`, t.auth, { html: "<p>x</p>" })).status).toBe(
      404,
    );
  });

  it("refuses everything else on its artifact with token_bound", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    const bound = (r: { status: number; body: any }, what: string) => {
      expect(r.status, what).toBe(403);
      expect(r.body.error.details?.reason, what).toBe("token_bound");
    };
    bound(await req("POST", "/artifacts", t.auth, { title: "New", html: "<p>x</p>" }), "create");
    bound(await req("POST", "/uploads", t.auth, { type: "html" }), "upload without id");
    bound(await req("PATCH", `/artifacts/${id}`, t.auth, { category: "Elsewhere" }), "category");
    bound(await req("PATCH", `/artifacts/${id}`, t.auth, { title: "Renamed" }), "title");
    bound(
      await req("PUT", `/artifacts/${id}/visibility`, t.auth, { visibility: "unlisted" }),
      "visibility",
    );
    bound(await req("PUT", `/artifacts/${id}/sharing`, t.auth, { grants: [] }), "sharing");
    bound(await req("POST", `/artifacts/${id}/versions/1/restore`, t.auth, {}), "restore");
    // Nor a version with an old version's files under a new source: a restore by another name.
    bound(
      await req("PUT", `/artifacts/${id}`, t.auth, {
        html: DATA_PAGE.replace("A report", "The next report"),
        base_version: 1,
        files_from_version: 1,
      }),
      "files_from_version",
    );
    bound(await req("DELETE", `/artifacts/${id}`, t.auth), "delete");
    bound(await req("POST", `/artifacts/${id}/comments`, t.auth, { body: "hi" }), "comment");
    // A page anchor (comments from the page) is a comment like any other.
    bound(
      await req("POST", `/artifacts/${id}/comments`, t.auth, {
        body: "hi",
        anchor: { kind: "page", key: "slide-1", x: 10, y: 20 },
      }),
      "page-anchored comment",
    );
    // Reading the threads too: they carry every commenter's email and the mention tasks.
    const posted = await req("POST", `/artifacts/${id}/comments`, h, { body: "A note" });
    expect(posted.status).toBe(201);
    const threads = await req("GET", `/artifacts/${id}/comments`, t.auth);
    bound(threads, "comments read");
    expect(JSON.stringify(threads.body)).not.toContain("A note");
    bound(await req("GET", `/artifacts/${id}/data`, t.auth), "data read");
    bound(
      await req("POST", `/artifacts/${id}/data`, t.auth, {
        ops: [{ op: "set", collection: "votes", doc_id: "b", data: { n: 2 }, if_rev: 0 }],
      }),
      "data write",
    );
    bound(await req("GET", `/artifacts/${id}/stats`, t.auth), "stats");
    // The summary across the person's artifacts would list the ones the binding hides.
    const summary = await req("GET", "/stats/artifacts", t.auth);
    bound(summary, "stats summary");
    expect(JSON.stringify(summary.body)).not.toContain("Other page");
    // An update that carries a category is refused before anything is written.
    const withCategory = await req("PUT", `/artifacts/${id}`, t.auth, {
      html: "<p>x</p>",
      category: "Reports",
    });
    expect(withCategory.status).toBe(403);
    expect(withCategory.body.error.details).toMatchObject({
      field: "category",
      reason: "token_bound",
    });
    // Still version 1: nothing above published.
    expect((await req("GET", `/artifacts/${id}`, t.auth)).body.version).toBe(1);
    // The message never names the artifact.
    const create = await req("POST", "/artifacts", t.auth, { title: "New", html: "<p>x</p>" });
    expect(JSON.stringify(create.body)).not.toContain(id);
  });

  it("lists only its artifact, with no categories, and probes nothing through filters", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    const list = await req("GET", "/artifacts", t.auth);
    expect(list.status).toBe(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(list.body.items[0].category).toBeNull();
    expect(list.body.categories).toEqual([]);
    expect((await req("GET", "/artifacts?limit=0", t.auth)).body).toMatchObject({
      items: [],
      categories: [],
    });
    expect((await req("GET", "/artifacts?category=Reports", t.auth)).body.items).toEqual([]);
    expect((await req("GET", "/artifacts?query=coverage", t.auth)).body.items).toHaveLength(1);
    expect((await req("GET", "/artifacts?query=other", t.auth)).body.items).toEqual([]);
    const cats = await req("GET", "/categories", t.auth);
    expect(cats.status).toBe(200);
    expect(cats.body.items).toEqual([]);
  });

  it("over MCP: the same rules", async () => {
    const { h, id, other } = await setup();
    const t = await boundToken(h, id);
    const c = await mcpClient(t.token);
    const got = await tool(c, "get_artifact", { id });
    expect(got.isError).toBe(false);
    expect(got.data).toMatchObject({ id, category: null, data_usage: null });
    expect((await tool(c, "get_artifact", { id: other.id })).data.error.code).toBe("not_found");
    const pub = await tool(c, "publish_artifact", { title: "New", html: "<p>x</p>" });
    expect(pub.isError).toBe(true);
    expect(pub.data.error.details.reason).toBe("token_bound");
    const up = await tool(c, "start_upload", { type: "html" });
    expect(up.data.error.details.reason).toBe("token_bound");
    for (const [name, args] of [
      ["set_visibility", { id, visibility: "unlisted" }],
      ["restore_version", { id, version: 1 }],
      ["list_artifact_data", { id }],
      ["list_comments", { id }],
      ["get_artifact_stats", { id }],
      ["get_artifact_stats", {}],
      [
        "write_artifact_data",
        { id, ops: [{ op: "delete", collection: "votes", doc_id: "a", if_rev: 1 }] },
      ],
    ] as const) {
      const r = await tool(c, name, args);
      expect(r.isError, `${name} ${r.text}`).toBe(true);
      expect(r.data.error?.details?.reason, `${name} ${r.text}`).toBe("token_bound");
    }
    const list = await tool(c, "list_artifacts", {});
    expect(list.data).toMatchObject({ items: [{ id }], categories: [] });
    expect(await tool(c, "list_artifacts", { limit: 0 })).toMatchObject({
      data: { items: [], categories: [] },
    });
    const mentions = await tool(c, "list_mentions", {});
    expect(mentions.isError).toBe(true);
    expect(mentions.data.error.code).toBe("forbidden");
    const updated = await tool(c, "update_artifact", { id, html: DATA_PAGE, base_version: 1 });
    expect(updated.isError).toBe(false);
    expect(updated.data.version).toBe(2);
    expect((await tool(c, "list_versions", { id })).isError).toBe(false);
    const preview = await tool(c, "preview_artifact", { id });
    expect(preview.isError).toBe(false);
    expect((await tool(c, "preview_artifact", { id: other.id })).data.error.code).toBe("not_found");
    await c.close();
  });

  it("publishes a bundle through an upload ticket for its artifact", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    const ticket = await req("POST", "/uploads", t.auth, { id, base_version: 1 });
    expect(ticket.status).toBe(201);
    const bundle = new Request(ticket.body.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket.body.upload_token}` },
      body: tar([{ name: "index.html", data: DATA_PAGE.replace("report", "bundled report") }]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(bundle, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await json(res)).version).toBe(2);
  });

  it("a ticket rebuilds the binding from the live connection row", async () => {
    const { owner, h, id } = await setup();
    const t = await boundToken(h, id);
    const p = await resolveBearer(db(), config(), t.token, () => undefined);
    expect(p).toMatchObject({ kind: "agent", boundArtifactId: id });
    const wide = await resolveBearer(db(), config(), owner.token, () => undefined);
    expect(wide).toMatchObject({ kind: "agent", boundArtifactId: null });
    // A revoked bound token's ticket fails at the bundle, as every revoked connection's does.
    const ticket = await req("POST", "/uploads", t.auth, { id, base_version: 1 });
    expect(ticket.status).toBe(201);
    await req("DELETE", `/connections/${t.connectionId}`, h);
    const bundle = new Request(ticket.body.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket.body.upload_token}` },
      body: tar([{ name: "index.html", data: DATA_PAGE }]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(bundle, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("is never the target of an @<label> mention, even when it is the oldest with that label", async () => {
    const { owner, h, id, other } = await setup();
    const t = await boundToken(h, id);
    const wide = await createToken(owner.user.id, { label: "CI: report" });
    const posted = await req("POST", `/artifacts/${other.id}/comments`, h, {
      body: "@ci-report fix the chart",
    });
    expect(posted.status).toBe(201);
    const tasks = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.commentId, posted.body.id))
      .all();
    expect(tasks.map((x) => x.targetConnection)).toEqual([wide.connectionId]);
    // Alone with that label, a bound token makes no task at all (it could never claim it).
    await db()
      .update(agentConnections)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(agentConnections.id, wide.connectionId))
      .run();
    const again = await req("POST", `/artifacts/${id}/comments`, h, { body: "@ci-report hi" });
    expect(again.status).toBe(201);
    expect(again.body.mentions).toEqual([]);
    expect(t.connectionId).not.toBe(wide.connectionId);
  });

  it("GET /me names the connection and its artifact", async () => {
    const { owner, h, id, slug } = await setup();
    const t = await boundToken(h, id);
    const me = await req("GET", "/me", t.auth);
    // Only the connection and the person's id: no email, name, counts or admin flag.
    expect(me.body).toEqual({
      id: owner.user.id,
      connection: {
        id: t.connectionId,
        label: "CI: report",
        bound: true,
        artifact: { id, slug, title: "Coverage report" },
      },
    });
    expect(JSON.stringify(me.body)).not.toContain(owner.user.email);
    const wide = await req("GET", "/me", owner.auth);
    expect(wide.body).toMatchObject({ email: owner.user.email, is_admin: false });
    expect(wide.body.connection).toMatchObject({
      label: "Test token",
      bound: false,
      artifact: null,
    });
    expect((await req("GET", "/me", h)).body.connection).toBeNull();
  });

  it("a type filter applies to its one artifact too", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    expect((await req("GET", "/artifacts?type=html", t.auth)).body.items).toHaveLength(1);
    expect((await req("GET", "/artifacts?type=doc", t.auth)).body).toEqual({
      items: [],
      categories: [],
    });
    const c = await mcpClient(t.token);
    expect((await tool(c, "list_artifacts", { type: "doc" })).data.items).toEqual([]);
    expect((await tool(c, "list_artifacts", { type: "html" })).data.items).toHaveLength(1);
    await c.close();
  });
});

describe("a token limited to one artifact never sees the page run with its data", () => {
  /** A shared-data read the way the runtime makes one, with whatever content cookie it has. */
  const readData = (id: string, cookie: string | null) =>
    call(`${contentOrigin(id)}/__plinth/api/v1/data/votes`, {
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        ...(cookie ? { cookie } : {}),
      },
    });

  it("the viewer gate refuses it, so no pass reads the shared data", async () => {
    const { owner, id, other } = await setup();
    const t = await boundToken(await signedIn(owner.user.id), id);
    const gate = await req("GET", `/view/${id}`, t.auth);
    expect(gate.status).toBe(403);
    expect(gate.body.error.details.reason).toBe("token_bound");
    expect(gate.body.enter_url).toBeUndefined();
    // Every other artifact is the 404 it always is.
    expect((await req("GET", `/view/${other.id}`, t.auth)).body).toEqual({ status: "not_found" });
    // The reviewer's path: redeem the gate's URL, then read /__plinth/api/ as a page script would.
    const entered = await enterContent(id, { headers: t.auth });
    expect(entered.cookie).toBeNull();
    const read = await readData(id, entered.cookie);
    expect(read.status).not.toBe(200);
    expect(await read.text()).not.toContain('"votes"');
    // The owner's account-wide token and the owner in a browser still open it, and read the data.
    expect((await req("GET", `/view/${id}`, owner.auth)).body.status).toBe("ok");
    const mine = await enterContent(id, { headers: (await browserSession(owner.user.id)).headers });
    expect(mine.cookie).toBeTruthy();
    expect((await readData(id, mine.cookie)).status).toBe(200);
  });

  it("the gate refuses it on an unlisted artifact too, and after a correct password", async () => {
    const pub = await setup({ visibility: "unlisted" });
    const t = await boundToken(pub.h, pub.id);
    const gate = await req("GET", `/view/${pub.id}`, t.auth);
    expect(gate.status).toBe(403);
    expect(gate.body.error.details.reason).toBe("token_bound");

    const owner = await agent();
    const h = await signedIn(owner.user.id);
    const locked = await publish(owner.auth, {
      title: "Locked",
      html: DATA_PAGE,
      visibility: "password",
      password: "correct horse battery",
    });
    expect(locked.res.status).toBe(201);
    const lt = await boundToken(h, locked.body.id);
    // The owner's token needs no password, and gets no pass either way.
    expect((await req("GET", `/view/${locked.body.id}`, lt.auth)).body.error.details.reason).toBe(
      "token_bound",
    );
    const pw = await req("POST", `/view/${locked.body.id}/password`, lt.auth, {
      password: "correct horse battery",
    });
    expect(pw.status).toBe(403);
    expect(pw.body.error.details.reason).toBe("token_bound");
  });

  it("gets no thumbnail, and its summaries carry no thumbnail_url", async () => {
    const { owner, h, id } = await setup();
    const t = await boundToken(h, id);
    const shot = await req("GET", `/artifacts/${id}/thumbnail`, t.auth);
    expect(shot.status).toBe(403);
    expect(shot.body.error.details.reason).toBe("token_bound");
    // The owner's own answer is the usual "No thumbnail yet" (this instance takes none).
    expect((await req("GET", `/artifacts/${id}/thumbnail`, owner.auth)).status).toBe(404);
    // With thumbnails on, the owner's summary links one and the bound token's does not.
    const on = { BROWSER: {} as Fetcher };
    const mine = await json(
      await fetchWith(on, `/api/v1/artifacts/${id}`, { headers: owner.auth }),
    );
    expect(mine.thumbnail_url).toEqual(expect.stringContaining(`/artifacts/${id}/thumbnail`));
    const its = await json(await fetchWith(on, `/api/v1/artifacts/${id}`, { headers: t.auth }));
    expect(its.id).toBe(id);
    expect(its.thumbnail_url).toBeNull();
    const list = await json(await fetchWith(on, "/api/v1/artifacts", { headers: t.auth }));
    expect(list.items[0].thumbnail_url).toBeNull();
  });

  it("its in-chat preview is a pass that reads no shared data and joins no room", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    const c = await mcpClient(t.token);
    const room = `<!doctype html><title>Board</title>
<meta name="plinth-capabilities" content="data viewer room"><p>board</p>`;
    const up = await tool(c, "update_artifact", { id, html: room, base_version: 1 });
    expect(up.isError, up.text).toBe(false);
    const link = await tool(c, "preview_artifact", { id });
    expect(link.isError, link.text).toBe(false);
    await c.close();
    const enter = await call(link.data.preview_url, { headers: { "sec-fetch-dest": "iframe" } });
    const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("=");
    const read = await readData(id, cookie);
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(await read.text()).toContain("preview");
    const ws = await upgrade(id, cookie);
    expect(ws.status).toBe(403);
    expect(ws.webSocket).toBeFalsy();
    expect(await ws.text()).toContain("preview");
  });
});

describe("a token limited to one artifact never learns who has access", () => {
  /** A page that lists its people, the owner named, an editor with a grant, and a bound token. */
  async function peopleSetup() {
    const owner = await agent();
    expect((await setName(owner.user.id, "Olive Owner")).status).toBe(200);
    const h = await signedIn(owner.user.id);
    const page = await publish(owner.auth, { title: "Team", html: peoplePage() });
    expect(page.res.status).toBe(201);
    const id = page.body.id as string;
    const other = await publish(owner.auth, { title: "Other team", html: peoplePage() });
    expect(other.res.status).toBe(201);
    const editor = await createUser();
    await grant(id, editor.email, "editor");
    await grant(other.body.id, editor.email, "editor");
    // A named entry, so documents carry the owner's name to anyone who may read them.
    const w = await req("POST", `/artifacts/${id}/data`, owner.auth, {
      ops: [{ op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 }],
    });
    expect(w.status).toBe(200);
    return { owner, h, id, otherId: other.body.id as string, editor, t: await boundToken(h, id) };
  }

  /** Nothing in a refusal names a person on the artifact. */
  function namesNobody(body: unknown, s: Awaited<ReturnType<typeof peopleSetup>>, what: string) {
    const text = JSON.stringify(body);
    for (const leak of [s.owner.user.email, s.editor.email, "Olive Owner"]) {
      expect(text, `${what}: ${leak}`).not.toContain(leak);
    }
  }

  it("GET /people is token_bound on its artifact and a 404 elsewhere; the owner's own token reads it", async () => {
    const s = await peopleSetup();
    const mine = await req("GET", `/artifacts/${s.id}/people`, s.owner.auth);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).toContain(s.editor.email);
    const its = await req("GET", `/artifacts/${s.id}/people`, s.t.auth);
    expect(its.status).toBe(403);
    expect(its.body.error.details.reason).toBe("token_bound");
    namesNobody(its.body, s, "people");
    const searched = await req("GET", `/artifacts/${s.id}/people?q=olive`, s.t.auth);
    expect(searched.status).toBe(403);
    namesNobody(searched.body, s, "people search");
    const elsewhere = await req("GET", `/artifacts/${s.otherId}/people`, s.t.auth);
    expect(elsewhere.status).toBe(404);
    namesNobody(elsewhere.body, s, "other people");
  });

  it("list_artifact_data (summary, collection, document) and the viewer gate refuse it", async () => {
    const s = await peopleSetup();
    const c = await mcpClient(s.t.token);
    for (const args of [
      { id: s.id },
      { id: s.id, collection: "votes" },
      { id: s.id, collection: "votes", doc_id: "a" },
    ]) {
      const r = await tool(c, "list_artifact_data", args);
      expect(r.isError, r.text).toBe(true);
      expect(r.data.error.details.reason, r.text).toBe("token_bound");
      namesNobody(r.data, s, `list_artifact_data ${JSON.stringify(args)}`);
    }
    const elsewhere = await tool(c, "list_artifact_data", { id: s.otherId });
    expect(elsewhere.data.error.code).toBe("not_found");
    await c.close();
    // REST: the same refusals, and the gate (which would carry `people`) gives no pass.
    for (const path of [`/artifacts/${s.id}/data`, `/artifacts/${s.id}/data/votes/a`]) {
      const r = await req("GET", path, s.t.auth);
      expect(r.status, path).toBe(403);
      expect(r.body.error.details.reason, path).toBe("token_bound");
      namesNobody(r.body, s, path);
    }
    const gate = await req("GET", `/view/${s.id}`, s.t.auth);
    expect(gate.status).toBe(403);
    expect(gate.body.error.details.reason).toBe("token_bound");
    expect(gate.body.people).toBeUndefined();
    namesNobody(gate.body, s, "gate");
    // The owner's own gate in a browser does carry the block, so the refusal is the binding's.
    const own = await req("GET", `/view/${s.id}`, s.h);
    expect(own.body.status).toBe("ok");
    expect(own.body.people).toMatchObject({ list: true });
  });

  it("its in-chat preview lists nobody and names nobody in a room", async () => {
    const s = await peopleSetup();
    const c = await mcpClient(s.t.token);
    const up = await tool(c, "update_artifact", {
      id: s.id,
      html: peoplePage({ room: true }),
      base_version: 1,
    });
    expect(up.isError, up.text).toBe(false);
    const link = await tool(c, "preview_artifact", { id: s.id });
    expect(link.isError, link.text).toBe(false);
    await c.close();
    const enter = await call(link.data.preview_url, { headers: { "sec-fetch-dest": "iframe" } });
    const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("=");
    for (const path of ["/people", "/people/u_0123456789abcdef01234567", "/data/votes"]) {
      const res = await api(s.id, path, { cookie });
      expect(res.status, path).toBe(403);
      const e = await errOf(res);
      expect(e.details?.reason, path).toBe("preview");
      namesNobody(e, s, path);
    }
    const ws = await upgrade(s.id, cookie);
    expect(ws.status).toBe(403);
    expect(ws.webSocket).toBeFalsy();
  });
});

describe("a version a token limited to one artifact wrote never lists the people", () => {
  /** What the owner gets from each way to read the list while the current version is shown. */
  async function ownerReads(id: string, h: Record<string, string>, token: string) {
    const cookie = await cookieFor(id, h);
    const session = await json(await api(id, "/session", { cookie }));
    const page = await api(id, "/people", { cookie });
    const one = await api(id, "/people/u_0123456789abcdef01234567", { cookie });
    const rest = await req("GET", `/artifacts/${id}/people`, { Authorization: `Bearer ${token}` });
    const c = await mcpClient(token);
    const summary = await tool(c, "list_artifact_data", { id });
    await c.close();
    const gate = await req("GET", `/view/${id}`, h);
    return { session, page, one, rest, summary, gate };
  }

  /** Every way in refuses the list and names nobody. */
  async function expectNoList(after: Awaited<ReturnType<typeof ownerReads>>, email: string) {
    expect(after.session.can_list_people).toBe(false);
    for (const [what, res] of [
      ["page", after.page],
      ["one", after.one],
    ] as const) {
      expect(res.status, what).toBe(403);
      const text = await res.text();
      expect(text, what).not.toContain(email);
      expect(JSON.parse(text).error, what).toMatchObject({
        code: "forbidden",
        message: expect.stringMatching(/token limited to one artifact/),
      });
    }
    expect(after.rest.status).toBe(403);
    expect(after.rest.body.error.code).toBe("forbidden");
    expect(after.rest.body.error.message).toMatch(/token limited to one artifact/);
    expect(JSON.stringify(after.rest.body)).not.toContain(email);
    expect(after.summary.isError, after.summary.text).toBe(false);
    expect(after.summary.data.people).toBeUndefined();
    expect(after.summary.text).not.toContain(email);
    expect(after.gate.body.status).toBe("ok");
    expect(after.gate.body.people?.list).toBeUndefined();
  }

  it("the owner opening it gets no list from the runtime, REST, MCP or the gate, even after a person's newer version", async () => {
    const owner = await agent();
    const h = await signedIn(owner.user.id);
    const page = await publish(owner.auth, { title: "Team", html: peoplePage() });
    expect(page.res.status).toBe(201);
    const id = page.body.id as string;
    const editor = await createUser();
    await grant(id, editor.email, "editor");

    // v1, written by the owner's account-wide token: every way in lists the people.
    const before = await ownerReads(id, h, owner.token);
    expect(before.session.can_list_people).toBe(true);
    expect(before.page.status).toBe(200);
    expect(JSON.stringify(await json(before.page))).toContain(editor.email);
    expect(before.rest.status).toBe(200);
    expect(before.summary.isError, before.summary.text).toBe(false);
    expect(JSON.stringify(before.summary.data.people)).toContain(editor.email);
    expect(before.gate.body.people).toMatchObject({ list: true });

    // v2, the same page published by a leaked CI token: nothing lists the people.
    const t = await boundToken(h, id);
    const c = await mcpClient(t.token);
    const up = await tool(c, "update_artifact", {
      id,
      html: peoplePage().replace("<p>team</p>", "<p>team v2</p>"),
      base_version: 1,
    });
    expect(up.isError, up.text).toBe(false);
    await c.close();
    await expectNoList(await ownerReads(id, h, owner.token), editor.email);

    // v3, the owner publishes again. v2 is still served at /__plinth/v/2/ on the same origin and
    // pass, and nothing on a request says which version's code made it, so the list stays off.
    const again = await req("PUT", `/artifacts/${id}`, owner.auth, {
      html: peoplePage(),
      base_version: 2,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const later = await ownerReads(id, h, owner.token);
    await expectNoList(later, editor.email);

    // The owner opens v2 from History: the gate sends them to /__plinth/v/2/, which serves the
    // token's page, and that page's own call to the people route is refused.
    const gate = await req("GET", `/view/${id}?version=2`, h);
    expect(gate.body.status).toBe("ok");
    expect(gate.body.people?.list).toBeUndefined();
    const cookie = await cookieFor(id, h);
    const old = await call(`${contentOrigin(id)}/__plinth/v/2/`, { headers: { Cookie: cookie } });
    expect(old.status).toBe(200);
    expect(await old.text()).toContain("team v2");
    const fromOld = await api(id, "/people", { cookie });
    expect(fromOld.status).toBe(403);
    expect(await fromOld.text()).not.toContain(editor.email);

    // Restoring the token's v2 as v4 does not turn it back on either.
    const restored = await req("POST", `/artifacts/${id}/versions/2/restore`, owner.auth, {});
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    expect(restored.body.version).toBe(4);
    await expectNoList(await ownerReads(id, h, owner.token), editor.email);
  });

  it("versions written by the owner and by an editor's account-wide agent keep the list", async () => {
    const owner = await agent();
    const h = await signedIn(owner.user.id);
    const page = await publish(owner.auth, { title: "Team", html: peoplePage() });
    expect(page.res.status).toBe(201);
    const id = page.body.id as string;
    const editor = await agent();
    await grant(id, editor.user.email, "editor");
    const up = await req("PUT", `/artifacts/${id}`, editor.auth, {
      html: peoplePage().replace("<p>team</p>", "<p>team v2</p>"),
      base_version: 1,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const reads = await ownerReads(id, h, owner.token);
    expect(reads.session.can_list_people).toBe(true);
    expect(reads.page.status).toBe(200);
    expect(JSON.stringify(await json(reads.page))).toContain(editor.user.email);
    expect(reads.rest.status).toBe(200);
    expect(reads.summary.isError, reads.summary.text).toBe(false);
    expect(JSON.stringify(reads.summary.data.people)).toContain(editor.user.email);
    expect(reads.gate.body.people).toMatchObject({ list: true });
  });
});

describe("a token limited to one artifact, on the tools that read other artifacts", () => {
  /** A design system the same person owns, so only the binding stands in the way. */
  async function publishDs(auth: Record<string, string>, visibility = "allowlist") {
    const r = await publish(auth, {
      html: undefined,
      title: "Acme UI",
      type: "design_system",
      content: JSON.stringify(acme),
      visibility,
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(201);
    return r;
  }
  const builtOn = (ref: string) =>
    `<!doctype html><html><head><title>Report</title><meta name="plinth-design-system" content="${ref}"></head><body><p>x</p></body></html>`;

  it("get_artifact_stats on another artifact is the 404 every other artifact gets", async () => {
    const { h, id, other } = await setup();
    const t = await boundToken(h, id);
    for (const ref of [other.id, other.slug, "abcdefghij0123456789"]) {
      const r = await req("GET", `/artifacts/${ref}/stats`, t.auth);
      expect(r.status, ref).toBe(404);
      expect(JSON.stringify(r.body), ref).not.toContain("token_bound");
    }
    const c = await mcpClient(t.token);
    const r = await tool(c, "get_artifact_stats", { id: other.id });
    expect(r.data.error.code).toBe("not_found");
    await c.close();
  });

  it("get_design_system on another artifact is a 404, private or unlisted, by id or slug", async () => {
    const { owner, h, id } = await setup();
    const t = await boundToken(h, id);
    const c = await mcpClient(t.token);
    const missing = await req("GET", "/artifacts/abcdefghij0123456789/design-system", t.auth);
    for (const visibility of ["allowlist", "unlisted"]) {
      const { body: ds } = await publishDs(owner.auth, visibility);
      // The owner's account-wide token reads it, so the binding alone refuses it.
      expect((await req("GET", `/artifacts/${ds.id}/design-system`, owner.auth)).status).toBe(200);
      for (const ref of [ds.id, ds.slug]) {
        const r = await req("GET", `/artifacts/${ref}/design-system`, t.auth);
        expect(r.status, `${visibility} ${ref}`).toBe(404);
        expect(r.body, `${visibility} ${ref}`).toEqual(missing.body);
        const m = await tool(c, "get_design_system", { id: ref });
        expect(m.isError).toBe(true);
        expect(m.data.error.code).toBe("not_found");
      }
    }
    await c.close();
  });

  it("a page it publishes that names another design system gets the unavailable warning", async () => {
    const { owner, h, id } = await setup();
    const { body: ds } = await publishDs(owner.auth, "unlisted");
    const t = await boundToken(h, id);
    const r = await req("PUT", `/artifacts/${id}`, t.auth, {
      html: builtOn(`${ds.id}@1`),
      base_version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.warnings.map((w: { code: string }) => w.code)).toEqual([
      "design_system_unavailable",
    ]);
    expect(JSON.stringify(r.body)).not.toContain("Acme UI");
    // get_artifact leaves the reference out for the token, and shows it to the owner.
    expect((await req("GET", `/artifacts/${id}`, t.auth)).body.design_system).toBeNull();
    expect((await req("GET", `/artifacts/${id}`, owner.auth)).body.design_system).toMatchObject({
      id: ds.id,
      version: 1,
    });
  });

  it("a token limited to a design system reads that design system", async () => {
    const owner = await agent();
    const h = await signedIn(owner.user.id);
    const { body: ds } = await publishDs(owner.auth);
    const t = await boundToken(h, ds.id);
    const r = await req("GET", `/artifacts/${ds.id}/design-system`, t.auth);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: ds.id, version: 1, name: "Acme UI" });
    const c = await mcpClient(t.token);
    const m = await tool(c, "get_design_system", { id: ds.id });
    expect(m.isError).toBe(false);
    // Each answer stamps its own install.record.copiedAt.
    const untimed = (b: Record<string, any>) => ({
      ...b,
      install: { ...b.install, record: { ...b.install.record, copiedAt: "" } },
    });
    expect(untimed(m.data)).toEqual(untimed(r.body));
    await c.close();
  });
});

describe("the end of a token limited to one artifact", () => {
  it("removing the person's grant stops it, and /me then shows no artifact", async () => {
    const { h, id } = await setup();
    const editor = await createUser();
    await req("PUT", `/artifacts/${id}/sharing`, h, {
      grants: [{ email: editor.email, role: "editor" }],
    });
    const t = await boundToken(await signedIn(editor.id), id);
    expect((await req("GET", `/artifacts/${id}`, t.auth)).status).toBe(200);
    await req("PUT", `/artifacts/${id}/sharing`, h, { grants: [] });
    expect((await req("GET", `/artifacts/${id}`, t.auth)).status).toBe(404);
    expect((await req("PUT", `/artifacts/${id}`, t.auth, { html: "<p>x</p>" })).status).toBe(404);
    // Every other action answers the same 404, never a token_bound that says the artifact is live.
    for (const [method, path, body] of [
      ["DELETE", `/artifacts/${id}`, undefined],
      ["PUT", `/artifacts/${id}/visibility`, { visibility: "unlisted" }],
      ["POST", `/artifacts/${id}/comments`, { body: "hi" }],
      ["GET", `/artifacts/${id}/comments`, undefined],
      ["GET", `/artifacts/${id}/data`, undefined],
      ["GET", `/artifacts/${id}/stats`, undefined],
    ] as const) {
      const r = await req(method, path, t.auth, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body), `${method} ${path}`).not.toContain("token_bound");
    }
    const me = await req("GET", "/me", t.auth);
    expect(me.body.connection).toMatchObject({ bound: true, artifact: null });
  });

  it("deleting the artifact revokes its tokens; erasing the owner removes them", async () => {
    const { owner, h, id } = await setup();
    const t = await boundToken(h, id);
    expect((await req("DELETE", `/artifacts/${id}`, h)).status).toBeLessThan(300);
    const row = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, t.connectionId))
      .get();
    expect(row?.revokedAt).toBeTruthy();
    expect((await req("GET", "/me", t.auth)).status).toBe(401);
    for (const stmt of eraseUserSql(owner.user.email).split("; ")) {
      await env.DB.prepare(stmt).all();
    }
    const gone = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, t.connectionId))
      .get();
    expect(gone).toBeUndefined();
  });

  it("a takedown revokes its tokens too", async () => {
    const { h, id } = await setup();
    const t = await boundToken(h, id);
    await env.DB.prepare(
      "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?1, ?2, 'x', 'open', ?3)",
    )
      .bind(`r${id}`.slice(0, 20), id, new Date().toISOString())
      .run();
    const { decideReport } = await import("../src/services/reports.ts");
    const admin = await createUser();
    await decideReport(
      serviceCtxFor(
        { kind: "user", userId: admin.id, email: admin.email, isAdmin: true },
        { config: { adminEmails: [admin.email] } },
      ),
      `r${id}`.slice(0, 20),
      "actioned",
    );
    expect((await req("GET", `/artifacts/${id}`, t.auth)).status).toBe(401);
  });
});

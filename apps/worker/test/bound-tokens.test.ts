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
import { agentConnections } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import {
  agent,
  browserSession,
  call,
  config,
  createUser,
  db,
  json,
  mcpClient,
  publish,
  serviceCtxFor,
  tool,
} from "./helpers.ts";

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
    bound(await req("DELETE", `/artifacts/${id}`, t.auth), "delete");
    bound(await req("POST", `/artifacts/${id}/comments`, t.auth, { body: "hi" }), "comment");
    bound(await req("GET", `/artifacts/${id}/data`, t.auth), "data read");
    bound(
      await req("POST", `/artifacts/${id}/data`, t.auth, {
        ops: [{ op: "set", collection: "votes", doc_id: "b", data: { n: 2 }, if_rev: 0 }],
      }),
      "data write",
    );
    bound(await req("GET", `/artifacts/${id}/views`, t.auth), "views");
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

  it("GET /me names the connection and its artifact", async () => {
    const { owner, h, id, slug } = await setup();
    const t = await boundToken(h, id);
    const me = await req("GET", "/me", t.auth);
    expect(me.body.connection).toEqual({
      id: t.connectionId,
      label: "CI: report",
      bound: true,
      artifact: { id, slug, title: "Coverage report" },
    });
    const wide = await req("GET", "/me", owner.auth);
    expect(wide.body.connection).toMatchObject({
      label: "Test token",
      bound: false,
      artifact: null,
    });
    expect((await req("GET", "/me", h)).body.connection).toBeNull();
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

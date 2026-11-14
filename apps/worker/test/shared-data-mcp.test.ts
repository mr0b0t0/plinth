// Shared data for agents and the app: the MCP tools list_artifact_data and write_artifact_data,
// their REST mirrors under /api/v1/artifacts/:ref/data, get_artifact's data fields, and the
// lifecycle (wiped on delete and takedown, kept across versions and restores). Design:
// docs/superpowers/specs/2026-11-14-shared-state-design.md sections 9 and 11.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { accessGrants } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import { DATA_UNTRUSTED_NOTE, OPAQUE_NOTE, UNTRUSTED_NOTE } from "../src/mcp/server.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  APP,
  agent,
  browserSession,
  config,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  tool,
  uniqueEmail,
} from "./helpers.ts";

const POLL = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-shared" content="tasks">
<p>poll</p>`;
const PLAIN = "<!doctype html><title>Plain</title><p>nothing declared</p>";

type Vars = Record<string, string>;
type Agent = Awaited<ReturnType<typeof agent>>;

async function run(path: string, init: RequestInit = {}, vars: Vars = {}): Promise<Response> {
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

async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

const viewerId = (artifactId: string, email: string) =>
  viewerIdFor(config().tokenSigningKey, artifactId, email);

/** The owner's agent (labelled "Poll bot") publishes a page over MCP. */
async function setup(html = POLL, ownerAgent?: Agent) {
  const owner = ownerAgent ?? (await agent({ label: "Poll bot" }));
  const client = await mcpClient(owner.token);
  const pub = await tool(client, "publish_artifact", { title: "Poll", html });
  expect(pub.isError, pub.text).toBe(false);
  return { owner, client, id: pub.data.id as string, slug: pub.data.slug as string };
}

/** Someone with a grant on the artifact and an agent token of their own. */
async function collaborator(artifactId: string, role: Role, scopes?: string) {
  const a = await agent({ label: `${role} agent`, ...(scopes ? { scopes } : {}) });
  await grant(artifactId, a.user.email, role);
  return { ...a, client: await mcpClient(a.token) };
}

/** A signed-in viewer's page writes through the content-host API. */
async function pagePut(
  artifactId: string,
  userId: string,
  path: string,
  body: unknown,
  vars: Vars = {},
) {
  const s = await browserSession(userId);
  const { cookie, gate } = await enterContent(artifactId, { headers: s.headers });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return run(
    `${contentOrigin(artifactId)}/__plinth/api/v1${path}`,
    {
      method: "PUT",
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        origin: contentOrigin(artifactId),
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(body),
    },
    vars,
  );
}

const write = (client: Awaited<ReturnType<typeof mcpClient>>, id: string, ops: unknown[]) =>
  tool(client, "write_artifact_data", { id, ops });

function rest(path: string, auth: Record<string, string>, init: RequestInit = {}, vars?: Vars) {
  return run(
    `/api/v1${path}`,
    {
      ...init,
      headers: {
        ...auth,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    },
    vars,
  );
}

async function rowCounts(artifactId: string) {
  const docs = await env.DB.prepare(
    "SELECT count(*) AS n FROM artifact_docs WHERE artifact_id = ?1",
  )
    .bind(artifactId)
    .first<{ n: number }>();
  const usage = await env.DB.prepare(
    "SELECT count(*) AS n FROM artifact_data_usage WHERE artifact_id = ?1",
  )
    .bind(artifactId)
    .first<{ n: number }>();
  return { docs: docs?.n ?? 0, usage: usage?.n ?? 0 };
}

// ---------- tool descriptions ----------

describe("MCP data tools: descriptions", () => {
  it("lists both tools with the data note and the usual untrusted note", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === "list_artifact_data");
    const writeTool = tools.find((t) => t.name === "write_artifact_data");
    expect(list).toBeDefined();
    expect(writeTool).toBeDefined();
    for (const t of [list, writeTool]) {
      expect(t?.description).toContain(DATA_UNTRUSTED_NOTE);
      expect(t?.description).toContain(UNTRUSTED_NOTE);
    }
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(writeTool?.annotations?.readOnlyHint).not.toBe(true);
    expect(DATA_UNTRUSTED_NOTE).toMatch(/^SECURITY: shared data is written by people viewing/);
    expect(DATA_UNTRUSTED_NOTE).toMatch(/cannot be reverted: change only what the person asked/);
  });

  it("tells publishers about shared data, and opaque instances that it is unavailable", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    for (const name of ["publish_artifact", "update_artifact"]) {
      const d = tools.find((t) => t.name === name)?.description ?? "";
      expect(d, name).toMatch(/polls, sign-up sheets and trackers among invited people/);
      expect(d, name).toMatch(/plinth-artifacts skill/);
      expect(d, name).toMatch(/list_artifact_data/);
    }
    expect(OPAQUE_NOTE).toContain("Shared data and viewer identity are unavailable to pages here.");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/list_artifact_data/);
    expect(instructions).toMatch(/write_artifact_data/);
  });
});

// ---------- reading ----------

describe("list_artifact_data", () => {
  it("returns the summary, a page and a single document", async () => {
    const { client, id } = await setup();
    const empty = await tool(client, "list_artifact_data", { id });
    expect(empty.isError, empty.text).toBe(false);
    expect(empty.data).toMatchObject({
      capabilities: ["data", "viewer"],
      available: true,
      usage: { docs: 0, bytes: 0 },
      limits: {
        max_doc_bytes: config().data.maxDocBytes,
        max_docs: config().data.maxDocsPerArtifact,
        max_bytes: config().data.maxBytesPerArtifact,
      },
      collections: [],
    });
    expect(empty.data.untrusted).toMatch(/untrusted/i);

    const w = await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { choice: "x" }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "b", data: { choice: "y" }, if_rev: 0 },
      { op: "set", collection: "notes", doc_id: "n1", data: { text: "hi" }, if_rev: 0 },
    ]);
    expect(w.isError, w.text).toBe(false);

    const sum = await tool(client, "list_artifact_data", { id });
    expect(sum.data.usage.docs).toBe(3);
    expect(sum.data.collections).toEqual([
      { name: "notes", docs: 1, bytes: expect.any(Number), updated_at: expect.any(String) },
      { name: "votes", docs: 2, bytes: expect.any(Number), updated_at: expect.any(String) },
    ]);

    const p1 = await tool(client, "list_artifact_data", { id, collection: "votes", limit: 1 });
    expect(p1.data.docs).toHaveLength(1);
    expect(p1.data.docs[0]).toMatchObject({
      collection: "votes",
      id: "a",
      data: { choice: "x" },
      rev: 1,
    });
    expect(p1.data.next_cursor).toEqual(expect.any(String));
    expect(p1.data.untrusted).toMatch(/untrusted/i);
    const p2 = await tool(client, "list_artifact_data", {
      id,
      collection: "votes",
      limit: 1,
      cursor: p1.data.next_cursor,
    });
    expect(p2.data.docs.map((d: { id: string }) => d.id)).toEqual(["b"]);
    expect(p2.data.next_cursor).toBeNull();

    const one = await tool(client, "list_artifact_data", { id, collection: "votes", doc_id: "b" });
    expect(one.data.doc).toMatchObject({ collection: "votes", id: "b", data: { choice: "y" } });
    expect(one.data.untrusted).toMatch(/untrusted/i);

    const missing = await tool(client, "list_artifact_data", {
      id,
      collection: "votes",
      doc_id: "zzz",
    });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe("not_found");

    const noCollection = await tool(client, "list_artifact_data", { id, doc_id: "a" });
    expect(noCollection.isError).toBe(true);
  });
});

// ---------- writing ----------

describe("write_artifact_data", () => {
  it("returns one result per op, a conflict included, and needs if_rev on every op", async () => {
    const { client, id } = await setup();
    const r = await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
      { op: "set", collection: "votes", data: { n: 2 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "a", data: { n: 3 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "a", data: { n: 4 }, if_rev: 1 },
      { op: "delete", collection: "votes", doc_id: "gone", if_rev: 1 },
      { op: "delete", collection: "votes", doc_id: "a", if_rev: 1 },
    ]);
    expect(r.isError, r.text).toBe(false);
    const results = r.data.results as {
      op: string;
      doc_id: string | null;
      ok: boolean;
      rev?: number;
      error?: { code: string; details?: any };
    }[];
    expect(results).toHaveLength(6);
    expect(results[0]).toMatchObject({
      op: "set",
      collection: "votes",
      doc_id: "a",
      ok: true,
      rev: 1,
    });
    // Revs grow across the artifact (one past its change counter), not per document.
    expect(results[1]).toMatchObject({ op: "set", ok: true, rev: 2 });
    expect(results[1]?.doc_id).toMatch(/^[A-Za-z0-9]/);
    expect(results[2]).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { current_rev: 1 } },
    });
    expect(results[3]).toMatchObject({ ok: true, rev: 3 });
    expect(results[4]).toMatchObject({ op: "delete", ok: false, error: { code: "not_found" } });
    expect(results[5]).toMatchObject({
      op: "delete",
      ok: false,
      error: { code: "conflict", details: { current_rev: 3 } },
    });

    const noRev = await write(client, id, [
      { op: "set", collection: "votes", doc_id: "c", data: { n: 1 } },
    ]);
    expect(noRev.isError).toBe(true);
    const noRevDelete = await write(client, id, [
      { op: "delete", collection: "votes", doc_id: "a" },
    ]);
    expect(noRevDelete.isError).toBe(true);
    const doc = await tool(client, "list_artifact_data", { id, collection: "votes", doc_id: "a" });
    expect(doc.data.doc).toMatchObject({ rev: 3, data: { n: 4 } });
  });

  it("allows owner and editor agents; refuses a commenter agent and a read-only token", async () => {
    const { owner, id } = await setup();
    const editor = await collaborator(id, "editor");
    const ed = await write(editor.client, id, [
      { op: "set", collection: "votes", doc_id: "e", data: { by: "editor" }, if_rev: 0 },
    ]);
    expect(ed.isError, ed.text).toBe(false);
    expect(ed.data.results[0].ok).toBe(true);
    expect((await tool(editor.client, "list_artifact_data", { id })).isError).toBe(false);

    const commenter = await collaborator(id, "commenter");
    const cw = await write(commenter.client, id, [
      { op: "set", collection: "votes", doc_id: "c", data: { by: "commenter" }, if_rev: 0 },
    ]);
    expect(cw.isError).toBe(true);
    expect(cw.data.error.code).toBe("forbidden");
    const cl = await tool(commenter.client, "list_artifact_data", { id });
    expect(cl.isError).toBe(true);
    expect(cl.data.error.code).toBe("forbidden");

    const readOnly = await createToken(owner.user.id, { scopes: "artifacts:read" });
    const ro = await mcpClient(readOnly.token);
    const rw = await write(ro, id, [
      { op: "set", collection: "votes", doc_id: "r", data: { by: "read-only" }, if_rev: 0 },
    ]);
    expect(rw.isError).toBe(true);
    expect(rw.data.error.code).toBe("forbidden");
    expect((await tool(ro, "list_artifact_data", { id })).isError).toBe(false);

    const stranger = await agent();
    const sc = await mcpClient(stranger.token);
    const sl = await tool(sc, "list_artifact_data", { id });
    expect(sl.data.error.code).toBe("not_found");
  });

  it("stamps agent writes via agent with the label, and page writes via page", async () => {
    const { owner, client, id } = await setup();
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "o", data: { by: "agent" }, if_rev: 0 },
    ]);
    const viewer = await createUser();
    await grant(id, viewer.email, "viewer");
    const put = await pagePut(id, viewer.id, "/data/votes/~me", { data: { choice: "y" } });
    expect(put.status).toBeLessThan(300);

    const page = await tool(client, "list_artifact_data", { id, collection: "votes" });
    const byId = new Map(page.data.docs.map((d: { id: string }) => [d.id, d]));
    expect(byId.get("o")).toMatchObject({
      created_by: {
        email: owner.user.email,
        role: "owner",
        via: "agent",
        connection_label: "Poll bot",
        viewer_id: await viewerId(id, owner.user.email),
      },
      updated_by: { via: "agent", connection_label: "Poll bot" },
    });
    const vid = await viewerId(id, viewer.email);
    expect(byId.get(vid)).toMatchObject({
      personal: true,
      data: { choice: "y" },
      created_by: {
        email: viewer.email,
        role: "viewer",
        via: "page",
        connection_label: null,
        viewer_id: vid,
      },
    });
  });

  it("rate limits and quotas apply per op, each op counting as one write", async () => {
    const { owner, id } = await setup();
    const post = (ops: unknown[], vars: Vars) =>
      rest(
        `/artifacts/${id}/data`,
        owner.auth,
        { method: "POST", body: JSON.stringify({ ops }) },
        vars,
      );
    const limited = { DATA_WRITES_PER_VIEWER_PER_HOUR: "2" };
    const r = await post(
      [
        { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
        { op: "set", collection: "votes", doc_id: "b", data: { n: 1 }, if_rev: 0 },
        { op: "set", collection: "votes", doc_id: "c", data: { n: 1 }, if_rev: 0 },
      ],
      limited,
    );
    expect(r.status).toBe(200);
    const results = (await json(r)).results;
    expect(results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false]);
    expect(results[2].error).toMatchObject({
      code: "rate_limited",
      details: { retry_after: expect.any(Number) },
    });
    expect(results[2].error.details.retry_after).toBeGreaterThan(0);

    const other = await setup(POLL, owner);
    const q = await rest(
      `/artifacts/${other.id}/data`,
      owner.auth,
      {
        method: "POST",
        body: JSON.stringify({
          ops: [
            { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
            { op: "set", collection: "votes", doc_id: "b", data: { n: 1 }, if_rev: 0 },
            { op: "set", collection: "votes", doc_id: "a", data: { n: 2 }, if_rev: 1 },
          ],
        }),
      },
      { DATA_MAX_DOCS_PER_ARTIFACT: "1" },
    );
    const qr = (await json(q)).results;
    expect(qr.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, true]);
    expect(qr[1].error).toMatchObject({ code: "quota_exceeded", details: { limit: "docs" } });
  });

  it("a person's page writes and their agent's writes share one rate limit", async () => {
    const { owner, id } = await setup();
    const vars = { DATA_WRITES_PER_VIEWER_PER_HOUR: "2" };
    expect(
      (await pagePut(id, owner.user.id, "/data/votes/p1", { data: { n: 1 } }, vars)).status,
    ).toBe(201);
    const viaRest = await rest(
      `/artifacts/${id}/data`,
      owner.auth,
      {
        method: "POST",
        body: JSON.stringify({
          ops: [
            { op: "set", collection: "votes", doc_id: "a1", data: { n: 1 }, if_rev: 0 },
            { op: "set", collection: "votes", doc_id: "a2", data: { n: 1 }, if_rev: 0 },
          ],
        }),
      },
      vars,
    );
    expect((await json(viaRest)).results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false]);
    // The page is now limited too: the agent's write counted against the same person.
    const page = await pagePut(id, owner.user.id, "/data/votes/p2", { data: { n: 1 } }, vars);
    expect(page.status).toBe(429);
    // Another person (an editor's agent) has a counter of their own.
    const editor = await collaborator(id, "editor");
    const ed = await rest(
      `/artifacts/${id}/data`,
      editor.auth,
      {
        method: "POST",
        body: JSON.stringify({
          ops: [{ op: "set", collection: "votes", doc_id: "e1", data: { n: 1 }, if_rev: 0 }],
        }),
      },
      vars,
    );
    expect((await json(ed)).results[0].ok).toBe(true);
  });

  it("an agent cannot create another person's personal document, the owner's included", async () => {
    const { client, id } = await setup();
    const viewer = await createUser();
    await grant(id, viewer.email, "viewer");
    const vid = await viewerId(id, viewer.email);
    const r = await write(client, id, [
      { op: "set", collection: "votes", doc_id: vid, data: { choice: "forged" }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "u_0123456789abcdef01234567", data: {}, if_rev: 0 },
    ]);
    expect(r.isError, r.text).toBe(false);
    for (const res of r.data.results) {
      expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    const listed = await tool(client, "list_artifact_data", { id, collection: "votes" });
    expect(listed.data.docs).toEqual([]);
  });

  it("an editor's agent moderates a viewer's personal document at its rev, stamped editor", async () => {
    const { id } = await setup();
    const viewer = await createUser();
    await grant(id, viewer.email, "viewer");
    const put = await pagePut(id, viewer.id, "/data/votes/~me", { data: { choice: "y" } });
    expect(put.status).toBe(201);
    const { rev, id: vid } = await json(put);
    const editor = await collaborator(id, "editor");
    const stale = await write(editor.client, id, [
      { op: "set", collection: "votes", doc_id: vid, data: { choice: "n" }, if_rev: rev + 100 },
    ]);
    expect(stale.data.results[0]).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { current_rev: rev } },
    });
    const ok = await write(editor.client, id, [
      { op: "set", collection: "votes", doc_id: vid, data: { choice: "removed" }, if_rev: rev },
    ]);
    expect(ok.data.results[0]).toMatchObject({ ok: true });
    const doc = await tool(editor.client, "list_artifact_data", {
      id,
      collection: "votes",
      doc_id: vid,
    });
    expect(doc.data.doc).toMatchObject({
      personal: true,
      data: { choice: "removed" },
      created_by: { email: viewer.email, role: "viewer", via: "page" },
      updated_by: {
        email: editor.user.email,
        role: "editor",
        via: "agent",
        connection_label: "editor agent",
      },
    });
  });

  it("~me in list_artifact_data and write_artifact_data is the calling person's own document", async () => {
    const { owner, client, id } = await setup();
    const editor = await collaborator(id, "editor");
    const mine = await write(client, id, [
      { op: "set", collection: "votes", doc_id: "~me", data: { by: "owner" }, if_rev: 0 },
    ]);
    const ownerVid = await viewerId(id, owner.user.email);
    expect(mine.data.results[0]).toMatchObject({ ok: true, doc_id: ownerVid });
    await write(editor.client, id, [
      { op: "set", collection: "votes", doc_id: "~me", data: { by: "editor" }, if_rev: 0 },
    ]);
    const o = await tool(client, "list_artifact_data", { id, collection: "votes", doc_id: "~me" });
    expect(o.data.doc).toMatchObject({ id: ownerVid, data: { by: "owner" } });
    const e = await tool(editor.client, "list_artifact_data", {
      id,
      collection: "votes",
      doc_id: "~me",
    });
    expect(e.data.doc).toMatchObject({
      id: await viewerId(id, editor.user.email),
      data: { by: "editor" },
    });
  });

  it("get_artifact shows capabilities and data usage", async () => {
    const { client, id } = await setup();
    const before = await tool(client, "get_artifact", { id });
    expect(before.data).toMatchObject({ capabilities: ["data", "viewer"], data_usage: null });
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
    ]);
    const after = await tool(client, "get_artifact", { id });
    expect(after.data.data_usage).toEqual({ docs: 1, bytes: expect.any(Number) });
    expect(after.data.data_usage.bytes).toBeGreaterThan(0);

    const plain = await setup(PLAIN);
    const p = await tool(plain.client, "get_artifact", { id: plain.id });
    expect(p.data).toMatchObject({ capabilities: [], data_usage: null });

    // Someone who may view but not read the data learns nothing about it.
    const commenter = await collaborator(id, "commenter");
    const c = await tool(commenter.client, "get_artifact", { id });
    expect(c.isError, c.text).toBe(false);
    expect(c.data.data_usage).toBeNull();
  });

  it("is refused when shared data is off, while reads still work", async () => {
    const { owner, id } = await setup();
    const vars = { ALLOW_SHARED_DATA: "false" };
    const w = await rest(
      `/artifacts/${id}/data`,
      owner.auth,
      {
        method: "POST",
        body: JSON.stringify({
          ops: [{ op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 }],
        }),
      },
      vars,
    );
    expect(w.status).toBe(403);
    expect((await json(w)).error).toMatchObject({
      code: "feature_disabled",
      details: { reason: "disabled" },
    });
    const r = await rest(`/artifacts/${id}/data`, owner.auth, {}, vars);
    expect(r.status).toBe(200);
    expect((await json(r)).available).toBe(false);
  });

  it("is refused under opaque isolation, over MCP and REST, while reads still work", async () => {
    const { owner, id } = await setup();
    const vars = { CONTENT_ISOLATION: "opaque" };
    const ops = [{ op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 }];
    const w = await rest(
      `/artifacts/${id}/data`,
      owner.auth,
      { method: "POST", body: JSON.stringify({ ops }) },
      vars,
    );
    expect(w.status).toBe(403);
    expect((await json(w)).error).toMatchObject({
      code: "feature_disabled",
      details: { reason: "opaque_isolation" },
    });
    const viaMcp = await tool(await mcpClient(owner.token, vars), "write_artifact_data", {
      id,
      ops,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.data.error).toMatchObject({
      code: "feature_disabled",
      details: { reason: "opaque_isolation" },
    });
    const r = await rest(`/artifacts/${id}/data`, owner.auth, {}, vars);
    expect(r.status).toBe(200);
    expect((await json(r)).available).toBe(false);
    expect(await rowCounts(id)).toEqual({ docs: 0, usage: 0 });
  });
});

// ---------- REST mirrors ----------

describe("REST mirrors under /api/v1/artifacts/:ref/data", () => {
  it("give the same results as the MCP tools", async () => {
    const { owner, client, id, slug } = await setup();
    const ops = [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "a", data: { n: 2 }, if_rev: 0 },
    ];
    const viaMcp = await write(client, id, ops);
    const other = await setup(POLL, owner);
    const viaRest = await rest(`/artifacts/${other.id}/data`, owner.auth, {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
    expect(viaRest.status).toBe(200);
    expect(await json(viaRest)).toEqual(viaMcp.data);

    const mcpSum = await tool(client, "list_artifact_data", { id });
    const restSum = await rest(`/artifacts/${slug}/data`, owner.auth);
    expect(restSum.status).toBe(200);
    expect(await json(restSum)).toEqual(mcpSum.data);

    const mcpPage = await tool(client, "list_artifact_data", { id, collection: "votes", limit: 5 });
    const restPage = await rest(`/artifacts/${id}/data/votes?limit=5`, owner.auth);
    expect(await json(restPage)).toEqual(mcpPage.data);

    const mcpDoc = await tool(client, "list_artifact_data", {
      id,
      collection: "votes",
      doc_id: "a",
    });
    const restDoc = await rest(`/artifacts/${id}/data/votes/a`, owner.auth);
    expect(await json(restDoc)).toEqual(mcpDoc.data);

    const missing = await rest(`/artifacts/${id}/data/votes/nope`, owner.auth);
    expect(missing.status).toBe(404);
    const badLimit = await rest(`/artifacts/${id}/data/votes?limit=0`, owner.auth);
    expect(badLimit.status).toBe(400);
  });

  it("stamps cookie requests via app, and refuses them without the CSRF token", async () => {
    const { owner, client, id } = await setup();
    const s = await browserSession(owner.user.id);
    const body = JSON.stringify({
      ops: [{ op: "set", collection: "votes", doc_id: "w", data: { n: 1 }, if_rev: 0 }],
    });
    const ok = await rest(`/artifacts/${id}/data`, s.headers, { method: "POST", body });
    expect(ok.status).toBe(200);
    const doc = await tool(client, "list_artifact_data", { id, collection: "votes", doc_id: "w" });
    expect(doc.data.doc.created_by).toMatchObject({
      email: owner.user.email,
      role: "owner",
      via: "app",
      connection_label: null,
    });

    const { "x-plinth-csrf": _csrf, ...noCsrf } = s.headers;
    const refused = await rest(`/artifacts/${id}/data`, noCsrf, { method: "POST", body });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe("csrf");
  });

  it("DELETE .../data clears everything for the signed-in owner only", async () => {
    const { owner, client, id } = await setup();
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "b", data: { n: 2 }, if_rev: 0 },
    ]);

    const editor = await collaborator(id, "editor");
    const es = await browserSession(editor.user.id);
    expect((await rest(`/artifacts/${id}/data`, es.headers, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await rest(`/artifacts/${id}/data`, owner.auth, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await rowCounts(id)).docs).toBe(2);

    const s = await browserSession(owner.user.id);
    const res = await rest(`/artifacts/${id}/data`, s.headers, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: 2 });
    expect((await rowCounts(id)).docs).toBe(0);
    const sum = await tool(client, "list_artifact_data", { id });
    expect(sum.data.usage).toEqual({ docs: 0, bytes: 0 });
  });
});

// ---------- lifecycle ----------

/** An admin: a signed-in person whose email is in ADMIN_EMAIL. */
async function admin() {
  const email = uniqueEmail("admin");
  const vars = { ADMIN_EMAIL: email };
  const cfg = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
  const user = await getOrCreateUser(db(), cfg, email, { verified: true });
  const s = await browserSession(user.id);
  return { vars, headers: { ...s.headers, "Content-Type": "application/json" } };
}

describe("shared data lifecycle", () => {
  it("deleting the artifact wipes its documents and usage row", async () => {
    const { owner, client, id } = await setup();
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
    ]);
    expect(await rowCounts(id)).toEqual({ docs: 1, usage: 1 });
    const res = await rest(`/artifacts/${id}`, owner.auth, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await rowCounts(id)).toEqual({ docs: 0, usage: 0 });
  });

  it("a takedown wipes its documents and usage row", async () => {
    const { client, id } = await setup();
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
    ]);
    // Anyone who can view may report: open it to link viewers first.
    await tool(client, "set_visibility", { id, visibility: "unlisted" });
    const adm = await admin();
    const reported = await run(
      `/api/v1/artifacts/${id}/report`,
      {
        method: "POST",
        headers: {
          Cookie: "__Host-plinth_csrf=r",
          "x-plinth-csrf": "r",
          Origin: APP,
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.77",
        },
        body: JSON.stringify({ reason: "Collects passwords" }),
      },
      adm.vars,
    );
    expect(reported.status).toBe(201);
    const { id: reportId } = await json(reported);
    const decided = await run(
      `/api/v1/admin/reports/${reportId}`,
      { method: "POST", headers: adm.headers, body: JSON.stringify({ state: "actioned" }) },
      adm.vars,
    );
    expect(decided.status).toBe(200);
    expect(await rowCounts(id)).toEqual({ docs: 0, usage: 0 });
  });

  it("data survives a new version and a restore", async () => {
    const { client, id } = await setup();
    await write(client, id, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
    ]);
    const up = await tool(client, "update_artifact", {
      id,
      html: POLL.replace("poll", "poll v2"),
      base_version: 1,
    });
    expect(up.isError, up.text).toBe(false);
    const restored = await tool(client, "restore_version", { id, version: 1 });
    expect(restored.isError, restored.text).toBe(false);
    const doc = await tool(client, "list_artifact_data", { id, collection: "votes", doc_id: "a" });
    expect(doc.data.doc).toMatchObject({ rev: 1, data: { n: 1 } });
    expect(await rowCounts(id)).toEqual({ docs: 1, usage: 1 });
  });
});

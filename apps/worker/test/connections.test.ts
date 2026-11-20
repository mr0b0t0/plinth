import { CSRF_HEADER } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConnections, artifacts } from "../src/db/schema.ts";
import { hashToken } from "../src/lib/crypto.ts";
import {
  agent,
  browserSession,
  call,
  createUser,
  db,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";

async function signedIn() {
  const user = await createUser();
  const s = await browserSession(user.id);
  const h = { ...s.headers, "Content-Type": "application/json" };
  return { user, h };
}

async function createPat(h: Record<string, string>, body: Record<string, unknown>) {
  const res = await call("/api/v1/connections", {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  return { res, body: await json(res) };
}

/** last_used_at is written after the response (waitUntil); poll briefly. */
async function lastUsed(id: string): Promise<string | null> {
  for (let i = 0; i < 50; i++) {
    const row = await db().select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    if (row?.lastUsedAt) return row.lastUsedAt;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe("personal access tokens", () => {
  it("are shown once, stored only as a hash, and work on the API and MCP", async () => {
    const { h } = await signedIn();
    const { res, body } = await createPat(h, { label: "CI", client_type: "codex" });
    expect(res.status).toBe(201);
    expect(body.token).toMatch(/^plinth_pat_[A-Za-z0-9]{40}$/);
    expect(body.connection).toMatchObject({
      label: "CI",
      client_type: "codex",
      kind: "token",
      scopes: ["artifacts:read", "artifacts:write", "mentions"],
      last_used_at: null,
      revoked_at: null,
    });

    const row = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, body.connection.id))
      .get();
    expect(row?.tokenHash).toBe(await hashToken(body.token));
    expect(JSON.stringify(row)).not.toContain(body.token);

    // Never retrievable again.
    const list = await json(await call("/api/v1/connections", { headers: h }));
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(JSON.stringify(list)).not.toContain(row?.tokenHash);

    const auth = { Authorization: `Bearer ${body.token}` };
    expect((await publish(auth)).res.status).toBe(201);
    expect(await lastUsed(body.connection.id)).toBeTruthy();
    const c = await mcpClient(body.token);
    expect((await tool(c, "list_artifacts", {})).data.items).toHaveLength(1);
  });

  it("honours requested scopes", async () => {
    const { h } = await signedIn();
    const { body } = await createPat(h, { label: "Read only", scopes: ["artifacts:read"] });
    expect(body.connection.scopes).toEqual(["artifacts:read"]);
    const { res } = await publish({ Authorization: `Bearer ${body.token}` });
    expect(res.status).toBe(403);
  });

  it("a revoked token gets 401 on the API and on /mcp", async () => {
    const { h } = await signedIn();
    const { body } = await createPat(h, { label: "Temp" });
    const auth = { Authorization: `Bearer ${body.token}` };
    expect((await call("/api/v1/artifacts", { headers: auth })).status).toBe(200);

    const del = await call(`/api/v1/connections/${body.connection.id}`, {
      method: "DELETE",
      headers: h,
    });
    expect(del.status).toBe(200);
    const revoked = await json(del);
    expect(revoked.revoked_at).toBeTruthy();

    expect((await call("/api/v1/artifacts", { headers: auth })).status).toBe(401);
    const mcp = await call("/mcp", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);

    const list = await json(await call("/api/v1/connections", { headers: h }));
    expect(list.items.find((x: { id: string }) => x.id === body.connection.id).revoked_at).toBe(
      revoked.revoked_at,
    );
  });

  it("can be renamed; validation applies", async () => {
    const { h } = await signedIn();
    const { body } = await createPat(h, { label: "Old" });
    const res = await call(`/api/v1/connections/${body.connection.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ label: "New name" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).label).toBe("New name");
    const bad = await createPat(h, { label: "" });
    expect(bad.res.status).toBe(400);
    const badScope = await createPat(h, { label: "x", scopes: ["admin"] });
    expect(badScope.res.status).toBe(400);
  });

  it("a person only sees and changes their own connections", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    const { body } = await createPat(alice.h, { label: "Alice's" });
    const bobList = await json(await call("/api/v1/connections", { headers: bob.h }));
    expect(bobList.items).toEqual([]);
    for (const [method, payload] of [
      ["PATCH", { label: "pwned" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call(`/api/v1/connections/${body.connection.id}`, {
        method,
        headers: bob.h,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      expect(res.status).toBe(404);
    }
    const row = await db()
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, body.connection.id))
      .get();
    expect(row).toMatchObject({ label: "Alice's", revokedAt: null });
  });

  it("agents cannot manage connections; anonymous callers must sign in; writes need CSRF", async () => {
    const a = await agent();
    const asAgent = await call("/api/v1/connections", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "escalate" }),
    });
    expect(asAgent.status).toBe(403);
    expect((await call("/api/v1/connections", { headers: a.auth })).status).toBe(403);
    expect(
      (await call(`/api/v1/connections/${a.connectionId}`, { method: "DELETE", headers: a.auth }))
        .status,
    ).toBe(403);
    expect((await call("/api/v1/connections")).status).toBe(401);

    const { h } = await signedIn();
    const noCsrf = Object.fromEntries(
      Object.entries(h).filter(([k]) => k.toLowerCase() !== CSRF_HEADER),
    );
    const res = await call("/api/v1/connections", {
      method: "POST",
      headers: noCsrf,
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("lists both token and oauth connections", async () => {
    const { user, h } = await signedIn();
    await createPat(h, { label: "PAT" });
    await db()
      .insert(agentConnections)
      .values({
        id: `oauthconn${Math.random().toString(36).slice(2, 10)}`,
        userId: user.id,
        label: "Claude desktop",
        clientType: "claude",
        kind: "oauth",
        tokenHash: null,
        scopes: "artifacts:read",
        createdAt: new Date().toISOString(),
      })
      .run();
    const list = await json(await call("/api/v1/connections", { headers: h }));
    expect(list.items.map((x: { kind: string }) => x.kind).sort()).toEqual(["oauth", "token"]);
  });
});

describe("ConnectionInfo.artifact (tokens limited to one artifact)", () => {
  async function bound(h: Record<string, string>, artifact: string) {
    const { res, body } = await createPat(h, { label: "CI", artifact });
    expect(res.status).toBe(201);
    return body.connection;
  }
  const list = async (h: Record<string, string>) =>
    (await json(await call("/api/v1/connections", { headers: h }))).items as {
      id: string;
      artifact: unknown;
    }[];
  const find = async (h: Record<string, string>, id: string) =>
    (await list(h)).find((c) => c.id === id)?.artifact;
  /** An owner with an account-wide token and a signed-in session. */
  async function owner() {
    const a = await agent();
    const s = await browserSession(a.user.id);
    return { ...a, h: { ...s.headers, "Content-Type": "application/json" } };
  }
  const share = (h: Record<string, string>, id: string, grants: unknown[]) =>
    call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ grants }),
    });

  it("names an owned artifact and a shared one; null for an unbound token", async () => {
    const a = await owner();
    const own = await publish(a.auth, { title: "Mine" });
    const mine = await bound(a.h, own.body.id);
    expect(mine.artifact).toEqual({ id: own.body.id, slug: own.body.slug, title: "Mine" });
    expect(await find(a.h, mine.id)).toEqual(mine.artifact);
    const editor = await signedIn();
    await share(a.h, own.body.id, [{ email: editor.user.email, role: "editor" }]);
    const shared = await bound(editor.h, own.body.id);
    expect(shared.artifact).toEqual({ id: own.body.id, slug: own.body.slug, title: "Mine" });
    const wide = await createPat(editor.h, { label: "Wide" });
    expect(wide.body.connection.artifact).toBeNull();
    expect(await find(editor.h, wide.body.connection.id)).toBeNull();
  });

  it("hides slug and title once the person may not view it: unshared, soft-deleted, taken down", async () => {
    const a = await owner();
    const editor = await signedIn();
    const pub = await publish(a.auth, { title: "Private", visibility: "allowlist" });
    await share(a.h, pub.body.id, [{ email: editor.user.email, role: "editor" }]);
    const c = await bound(editor.h, pub.body.id);
    await share(a.h, pub.body.id, []);
    expect(await find(editor.h, c.id)).toEqual({ id: pub.body.id, slug: null, title: null });

    const deleted = await publish(a.auth, { title: "Deleted" });
    const d = await bound(a.h, deleted.body.id);
    // Set directly, so the token row stays as it was.
    await db()
      .update(artifacts)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(artifacts.id, deleted.body.id))
      .run();
    expect(await find(a.h, d.id)).toEqual({ id: deleted.body.id, slug: null, title: null });

    const down = await publish(a.auth, { title: "Down" });
    const t = await bound(a.h, down.body.id);
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, down.body.id))
      .run();
    expect(await find(a.h, t.id)).toEqual({ id: down.body.id, slug: null, title: null });
  });

  it("create, rename and revoke answer with the same artifact as the list", async () => {
    const a = await owner();
    const pub = await publish(a.auth, { title: "Report" });
    const c = await bound(a.h, pub.body.slug);
    const listed = await find(a.h, c.id);
    expect(c.artifact).toEqual(listed);
    const renamed = await json(
      await call(`/api/v1/connections/${c.id}`, {
        method: "PATCH",
        headers: a.h,
        body: JSON.stringify({ label: "CI 2" }),
      }),
    );
    expect(renamed.artifact).toEqual(listed);
    const revoked = await json(
      await call(`/api/v1/connections/${c.id}`, { method: "DELETE", headers: a.h }),
    );
    expect(revoked.artifact).toEqual(listed);
    expect(revoked.revoked_at).toBeTruthy();
  });
});

import { CSRF_HEADER } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConnections } from "../src/db/schema.ts";
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

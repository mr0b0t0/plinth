import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../src/db/schema.ts";
import { contentNote, OPAQUE_NOTE } from "../src/mcp/server.ts";
import { agent, call, db, mcpClient, tool } from "./helpers.ts";

describe("MCP endpoint", () => {
  it("rejects requests without a token with 401 and resource metadata", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://app.localhost:8787/.well-known/oauth-protected-resource/mcp"',
    );
    await expect(mcpClient(null)).rejects.toThrow();
  });

  it("lists every tool, and descriptions warn that comment and artifact text is untrusted", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "claim_mention",
        "get_artifact",
        "list_artifacts",
        "list_mentions",
        "list_versions",
        "publish_artifact",
        "reply_comment",
        "restore_version",
        "set_visibility",
        "update_artifact",
      ].sort(),
    );
    for (const name of names) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/untrusted/i);
    }
  });

  it("publish, update, get, list, versions, restore and set_visibility succeed", async () => {
    const a = await agent();
    const c = await mcpClient(a.token);
    const pub = await tool(c, "publish_artifact", { title: "Chart", html: "<h1>v1</h1>" });
    expect(pub.isError).toBe(false);
    expect(pub.data).toMatchObject({ version: 1, visibility: "unlisted" });
    const id = pub.data.id as string;
    const up = await tool(c, "update_artifact", {
      id,
      html: "<h1>v2</h1>",
      note: "bigger",
      base_version: 1,
    });
    expect(up.data.version).toBe(2);
    const got = await tool(c, "get_artifact", { id });
    expect(got.data).toMatchObject({ html: "<h1>v2</h1>", version: 2 });
    const got1 = await tool(c, "get_artifact", { id, version: 1 });
    expect(got1.data.html).toBe("<h1>v1</h1>");
    const list = await tool(c, "list_artifacts", {});
    expect(list.data.items).toHaveLength(1);
    const versions = await tool(c, "list_versions", { id });
    expect(versions.data.items.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    const restored = await tool(c, "restore_version", { id, version: 1 });
    expect(restored.data.version).toBe(3);
    const vis = await tool(c, "set_visibility", {
      id,
      visibility: "password",
      password: "hunter22",
    });
    expect(vis.data.visibility).toBe("password");
  });

  it("fails cleanly: wrong owner, over quota, oversize, stale base_version, bad input", async () => {
    const a = await agent();
    const b = await agent();
    const ca = await mcpClient(a.token);
    const cb = await mcpClient(b.token);
    const pub = await tool(ca, "publish_artifact", {
      title: "Mine",
      html: "<p>x</p>",
      visibility: "allowlist",
    });
    const id = pub.data.id as string;

    const wrongOwner = await tool(cb, "update_artifact", { id, html: "<p>hijack</p>" });
    expect(wrongOwner.isError).toBe(true);
    expect(wrongOwner.data.error.code).toBe("not_found");
    const wrongRead = await tool(cb, "get_artifact", { id });
    expect(wrongRead.data.error.code).toBe("not_found");

    const oversize = await tool(ca, "publish_artifact", {
      title: "Big",
      html: "x".repeat(5 * 1024 * 1024 + 10),
    });
    expect(oversize.data.error.code).toBe("payload_too_large");

    await tool(ca, "update_artifact", { id, html: "<p>2</p>", base_version: 1 });
    const stale = await tool(ca, "update_artifact", { id, html: "<p>stale</p>", base_version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({ code: "conflict", details: { current_version: 2 } });

    await db().update(users).set({ artifactLimit: 1 }).where(eq(users.id, a.user.id)).run();
    const quota = await tool(ca, "publish_artifact", { title: "Two", html: "<p>2</p>" });
    expect(quota.data.error.code).toBe("quota_exceeded");

    const bad = await ca.callTool({ name: "publish_artifact", arguments: { title: "", html: "" } });
    expect(bad.isError).toBe(true);
  });

  it("a read-only token cannot publish", async () => {
    const a = await agent({ scopes: "artifacts:read" });
    const c = await mcpClient(a.token);
    const r = await tool(c, "publish_artifact", { title: "x", html: "<p>x</p>" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("forbidden");
  });
});

describe("MCP failures on every tool", () => {
  it("each tool refuses another user's artifact or task", async () => {
    const a = await agent();
    const b = await agent();
    const ca = await mcpClient(a.token);
    const cb = await mcpClient(b.token);
    const pub = await tool(ca, "publish_artifact", {
      title: "Private",
      html: "<p>x</p>",
      visibility: "allowlist",
    });
    const id = pub.data.id as string;
    const attempts: [string, Record<string, unknown>][] = [
      ["update_artifact", { id, html: "<p>y</p>" }],
      ["get_artifact", { id }],
      ["list_versions", { id }],
      ["restore_version", { id, version: 1 }],
      ["set_visibility", { id, visibility: "unlisted" }],
      ["claim_mention", { task_id: "nonexistenttask00001" }],
      ["reply_comment", { comment_id: "nonexistentcomment01", body: "hi" }],
    ];
    for (const [name, args] of attempts) {
      const r = await tool(cb, name, args);
      expect(r.isError, name).toBe(true);
      expect(["not_found", "forbidden"], name).toContain(r.data.error.code);
    }
    const list = await tool(cb, "list_artifacts", {});
    expect(list.data.items).toHaveLength(0);
    const mentions = await tool(cb, "list_mentions", {});
    expect(mentions.data.items).toHaveLength(0);
  });
});

describe("MCP tool descriptions and content isolation", () => {
  it("tell agents about the opaque sandbox only when artifacts run in it", () => {
    expect(contentNote({ contentIsolation: "opaque" })).toBe(OPAQUE_NOTE);
    expect(OPAQUE_NOTE).toMatch(/localStorage/);
    expect(OPAQUE_NOTE).toMatch(/fetch\(\)/);
    expect(contentNote({ contentIsolation: "origin" })).toBe("");
  });
});

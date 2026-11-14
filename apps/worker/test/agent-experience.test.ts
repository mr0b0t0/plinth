// The agent experience modelled on Claude's artifacts (docs/superpowers/specs/2026-11-14-agent-
// experience-design.md): private by default, and a comment loop agents can work through.
import { describe, expect, it } from "vitest";
import { agent, call, json, mcpClient, publish, tool } from "./helpers.ts";

async function postComment(headers: Record<string, string>, ref: string, body: string) {
  const res = await call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

describe("private by default", () => {
  it("REST publish without a visibility is private: anonymous visitors are asked to confirm", async () => {
    const owner = await agent();
    const { res, body } = await publish(owner.auth, { visibility: undefined });
    expect(res.status).toBe(201);
    expect(body.visibility).toBe("allowlist");
    const gate = await json(await call(`/api/v1/view/${body.slug}`));
    expect(gate.status).toBe("email_required");
  });

  it("MCP publish without a visibility is private; the server tells agents so", async () => {
    const owner = await agent();
    const c = await mcpClient(owner.token);
    expect(c.getInstructions()).toMatch(/private/);
    const pub = await tool(c, "publish_artifact", { title: "Notes", html: "<h1>Notes</h1>" });
    expect(pub.isError).toBe(false);
    expect(pub.data.visibility).toBe("allowlist");
    const gate = await json(await call(`/api/v1/view/${pub.data.slug}`));
    expect(gate.status).toBe("email_required");
  });

  it("an explicit visibility still wins", async () => {
    const owner = await agent();
    const c = await mcpClient(owner.token);
    const pub = await tool(c, "publish_artifact", {
      title: "Open",
      html: "<h1>Open</h1>",
      visibility: "unlisted",
    });
    expect(pub.data.visibility).toBe("unlisted");
  });
});

describe("comment loop over MCP", () => {
  it("lists threads, replies, resolves and reopens", async () => {
    const owner = await agent();
    const c = await mcpClient(owner.token);
    const pub = await tool(c, "publish_artifact", { title: "Deck", html: "<h1>Deck</h1>" });
    const root = await postComment(owner.auth, pub.data.slug, "Make the title bigger");

    const listed = await tool(c, "list_comments", { id: pub.data.id });
    expect(listed.isError).toBe(false);
    expect(listed.data.items).toHaveLength(1);
    expect(listed.data.items[0]).toMatchObject({ id: root.id, status: "open" });

    const reply = await tool(c, "reply_comment", { comment_id: root.id, body: "Done in v2" });
    expect(reply.isError).toBe(false);

    const resolved = await tool(c, "resolve_comment", { comment_id: root.id });
    expect(resolved.data.status).toBe("resolved");
    const reopened = await tool(c, "resolve_comment", { comment_id: root.id, resolved: false });
    expect(reopened.data.status).toBe("open");

    const after = await tool(c, "list_comments", { id: pub.data.slug });
    expect(after.data.items.map((i: { id: string }) => i.id)).toContain(reply.data.id);
  });

  it("another user's agent cannot read or resolve the threads of a private artifact", async () => {
    const owner = await agent();
    const stranger = await agent();
    const c = await mcpClient(owner.token);
    const pub = await tool(c, "publish_artifact", { title: "Plan", html: "<h1>Plan</h1>" });
    const root = await postComment(owner.auth, pub.data.slug, "Internal note");

    const s = await mcpClient(stranger.token);
    expect((await tool(s, "list_comments", { id: pub.data.id })).isError).toBe(true);
    expect((await tool(s, "resolve_comment", { comment_id: root.id })).isError).toBe(true);
  });
});

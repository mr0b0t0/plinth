// Page requests in the app and for agents (docs/spec.md "Page requests"): a request's thread is
// the owner's, editors' and its requester's only, on every comment read and write path; resolving
// one ends its task; the mention queue reports it as a page request with no owner authority; and
// reply_comment can finish a task with done=true.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eraseUserSql } from "../scripts/admin-lib.mjs";
import { PAGE_REQUEST_UNTRUSTED, UNTRUSTED_NOTE } from "../src/mcp/notes.ts";
import { mcpClient, tool, uniqueEmail } from "./helpers.ts";
import {
  agentOf,
  appHeaders,
  commentRow,
  cookieFor,
  file,
  grant,
  ON,
  person,
  REQUESTS_PAGE,
  rest,
  setup,
  taskOf,
  viewerCookie,
} from "./page-requests-helpers.ts";

const idsOf = (items: { id: string }[]) => items.map((c) => c.id);

async function commentRate(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key = ?1",
  )
    .bind(`comment:u:${userId}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function scenario() {
  const s = await setup(REQUESTS_PAGE, "unlisted");
  const requester = await person(s.id, "commenter");
  const otherCommenter = await person(s.id, "commenter");
  const editor = await person(s.id, "editor");
  const filed = await file(s.id, requester.cookie, {
    body: "Regenerate the chart",
    data: { q: 3 },
  });
  expect(filed.res.status).toBe(201);
  return { ...s, requester, otherCommenter, editor, rid: filed.json.id as string };
}

describe("page-request threads in the app", () => {
  it("are listed for the owner, editors and the requester, hidden from everyone else", async () => {
    const { id, ownerP, requester, otherCommenter, editor, rid } = await scenario();
    const plain = await rest(`/artifacts/${id}/comments`, otherCommenter.headers, "POST", {
      body: "A plain comment",
    });
    for (const who of [ownerP, editor, requester]) {
      const list = await rest(`/artifacts/${id}/comments`, who.headers);
      expect(idsOf(list.json.items), who.email).toContain(rid);
      const root = list.json.items.find((c: { id: string }) => c.id === rid);
      expect(root).toMatchObject({
        kind: "page_request",
        request_data: { q: 3 },
        parent_id: null,
        author: { email: requester.email },
      });
    }
    const other = await rest(`/artifacts/${id}/comments`, otherCommenter.headers);
    expect(idsOf(other.json.items)).not.toContain(rid);
    expect(idsOf(other.json.items)).toContain(plain.json.id);
    const anon = await rest(`/artifacts/${id}/comments`, appHeaders());
    expect(anon.res.status).toBe(200);
    expect(idsOf(anon.json.items)).not.toContain(rid);
    expect(plain.json).toMatchObject({ kind: "comment", request_data: null });
    // The list says who dismisses (owner, editors) and who withdraws.
    expect((await rest(`/artifacts/${id}/comments`, ownerP.headers)).json.can_moderate).toBe(true);
    expect((await rest(`/artifacts/${id}/comments`, editor.headers)).json.can_moderate).toBe(true);
    expect((await rest(`/artifacts/${id}/comments`, requester.headers)).json.can_moderate).toBe(
      false,
    );
  });

  it("refuses a reply into someone else's request like a missing parent, before the rate limit", async () => {
    const { id, ownerP, requester, otherCommenter, editor, rid } = await scenario();
    const inner = await rest(`/artifacts/${id}/comments`, requester.headers, "POST", {
      body: "My own follow-up",
      parent_id: rid,
    });
    expect(inner.res.status).toBe(201);
    const before = await commentRate(otherCommenter.userId);
    const bodies: string[] = [];
    for (const parent of [rid, inner.json.id, "zzzzzzzzzzzzzzzzzzzz"]) {
      const r = await rest(`/artifacts/${id}/comments`, otherCommenter.headers, "POST", {
        body: "Sneaking in",
        parent_id: parent,
      });
      expect(r.res.status, parent).toBe(404);
      bodies.push(JSON.stringify(r.json));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(await commentRate(otherCommenter.userId)).toBe(before);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM comments WHERE artifact_id = ?1 AND body = 'Sneaking in'",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    for (const who of [editor, ownerP]) {
      const r = await rest(`/artifacts/${id}/comments`, who.headers, "POST", {
        body: `reply from ${who.email}`,
        parent_id: rid,
      });
      expect(r.res.status).toBe(201);
      expect(r.json.kind).toBe("comment");
    }
  });

  it("is not found for resolve, reply_comment and its REST mirror by anyone who may not see it", async () => {
    const { id, requester, otherCommenter, rid } = await scenario();
    expect(
      (await rest(`/comments/${rid}`, otherCommenter.headers, "PATCH", { status: "resolved" })).res
        .status,
    ).toBe(404);
    const theirAgent = await agentOf(otherCommenter.userId);
    expect(
      (await rest(`/comments/${rid}/reply`, theirAgent.auth, "POST", { body: "hi" })).res.status,
    ).toBe(404);
    const client = await mcpClient(theirAgent.token, ON);
    const replied = await tool(client, "reply_comment", { comment_id: rid, body: "hi" });
    expect(replied.isError).toBe(true);
    expect(replied.text).toMatch(/not found/i);
    const resolved = await tool(client, "resolve_comment", { comment_id: rid });
    expect(resolved.isError).toBe(true);
    const listed = await tool(client, "list_comments", { id });
    expect(idsOf(listed.data.items)).not.toContain(rid);
    await client.close();
    // The requester's own agent (same user) sees it, as its user does.
    const mineAgent = await agentOf(requester.userId);
    const c2 = await mcpClient(mineAgent.token, ON);
    expect(idsOf((await tool(c2, "list_comments", { id })).data.items)).toContain(rid);
    await c2.close();
  });

  it("resolving a request fails its open task; reopening leaves it failed; comments keep theirs", async () => {
    const { id, ownerP, requester, rid } = await scenario();
    expect((await taskOf(rid))?.state).toBe("pending");
    const r = await rest(`/comments/${rid}`, ownerP.headers, "PATCH", { status: "resolved" });
    expect(r.res.status).toBe(200);
    const t = await taskOf(rid);
    expect(t?.state).toBe("failed");
    expect(t?.completed_at).toBeTypeOf("string");
    await rest(`/comments/${rid}`, requester.headers, "PATCH", { status: "open" });
    expect((await taskOf(rid))?.state).toBe("failed");
    const c = await rest(`/artifacts/${id}/comments`, ownerP.headers, "POST", {
      body: "@claude hi",
    });
    await rest(`/comments/${c.json.id}`, ownerP.headers, "PATCH", { status: "resolved" });
    expect((await taskOf(c.json.id))?.state).toBe("pending");
  });
});

describe("page requests in the mention queue", () => {
  it("lists a request with source page, no author role, the requester's role and its data", async () => {
    const { owner, id, ownerP, rid, requester } = await scenario();
    const own = await file(id, ownerP.cookie, { body: "From the owner's own session" });
    const c = await rest(`/artifacts/${id}/comments`, ownerP.headers, "POST", {
      body: "@claude go",
    });
    const list = await rest("/mentions", owner.auth);
    const byComment = new Map(list.json.items.map((t: any) => [t.comment_id, t]));
    expect(byComment.get(rid)).toMatchObject({
      source: "page",
      comment_author_role: null,
      requester_role: "commenter",
      request_data: { q: 3 },
      comment_body: "Regenerate the chart",
      comment_author_email: requester.email,
      target: "@claude",
    });
    expect(byComment.get(own.json.id)).toMatchObject({
      source: "page",
      comment_author_role: null,
      requester_role: "owner",
      request_data: null,
    });
    expect(byComment.get(c.json.id)).toMatchObject({
      source: "comment",
      comment_author_role: "owner",
      requester_role: null,
      request_data: null,
    });
    // Another user's agent and a codex connection of the owner never see it.
    const stranger = await agentOf(requester.userId);
    const theirs = await rest("/mentions", stranger.auth);
    expect(theirs.json.items.map((t: any) => t.comment_id)).not.toContain(rid);
    const codex = await agentOf(owner.user.id);
    await env.DB.prepare("UPDATE agent_connections SET client_type = 'codex' WHERE id = ?1")
      .bind(codex.connectionId)
      .run();
    expect(
      (await rest("/mentions", codex.auth)).json.items.map((t: any) => t.comment_id),
    ).not.toContain(rid);
  });

  it("one claim wins; done=true finishes without a version; done is exclusive and needs a claim", async () => {
    const { owner, rid } = await scenario();
    const task = await taskOf(rid);
    const second = await agentOf(owner.user.id, "Second bot");
    const [a, b] = await Promise.all([
      rest(`/mentions/${task?.id}/claim`, owner.auth, "POST"),
      rest(`/mentions/${task?.id}/claim`, second.auth, "POST"),
    ]);
    expect([a.res.status, b.res.status].sort()).toEqual([200, 409]);
    const winner = a.res.status === 200 ? owner.auth : second.auth;
    const loser = a.res.status === 200 ? second.auth : owner.auth;
    const both = await rest(`/comments/${rid}/reply`, winner, "POST", {
      body: "x",
      done: true,
      result_version: 1,
    });
    expect(both.res.status).toBe(400);
    const unclaimed = await rest(`/comments/${rid}/reply`, loser, "POST", {
      body: "x",
      done: true,
    });
    expect(unclaimed.res.status).toBe(409);
    const done = await rest(`/comments/${rid}/reply`, winner, "POST", {
      body: "Done: the chart now shows Q3.",
      done: true,
    });
    expect(done.res.status).toBe(201);
    const t = await taskOf(rid);
    expect(t).toMatchObject({ state: "done", result_version: null });
  });
});

describe("page requests for agents and erase", () => {
  it("the MCP text says page requests carry no owner authority", async () => {
    expect(UNTRUSTED_NOTE).toContain(PAGE_REQUEST_UNTRUSTED);
    expect(UNTRUSTED_NOTE).toContain('kind "page_request"');
    expect(UNTRUSTED_NOTE).toContain('requester_role "owner"');
    expect(UNTRUSTED_NOTE).toContain("never put people's names or email addresses");
    expect(UNTRUSTED_NOTE).toContain("titles, categories, comments");
    const { owner } = await setup();
    const client = await mcpClient(owner.token, ON);
    expect(client.getInstructions()).toContain("(from comments or from pages)");
    const tools = (await client.listTools()).tools;
    const d = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    expect(d("list_comments")).toContain(
      'kind "page_request" was filed by the artifact\'s page code',
    );
    expect(d("list_mentions")).toContain('(source: "page")');
    expect(d("claim_mention")).toContain("write_artifact_data or a reply");
    expect(d("reply_comment")).toContain("done=true");
    expect(d("reply_comment")).toContain("shows your reply text, with no author");
    await client.close();
  });

  it("erase-user deletes the page requests filed under a code-confirmed viewer's email", async () => {
    const { id, rid, requester } = await scenario();
    const email = uniqueEmail("coded");
    await grant(id, email, "commenter");
    const cookie = await cookieFor(id, appHeaders(await viewerCookie(email)));
    const theirs = await file(id, cookie, { body: "From a viewer confirmed by code" });
    expect(theirs.res.status).toBe(201);
    const row = await commentRow(theirs.json.id);
    expect(row?.author_user_id).toBeNull();
    for (const sql of eraseUserSql(email).split("; ")) await env.DB.prepare(sql).run();
    expect(await commentRow(theirs.json.id)).toBeNull();
    expect(await taskOf(theirs.json.id)).toBeNull();
    // Someone else's request stays.
    expect((await commentRow(rid))?.author_email).toBe(requester.email);
  });
});

import { COOKIES, CSRF_HEADER, type Role } from "@plinth/shared";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, agentConnections, mentionTasks, sessions } from "../src/db/schema.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  db,
  json,
  mcpClient,
  publish,
  tool,
  uniqueEmail,
} from "./helpers.ts";

const CSRF = "csrf-test-token-0123456789";

async function grant(artifactId: string, email: string, role: Role) {
  await db().insert(accessGrants).values({ artifactId, email, role, createdAt: nowIso() }).run();
}

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

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function postComment(
  headers: Record<string, string>,
  ref: string,
  body: Record<string, unknown>,
) {
  const res = await call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

async function tasksOf(commentId: string) {
  return db()
    .select()
    .from(mentionTasks)
    .where(eq(mentionTasks.commentId, commentId))
    .orderBy(asc(mentionTasks.targetLabel))
    .all();
}

async function listMentionsRest(token: string, state?: string) {
  const res = await call(`/api/v1/mentions${state ? `?state=${state}` : ""}`, {
    headers: bearer(token),
  });
  return { res, body: await json(res) };
}

function claimRest(token: string, taskId: string) {
  return call(`/api/v1/mentions/${taskId}/claim`, { method: "POST", headers: bearer(token) });
}

/** An owner with a published artifact, a Claude connection labelled "Work Claude" and a Codex one. */
async function setup(visibility: "unlisted" | "allowlist" = "unlisted") {
  const owner = await agent({ label: "Work Claude", clientType: "claude" });
  const codex = await createToken(owner.user.id, { label: "Laptop Codex", clientType: "codex" });
  const { body: artifact } = await publish(owner.auth, {
    title: "Report",
    html: "<!doctype html><h1>Report</h1>",
    visibility,
  });
  const browser = await browserSession(owner.user.id);
  return { owner, codex, artifact, browser: browser.headers };
}

describe("mentions create tasks", () => {
  it("@claude, @codex and @<label> of the owner's connections; nothing else", async () => {
    const { owner, artifact, browser } = await setup();
    const stranger = await agent({ label: "Other Label", clientType: "claude" });
    const revoked = await createToken(owner.user.id, { label: "Old Bot" });
    await db()
      .update(agentConnections)
      .set({ revokedAt: nowIso() })
      .where(eq(agentConnections.id, revoked.connectionId))
      .run();

    const c = await postComment(browser, artifact.slug, {
      body: "@Claude and @codex, also @work-claude, @laptop-codex. Not @nobody, @other-label, @old-bot or me@claude.ai",
    });
    const tasks = await tasksOf(c.id);
    expect(
      tasks.map((t) => [t.targetLabel, t.targetClientType, t.targetConnection, t.state]),
    ).toEqual([
      ["@claude", "claude", null, "pending"],
      ["@codex", "codex", null, "pending"],
      ["@laptop-codex", null, expect.any(String), "pending"],
      ["@work-claude", null, owner.connectionId, "pending"],
    ]);
    expect(tasks.some((t) => t.targetConnection === stranger.connectionId)).toBe(false);
    expect(c.mentions.map((m: { target: string }) => m.target).sort()).toEqual([
      "@claude",
      "@codex",
      "@laptop-codex",
      "@work-claude",
    ]);
    expect(c.mentions[0]).toMatchObject({ state: "pending", result_version: null });
  });

  it("commenters and editors can mention; agent-authored comments never create tasks", async () => {
    const { owner, artifact } = await setup("allowlist");
    for (const role of ["commenter", "editor"] as const) {
      const user = await createUser();
      await grant(artifact.id, user.email, role);
      const headers = (await browserSession(user.id)).headers;
      const c = await postComment(headers, artifact.slug, { body: `@claude from ${role}` });
      expect((await tasksOf(c.id)).length, role).toBe(1);
    }
    // A confirmed allowlist viewer with the commenter role (no account).
    const email = uniqueEmail("client");
    await grant(artifact.id, email, "commenter");
    const byViewer = await postComment(await viewerSession(email), artifact.slug, {
      body: "@codex please",
    });
    expect((await tasksOf(byViewer.id)).map((t) => t.targetClientType)).toEqual(["codex"]);

    // The owner's agent: its comment is stored, but its mentions stay text.
    const byAgent = await postComment(owner.auth, artifact.slug, {
      body: "@claude @codex @work-claude",
    });
    expect(byAgent.mentions).toEqual([]);
    expect(await tasksOf(byAgent.id)).toEqual([]);
  });

  it("an editor's mention targets the owner's connections, never the editor's own", async () => {
    const { artifact } = await setup();
    const editor = await agent({ label: "Editor Bot", clientType: "claude" });
    await grant(artifact.id, editor.user.email, "editor");
    const headers = (await browserSession(editor.user.id)).headers;
    const c = await postComment(headers, artifact.slug, { body: "@editor-bot and @claude" });
    expect((await tasksOf(c.id)).map((t) => t.targetLabel)).toEqual(["@claude"]);
    // The editor's own Claude cannot see the owner's @claude task.
    expect((await listMentionsRest(editor.token)).body.items).toEqual([]);
  });
});

describe("list_mentions visibility", () => {
  it("shows tasks to the matching agent of the owner only", async () => {
    const { owner, codex, artifact, browser } = await setup();
    const otherClaude = await createToken(owner.user.id, {
      label: "Home Claude",
      clientType: "claude",
    });
    const noScope = await createToken(owner.user.id, {
      label: "Read Only",
      clientType: "claude",
      scopes: "artifacts:read artifacts:write",
    });
    const strangerClaude = await agent({ label: "Work Claude", clientType: "claude" });

    const c = await postComment(browser, artifact.slug, {
      body: "@claude make the heading red",
      anchor: { selector: "h1", text: "Report", x: 0.5, y: 0.5 },
    });
    const pinned = await postComment(browser, artifact.slug, { body: "@work-claude only you" });

    const mine = await listMentionsRest(owner.token);
    expect(mine.res.status).toBe(200);
    expect(mine.body.items).toHaveLength(2);
    expect(mine.body.items[0]).toMatchObject({
      comment_id: c.id,
      artifact_id: artifact.id,
      artifact_slug: artifact.slug,
      artifact_title: "Report",
      state: "pending",
      target: "@claude",
      comment_body: "@claude make the heading red",
      comment_author: owner.user.email,
      anchor: { selector: "h1", text: "Report", x: 0.5, y: 0.5 },
      version_number: 1,
      claimed_by: null,
      result_version: null,
    });
    expect(mine.body.items[1]).toMatchObject({ comment_id: pinned.id, target: "@work-claude" });

    // Another Claude connection of the owner sees @claude but not the task for "Work Claude".
    const home = await listMentionsRest(otherClaude.token);
    expect(home.body.items.map((t: { target: string }) => t.target)).toEqual(["@claude"]);
    // Wrong client type, another user's agent (even with the same label), missing scope.
    expect((await listMentionsRest(codex.token)).body.items).toEqual([]);
    expect((await listMentionsRest(strangerClaude.token)).body.items).toEqual([]);
    const denied = await listMentionsRest(noScope.token);
    expect(denied.res.status).toBe(403);
    // People do not read the queue; anonymous callers are refused.
    expect((await call("/api/v1/mentions", { headers: browser })).status).toBe(403);
    expect((await call("/api/v1/mentions")).status).toBe(401);
    // Other states are filtered; an unknown state is invalid.
    expect((await listMentionsRest(owner.token, "done")).body.items).toEqual([]);
    expect((await listMentionsRest(owner.token, "nope")).res.status).toBe(400);

    // MCP mirrors REST.
    const client = await mcpClient(codex.token);
    expect((await tool(client, "list_mentions", {})).data.items).toEqual([]);
    const own = await mcpClient(owner.token);
    expect((await tool(own, "list_mentions", { state: "pending" })).data.items).toHaveLength(2);
  });

  it("tasks on deleted artifacts disappear; claiming a task you cannot see is 404", async () => {
    const { owner, codex, artifact, browser } = await setup();
    const c = await postComment(browser, artifact.slug, { body: "@claude hi" });
    const [task] = await tasksOf(c.id);
    expect((await claimRest(codex.token, task?.id ?? "")).status).toBe(404);
    const stranger = await agent({ clientType: "claude" });
    expect((await claimRest(stranger.token, task?.id ?? "")).status).toBe(404);
    expect((await claimRest(owner.token, "no-such-task")).status).toBe(404);
    await call(`/api/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: owner.auth });
    expect((await listMentionsRest(owner.token)).body.items).toEqual([]);
    expect((await claimRest(owner.token, task?.id ?? "")).status).toBe(404);
  });
});

describe("claim_mention is atomic", () => {
  async function tenClaudes() {
    const s = await setup();
    const tokens = [s.owner.token];
    for (let i = 0; i < 9; i++) {
      tokens.push(
        (await createToken(s.owner.user.id, { label: `Claude ${i}`, clientType: "claude" })).token,
      );
    }
    const c = await postComment(s.browser, s.artifact.slug, { body: "@claude do it" });
    const [task] = await tasksOf(c.id);
    if (!task) throw new Error("no task");
    return { ...s, tokens, task };
  }

  it("10 concurrent claims over /mcp: exactly one winner, the rest conflict", async () => {
    const { tokens, task } = await tenClaudes();
    const clients = await Promise.all(tokens.map((t) => mcpClient(t)));
    const results = await Promise.all(
      clients.map((c) => tool(c, "claim_mention", { task_id: task.id })),
    );
    const winners = results.filter((r) => !r.isError);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.data).toMatchObject({ id: task.id, state: "claimed" });
    for (const r of results.filter((r) => r.isError)) {
      expect(r.data.error.code).toBe("conflict");
    }
    const [row] = await db().select().from(mentionTasks).where(eq(mentionTasks.id, task.id)).all();
    expect(row?.state).toBe("claimed");
    expect(winners[0]?.data.claimed_by).toBe(row?.claimedBy);
  });

  it("10 concurrent claims over REST: exactly one 200, nine 409", async () => {
    const { tokens, task } = await tenClaudes();
    const responses = await Promise.all(tokens.map((t) => claimRest(t, task.id)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    // Claiming again, even by the winner, is a conflict.
    for (const t of tokens) expect((await claimRest(t, task.id)).status).toBe(409);
  });
});

describe("reply_comment", () => {
  it("full pull-mode flow through MCP tools", async () => {
    const { owner, artifact, browser } = await setup();
    const c = await postComment(browser, artifact.slug, {
      body: "@claude make the heading red",
      anchor: { selector: "h1", text: "Report" },
    });

    const client = await mcpClient(owner.token);
    const listed = await tool(client, "list_mentions", {});
    expect(listed.isError).toBe(false);
    const [task] = listed.data.items;
    expect(task).toMatchObject({ comment_id: c.id, comment_body: "@claude make the heading red" });

    const claimed = await tool(client, "claim_mention", { task_id: task.id });
    expect(claimed.data).toMatchObject({ state: "claimed", claimed_by: owner.connectionId });
    expect((await tool(client, "list_mentions", {})).data.items).toEqual([]);
    expect((await tool(client, "list_mentions", { state: "claimed" })).data.items).toHaveLength(1);

    const got = await tool(client, "get_artifact", { id: task.artifact_id });
    const html = (got.data.html as string).replace("<h1>", '<h1 style="color:red">');
    const updated = await tool(client, "update_artifact", {
      id: task.artifact_id,
      html,
      note: "Heading red, as asked in a comment",
      base_version: got.data.version,
    });
    expect(updated.data.version).toBe(2);

    const reply = await tool(client, "reply_comment", {
      comment_id: task.comment_id,
      body: "Done: the heading is red in v2.",
      result_version: updated.data.version,
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data).toMatchObject({
      parent_id: c.id,
      version_number: 2,
      body: "Done: the heading is red in v2.",
      author: { label: "Work Claude", connection_id: owner.connectionId },
      mentions: [],
    });

    const done = await tool(client, "list_mentions", { state: "done" });
    expect(done.data.items).toEqual([
      expect.objectContaining({ id: task.id, state: "done", result_version: 2 }),
    ]);

    // The thread, as the app sees it.
    const thread = await json(
      await call(`/api/v1/artifacts/${artifact.slug}/comments`, { headers: browser }),
    );
    expect(thread.items.map((x: { id: string }) => x.id)).toEqual([c.id, reply.data.id]);
    expect(thread.items[0].mentions).toEqual([
      { task_id: task.id, target: "@claude", state: "done", delivery: null, result_version: 2 },
    ]);
    // The new version exists and is current.
    const v2 = await tool(client, "get_artifact", { id: artifact.id });
    expect(v2.data).toMatchObject({ version: 2, current_version: 2 });
    expect(v2.data.html).toContain('<h1 style="color:red">');
  });

  it("validates result_version and supports failed", async () => {
    const { owner, artifact, browser } = await setup();
    const c = await postComment(browser, artifact.slug, { body: "@claude something impossible" });
    const [task] = await tasksOf(c.id);
    const reply = (body: Record<string, unknown>) =>
      call(`/api/v1/comments/${c.id}/reply`, {
        method: "POST",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // Without a claim, result_version is refused; a plain reply is just a comment.
    expect((await reply({ body: "done", result_version: 1 })).status).toBe(409);
    const plain = await reply({ body: "Looking at it" });
    expect(plain.status).toBe(201);
    expect((await tasksOf(c.id))[0]?.state).toBe("pending");

    expect((await claimRest(owner.token, task?.id ?? "")).status).toBe(200);
    // Not newer than the comment's version, or not existing, or both flags.
    expect((await reply({ body: "x", result_version: 1 })).status).toBe(400);
    expect((await reply({ body: "x", result_version: 5 })).status).toBe(404);
    expect((await reply({ body: "x", result_version: 2, failed: true })).status).toBe(400);
    // Progress reply keeps the claim.
    expect((await reply({ body: "Still working" })).status).toBe(201);
    expect((await tasksOf(c.id))[0]?.state).toBe("claimed");

    const failed = await reply({ body: "I could not do this.", failed: true });
    expect(failed.status).toBe(201);
    const [row] = await tasksOf(c.id);
    expect(row).toMatchObject({ state: "failed", resultVersion: null });
    expect(row?.completedAt).toBeTruthy();
    // A finished task cannot be completed again.
    expect((await reply({ body: "x", failed: true })).status).toBe(409);
  });

  it("only the connection that claimed the task can complete it", async () => {
    const { owner, artifact, browser } = await setup();
    const other = await createToken(owner.user.id, { label: "Home Claude", clientType: "claude" });
    const c = await postComment(browser, artifact.slug, { body: "@claude go" });
    const [task] = await tasksOf(c.id);
    expect((await claimRest(owner.token, task?.id ?? "")).status).toBe(200);
    const res = await call(`/api/v1/comments/${c.id}/reply`, {
      method: "POST",
      headers: { ...bearer(other.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "mine", failed: true }),
    });
    expect(res.status).toBe(409);
    expect((await tasksOf(c.id))[0]?.state).toBe("claimed");
  });

  it("people reply through REST; replies attach to the thread root", async () => {
    const { artifact, browser } = await setup("allowlist");
    const commenter = await createUser();
    await grant(artifact.id, commenter.email, "commenter");
    const headers = (await browserSession(commenter.id)).headers;
    const root = await postComment(browser, artifact.slug, { body: "Root" });
    const child = await postComment(browser, artifact.slug, { body: "Child", parent_id: root.id });
    const res = await call(`/api/v1/comments/${child.id}/reply`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "@claude can you help" }),
    });
    expect(res.status).toBe(201);
    const reply = await json(res);
    expect(reply).toMatchObject({ parent_id: root.id, author: { email: commenter.email } });
    // A person's reply with a mention creates a task like any comment.
    expect(reply.mentions).toEqual([expect.objectContaining({ target: "@claude" })]);

    const viewer = await createUser();
    await grant(artifact.id, viewer.email, "viewer");
    const denied = await call(`/api/v1/comments/${root.id}/reply`, {
      method: "POST",
      headers: { ...(await browserSession(viewer.id)).headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(denied.status).toBe(403);
  });
});

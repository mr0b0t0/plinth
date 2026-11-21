// Ask an agent (docs/spec.md "Ask an agent"): a comment's `request_to` makes a mention task for the
// owner's connections of one client type, `other` included, and is refused with `no_agent` when no
// such connection can take it; the gate's `ask` part lists those client types (never labels) for
// everyone who may mention; the `live_off` part says why editing on the page is off, exactly where
// `live` would be.

import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConnections, comments, mentionTasks } from "../src/db/schema.ts";
import { peek } from "../src/lib/ratelimit.ts";
import { nowIso } from "../src/lib/time.ts";
import { takesRequests } from "../src/policy.ts";
import {
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  db,
  fetchWith,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";
import { grant } from "./room-helpers.ts";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An owner whose only connection is a mentions-less token (so it is no target), and an artifact. */
async function ownerWith(body: Record<string, unknown> = {}) {
  const owner = await agent({ scopes: "artifacts:read artifacts:write", label: "Publisher" });
  const { body: a } = await publish(owner.auth, { visibility: "allowlist", ...body });
  const session = await browserSession(owner.user.id);
  return { owner, id: a.id as string, slug: a.slug as string, session };
}

async function personWith(id: string, role: Role) {
  const user = await createUser();
  await grant(id, user.email, role);
  return { user, session: await browserSession(user.id) };
}

function postComment(headers: Record<string, string>, ref: string, body: Record<string, unknown>) {
  return call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tasksOf(commentId: string) {
  return db()
    .select()
    .from(mentionTasks)
    .where(eq(mentionTasks.commentId, commentId))
    .orderBy(asc(mentionTasks.targetLabel))
    .all();
}

async function commentCount(artifactId: string) {
  const rows = await db().select().from(comments).where(eq(comments.artifactId, artifactId)).all();
  return rows.length;
}

const gate = async (id: string, headers: Record<string, string>, vars?: Record<string, string>) =>
  json(
    vars
      ? await fetchWith(vars, `/api/v1/view/${id}`, { headers })
      : await call(`/api/v1/view/${id}`, { headers }),
  );

describe("request_to on a new comment", () => {
  for (const clientType of ["claude", "codex", "other"] as const) {
    it(`makes one task for the owner's ${clientType} connections`, async () => {
      const { owner, id } = await ownerWith();
      await createToken(owner.user.id, { clientType, label: `My ${clientType}` });
      const commenter = await personWith(id, "commenter");
      const res = await postComment(commenter.session.headers, id, {
        body: "Make the heading red",
        request_to: clientType,
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const c = await json(res);
      const label = { claude: "@claude", codex: "@codex", other: "@agent:other" }[clientType];
      expect(c.mentions).toEqual([
        { task_id: expect.any(String), target: label, state: "pending", result_version: null },
      ]);
      const tasks = await tasksOf(c.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        targetClientType: clientType,
        targetConnection: null,
        targetLabel: label,
        state: "pending",
      });
      // The body is the person's description, unchanged: no @name was added to it.
      expect(c.body).toBe("Make the heading red");
    });
  }

  it("does not make a second task for a client type the body already names", async () => {
    const { owner, id, session } = await ownerWith();
    await createToken(owner.user.id, { clientType: "claude" });
    const res = await postComment(session.headers, id, {
      body: "@claude make the heading red",
      request_to: "claude",
    });
    expect(res.status).toBe(201);
    const tasks = await tasksOf((await json(res)).id);
    expect(tasks.map((t) => t.targetLabel)).toEqual(["@claude"]);
  });

  it("keeps the anchor the person picked", async () => {
    const { owner, id } = await ownerWith();
    await createToken(owner.user.id, { clientType: "claude" });
    const editor = await personWith(id, "editor");
    const anchor = { selector: "h1", text: "Hello", x: 0.5, y: 0.5 };
    const res = await postComment(editor.session.headers, id, {
      body: "Bigger",
      anchor,
      request_to: "claude",
    });
    expect(res.status).toBe(201);
    expect((await json(res)).anchor).toEqual(anchor);
  });

  it("is refused with no_agent, writing nothing, when no connection of that type can take it", async () => {
    const { owner, id, session } = await ownerWith();
    // A Claude token that was revoked, a Claude token limited to this artifact, and a Claude
    // token without the mentions scope: none of them can take a request.
    const revoked = await createToken(owner.user.id, { clientType: "claude" });
    await db()
      .update(agentConnections)
      .set({ revokedAt: nowIso() })
      .where(eq(agentConnections.id, revoked.connectionId))
      .run();
    await createToken(owner.user.id, {
      clientType: "claude",
      artifactId: id,
      scopes: "artifacts:read artifacts:write",
    });
    await createToken(owner.user.id, { clientType: "claude", scopes: "artifacts:read" });
    // Someone else's Claude connection never counts.
    const other = await createUser();
    await createToken(other.id, { clientType: "claude" });

    const before = await commentCount(id);
    const res = await postComment(session.headers, id, { body: "Please", request_to: "claude" });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.details).toMatchObject({ field: "request_to", reason: "no_agent" });
    expect(await commentCount(id)).toBe(before);
    // A plain comment still posts.
    expect((await postComment(session.headers, id, { body: "Please" })).status).toBe(201);
  });

  it("does not count a request no agent can take against the comment limit", async () => {
    const { id, session, owner } = await ownerWith();
    const key = `comment:u:${owner.user.id}`;
    const before = await peek(env.DB, key, 3600);
    const refused = await postComment(session.headers, id, { body: "Please", request_to: "codex" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error.details).toMatchObject({ reason: "no_agent" });
    expect(await peek(env.DB, key, 3600)).toBe(before);
    // A viewer, who may not ask, is refused before it counts too.
    const viewer = await personWith(id, "viewer");
    const vkey = `comment:u:${viewer.user.id}`;
    const res = await postComment(viewer.session.headers, id, { body: "Hi", request_to: "codex" });
    expect(res.status).toBe(403);
    expect(await peek(env.DB, vkey, 3600)).toBe(0);
    // A plain comment still counts.
    expect((await postComment(session.headers, id, { body: "Please" })).status).toBe(201);
    expect(await peek(env.DB, key, 3600)).toBe(before + 1);
  });

  it("keeps the generic target apart from a connection labelled Agent", async () => {
    const { owner, id, session } = await ownerWith();
    const labelled = await createToken(owner.user.id, { clientType: "claude", label: "Agent" });
    await createToken(owner.user.id, { clientType: "other", label: "ChatGPT" });
    const asked = await json(
      await postComment(session.headers, id, { body: "Add a footer", request_to: "other" }),
    );
    const mentioned = await json(
      await postComment(session.headers, id, { body: "@agent add a footer" }),
    );
    const [request] = await tasksOf(asked.id);
    const [mention] = await tasksOf(mentioned.id);
    expect(request).toMatchObject({
      targetLabel: "@agent:other",
      targetClientType: "other",
      targetConnection: null,
    });
    expect(mention).toMatchObject({
      targetLabel: "@agent",
      targetClientType: null,
      targetConnection: labelled.connectionId,
    });
    expect(asked.mentions[0].target).not.toBe(mentioned.mentions[0].target);
  });

  it("is refused on a reply", async () => {
    const { owner, id, session } = await ownerWith();
    await createToken(owner.user.id, { clientType: "claude" });
    const root = await json(await postComment(session.headers, id, { body: "Root" }));
    const res = await postComment(session.headers, id, {
      body: "Reply",
      parent_id: root.id,
      request_to: "claude",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details).toMatchObject({ reason: "reply" });
  });

  it("makes no task when an agent writes the comment", async () => {
    const { owner, id } = await ownerWith();
    const claude = await createToken(owner.user.id, { clientType: "claude" });
    const res = await postComment(bearer(claude.token), id, {
      body: "Note to self",
      request_to: "claude",
    });
    expect(res.status).toBe(201);
    expect(await tasksOf((await json(res)).id)).toEqual([]);
  });

  it("an `other` connection lists and claims the request; Claude never sees it", async () => {
    const { owner, id } = await ownerWith();
    const chatgpt = await createToken(owner.user.id, { clientType: "other", label: "ChatGPT" });
    const claude = await createToken(owner.user.id, { clientType: "claude" });
    const commenter = await personWith(id, "commenter");
    const c = await json(
      await postComment(commenter.session.headers, id, {
        body: "Add a footer",
        request_to: "other",
      }),
    );

    const client = await mcpClient(chatgpt.token);
    const listed = await tool(client, "list_mentions", {});
    const task = listed.data.items.find((t: { comment_id: string }) => t.comment_id === c.id);
    expect(task).toMatchObject({
      target: "@agent:other",
      comment_body: "Add a footer",
      comment_author_role: "commenter",
    });
    const claimed = await tool(client, "claim_mention", { task_id: task.id });
    expect(claimed.data.state).toBe("claimed");
    await client.close();

    const res = await call("/api/v1/mentions", { headers: bearer(claude.token) });
    const items = (await json(res)).items as { comment_id: string }[];
    expect(items.some((t) => t.comment_id === c.id)).toBe(false);
  });
});

describe("the ask gate part", () => {
  it("lists the client types that can take requests, for the owner, editors and commenters", async () => {
    const { owner, id, session } = await ownerWith();
    await createToken(owner.user.id, { clientType: "codex", label: "Laptop Codex" });
    await createToken(owner.user.id, { clientType: "claude", label: "Work Claude" });
    await createToken(owner.user.id, { clientType: "claude", label: "Home Claude" });
    // Limited to one artifact, or without mentions: not targets.
    await createToken(owner.user.id, {
      clientType: "other",
      artifactId: id,
      scopes: "artifacts:read",
    });
    const g = await gate(id, session.headers);
    expect(g.ask).toEqual({ targets: ["claude", "codex"] });
    // Labels never leave the owner's connections.
    expect(JSON.stringify(g)).not.toContain("Work Claude");
    for (const role of ["editor", "commenter"] as const) {
      const p = await personWith(id, role);
      expect((await gate(id, p.session.headers)).ask).toEqual({ targets: ["claude", "codex"] });
    }
  });

  it("has empty targets when the owner has no connection that can take requests", async () => {
    const { id, session } = await ownerWith();
    expect((await gate(id, session.headers)).ask).toEqual({ targets: [] });
  });

  it("is absent for viewers, link viewers and agents", async () => {
    const { owner, id } = await ownerWith({ visibility: "unlisted" });
    const claude = await createToken(owner.user.id, { clientType: "claude" });
    const viewer = await personWith(id, "viewer");
    expect((await gate(id, viewer.session.headers)).ask).toBeUndefined();
    expect((await gate(id, {})).ask).toBeUndefined();
    const asAgent = await gate(id, bearer(claude.token));
    expect(asAgent.status).toBe("ok");
    expect(asAgent.ask).toBeUndefined();
  });
});

describe("the live_off gate part", () => {
  const doc = { type: "doc", content: "# Plan\n\nFirst.\n", html: undefined };

  it("says `disabled` under ALLOW_LIVE_EDITING=false, for owners and editors of a doc only", async () => {
    const { id, session } = await ownerWith(doc);
    const off = { ALLOW_LIVE_EDITING: "false" };
    const g = await gate(id, session.headers, off);
    expect(g.live_off).toEqual({ reason: "disabled" });
    expect(g.live).toBeUndefined();
    const editor = await personWith(id, "editor");
    expect((await gate(id, editor.session.headers, off)).live_off).toEqual({ reason: "disabled" });
    const commenter = await personWith(id, "commenter");
    expect((await gate(id, commenter.session.headers, off)).live_off).toBeUndefined();
  });

  it("says `isolation` under opaque isolation", async () => {
    const { id, session } = await ownerWith(doc);
    const g = await gate(id, session.headers, { CONTENT_ISOLATION: "opaque" });
    expect(g.live_off).toEqual({ reason: "isolation" });
    expect(g.live).toBeUndefined();
  });

  it("is never there with `live`, on an HTML page, or on a pinned version", async () => {
    const { id, session } = await ownerWith(doc);
    const on = await gate(id, session.headers);
    expect(on.live).toBeDefined();
    expect(on.live_off).toBeUndefined();
    const pinned = json(
      await fetchWith({ ALLOW_LIVE_EDITING: "false" }, `/api/v1/view/${id}?version=1`, {
        headers: session.headers,
      }),
    );
    expect((await pinned).live_off).toBeUndefined();
    const html = await ownerWith();
    expect(
      (await gate(html.id, html.session.headers, { ALLOW_LIVE_EDITING: "false" })).live_off,
    ).toBeUndefined();
  });
});

describe("takesRequests", () => {
  it("needs a connection that is not revoked, not bound and holds mentions", () => {
    const ok = { revokedAt: null, artifactId: null, scopes: new Set(["mentions"]) };
    expect(takesRequests(ok)).toBe(true);
    expect(takesRequests({ ...ok, revokedAt: nowIso() })).toBe(false);
    expect(takesRequests({ ...ok, artifactId: "a1" })).toBe(false);
    expect(takesRequests({ ...ok, scopes: new Set(["artifacts:read"]) })).toBe(false);
  });
});

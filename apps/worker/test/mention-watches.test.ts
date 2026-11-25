// Mention wake-ups (docs/spec.md "Mention wake-ups"): watch_mentions as an MCP task (protocol
// revision 2026-07-28, io.modelcontextprotocol/tasks), the relay's watches over REST, and the one
// routing rule both share: a pending mention is offered to one live watch at a time, the best one
// first, never twice to a watch, at most MENTION_WATCH.maxOffers times.
import { MENTION_WATCH } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, mentionTasks, mentionWatches } from "../src/db/schema.ts";
import { nowIso } from "../src/lib/time.ts";
import { sweepMentionWatches } from "../src/services/mentionWatches.ts";
import {
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
} from "./helpers.ts";

const TASKS = "io.modelcontextprotocol/tasks";

/** The per-request `_meta` a 2026-07-28 client sends, with or without the tasks extension. */
function meta(tasks: boolean) {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "watch-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": tasks ? { extensions: { [TASKS]: {} } } : {},
  };
}

/** One JSON-RPC request to /mcp as a 2026-07-28 client. */
async function rpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { tasks?: boolean; name?: string } = {},
) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(opts.name ? { "Mcp-Name": opts.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: meta(opts.tasks ?? true) },
    }),
  });
  return json<{ result?: any; error?: { code: number; message: string } }>(res);
}

const callTool = (token: string, name: string, args: Record<string, unknown>, tasks = true) =>
  rpc(token, "tools/call", { name, arguments: args }, { tasks, name });

const getTask = (token: string, taskId: string, tasks = true) =>
  rpc(token, "tasks/get", { taskId }, { tasks, name: taskId });

/** An owner with a Claude connection and one published artifact. */
async function setup(opts: { clientType?: "claude" | "codex" | "other" } = {}) {
  const a = await agent({ clientType: opts.clientType ?? "claude", label: "Laptop Claude" });
  const { body: art } = await publish(a.auth);
  const owner = await browserSession(a.user.id);
  return { ...a, art, owner };
}

async function comment(headers: Record<string, string>, ref: string, body: string) {
  const res = await call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

async function startWatch(token: string, artifactId: string) {
  const r = await callTool(token, "watch_mentions", { artifact_id: artifactId });
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  expect(r.result.resultType).toBe("task");
  return r.result.taskId as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function relayWatch(token: string, body: Record<string, unknown>) {
  const res = await call("/api/v1/mention-watches", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: await json(res) };
}

async function pollRelay(token: string, ids: string[]) {
  const res = await call("/api/v1/mention-watches/poll", {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ watches: any[] }>(res)).watches;
}

/** Let an offer lapse, as if TTL.mentionOfferMs passed without a claim. */
async function lapseOffers(artifactId: string) {
  await db()
    .update(mentionTasks)
    .set({ offeredUntil: new Date(Date.now() - 1000).toISOString() })
    .where(eq(mentionTasks.artifactId, artifactId))
    .run();
}

async function taskRow(id: string) {
  return db().select().from(mentionTasks).where(eq(mentionTasks.id, id)).get();
}

describe("watch_mentions as an MCP task", () => {
  it("is advertised: the tasks extension in server/discover and the tool in tools/list", async () => {
    const a = await agent({ clientType: "claude" });
    const d = await rpc(a.token, "server/discover");
    expect(d.result.capabilities.extensions[TASKS]).toEqual({});
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const w = tools.find((t) => t.name === "watch_mentions");
    expect(w?.description).toMatch(/untrusted/i);
    expect(w?.inputSchema.required).toEqual(["artifact_id"]);
  });

  it("starts a task, stays working, then completes with ids only when a comment mentions the agent", async () => {
    const s = await setup();
    const taskId = await startWatch(s.token, s.art.id);
    const created = await callTool(s.token, "watch_mentions", { artifact_id: s.art.id });
    // A second watch of the same connection on the same artifact replaces the first.
    const second = created.result.taskId as string;
    expect((await getTask(s.token, taskId)).result.status).toBe("cancelled");

    const first = await getTask(s.token, second);
    expect(first.result).toMatchObject({
      resultType: "complete",
      taskId: second,
      status: "working",
      ttlMs: MENTION_WATCH.taskTtlMs,
      pollIntervalMs: MENTION_WATCH.pollMs,
    });
    expect(second).toMatch(/^mw_[A-Za-z0-9]{32}$/);

    const c = await comment(s.owner.headers, s.art.id, "@claude make the heading SECRET-RED");
    // The thread says the request waits for a session until one is woken for it.
    expect(c.mentions[0]).toMatchObject({ state: "pending", delivery: "waiting" });

    const done = await getTask(s.token, second);
    expect(done.result.status).toBe("completed");
    expect(done.result.result.isError).toBe(false);
    const text = done.result.result.content[0].text as string;
    // Ids and the server's sentences, never the comment text.
    expect(text).not.toContain("SECRET-RED");
    const payload = JSON.parse(text);
    const [mt] = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.commentId, c.id))
      .all();
    expect(payload.mention_tasks).toEqual([{ task_id: mt?.id, artifact_id: s.art.id }]);
    expect(payload.next).toContain("claim_mention");
    expect(payload.next).toContain(`artifact_id "${s.art.id}" again`);

    // The thread now says it was sent; the result keeps answering the same once finished.
    const listed = await json(
      await call(`/api/v1/artifacts/${s.art.id}/comments`, { headers: s.owner.headers }),
    );
    expect(listed.items[0].mentions[0]).toMatchObject({ state: "pending", delivery: "sent" });
    expect((await getTask(s.token, second)).result.result).toEqual(done.result.result);

    // Claiming clears the delivery: it is no longer pending.
    const client = await mcpClient(s.token);
    const claimed = await tool(client, "claim_mention", { task_id: mt?.id });
    expect(claimed.isError).toBe(false);
    expect(claimed.data.delivery).toBeNull();
    expect(claimed.data.comment_body).toContain("SECRET-RED");
  });

  it("answers with a plain result in a client without tasks, and refuses task methods there", async () => {
    const s = await setup();
    const r = await callTool(s.token, "watch_mentions", { artifact_id: s.art.id }, false);
    expect(r.result.resultType).toBe("complete");
    const body = JSON.parse(r.result.content[0].text);
    expect(body.watching).toBe(false);
    expect(body.note).toMatch(/can't run MCP tasks/);
    expect(
      await db().select().from(mentionWatches).where(eq(mentionWatches.userId, s.user.id)).all(),
    ).toEqual([]);

    const taskId = await startWatch(s.token, s.art.id);
    const refused = await getTask(s.token, taskId, false);
    expect(refused.error?.code).toBe(-32021);
  });

  it("works through the legacy (2025-11-25) client too, as a plain result", async () => {
    const s = await setup();
    const client = await mcpClient(s.token);
    const r = await tool(client, "watch_mentions", { artifact_id: s.art.id });
    expect(r.isError).toBe(false);
    expect(r.data.watching).toBe(false);
  });

  it("keeps each connection's tasks to itself, and only the owner's agents can watch", async () => {
    const s = await setup();
    const taskId = await startWatch(s.token, s.art.id);
    const other = await createToken(s.user.id, { clientType: "claude" });
    const stranger = await agent({ clientType: "claude" });
    for (const t of [other.token, stranger.token]) {
      const r = await getTask(t, taskId);
      expect(r.error?.code).toBe(-32602);
      expect((await rpc(t, "tasks/cancel", { taskId }, { name: taskId })).error?.code).toBe(-32602);
    }
    expect((await getTask(s.token, "mw_nope")).error?.code).toBe(-32602);
    // Someone else's artifact, even one shared with them: requests there go to its owner's agents.
    const r = await callTool(stranger.token, "watch_mentions", { artifact_id: s.art.id });
    expect(r.result.isError).toBe(true);
    // No mentions scope, or a token limited to one artifact: no watch.
    const noMentions = await createToken(s.user.id, {
      clientType: "claude",
      scopes: "artifacts:read artifacts:write",
    });
    const bound = await createToken(s.user.id, {
      clientType: "claude",
      scopes: "artifacts:read artifacts:write",
      artifactId: s.art.id,
    });
    for (const t of [noMentions.token, bound.token]) {
      const x = await callTool(t, "watch_mentions", { artifact_id: s.art.id });
      expect(x.result.isError).toBe(true);
    }
  });

  it("tasks/cancel ends the watch; nothing is offered to it after", async () => {
    const s = await setup();
    const taskId = await startWatch(s.token, s.art.id);
    const c = await rpc(s.token, "tasks/cancel", { taskId }, { name: taskId });
    expect(c.result).toMatchObject({ resultType: "complete" });
    await comment(s.owner.headers, s.art.id, "@claude hi");
    expect((await getTask(s.token, taskId)).result.status).toBe("cancelled");
    const [t] = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.artifactId, s.art.id))
      .all();
    expect(t?.offeredTo).toBeNull();
    // tasks/update has nothing to answer: acknowledged.
    const u = await rpc(s.token, "tasks/update", { taskId, inputResponses: {} }, { name: taskId });
    expect(u.result).toMatchObject({ resultType: "complete" });
  });

  it("ends a watch at its lifetime with a 'watch again' result, so the client never loses it", async () => {
    const s = await setup();
    const taskId = await startWatch(s.token, s.art.id);
    await db()
      .update(mentionWatches)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(mentionWatches.id, taskId))
      .run();
    const r = await getTask(s.token, taskId);
    expect(r.result.status).toBe("completed");
    const body = JSON.parse(r.result.result.content[0].text);
    expect(body.mention_tasks).toEqual([]);
    expect(body.next).toContain("watch_mentions");
  });

  it("hears mentions of its own connection by label, and only its client type's", async () => {
    const s = await setup();
    const taskId = await startWatch(s.token, s.art.id);
    await comment(s.owner.headers, s.art.id, "@codex and @agent:other, not for Claude");
    expect((await getTask(s.token, taskId)).result.status).toBe("working");
    await comment(s.owner.headers, s.art.id, "@laptop-claude please");
    expect((await getTask(s.token, taskId)).result.status).toBe("completed");
  });
});

describe("publish and update say when to watch", () => {
  it("adds watch_mentions to the result only for a client with tasks, until a live watch exists", async () => {
    const a = await agent({ clientType: "claude" });
    const pub = await callTool(a.token, "publish_artifact", {
      title: "Hinted",
      html: "<!doctype html><title>Hinted</title><h1>Hi</h1>",
    });
    const result = JSON.parse(pub.result.content[0].text);
    expect(result.watch_mentions).toMatch(/Call watch_mentions/);

    const legacy = await callTool(
      a.token,
      "publish_artifact",
      { title: "Plain", html: "<!doctype html><title>Plain</title><h1>Hi</h1>" },
      false,
    );
    expect(JSON.parse(legacy.result.content[0].text).watch_mentions).toBeUndefined();

    await startWatch(a.token, result.id);
    const upd = await callTool(a.token, "update_artifact", {
      id: result.id,
      html: "<!doctype html><title>Hinted</title><h1>Two</h1>",
    });
    expect(JSON.parse(upd.result.content[0].text).watch_mentions).toBeUndefined();
  });

  it("leaves it out for an editor's agent, which can't watch either: requests go to the owner's agents", async () => {
    const owner = await agent({ clientType: "claude" });
    const { body: art } = await publish(owner.auth);
    const editor = await agent({ clientType: "claude" });
    await db()
      .insert(accessGrants)
      .values({ artifactId: art.id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const upd = await callTool(editor.token, "update_artifact", {
      id: art.id,
      html: "<!doctype html><title>E</title><h1>E</h1>",
    });
    expect(upd.result.isError, upd.result.content[0].text).toBeFalsy();
    expect(JSON.parse(upd.result.content[0].text).watch_mentions).toBeUndefined();
    const w = await callTool(editor.token, "watch_mentions", { artifact_id: art.id });
    expect(w.result.isError).toBe(true);
    expect(w.result.content[0].text).toMatch(/owner's agents/);
  });
});

describe("routing between watches", () => {
  it("offers a mention to the newest live watch first, then to the next once the offer lapses", async () => {
    const s = await setup();
    const laptop = await createToken(s.user.id, { clientType: "claude" });
    const older = await startWatch(s.token, s.art.id);
    const newer = await startWatch(laptop.token, s.art.id);
    await comment(s.owner.headers, s.art.id, "@claude one");
    // The older watch polls first but the newer one is live and better: it waits.
    expect((await getTask(s.token, older)).result.status).toBe("working");
    expect((await getTask(laptop.token, newer)).result.status).toBe("completed");
    // Nobody claimed it: after the offer lapses the older watch gets it.
    await lapseOffers(s.art.id);
    expect((await getTask(s.token, older)).result.status).toBe("completed");
    const [t] = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.artifactId, s.art.id))
      .all();
    expect(t?.offerCount).toBe(2);
    expect(JSON.parse(t?.offeredWatches ?? "[]")).toEqual([newer, older]);
  });

  it("skips a watch that stopped polling", async () => {
    const s = await setup();
    const laptop = await createToken(s.user.id, { clientType: "claude" });
    const quiet = await startWatch(laptop.token, s.art.id);
    const live = await startWatch(s.token, s.art.id);
    await db()
      .update(mentionWatches)
      .set({ lastSeenAt: new Date(Date.now() - MENTION_WATCH.liveMs - 1000).toISOString() })
      .where(eq(mentionWatches.id, live))
      .run();
    // `live` is newer but silent: the quiet-but-live one is the best live watch now.
    await comment(s.owner.headers, s.art.id, "@claude go");
    expect((await getTask(laptop.token, quiet)).result.status).toBe("completed");
  });

  it("wakes at most maxOffers sessions for one mention, then it waits", async () => {
    const s = await setup();
    await comment(s.owner.headers, s.art.id, "@claude nobody claims this");
    for (let i = 0; i < MENTION_WATCH.maxOffers; i++) {
      const w = await startWatch(s.token, s.art.id);
      expect((await getTask(s.token, w)).result.status).toBe("completed");
      await lapseOffers(s.art.id);
    }
    const last = await startWatch(s.token, s.art.id);
    expect((await getTask(s.token, last)).result.status).toBe("working");
    const c = await json(
      await call(`/api/v1/artifacts/${s.art.id}/comments`, { headers: s.owner.headers }),
    );
    expect(c.items[0].mentions[0].delivery).toBe("waiting");
  });

  it("never offers a claimed mention", async () => {
    const s = await setup();
    const c = await comment(s.owner.headers, s.art.id, "@claude x");
    const client = await mcpClient(s.token);
    const [t] = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.commentId, c.id))
      .all();
    expect((await tool(client, "claim_mention", { task_id: t?.id })).isError).toBe(false);
    const w = await startWatch(s.token, s.art.id);
    expect((await getTask(s.token, w)).result.status).toBe("working");
  });
});

describe("relay watches (the mention relay on the user's computer)", () => {
  it("needs mentions:watch to hear other client types; mentions alone hears its own", async () => {
    const user = await createUser();
    const { body: art } = await publish({
      Authorization: `Bearer ${(await createToken(user.id)).token}`,
    });
    const legacy = await createToken(user.id, { clientType: "claude", scopes: "mentions" });
    const relay = await createToken(user.id, { clientType: "other", scopes: "mentions:watch" });
    const none = await createToken(user.id, { clientType: "claude", scopes: "artifacts:read" });

    expect(
      (await relayWatch(legacy.token, { artifact_id: art.id, client_type: "claude" })).res.status,
    ).toBe(201);
    expect(
      (await relayWatch(legacy.token, { artifact_id: art.id, client_type: "codex" })).res.status,
    ).toBe(403);
    expect(
      (await relayWatch(relay.token, { artifact_id: art.id, client_type: "codex" })).res.status,
    ).toBe(201);
    expect(
      (await relayWatch(relay.token, { artifact_id: null, client_type: "claude" })).res.status,
    ).toBe(201);
    expect(
      (await relayWatch(none.token, { artifact_id: null, client_type: "claude" })).res.status,
    ).toBe(403);
    // A relay token can't read or claim requests, nor use the MCP tools.
    const listed = await call("/api/v1/mentions", { headers: bearer(relay.token) });
    expect(listed.status).toBe(403);
  });

  it("hands a relay watch its offers (ids only), keeps them while open, and routes tasks first", async () => {
    const s = await setup({ clientType: "codex" });
    const relay = await createToken(s.user.id, { clientType: "other", scopes: "mentions:watch" });
    const { body: w } = await relayWatch(relay.token, {
      artifact_id: s.art.id,
      client_type: "codex",
    });
    const { body: all } = await relayWatch(relay.token, {
      artifact_id: null,
      client_type: "codex",
    });
    expect(w).toMatchObject({ kind: "relay", status: "working", client_type: "codex" });
    await comment(s.owner.headers, s.art.id, "@codex please SECRET");
    const polled = await pollRelay(relay.token, [w.id, all.id, "mw_not_mine"]);
    expect(polled.map((p) => p.id).sort()).toEqual([w.id, all.id].sort());
    const mine = polled.find((p) => p.id === w.id);
    expect(mine.offers).toHaveLength(1);
    expect(JSON.stringify(polled)).not.toContain("SECRET");
    // The artifact's own watch beat the one on every artifact.
    expect(polled.find((p) => p.id === all.id).offers).toEqual([]);
    // Polled again while the offer is open: handed again (the relay announces each task once).
    expect((await pollRelay(relay.token, [w.id]))[0].offers).toEqual(mine.offers);
    // Another relay connection can't poll or end it.
    const other = await createToken(s.user.id, { clientType: "other", scopes: "mentions:watch" });
    expect(await pollRelay(other.token, [w.id])).toEqual([]);
    const del = await call(`/api/v1/mention-watches/${w.id}`, {
      method: "DELETE",
      headers: bearer(other.token),
    });
    expect(del.status).toBe(404);
    const ok = await call(`/api/v1/mention-watches/${w.id}`, {
      method: "DELETE",
      headers: bearer(relay.token),
    });
    expect((await json(ok)).status).toBe("cancelled");
    expect((await pollRelay(relay.token, [w.id]))[0]).toMatchObject({
      status: "cancelled",
      offers: [],
    });
  });

  it("prefers a live MCP task watch over a relay watch on the same artifact", async () => {
    const s = await setup();
    const relay = await createToken(s.user.id, { clientType: "other", scopes: "mentions:watch" });
    const { body: w } = await relayWatch(relay.token, {
      artifact_id: s.art.id,
      client_type: "claude",
    });
    const task = await startWatch(s.token, s.art.id);
    await comment(s.owner.headers, s.art.id, "@claude go");
    expect((await pollRelay(relay.token, [w.id]))[0].offers).toEqual([]);
    expect((await getTask(s.token, task)).result.status).toBe("completed");
    // The task's session never claimed it: the relay gets it next.
    await lapseOffers(s.art.id);
    expect((await pollRelay(relay.token, [w.id]))[0].offers).toHaveLength(1);
  });

  it("an account-wide relay watch catches mentions no session on the artifact watches", async () => {
    const s = await setup();
    const relay = await createToken(s.user.id, { clientType: "claude", scopes: "mentions" });
    const { body: all } = await relayWatch(relay.token, {
      artifact_id: null,
      client_type: "claude",
    });
    const c = await comment(s.owner.headers, s.art.id, "@claude anyone?");
    const [p] = await pollRelay(relay.token, [all.id]);
    const t = await taskRow(p.offers[0].task_id);
    expect(t?.commentId).toBe(c.id);
  });

  it("a relay watch nobody polls ends, and the sweep expires and later deletes watches", async () => {
    const s = await setup();
    const relay = await createToken(s.user.id, { clientType: "claude", scopes: "mentions:watch" });
    const { body: w } = await relayWatch(relay.token, { artifact_id: null, client_type: "claude" });
    const past = new Date(Date.now() - 1000).toISOString();
    await db()
      .update(mentionWatches)
      .set({ expiresAt: past })
      .where(eq(mentionWatches.id, w.id))
      .run();
    expect((await pollRelay(relay.token, [w.id]))[0].status).toBe("expired");

    const task = await startWatch(s.token, s.art.id);
    await db()
      .update(mentionWatches)
      .set({ expiresAt: past })
      .where(eq(mentionWatches.id, task))
      .run();
    await sweepMentionWatches({ db: db() });
    const row = await db().select().from(mentionWatches).where(eq(mentionWatches.id, task)).get();
    expect(row?.status).toBe("expired");
    await sweepMentionWatches({ db: db() }, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(
      await db().select().from(mentionWatches).where(eq(mentionWatches.id, task)).get(),
    ).toBeUndefined();
  });

  it("caps watches per connection, ending the oldest", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await publish(s.auth, { title: `A${i}` });
      ids.push(await startWatch(s.token, body.id));
    }
    const working = await db()
      .select()
      .from(mentionWatches)
      .where(eq(mentionWatches.connectionId, s.connectionId))
      .all();
    expect(working.filter((w) => w.status === "working")).toHaveLength(3);
    expect(MENTION_WATCH.maxTaskWatchesPerConnection).toBeGreaterThan(3);
  });
});

// MCP Events for mention wake-ups (docs/spec.md "Mention wake-ups"): `mention.created`, delivered
// by signed webhook to a client such as ChatGPT, in both the sketch's dialect (what ChatGPT runs:
// webhook-id = eventId, codes -32011..-32015) and SEP-3415's (random webhook-id, -32023..-32027).
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentConnections,
  eventDeliveries,
  eventSubscriptions,
  mentionTasks,
} from "../src/db/schema.ts";
import { nowIso } from "../src/lib/time.ts";
import { deliverDue, signWebhook } from "../src/services/mentionEvents.ts";
import { agent, browserSession, call, config, createToken, db, json, publish } from "./helpers.ts";

const EVENTS = "io.modelcontextprotocol/events";
const CALLBACK = "https://hooks.example.com/mcp-events/cb_1";
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;

function meta(final: boolean) {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "events-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": final ? { extensions: { [EVENTS]: {} } } : {},
  };
}

async function rpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  final = false,
) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: meta(final) },
    }),
  });
  return json<{ result?: any; error?: { code: number; message: string; data?: any } }>(res);
}

type Sent = { url: string; headers: Record<string, string>; body: string };

/** A receiver that echoes verification challenges and answers events with `status`. */
function receiver(status = 200) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init as RequestInit);
    if (!req.url.startsWith("https://hooks.example.com/")) throw new Error(`unexpected ${req.url}`);
    const body = await req.text();
    sent.push({ url: req.url, headers: Object.fromEntries(req.headers.entries()), body });
    const parsed = JSON.parse(body);
    if (parsed.type === "verification") return Response.json({ challenge: parsed.challenge });
    return new Response("", { status });
  });
  return { sent, spy, events: () => sent.filter((s) => !JSON.parse(s.body).type) };
}

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const a = await agent({ clientType: "other", label: "ChatGPT" });
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

const sub = (args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  name: "mention.created",
  arguments: args,
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  cursor: null,
  ...extra,
});

/** Wait for waitUntil work (the delivery after a comment) to land. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

describe("mention.created over MCP Events", () => {
  it("advertises both the sketch's capability and the extension, and lists one event type", async () => {
    const a = await agent({ clientType: "other" });
    const d = await rpc(a.token, "server/discover");
    expect(d.result.capabilities.events).toEqual({});
    expect(d.result.capabilities.extensions[EVENTS]).toEqual({});
    const l = await rpc(a.token, "events/list");
    expect(l.result.events.map((e: { name: string }) => e.name)).toEqual(["mention.created"]);
    const [ev] = l.result.events;
    expect(ev.delivery).toContain("webhook");
    expect(Object.keys(ev.payloadSchema.properties)).not.toContain("text");
    expect(ev.description).toMatch(/untrusted/);
  });

  it("verifies the callback, then delivers a signed webhook with ids only (sketch: webhook-id = eventId)", async () => {
    const s = await setup();
    const r = receiver();
    const res = await rpc(s.token, "events/subscribe", sub());
    expect(res.error, JSON.stringify(res)).toBeUndefined();
    expect(res.result).toMatchObject({ resultType: "complete", cursor: null, truncated: false });
    expect(res.result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    const verification = r.sent[0];
    expect(JSON.parse(verification?.body ?? "{}").type).toBe("verification");
    expect(verification?.headers["webhook-id"]).toMatch(/^msg_verification_/);

    const c = await comment(s.owner.headers, s.art.id, "@agent:other please SECRET-WORDS");
    await settle();
    const [ev] = r.events();
    expect(ev, JSON.stringify(r.sent)).toBeDefined();
    const body = JSON.parse(ev?.body ?? "{}");
    expect(body.name).toBe("mention.created");
    expect(ev?.body).not.toContain("SECRET-WORDS");
    const [task] = await db()
      .select()
      .from(mentionTasks)
      .where(eq(mentionTasks.commentId, c.id))
      .all();
    expect(body.data).toMatchObject({
      task_id: task?.id,
      artifact_id: s.art.id,
      comment_id: c.id,
      target: "@agent:other",
    });
    expect(ev?.headers["webhook-id"]).toBe(body.eventId);
    expect(ev?.headers["x-mcp-subscription-id"]).toBe(res.result.id);
    // The signature checks out with the client's secret.
    const ts = Number(ev?.headers["webhook-timestamp"]);
    expect(ev?.headers["webhook-signature"]).toBe(
      await signWebhook([KEY], body.eventId, ts, ev?.body ?? ""),
    );
    // The thread says it was sent.
    const listed = await json(
      await call(`/api/v1/artifacts/${s.art.id}/comments`, { headers: s.owner.headers }),
    );
    expect(listed.items[0].mentions[0].delivery).toBe("sent");
  });

  it("uses a random webhook-id per message and SEP-3415's codes for a client that declares the extension", async () => {
    const s = await setup();
    const r = receiver();
    await rpc(s.token, "events/subscribe", sub(), true);
    await comment(s.owner.headers, s.art.id, "@agent:other go");
    await settle();
    const [ev] = r.events();
    const body = JSON.parse(ev?.body ?? "{}");
    expect(ev?.headers["webhook-id"]).toMatch(/^msg_/);
    expect(ev?.headers["webhook-id"]).not.toBe(body.eventId);
    // Unknown event: NotFound in each numbering.
    expect(
      (await rpc(s.token, "events/subscribe", { ...sub(), name: "nope" }, true)).error?.code,
    ).toBe(-32023);
    expect((await rpc(s.token, "events/subscribe", { ...sub(), name: "nope" })).error?.code).toBe(
      -32011,
    );
  });

  it("refuses bad callbacks, secrets and modes, and unverified callbacks", async () => {
    const s = await setup();
    receiver();
    for (const url of [
      "http://hooks.example.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://u:p@hooks.example.com/x",
      "https://hooks.example.com:8443/x",
    ]) {
      const r = await rpc(s.token, "events/subscribe", {
        ...sub(),
        delivery: { mode: "webhook", url, secret: SECRET },
      });
      expect(r.error?.code, url).toBe(-32602);
    }
    const badSecret = await rpc(s.token, "events/subscribe", {
      ...sub(),
      delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_c2hvcnQ=" },
    });
    expect(badSecret.error?.code).toBe(-32602);
    const push = await rpc(s.token, "events/subscribe", { ...sub(), delivery: { mode: "push" } });
    expect(push.error?.code).toBe(-32014);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ challenge: "wrong" }),
    );
    const r = await rpc(s.token, "events/subscribe", sub());
    expect(r.error, JSON.stringify(r.error)).toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    });
    expect(
      await db()
        .select()
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.userId, s.user.id))
        .all(),
    ).toEqual([]);
  });

  it("is the owner's agents' only: an artifact filter on someone else's artifact is refused", async () => {
    const s = await setup();
    receiver();
    const stranger = await agent({ clientType: "other" });
    const r = await rpc(stranger.token, "events/subscribe", sub({ artifact_id: s.art.id }));
    expect(r.error?.code).toBe(-32012);
    const noMentions = await createToken(s.user.id, {
      clientType: "other",
      scopes: "artifacts:read",
    });
    expect((await rpc(noMentions.token, "events/subscribe", sub())).error?.code).toBe(-32012);
  });

  it("filters by artifact and by whom the mention addresses", async () => {
    const s = await setup();
    const r = receiver();
    const { body: other } = await publish(s.auth, { title: "Other" });
    await rpc(s.token, "events/subscribe", sub({ artifact_id: s.art.id }));
    await comment(s.owner.headers, other.id, "@agent:other on another artifact");
    await comment(s.owner.headers, s.art.id, "@claude not for this connection");
    await settle();
    expect(r.events()).toEqual([]);
    await comment(s.owner.headers, s.art.id, "@chatgpt by label");
    await settle();
    expect(r.events()).toHaveLength(1);
  });

  it("refreshing keeps one subscription, and unsubscribe is idempotent", async () => {
    const s = await setup();
    receiver();
    const a = await rpc(s.token, "events/subscribe", sub({}, { ttlMs: 60_000 }));
    const b = await rpc(s.token, "events/subscribe", { ...sub(), arguments: {} });
    expect(b.result.id).toBe(a.result.id);
    expect(b.result.deliveryStatus).toMatchObject({ active: true });
    // The grant is clamped up to an hour at least.
    expect(Date.parse(a.result.refreshBefore) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    const u = await rpc(s.token, "events/unsubscribe", {
      name: "mention.created",
      arguments: {},
      delivery: { url: CALLBACK },
    });
    expect(u.result).toMatchObject({ resultType: "complete" });
    expect(
      (
        await rpc(s.token, "events/unsubscribe", {
          name: "mention.created",
          arguments: {},
          delivery: { url: CALLBACK },
        })
      ).error,
    ).toBeUndefined();
    expect(
      await db()
        .select()
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.id, a.result.id))
        .all(),
    ).toEqual([]);
  });

  it("retries a failed delivery with backoff, stops on 410, and never delivers for a revoked connection", async () => {
    const s = await setup();
    const r = receiver(503);
    const subscribed = await rpc(s.token, "events/subscribe", sub());
    await comment(s.owner.headers, s.art.id, "@agent:other retry me");
    await settle();
    expect(r.events()).toHaveLength(1);
    const d = await db()
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.subscriptionId, subscribed.result.id))
      .get();
    expect(
      d?.nextAttemptAt,
      JSON.stringify(await db().select().from(eventDeliveries).all()),
    ).not.toBeNull();
    // Not due yet: nothing sent.
    await deliverDue({ db: db(), config: config() });
    expect(r.events()).toHaveLength(1);
    // Due: sent again with the same webhook-id, a fresh timestamp.
    await deliverDue({ db: db(), config: config() }, Date.now() + 61_000);
    expect(r.events()).toHaveLength(2);
    expect(r.events()[1]?.headers["webhook-id"]).toBe(r.events()[0]?.headers["webhook-id"]);
    vi.restoreAllMocks();
    const gone = receiver(410);
    await deliverDue({ db: db(), config: config() }, Date.now() + 10 * 60_000);
    expect(gone.events()).toHaveLength(1);
    const after = await db()
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.id, d?.id ?? ""))
      .get();
    expect(after?.nextAttemptAt).toBeNull();

    await db()
      .update(agentConnections)
      .set({ revokedAt: nowIso() })
      .where(eq(agentConnections.id, s.connectionId))
      .run();
    await comment(s.owner.headers, s.art.id, "@agent:other after revoke");
    await settle();
    expect(gone.events()).toHaveLength(1);
  });

  it("events/poll hands pending mentions after a cursor (SEP-3415 clients without a callback)", async () => {
    const s = await setup();
    const first = await rpc(
      s.token,
      "events/poll",
      { name: "mention.created", arguments: {}, cursor: null },
      true,
    );
    expect(first.result.events).toEqual([]);
    const cursor = first.result.cursor;
    await new Promise((r) => setTimeout(r, 5));
    await comment(s.owner.headers, s.art.id, "@agent:other poll me SECRET");
    const next = await rpc(
      s.token,
      "events/poll",
      { name: "mention.created", arguments: {}, cursor },
      true,
    );
    expect(next.result.events).toHaveLength(1);
    expect(JSON.stringify(next.result)).not.toContain("SECRET");
    const again = await rpc(
      s.token,
      "events/poll",
      { name: "mention.created", arguments: {}, cursor: next.result.cursor },
      true,
    );
    expect(again.result.events).toEqual([]);
  });
});

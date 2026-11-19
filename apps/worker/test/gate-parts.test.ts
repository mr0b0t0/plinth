// The viewer gate is assembled from gate parts (api/view.ts GATE_PARTS). The wire shape is the
// same as before the parts: the fields every ok gate has, in order, then `data`, then `live`, then
// `people`, then `page_comments`, then `voice` (dictation, gate-voice in dictation.test.ts), then
// `watch` (live views, live-view.test.ts), then `hold` (live views, live-view-update.test.ts), then
// `files`, then `sources` and `removed_sources` (data sources, data-sources.test.ts), each only
// when its part has something to say. The parts run concurrently; their fields keep this order.
import { describe, expect, it } from "vitest";
import { GATE_PARTS, type GatePart } from "../src/api/view.ts";
import { run } from "./data-sources-helpers.ts";
import { APP, agent, browserSession, call, json, publish } from "./helpers.ts";

const DECLARED = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer room">
<meta name="plinth-data-shared" content="tasks"><p>poll</p>`;

async function gateAs(userId: string, id: string) {
  const s = await browserSession(userId);
  return json(await call(`/api/v1/view/${id}`, { headers: s.headers }));
}

const BASE_KEYS = ["status", "artifact", "enter_url", "role"];
const ARTIFACT_KEYS = [
  "id",
  "slug",
  "title",
  "type",
  "current_version",
  "version",
  "visibility",
  "owner_name",
];

describe("gate parts", () => {
  it("runs the data part, the live part, the people part, page comments, voice, watch, hold, files, then sources", () => {
    expect(GATE_PARTS.length).toBe(9);
  });

  it("a page that declares comments and data: `data`, then `page_comments`", async () => {
    const a = await agent();
    const html = DECLARED.replace('content="data viewer room"', 'content="data comments"');
    const { body } = await publish(a.auth, { html, visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "data", "page_comments", "watch"]);
    expect(gate.page_comments).toBe(true);
    expect(gate.data.capabilities).toEqual(["data", "comments"]);
  });

  it("a page that declares nothing: the fields every gate has, and `watch`", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "watch"]);
    expect(Object.keys(gate.artifact)).toEqual(ARTIFACT_KEYS);
    expect(gate.role).toBe("owner");
  });

  it("a page that declares shared data and a room: `data` after the base fields", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { html: DECLARED, visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "data", "watch"]);
    expect(Object.keys(gate.data)).toEqual([
      "available",
      "capabilities",
      "identified",
      "can_write",
      "email",
      "room_email",
    ]);
    expect(gate.data).toEqual({
      available: true,
      capabilities: ["data", "viewer", "room"],
      identified: true,
      can_write: true,
      email: a.user.email,
      room_email: a.user.email,
    });
  });

  it("a doc its owner opens: `live` after the base fields", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, {
      html: undefined,
      type: "doc",
      content: "# Notes\n",
      visibility: "allowlist",
    });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "live", "watch"]);
    expect(Object.keys(gate.live)).toEqual(["mode", "draft"]);
    expect(gate.live).toEqual({ mode: "room", draft: null });
  });

  it("runs the parts at the same time and still adds their fields in list order", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { visibility: "allowlist" });
    // The first extra part waits until the second has run: one after the other, the gate would
    // never answer. The second finishes first, and its field still comes last.
    let release: () => void = () => undefined;
    const second = new Promise<void>((r) => {
      release = r;
    });
    const extra: GatePart[] = [
      async () => {
        await second;
        return { extra_first: true } as never;
      },
      async () => {
        release();
        return { extra_second: true } as never;
      },
    ];
    const list = GATE_PARTS as GatePart[];
    list.push(...extra);
    try {
      // Through this module's own Worker, so the parts pushed here are the ones it runs.
      const s = await browserSession(a.user.id);
      const gate = await json(await run(`${APP}/api/v1/view/${body.id}`, { headers: s.headers }));
      expect(Object.keys(gate)).toEqual([...BASE_KEYS, "watch", "extra_first", "extra_second"]);
    } finally {
      list.splice(list.length - extra.length, extra.length);
    }
    expect(GATE_PARTS.length).toBe(9);
  });
});

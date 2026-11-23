// The viewer gate is assembled from gate parts (api/view.ts GATE_PARTS). The wire shape is the
// same as before the parts: the fields every ok gate has, in order, then `data`, then `live`, then
// `page_comments`, then `watch` (live views, live-view.test.ts), then `people`, then `hold` (live
// views, live-view-update.test.ts), then `ask` (the agents a comment can mention: for everyone who may mention, so for
// these owners, whose test token is an `other` connection), then `live_off` (ask-agent.test.ts),
// then `from_code` (published from code, published-from-code.test.ts), each only when its part
// has something to say.
import { describe, expect, it } from "vitest";
import { GATE_PARTS } from "../src/api/view.ts";
import { agent, browserSession, call, json, publish } from "./helpers.ts";

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
  it("runs the data part, the live part, page comments, watch, the people part, hold, ask, live_off, from_code, then no_editor", () => {
    expect(GATE_PARTS.length).toBe(10);
  });

  it("a page that declares comments and data: `data`, then `page_comments`", async () => {
    const a = await agent();
    const html = DECLARED.replace('content="data viewer room"', 'content="data comments"');
    const { body } = await publish(a.auth, { html, visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "data", "page_comments", "watch", "ask"]);
    expect(gate.page_comments).toBe(true);
    expect(gate.data.capabilities).toEqual(["data", "comments"]);
  });

  it("a page that declares nothing: the fields every gate has, `watch` and `ask`", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "watch", "ask"]);
    expect(gate.ask).toEqual({ targets: ["other"] });
    expect(Object.keys(gate.artifact)).toEqual(ARTIFACT_KEYS);
    expect(gate.role).toBe("owner");
  });

  it("a page that declares shared data and a room: `data` after the base fields", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { html: DECLARED, visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "data", "watch", "ask"]);
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
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "live", "watch", "ask"]);
    expect(Object.keys(gate.live)).toEqual(["mode", "draft"]);
    expect(gate.live).toEqual({ mode: "room", draft: null });
  });
});

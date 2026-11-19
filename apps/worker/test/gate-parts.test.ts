// The viewer gate is assembled from gate parts (api/view.ts GATE_PARTS). The wire shape is the
// same as before the parts: the fields every ok gate has, in order, then `data`, then `live`, each
// only when its part has something to say.
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
  it("runs the data part, then the live part", () => {
    expect(GATE_PARTS.length).toBe(2);
  });

  it("a page that declares nothing: only the fields every gate has", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual(BASE_KEYS);
    expect(Object.keys(gate.artifact)).toEqual(ARTIFACT_KEYS);
    expect(gate.role).toBe("owner");
  });

  it("a page that declares shared data and a room: `data` after the base fields", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { html: DECLARED, visibility: "allowlist" });
    const gate = await gateAs(a.user.id, body.id);
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "data"]);
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
    expect(Object.keys(gate)).toEqual([...BASE_KEYS, "live"]);
    expect(Object.keys(gate.live)).toEqual(["mode", "draft"]);
    expect(gate.live).toEqual({ mode: "room", draft: null });
  });
});

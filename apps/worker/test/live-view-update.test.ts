// Live views, applying a new version (docs/spec.md "Live views", keeping state): the `hold`
// declaration (stored only when declared, every other declaration byte for byte as before), the
// gate's `hold` field (an HTML page's current version, while ALLOW_LIVE_VIEWS is on), the app
// config's `live_views`, and a doc's versioned source, which the doc renderer fetches to show a
// newer version in place, behind the same content pass.
import {
  type Capabilities,
  parseCapabilities,
  readStoredCapabilities,
  serializeCapabilities,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  agent,
  browserSession,
  call,
  contentOrigin,
  enterContent,
  fetchWith,
  json,
  publish,
  versionRow,
} from "./helpers.ts";

const HOLD = `<!doctype html><title>Form</title>
<meta name="plinth-capabilities" content="hold"><form><input name="q"></form>`;
const PLAIN = "<!doctype html><title>Plain</title><p>plain</p>";

async function owned(html: string | null = HOLD, extra: Record<string, unknown> = {}) {
  const a = await agent();
  const { body } = await publish(a.auth, { html: html ?? undefined, ...extra });
  const s = await browserSession(a.user.id);
  return { a, id: body.id as string, headers: s.headers };
}

const gate = async (headers: Record<string, string>, id: string, q = "", vars = {}) =>
  json(await fetchWith(vars, `/api/v1/view/${id}${q}`, { headers }));

describe("the hold declaration", () => {
  it("declares on its own, with no store and no room, and is stored only when declared", () => {
    const c = parseCapabilities('<meta name="plinth-capabilities" content="hold">');
    expect(c).toEqual({
      data: false,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      people: false,
      comments: false,
      dictation: false,
      hold: true,
    });
    const stored = serializeCapabilities(c as Capabilities);
    expect(stored).toBe('{"data":false,"viewer":false,"shared":[],"hold":true}');
    expect(readStoredCapabilities(stored)).toEqual(c);
    // Every declaration without it is stored exactly as before.
    for (const [content, bytes] of [
      ["data viewer", '{"data":true,"viewer":true,"shared":[]}'],
      ["room", '{"data":false,"viewer":false,"shared":[],"room":true,"roomOpen":[]}'],
      ["comments", '{"data":false,"viewer":false,"shared":[],"comments":true}'],
      ["dictation", '{"data":false,"viewer":false,"shared":[],"dictation":true}'],
    ] as const) {
      const parsed = parseCapabilities(`<meta name="plinth-capabilities" content="${content}">`);
      expect(serializeCapabilities(parsed as Capabilities)).toBe(bytes);
      expect(readStoredCapabilities(bytes)?.hold).toBe(false);
    }
    expect(readStoredCapabilities('{"data":true,"viewer":false,"hold":false}')?.hold).toBe(false);
    // Alongside data, it is one more key.
    const both = parseCapabilities('<meta name="plinth-capabilities" content="data hold">');
    expect(serializeCapabilities(both as Capabilities)).toBe(
      '{"data":true,"viewer":false,"shared":[],"hold":true}',
    );
  });

  it("is stored with the version, and the page gets no shared data", async () => {
    const { id, headers } = await owned();
    expect((await versionRow(id, 1))?.capabilities).toBe(
      '{"data":false,"viewer":false,"shared":[],"hold":true}',
    );
    const { cookie } = await enterContent(id, { headers });
    const session = await call(`${contentOrigin(id)}/__plinth/api/v1/session`, {
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        cookie: cookie as string,
      },
    });
    expect(await json(session)).toEqual({ available: false, reason: "not_declared" });
  });
});

describe("the gate's hold field", () => {
  it("says hold for an HTML page whose current version declares it, last among the parts", async () => {
    const { a, id, headers } = await owned();
    const g = await gate(headers, id);
    expect(g.hold).toBe(true);
    expect(Object.keys(g).at(-1)).toBe("hold");
    // The current version's declaration governs, on a version link too.
    const put = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: PLAIN, base_version: 1 }),
    });
    expect(put.status).toBe(200);
    expect((await gate(headers, id)).hold).toBeUndefined();
    expect((await gate(headers, id, "?version=1")).hold).toBeUndefined();
  });

  it("is absent for pages that do not declare it, for docs, and with ALLOW_LIVE_VIEWS off", async () => {
    const plain = await owned(PLAIN);
    expect((await gate(plain.headers, plain.id)).hold).toBeUndefined();
    const doc = await owned(null, { type: "doc", content: "# Notes\n" });
    expect((await gate(doc.headers, doc.id)).hold).toBeUndefined();
    const { id, headers } = await owned();
    const off = await gate(headers, id, "", { ALLOW_LIVE_VIEWS: "false" });
    expect(off.status).toBe("ok");
    expect(off.hold).toBeUndefined();
    // The switch alone counts: without the ROOMS binding (no watch socket) it still holds.
    const noRooms = await gate(headers, id, "", { ROOMS: undefined });
    expect(noRooms.watch).toBeUndefined();
    expect(noRooms.hold).toBe(true);
  });
});

describe("the app config", () => {
  it("says whether open views keep state across versions (ALLOW_LIVE_VIEWS)", async () => {
    expect((await json(await fetchWith({}, "/api/v1/config"))).live_views).toBe(true);
    const off = await json(await fetchWith({ ALLOW_LIVE_VIEWS: "false" }, "/api/v1/config"));
    expect(off.live_views).toBe(false);
  });
});

describe("a doc's versioned source", () => {
  it("is what the renderer fetches to show a newer version in place, behind the same pass", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { type: "doc", content: "# One\n", html: undefined });
    const id = body.id as string;
    const s = await browserSession(a.user.id);
    const { cookie } = await enterContent(id, { headers: s.headers });
    const put = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Two\n", base_version: 1 }),
    });
    expect(put.status).toBe(200);
    // The pass the frame was entered with reads version 2's Markdown, as text, running nothing.
    const res = await call(`${contentOrigin(id)}/__plinth/v/2/content.md`, {
      headers: { cookie: cookie as string, "sec-fetch-dest": "empty" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Two\n");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    // Without the pass, nothing: an iframe request gets the 401 the renderer answers ok: false to.
    const none = await call(`${contentOrigin(id)}/__plinth/v/2/content.md`, {
      headers: { "sec-fetch-dest": "empty" },
    });
    expect([401, 302]).toContain(none.status);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });
});

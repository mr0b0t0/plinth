// Comments from the page (docs/spec.md "Comments from the page"): the server side. Page anchors
// are stored and read back through the anchor schema, on REST and MCP and in mention tasks; the
// gate says when the current version declares `comments` and then never asks for review mode; a
// comments-only page has no shared data and no room; content responses and reserved paths are
// unchanged.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { runtimeScript } from "../src/content/runtime.ts";
import { RESERVED_PATHS } from "../src/content/serve.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  enterContent,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";
import { info, run } from "./room-helpers.ts";

const PAGE = `<!doctype html><title>Board</title>
<meta name="plinth-capabilities" content="comments">
<canvas width="400" height="300"></canvas>`;
const PLAIN = "<!doctype html><title>Plain</title><h1>Plain</h1>";
const ANCHOR = {
  kind: "page",
  key: "canvas",
  x: 120.5,
  y: -8,
  text: "Top left",
  data: { zoom: 2 },
};

async function owned(html = PAGE, body: Record<string, unknown> = {}) {
  const a = await agent({ clientType: "claude" });
  const { body: p } = await publish(a.auth, { html, visibility: "allowlist", ...body });
  const session = await browserSession(a.user.id);
  return { a, p, headers: session.headers };
}

function postComment(headers: Record<string, string>, ref: string, body: Record<string, unknown>) {
  return call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function gate(headers: Record<string, string>, ref: string, query = "") {
  return json(await call(`/api/v1/view/${ref}${query}`, { headers }));
}

describe("page anchors on comments", () => {
  it("round-trip through POST, GET and list_comments", async () => {
    const { a, p, headers } = await owned();
    const res = await postComment(headers, p.id, { body: "Look here", anchor: ANCHOR });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.anchor).toEqual(ANCHOR);
    const list = await json(await call(`/api/v1/artifacts/${p.id}/comments`, { headers }));
    expect(list.items[0].anchor).toEqual(ANCHOR);
    const client = await mcpClient(a.token);
    const { data } = await tool(client, "list_comments", { id: p.id });
    await client.close();
    expect(data.items[0].anchor).toEqual(ANCHOR);
  });

  it("are accepted on pages that do not declare comments, like element anchors", async () => {
    const { p, headers } = await owned(PLAIN);
    const res = await postComment(headers, p.id, {
      body: "Here",
      anchor: { kind: "page", key: "a" },
    });
    expect(res.status).toBe(201);
    // Element anchors keep their stored shape: no kind.
    const el = await json(
      await postComment(headers, p.id, { body: "H1", anchor: { selector: "h1", x: 0.5, y: 0.5 } }),
    );
    expect(el.anchor).toEqual({ selector: "h1", x: 0.5, y: 0.5 });
  });

  it("refuses page anchors that break the rules", async () => {
    const { p, headers } = await owned();
    const bad = [
      { kind: "page", key: "" },
      { kind: "page", key: "a b" },
      { kind: "page", key: "a", x: 2e9 },
      { kind: "page", key: "a", text: "t".repeat(121) },
      { kind: "page", key: "a", data: { o: { p: 1 } } },
      {
        kind: "page",
        key: "a",
        data: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
      },
      {
        kind: "page",
        key: "a",
        data: {
          s: "x".repeat(200),
          t: "x".repeat(200),
          u: "x".repeat(200),
          v: "x".repeat(200),
          w: "x".repeat(200),
        },
      },
      { kind: "page", key: "a", selector: "h1" },
      { kind: "page", selector: "h1" },
      { kind: "element", selector: "h1" },
    ];
    for (const anchor of bad) {
      const res = await postComment(headers, p.id, { body: "x", anchor });
      expect(res.status, JSON.stringify(anchor)).toBe(400);
    }
  });

  it("read a stored anchor that no schema allows as no anchor", async () => {
    const { p, headers } = await owned();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (await json(await postComment(headers, p.id, { body: `c${i}`, anchor: ANCHOR }))).id,
      );
    }
    const junk = ["not json", '{"kind":"page","key":"a b"}', '{"selector":7}'];
    for (const [i, value] of junk.entries()) {
      await env.DB.prepare("UPDATE comments SET anchor = ?1 WHERE id = ?2")
        .bind(value, ids[i])
        .run();
    }
    const list = await json(await call(`/api/v1/artifacts/${p.id}/comments`, { headers }));
    expect(list.items.map((c: { anchor: unknown }) => c.anchor)).toEqual([null, null, null]);
  });

  it("travel with the mention task", async () => {
    const { a, p, headers } = await owned();
    const res = await postComment(headers, p.id, { body: "@claude move this", anchor: ANCHOR });
    expect(res.status).toBe(201);
    const client = await mcpClient(a.token);
    const { data } = await tool(client, "list_mentions", {});
    const listed = await client.listTools();
    await client.close();
    const task = data.items.find((t: { artifact_id: string }) => t.artifact_id === p.id);
    expect(task.anchor).toEqual(ANCHOR);
    // The tool descriptions say what a page anchor is, and that it is untrusted.
    for (const name of ["list_comments", "list_mentions"]) {
      const d = listed.tools.find((t) => t.name === name)?.description ?? "";
      expect(d, name).toContain('`kind: "page"`');
      expect(d, name).toContain("untrusted like the comment text");
    }
  });
});

describe("the gate for a page that declares comments", () => {
  it("says page_comments only for the current version of an HTML artifact", async () => {
    const { a, p, headers } = await owned();
    expect((await gate(headers, p.id)).page_comments).toBe(true);
    // A comments-only page tells the viewer nothing about shared data.
    expect((await gate(headers, p.id)).data).toBeUndefined();
    // The current version's declaration governs, also for an old version's link.
    const update = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: PLAIN, base_version: 1 }),
    });
    expect(update.status).toBe(200);
    expect((await gate(headers, p.id)).page_comments).toBeUndefined();
    expect((await gate(headers, p.id, "?version=1")).page_comments).toBeUndefined();

    const plain = await owned(PLAIN);
    expect((await gate(plain.headers, plain.p.id)).page_comments).toBeUndefined();
    // A doc never declares anything.
    const doc = await owned(undefined, { html: undefined, type: "doc", content: "# Notes\n" });
    expect((await gate(doc.headers, doc.p.id)).page_comments).toBeUndefined();
  });

  it("ignores review mode for a declaring page and keeps it for others", async () => {
    const { p, headers } = await owned();
    const declared = await gate(headers, p.id, "?review=1");
    expect(declared.page_comments).toBe(true);
    const enter = await call(declared.enter_url);
    expect(enter.headers.get("location") ?? "").not.toContain("plinth-review");

    const plain = await owned(PLAIN);
    const reviewed = await gate(plain.headers, plain.p.id, "?review=1");
    const plainEnter = await call(reviewed.enter_url);
    expect(plainEnter.headers.get("location") ?? "").toContain("plinth-review=1");
  });
});

describe("a page that declares only comments", () => {
  it("has no shared data and no room", async () => {
    const { p, headers } = await owned();
    const { cookie } = await enterContent(p.id, { headers });
    expect(cookie).toBeTruthy();
    const session = await run(`${contentOrigin(p.id)}/__plinth/api/v1/session`, {
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        cookie: cookie as string,
      },
    });
    expect(await json(session)).toEqual({ available: false, reason: "not_declared" });
    const room = await info(p.id, cookie);
    expect(await json(room)).toEqual({ available: false, reason: "not_declared" });
  });

  it("is served with the same CSP and sandbox as any page, in both isolation modes", async () => {
    for (const vars of [{}, { CONTENT_ISOLATION: "opaque" }]) {
      const csps: string[] = [];
      for (const html of [PAGE, PLAIN]) {
        const { a, p } = await owned(html);
        const g = await json(await run(`${APP}/api/v1/view/${p.id}`, { headers: a.auth }, vars));
        const enter = await run(g.enter_url, {}, vars);
        const c = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const page = await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: c } }, vars);
        expect(page.status).toBe(200);
        // The CSP names the artifact's own origin (the room socket): compare without it.
        csps.push((page.headers.get("content-security-policy") ?? "").replaceAll(p.id, "<id>"));
      }
      expect(csps[0]).toBe(csps[1]);
    }
    expect(contentCsp(config())).not.toContain("plinth-comments");
  });

  it("adds no reserved path, and runtime.js stays one static file for every artifact", async () => {
    expect(RESERVED_PATHS.map((r) => r.path)).toEqual([
      "/__plinth/api/",
      "/__plinth/room/",
      "/__plinth/bridge.js",
      "/__plinth/runtime.js",
      "/__plinth/preview",
      "/__plinth/types/",
      // A design's board loader (type-design), behind the content pass.
      "/__plinth/frames/",
      // Files people add to a page (viewer uploads), behind the content pass.
      "/__plinth/files/",
    ]);
    const { p } = await owned();
    const { p: other } = await owned(PLAIN);
    const one = await call(`${contentOrigin(p.id)}/__plinth/runtime.js`);
    const two = await call(`${contentOrigin(other.id)}/__plinth/runtime.js`);
    const body = await one.text();
    expect(body).toBe(await two.text());
    expect(body).toBe(runtimeScript(config()));
    expect(body).toContain(`var APP_ORIGIN = ${JSON.stringify(config().appOrigin)};`);
    expect(one.headers.get("cache-control")).toBe("private, no-cache");
    expect(one.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});

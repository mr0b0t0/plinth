// Typed artifacts, slice 1: the doc type (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md).
// A doc stores content.md (Markdown) plus image assets instead of index.html; MCP and REST accept
// type and content, and every mismatch is refused with the same fix-it error on both.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, artifacts, versions } from "../src/db/schema.ts";
import {
  agent,
  call,
  db,
  json,
  mcpClient,
  publish,
  r2Keys,
  sha256Of,
  storedFile,
  tool,
  versionRow,
} from "./helpers.ts";

const PNG = "iVBORw0KGgo=";
const MD =
  "# Plan\n\nSome *prose* with a [link](https://example.com).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![dot](img/dot.png)\n";

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Publish a doc over REST (no html field). */
const publishDoc = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, {
    html: undefined,
    type: "doc",
    content: MD,
    assets: [{ path: "img/dot.png", content: PNG, encoding: "base64" }],
    ...body,
  });

const getDetail = async (auth: Record<string, string>, ref: string, n?: number) =>
  json(
    await call(n ? `/api/v1/artifacts/${ref}/versions/${n}` : `/api/v1/artifacts/${ref}`, {
      headers: auth,
    }),
  );

async function manifestPaths(id: string, n: number) {
  const v = await db().select().from(versions).where(eq(versions.artifactId, id)).all();
  const row = v.find((r) => r.number === n);
  return (JSON.parse(row?.manifest ?? "[]") as { path: string; content_type: string }[]).sort(
    (a, b) => a.path.localeCompare(b.path),
  );
}

/** A REST error, from a raw response or from publish(), which has already read the body. */
type Result = Response | { res: Response; body: any };

async function expectInvalid(r: Result, field: string, message: string | RegExp, type?: string) {
  const res = r instanceof Response ? r : r.res;
  expect(res.status).toBe(400);
  const { error } = r instanceof Response ? await json(r) : r.body;
  expect(error.code).toBe("invalid_input");
  if (typeof message === "string") expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
  expect(error.details).toMatchObject({ field, ...(type ? { type } : {}) });
}

describe("doc artifacts over REST", () => {
  it("publishes a doc: content.md plus its image, no index.html, type doc everywhere", async () => {
    const a = await agent();
    const { res, body } = await publishDoc(a.auth);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ version: 1, type: "doc" });
    expect(await manifestPaths(body.id, 1)).toEqual([
      {
        path: "content.md",
        size_bytes: new TextEncoder().encode(MD).byteLength,
        content_type: "text/markdown; charset=utf-8",
        sha256: await sha256Of(MD),
      },
      {
        path: "img/dot.png",
        size_bytes: 8,
        content_type: "image/png",
        sha256: await sha256Of(Uint8Array.from(atob("iVBORw0KGgo="), (c) => c.charCodeAt(0))),
      },
    ]);
    const v1 = await versionRow(body.id, 1);
    expect(await r2Keys(v1?.r2Prefix ?? "-")).not.toContain(`${v1?.r2Prefix}index.html`);
    expect(await (await storedFile(body.id, 1, "content.md"))?.text()).toBe(MD);

    const detail = await getDetail(a.auth, body.slug);
    expect(detail).toMatchObject({
      type: "doc",
      content: MD,
      source_path: "content.md",
      version: 1,
    });
    expect("html" in detail).toBe(false);
    expect(detail.assets.map((x: { path: string }) => x.path)).toEqual(["img/dot.png"]);

    const list = await json(await call("/api/v1/artifacts", { headers: a.auth }));
    expect(list.items.find((i: { id: string }) => i.id === body.id)).toMatchObject({ type: "doc" });
  });

  it("stores content byte for byte", async () => {
    const a = await agent();
    const odd = "  # Title\r\n\r\nTabs\there, unicode é ✓, trailing spaces   \n\n\n";
    const { body } = await publishDoc(a.auth, { content: odd, assets: undefined });
    const detail = await getDetail(a.auth, body.id);
    expect(detail.content).toBe(odd);
  });

  it("an html publish without type is unchanged and reports type html", async () => {
    const a = await agent();
    const { res, body } = await publish(a.auth, { assets: [{ path: "a.css", content: "x" }] });
    expect(res.status).toBe(201);
    expect(body.type).toBe("html");
    expect(await storedFile(body.id, 1, "index.html")).not.toBeNull();
    const detail = await getDetail(a.auth, body.id);
    expect(detail).toMatchObject({
      type: "html",
      html: "<!doctype html><h1>Hello</h1>",
      source_path: "index.html",
    });
    expect("content" in detail).toBe(false);
    expect(detail.assets.map((x: { path: string }) => x.path)).toEqual(["a.css"]);
  });

  it("refuses every mismatch between type and fields with a fix-it message", async () => {
    const a = await agent();
    await expectInvalid(
      await publishDoc(a.auth, { content: undefined }),
      "content",
      "type doc needs its Markdown in content",
      "doc",
    );
    await expectInvalid(
      await publishDoc(a.auth, { html: "<p>x</p>" }),
      "html",
      "type doc takes Markdown in content, not html",
      "doc",
    );
    await expectInvalid(
      await publish(a.auth, { content: "# x" }),
      "content",
      'content is for typed artifacts: pass type "doc", or send html',
      "html",
    );
    await expectInvalid(
      await publish(a.auth, { type: "html", content: "# x", html: undefined }),
      "content",
      'content is for typed artifacts: pass type "doc", or send html',
      "html",
    );
    await expectInvalid(
      await publish(a.auth, { html: undefined }),
      "html",
      'html is required (or pass type "doc" with content)',
      "html",
    );
    await expectInvalid(
      await publishDoc(a.auth, { content: "<!DOCTYPE html><html><body>x</body></html>" }),
      "content",
      'content for type doc is Markdown. To publish HTML, use type "html" and the html field.',
      "doc",
    );
    await expectInvalid(
      await publishDoc(a.auth, { content: "\n  <html lang=en><p>x</p>" }),
      "content",
      /is Markdown/,
    );
    // Markdown that merely mentions HTML is fine.
    expect((await publishDoc(a.auth, { content: "Use `<html>` at the top." })).res.status).toBe(
      201,
    );
  });

  it("refuses an unknown type", async () => {
    const a = await agent();
    const { res, body } = await publishDoc(a.auth, { type: "deck" });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_input");
  });

  it("refuses Markdown over 1 MB with payload_too_large", async () => {
    const a = await agent();
    const big = "a".repeat(1024 * 1024 + 1);
    const { res, body } = await publishDoc(a.auth, { content: big, assets: undefined });
    expect(res.status).toBe(413);
    expect(body.error).toMatchObject({
      code: "payload_too_large",
      details: { limit_bytes: 1024 * 1024, size_bytes: 1024 * 1024 + 1 },
    });
  });

  it("refuses doc assets at reserved paths and assets that are not images", async () => {
    const a = await agent();
    await expectInvalid(
      await publishDoc(a.auth, { assets: [{ path: "content.md", content: "x" }] }),
      "assets",
      "content.md and index.html belong to the doc, not its assets",
      "doc",
    );
    // index.html too: the same rule and message, with the type and field, for a doc.
    await expectInvalid(
      await publishDoc(a.auth, { assets: [{ path: "index.html", content: "x" }] }),
      "assets",
      "content.md and index.html belong to the doc, not its assets",
      "doc",
    );
    // An html artifact's index.html asset is refused as before, now with its type and field.
    await expectInvalid(
      await publish(a.auth, { assets: [{ path: "index.html", content: "x" }] }),
      "assets",
      "index.html is the html field, not an asset",
      "html",
    );
    await expectInvalid(
      await publishDoc(a.auth, { assets: [{ path: "app.js", content: "alert(1)" }] }),
      "assets",
      "A doc's assets are images (png, jpg, gif, webp, avif, svg)",
      "doc",
    );
    await expectInvalid(
      await publishDoc(a.auth, {
        assets: [{ path: "blob", content: "x", content_type: "text/html" }],
      }),
      "assets",
      /images/,
    );
    // Every image kind is fine; html artifacts may still carry a content.md asset.
    const ok = await publishDoc(a.auth, {
      assets: ["a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.avif", "g.svg"].map((p) => ({
        path: p,
        content: PNG,
        encoding: "base64",
      })),
    });
    expect(ok.res.status).toBe(201);
    expect(
      (await publish(a.auth, { assets: [{ path: "content.md", content: "x" }] })).res.status,
    ).toBe(201);
  });

  it("refuses an update that sends the other type's field", async () => {
    const a = await agent();
    const { body: doc } = await publishDoc(a.auth);
    await expectInvalid(
      await put(a.auth, doc.id, { html: "<p>x</p>" }),
      "html",
      "This artifact is a doc: send its Markdown as content. The type cannot change.",
      "doc",
    );
    await expectInvalid(
      await put(a.auth, doc.id, { note: "x" }),
      "content",
      /send its Markdown as content/,
      "doc",
    );
    await expectInvalid(
      await put(a.auth, doc.id, { content: "<!doctype html><p>x</p>" }),
      "content",
      /is Markdown/,
      "doc",
    );
    const { body: page } = await publish(a.auth);
    await expectInvalid(
      await put(a.auth, page.id, { content: "# x" }),
      "content",
      "This artifact is an HTML page: send html. The type cannot change.",
      "html",
    );
    await expectInvalid(
      await put(a.auth, page.id, { note: "x" }),
      "html",
      /html is required/,
      "html",
    );
    // Nothing was written.
    expect((await getDetail(a.auth, doc.id)).current_version).toBe(1);
    expect((await getDetail(a.auth, page.id)).current_version).toBe(1);
  });

  it("updates with content and base_version, refuses a stale base, carries images forward", async () => {
    const a = await agent();
    const { body: p } = await publishDoc(a.auth);
    const res = await put(a.auth, p.id, { content: "# Plan v2\n", base_version: 1, note: "two" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ version: 2, type: "doc" });
    expect((await manifestPaths(p.id, 2)).map((m) => m.path)).toEqual([
      "content.md",
      "img/dot.png",
    ]);
    expect(await (await storedFile(p.id, 2, "img/dot.png"))?.arrayBuffer()).toBeTruthy();

    const stale = await put(a.auth, p.id, { content: "# stale\n", base_version: 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({
      code: "conflict",
      details: { current_version: 2 },
    });
    const rows = await db().select().from(versions).where(eq(versions.artifactId, p.id)).all();
    expect(rows).toHaveLength(2);

    const d2 = await getDetail(a.auth, p.id);
    expect(d2).toMatchObject({ version: 2, content: "# Plan v2\n", type: "doc" });
    expect(d2.assets.map((x: { path: string }) => x.path)).toEqual(["img/dot.png"]);
    expect((await getDetail(a.auth, p.id, 1)).content).toBe(MD);
  });

  it("restore of v1 publishes v1's content as v3", async () => {
    const a = await agent();
    const { body: p } = await publishDoc(a.auth);
    await put(a.auth, p.id, { content: "# v2\n", assets: [] });
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ version: 3, type: "doc" });
    const d3 = await getDetail(a.auth, p.id);
    expect(d3).toMatchObject({ version: 3, type: "doc", content: MD });
    expect(d3.assets.map((x: { path: string }) => x.path)).toEqual(["img/dot.png"]);
    expect((await getDetail(a.auth, p.id, 2)).assets).toEqual([]);
  });

  it("a row written without a type reads as html", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    // Rows from before migration 0004 get the column default.
    await env.DB.prepare(
      `INSERT INTO artifacts (id, owner_id, slug, title, current_version, visibility, access_epoch,
         created_at, updated_at)
       VALUES ('legacyartifact000001', ?1, 'legacy-row', 'Legacy', 0, 'unlisted', 1, ?2, ?2)`,
    )
      .bind(a.user.id, new Date().toISOString())
      .run();
    const row = await db()
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, "legacyartifact000001"))
      .get();
    expect(row?.type).toBe("html");
    expect((await getDetail(a.auth, p.id)).type).toBe("html");
  });

  it("the view gate reports the type", async () => {
    const a = await agent();
    const { body: p } = await publishDoc(a.auth, { visibility: "unlisted" });
    const gate = await json(await call(`/api/v1/view/${p.slug}`));
    expect(gate).toMatchObject({ status: "ok", artifact: { type: "doc" } });
  });
});

describe("an artifact whose stored type this instance does not know", () => {
  // A row written by a newer Plinth (say, a deck) is refused everywhere, never read as HTML.
  async function deck() {
    const a = await agent();
    const { body: p } = await publishDoc(a.auth);
    await db()
      .update(artifacts)
      .set({ type: "deck" as never })
      .where(eq(artifacts.id, p.id))
      .run();
    return { a, p };
  }

  const expectUnsupported = (error: { code: string; message: string; details: unknown }) =>
    expect(error).toMatchObject({
      code: "feature_disabled",
      message: "This artifact's type is not supported by this instance",
      details: { type: "deck" },
    });

  it("REST get, version get, update and restore refuse it with feature_disabled", async () => {
    const { a, p } = await deck();
    for (const path of [`/api/v1/artifacts/${p.id}`, `/api/v1/artifacts/${p.id}/versions/1`]) {
      const res = await call(path, { headers: a.auth });
      expect(res.status, path).toBe(403);
      expectUnsupported((await json(res)).error);
    }
    for (const body of [{ content: "# x\n", base_version: 1 }, { html: "<p>x</p>" }]) {
      const res = await put(a.auth, p.id, body);
      expect(res.status).toBe(403);
      expectUnsupported((await json(res)).error);
    }
    const restore = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 1 }),
    });
    expect(restore.status).toBe(403);
    expectUnsupported((await json(restore)).error);
    // Nothing was written.
    const rows = await db().select().from(versions).where(eq(versions.artifactId, p.id)).all();
    expect(rows).toHaveLength(1);
  });

  it("MCP get_artifact, update_artifact and restore_version refuse it the same way", async () => {
    const { a, p } = await deck();
    const mcp = await mcpClient(a.token);
    for (const [name, args] of [
      ["get_artifact", { id: p.id }],
      ["update_artifact", { id: p.id, content: "# x\n", base_version: 1 }],
      ["restore_version", { id: p.id, version: 1 }],
    ] as const) {
      const r = await tool(mcp, name, args);
      expect(r.isError, name).toBe(true);
      expectUnsupported(r.data.error);
    }
    await mcp.close();
  });
});

describe("doc artifacts over MCP", () => {
  it("publishes, reads, updates and lists a doc", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", {
      title: "Notes",
      type: "doc",
      content: MD,
      assets: [{ path: "img/dot.png", content: PNG, encoding: "base64" }],
    });
    expect(pub.isError).toBe(false);
    expect(pub.data).toMatchObject({ version: 1, type: "doc" });
    expect((await manifestPaths(pub.data.id, 1)).map((m) => m.path)).toEqual([
      "content.md",
      "img/dot.png",
    ]);

    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data).toMatchObject({ type: "doc", content: MD, source_path: "content.md" });
    expect("html" in got.data).toBe(false);
    expect(got.data.assets.map((x: { path: string }) => x.path)).toEqual(["img/dot.png"]);

    const wrong = await tool(mcp, "update_artifact", { id: pub.data.id, html: "<p>x</p>" });
    expect(wrong.isError).toBe(true);
    expect(wrong.data.error).toMatchObject({
      code: "invalid_input",
      message: "This artifact is a doc: send its Markdown as content. The type cannot change.",
      details: { type: "doc", field: "html" },
    });

    const up = await tool(mcp, "update_artifact", {
      id: pub.data.id,
      content: "# Notes v2\n",
      base_version: 1,
    });
    expect(up.data).toMatchObject({ version: 2, type: "doc" });
    const stale = await tool(mcp, "update_artifact", {
      id: pub.data.id,
      content: "# stale\n",
      base_version: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({ code: "conflict", details: { current_version: 2 } });

    const list = await tool(mcp, "list_artifacts", {});
    expect(list.data.items.find((i: { id: string }) => i.id === pub.data.id)).toMatchObject({
      type: "doc",
    });

    const noContent = await tool(mcp, "publish_artifact", { title: "x", type: "doc" });
    expect(noContent.isError).toBe(true);
    expect(noContent.data.error).toMatchObject({
      code: "invalid_input",
      message: "type doc needs its Markdown in content",
    });
    await mcp.close();
  });

  it("gives the same fix-it errors as REST for every refused call", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const { body: doc } = await publishDoc(a.auth);
    const { body: page } = await publish(a.auth);
    const png = { content: PNG, encoding: "base64" };
    const rows: Array<{
      name: string;
      args: Record<string, unknown>;
      rest: () => Promise<Result>;
    }> = [
      {
        name: "publish_artifact",
        args: { title: "x", type: "doc", content: MD, html: "<p>x</p>" },
        rest: () => publishDoc(a.auth, { html: "<p>x</p>" }),
      },
      {
        name: "publish_artifact",
        args: { title: "x", content: "# x" },
        rest: () => publish(a.auth, { content: "# x" }),
      },
      {
        name: "publish_artifact",
        args: { title: "x" },
        rest: () => publish(a.auth, { html: undefined }),
      },
      {
        name: "publish_artifact",
        args: { title: "x", type: "doc", content: "<!doctype html><p>x</p>" },
        rest: () => publishDoc(a.auth, { content: "<!doctype html><p>x</p>" }),
      },
      ...["content.md", "index.html"].map((path) => ({
        name: "publish_artifact",
        args: { title: "x", type: "doc", content: MD, assets: [{ path, ...png }] },
        rest: () => publishDoc(a.auth, { assets: [{ path, ...png }] }),
      })),
      {
        name: "publish_artifact",
        args: { title: "x", type: "doc", content: MD, assets: [{ path: "a.js", content: "1" }] },
        rest: () => publishDoc(a.auth, { assets: [{ path: "a.js", content: "1" }] }),
      },
      {
        name: "publish_artifact",
        args: { title: "x", type: "doc", content: "a".repeat(1024 * 1024 + 1) },
        rest: () => publishDoc(a.auth, { content: "a".repeat(1024 * 1024 + 1), assets: undefined }),
      },
      {
        name: "update_artifact",
        args: { id: doc.id, content: "<html><p>x</p>" },
        rest: () => put(a.auth, doc.id, { content: "<html><p>x</p>" }),
      },
      {
        name: "update_artifact",
        args: { id: doc.id, note: "x" },
        rest: () => put(a.auth, doc.id, { note: "x" }),
      },
      {
        name: "update_artifact",
        args: { id: doc.id, content: "# x", assets: [{ path: "index.html", content: "x" }] },
        rest: () =>
          put(a.auth, doc.id, { content: "# x", assets: [{ path: "index.html", content: "x" }] }),
      },
      {
        name: "update_artifact",
        args: { id: page.id, content: "# x" },
        rest: () => put(a.auth, page.id, { content: "# x" }),
      },
    ];
    for (const row of rows) {
      const label = `${row.name} ${JSON.stringify(row.args).slice(0, 80)}`;
      const r = await row.rest();
      const restError = (r instanceof Response ? await json(r) : r.body).error;
      expect(restError.code, label).toMatch(/^(invalid_input|payload_too_large)$/);
      const m = await tool(mcp, row.name, row.args);
      expect(m.isError, label).toBe(true);
      expect(m.data.error, label).toEqual(restError);
    }
    // Nothing was written by any of them.
    expect((await getDetail(a.auth, doc.id)).current_version).toBe(1);
    expect((await getDetail(a.auth, page.id)).current_version).toBe(1);
    await mcp.close();
  });

  it("an html publish without type still works over MCP", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", { title: "Page", html: "<h1>Hi</h1>" });
    expect(pub.data).toMatchObject({ version: 1, type: "html" });
    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data).toMatchObject({
      type: "html",
      html: "<h1>Hi</h1>",
      source_path: "index.html",
    });
    await mcp.close();
  });

  it("tool descriptions teach the doc type", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const { tools } = await mcp.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    expect(desc("publish_artifact")).toMatch(/type "doc"/);
    expect(desc("update_artifact")).toMatch(/type cannot change/);
    expect(desc("get_artifact")).toMatch(/Markdown/);
    expect(mcp.getInstructions()).toMatch(/type "doc" with Markdown in content/);
    await mcp.close();
  });
});

describe("doc artifacts with unsaved page edits (#36)", () => {
  const putDraft = (id: string, base = 1) =>
    env.DB.prepare(
      `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, created_at, updated_at)
       VALUES (?1, ?2, 'secret draft words', 18, 4, ?3, ?3)`,
    )
      .bind(id, base, new Date().toISOString())
      .run();

  it("get_artifact says so with metadata only, to owners and editors; never the draft text", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", { title: "Notes", type: "doc", content: MD });
    const id = pub.data.id as string;
    expect((await tool(mcp, "get_artifact", { id })).data.live_draft).toBeNull();
    await putDraft(id);
    const got = await tool(mcp, "get_artifact", { id });
    expect(got.data.live_draft).toEqual({
      base_version: 1,
      dirty: true,
      conflict_version: null,
      updated_at: expect.any(String),
    });
    expect(got.text).not.toContain("secret draft words");
    // An HTML artifact never has the field; a link viewer of a doc does not see it.
    const html = await tool(mcp, "publish_artifact", { title: "Page", html: "<p>x</p>" });
    expect("live_draft" in (await tool(mcp, "get_artifact", { id: html.data.id })).data).toBe(
      false,
    );
    await tool(mcp, "set_visibility", { id, visibility: "unlisted" });
    const other = await agent();
    const seen = await getDetail(other.auth, id);
    expect("live_draft" in seen).toBe(false);
    // With grants: an editor's agent sees it, a commenter's agent does not.
    await tool(mcp, "set_visibility", { id, visibility: "allowlist" });
    const commenter = await agent();
    const editor = await agent();
    const at = new Date().toISOString();
    await db()
      .insert(accessGrants)
      .values([
        { artifactId: id, email: commenter.user.email, role: "commenter", createdAt: at },
        { artifactId: id, email: editor.user.email, role: "editor", createdAt: at },
      ])
      .run();
    expect("live_draft" in (await getDetail(commenter.auth, id))).toBe(false);
    expect((await getDetail(editor.auth, id)).live_draft).toMatchObject({ base_version: 1 });
  });

  it("update_artifact and REST updates warn live_draft (no action needed); without a draft they do not", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", { title: "Notes", type: "doc", content: MD });
    const id = pub.data.id as string;
    const quiet = await tool(mcp, "update_artifact", { id, content: "# v2\n", base_version: 1 });
    expect(quiet.data.warnings).toEqual([]);
    await putDraft(id, 2);
    const up = await tool(mcp, "update_artifact", { id, content: "# v3\n", base_version: 2 });
    expect(up.isError).toBe(false);
    expect(up.data.version).toBe(3);
    expect(up.data.warnings).toEqual([
      {
        code: "live_draft",
        file: "content.md",
        message: expect.stringMatching(/editing this doc on its page.*Nothing was overwritten/),
      },
    ]);
    const rest = await json(await put(a.auth, id, { content: "# v4\n", base_version: 3 }));
    expect(rest.warnings.map((w: { code: string }) => w.code)).toEqual(["live_draft"]);
    // A restore is not warned about (it returns no warnings).
    const restored = await json(
      await call(`/api/v1/artifacts/${id}/versions/1/restore`, {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(restored.warnings).toEqual([]);
  });

  it("the tool descriptions tell agents the draft is metadata and the warning needs no action", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const { tools } = await mcp.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    expect(desc("get_artifact")).toMatch(/live_draft.*metadata.*never returned/);
    expect(desc("update_artifact")).toMatch(/live_draft says people are editing a doc/);
    expect(desc("publish_artifact")).toMatch(/declare room for live presence/);
    expect(mcp.getInstructions()).toContain("not_scanned and live_draft need no action");
  });
});

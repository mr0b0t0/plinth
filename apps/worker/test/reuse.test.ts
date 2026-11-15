// Reuse by {path, sha256} within one artifact (docs/spec.md, "reuse by hash"): no new object,
// stored_at names the origin and never a chain, content types follow the new path, refused
// references, legacy versions written before 0006, and the stager the bundle path uses.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { artifacts, versions } from "../src/db/schema.ts";
import { commitStaged, openStager, updateTarget } from "../src/services/stage.ts";
import {
  agent,
  agentPrincipal,
  browserSession,
  call,
  contentOrigin,
  db,
  enterContent,
  json,
  manifestOf,
  mcpClient,
  publish,
  r2Keys,
  serviceCtxFor,
  sha256Of,
  storedFile,
  tool,
  versionRow,
} from "./helpers.ts";

const CSS = "h1{color:red}";
const PNG = "iVBORw0KGgo=";
const pngBytes = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function seed() {
  const a = await agent();
  const { body: p } = await publish(a.auth, {
    assets: [
      { path: "style.css", content: CSS },
      { path: "img/dot.png", content: PNG, encoding: "base64" },
    ],
  });
  return { a, p };
}

async function serve(id: string, path: string) {
  const { cookie } = await enterContent(id);
  return call(`${contentOrigin(id)}${path}`, { headers: { Cookie: cookie ?? "" } });
}

describe("reuse by {path, sha256}", () => {
  it("writes no object for a reused file and points stored_at at its origin", async () => {
    const { a, p } = await seed();
    const v1 = await versionRow(p.id, 1);
    const res = await put(a.auth, p.id, {
      html: "<p>v2</p>",
      base_version: 1,
      assets: [
        { path: "style.css", sha256: await sha256Of(CSS) },
        { path: "img/dot.png", sha256: await sha256Of(pngBytes) },
      ],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.stored).toEqual({
      files: 3,
      written: 1,
      reused: 2,
      bytes: 9 + CSS.length + pngBytes.byteLength,
      bytes_written: 9,
    });
    const v2 = await versionRow(p.id, 2);
    // Only the source was written under v2's prefix.
    expect(await r2Keys(v2?.r2Prefix ?? "-")).toEqual([`${v2?.r2Prefix}index.html`]);
    const rel = (v1?.r2Prefix ?? "").slice(`artifacts/${p.id}/`.length);
    const m = await manifestOf(p.id, 2);
    expect(m.find((e) => e.path === "style.css")?.stored_at).toBe(`${rel}style.css`);
    expect(m.find((e) => e.path === "index.html")?.stored_at).toBeUndefined();
    expect((await versionRow(p.id, 2))?.storedBytes).toBe(9);
    // And the content host serves the reused bytes.
    const css = await serve(p.id, "/style.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(CSS);
  });

  it("sending the same bytes with content also reuses them (dedupe on the inline path)", async () => {
    const { a, p } = await seed();
    const res = await put(a.auth, p.id, {
      html: "<p>v2</p>",
      assets: [
        { path: "style.css", content: CSS, sha256: await sha256Of(CSS) },
        { path: "img/dot.png", content: PNG, encoding: "base64" },
      ],
    });
    expect((await json(res)).stored).toMatchObject({ written: 1, reused: 2 });
  });

  it("never builds a chain: a reference of a reference names the first version", async () => {
    const { a, p } = await seed();
    const ref = [{ path: "style.css", sha256: await sha256Of(CSS) }];
    await put(a.auth, p.id, { html: "<p>2</p>", assets: ref });
    await put(a.auth, p.id, { html: "<p>3</p>", assets: ref });
    await put(a.auth, p.id, { html: "<p>4</p>" });
    const v1 = await versionRow(p.id, 1);
    const origin = `${(v1?.r2Prefix ?? "").slice(`artifacts/${p.id}/`.length)}style.css`;
    for (const n of [2, 3, 4]) {
      expect((await manifestOf(p.id, n)).find((e) => e.path === "style.css")?.stored_at).toBe(
        origin,
      );
    }
  });

  it("serves a reused file under its new path with the new path's content type", async () => {
    const { a, p } = await seed();
    const data = '{"a":1}';
    await put(a.auth, p.id, {
      html: "<p>2</p>",
      assets: [{ path: "data.txt", content: data }],
    });
    const res = await put(a.auth, p.id, {
      html: "<p>3</p>",
      assets: [{ path: "data.json", sha256: await sha256Of(data) }],
    });
    expect(res.status).toBe(200);
    const served = await serve(p.id, "/data.json");
    expect(served.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await served.text()).toBe(data);
  });

  it("reports every reference the current version cannot satisfy as missing_paths", async () => {
    const { a, p } = await seed();
    // Another artifact's file is not this artifact's: its hash counts as missing.
    const other = await publish(a.auth, { assets: [{ path: "x.css", content: "other" }] });
    expect(other.res.status).toBe(201);
    const res = await put(a.auth, p.id, {
      html: "<p>2</p>",
      assets: [
        { path: "style.css", sha256: await sha256Of(CSS) },
        { path: "x.css", sha256: await sha256Of("other") },
        { path: "nope.js", sha256: "0".repeat(64) },
      ],
    });
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.code).toBe("invalid_input");
    expect(error.details.missing_paths).toEqual(["x.css", "nope.js"]);
    expect(error.details.next).toBeTruthy();
    // Nothing was committed and nothing was left behind.
    expect(
      (await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get())?.currentVersion,
    ).toBe(1);
    const prefixes = new Set(
      (await r2Keys(`artifacts/${p.id}/`)).map((k) => k.split("/").slice(0, 3).join("/")),
    );
    expect(prefixes.size).toBe(1);
  });

  it("refuses content that does not match its sha256, naming both hashes", async () => {
    const { a, p } = await seed();
    const res = await put(a.auth, p.id, {
      html: "<p>2</p>",
      assets: [{ path: "style.css", content: "changed", sha256: await sha256Of(CSS) }],
    });
    expect(res.status).toBe(400);
    const { error } = await json(res);
    expect(error.details).toMatchObject({
      path: "style.css",
      expected: await sha256Of(CSS),
      actual: await sha256Of("changed"),
    });
  });

  it("an asset needs content or sha256", async () => {
    const { a, p } = await seed();
    const res = await put(a.auth, p.id, { html: "<p>2</p>", assets: [{ path: "style.css" }] });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/needs content or sha256/);
  });

  it("applies reserved paths and a doc's image rule to references too", async () => {
    const { a, p } = await seed();
    const reserved = await put(a.auth, p.id, {
      html: "<p>2</p>",
      assets: [{ path: "index.html", sha256: await sha256Of(CSS) }],
    });
    expect(reserved.status).toBe(400);
    const doc = await publish(a.auth, {
      type: "doc",
      html: undefined,
      content: "# Doc\n",
      assets: [{ path: "img/dot.png", content: PNG, encoding: "base64" }],
    });
    expect(doc.res.status).toBe(201);
    const script = await put(a.auth, doc.body.id, {
      content: "# Doc 2\n",
      assets: [{ path: "x.js", sha256: await sha256Of(pngBytes) }],
    });
    expect(script.status).toBe(400);
    expect((await json(script)).error.message).toMatch(/images/);
    const image = await put(a.auth, doc.body.id, {
      content: "# Doc 2\n",
      assets: [{ path: "img/same.png", sha256: await sha256Of(pngBytes) }],
    });
    expect(image.status).toBe(200);
  });

  it("works through MCP update_artifact, and get_artifact lists sha256 but never stored_at", async () => {
    const { a, p } = await seed();
    const client = await mcpClient(a.token);
    const got = await tool(client, "get_artifact", { id: p.id });
    const hashes = Object.fromEntries(
      (got.data.assets as { path: string; sha256: string }[]).map((x) => [x.path, x.sha256]),
    );
    expect(hashes["style.css"]).toBe(await sha256Of(CSS));
    const upd = await tool(client, "update_artifact", {
      id: p.id,
      html: "<p>mcp</p>",
      base_version: 1,
      assets: Object.entries(hashes).map(([path, sha256]) => ({ path, sha256 })),
    });
    expect(upd.isError).toBe(false);
    expect(upd.data.stored).toMatchObject({ written: 1, reused: 2 });
    const again = await tool(client, "get_artifact", { id: p.id });
    expect(again.text).not.toContain("stored_at");
    const rest = await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth });
    expect(await rest.text()).not.toContain("stored_at");
    await client.close();
  });

  it("the web editor's save (session, html only, base_version) still works and carries assets", async () => {
    const { a, p } = await seed();
    const s = await browserSession(a.user.id);
    const res = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>edited</p>", base_version: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).stored).toMatchObject({ files: 3, written: 1, reused: 2 });
    expect(await (await storedFile(p.id, 2, "style.css"))?.text()).toBe(CSS);
  });
});

describe("versions written before 0006 (legacy layout)", () => {
  /** Rewrite version 1 as an older Worker stored it: v1/ prefix, no sha256, no stored_bytes. */
  async function makeLegacy(id: string) {
    const v1 = await versionRow(id, 1);
    if (!v1) throw new Error("no v1");
    const legacy = `artifacts/${id}/v1/`;
    const entries = (await manifestOf(id, 1)).map(({ path, size_bytes, content_type }) => ({
      path,
      size_bytes,
      content_type,
    }));
    for (const e of entries) {
      const obj = await storedFile(id, 1, e.path);
      if (!obj) throw new Error(`no stored ${e.path}`);
      await env.FILES.put(legacy + e.path, await obj.arrayBuffer(), {
        httpMetadata: { contentType: e.content_type },
      });
    }
    await env.FILES.delete(await r2Keys(v1.r2Prefix));
    await db()
      .update(versions)
      .set({ r2Prefix: legacy, manifest: JSON.stringify(entries), storedBytes: null })
      .where(eq(versions.id, v1.id))
      .run();
  }

  it("serves, carries forward and restores an old-layout version", async () => {
    const { a, p } = await seed();
    await makeLegacy(p.id);
    const v1 = await serve(p.id, "/style.css");
    expect(await v1.text()).toBe(CSS);
    // A legacy entry has no hash: it can be carried but never matched.
    const ref = await put(a.auth, p.id, {
      html: "<p>2</p>",
      assets: [{ path: "style.css", sha256: await sha256Of(CSS) }],
    });
    expect(ref.status).toBe(400);
    const carry = await put(a.auth, p.id, { html: "<p>2</p>" });
    expect(carry.status).toBe(200);
    expect((await json(carry)).stored).toMatchObject({ written: 1, reused: 2 });
    expect((await manifestOf(p.id, 2)).find((e) => e.path === "style.css")).toMatchObject({
      stored_at: "v1/style.css",
    });
    expect(await (await serve(p.id, "/style.css")).text()).toBe(CSS);
    const restore = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: a.auth,
    });
    expect(restore.status).toBe(201);
    expect(await (await serve(p.id, "/")).text()).toBe("<!doctype html><h1>Hello</h1>");
    expect(await (await serve(p.id, "/img/dot.png")).arrayBuffer()).toEqual(pngBytes.buffer);
    expect(await (await serve(p.id, "/__plinth/v/1/style.css")).text()).toBe(CSS);
  });

  it("drops legacy paths older releases accepted but never served, instead of failing", async () => {
    const { a, p } = await seed();
    await makeLegacy(p.id);
    const v1 = await versionRow(p.id, 1);
    if (!v1) throw new Error("no v1");
    // Older releases accepted `a//b.js` and `img/`; the content host never served them.
    const odd = [
      { path: "a//b.js", size_bytes: 1, content_type: "text/javascript" },
      { path: "img/", size_bytes: 1, content_type: "application/octet-stream" },
      { path: "c//d.js", size_bytes: 1, content_type: "text/javascript", sha256: "a".repeat(64) },
    ];
    for (const e of odd) await env.FILES.put(v1.r2Prefix + e.path, "x");
    await db()
      .update(versions)
      .set({ manifest: JSON.stringify([...JSON.parse(v1.manifest), ...odd]) })
      .where(eq(versions.id, v1.id))
      .run();

    // An update without assets carries every servable file and leaves the odd ones out.
    const carry = await put(a.auth, p.id, { html: "<p>2</p>", base_version: 1 });
    expect(carry.status).toBe(200);
    expect((await manifestOf(p.id, 2)).map((e) => e.path).sort()).toEqual(
      ["img/dot.png", "index.html", "style.css"].sort(),
    );
    expect(await (await serve(p.id, "/style.css")).text()).toBe(CSS);

    // Restoring the legacy version works too.
    const restore = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: a.auth,
    });
    expect(restore.status).toBe(201);
    expect((await manifestOf(p.id, 3)).map((e) => e.path).sort()).toEqual(
      ["img/dot.png", "index.html", "style.css"].sort(),
    );
    expect(await (await serve(p.id, "/img/dot.png")).arrayBuffer()).toEqual(pngBytes.buffer);
  });
});

describe("the reference check on reused files", () => {
  it("names reused text files it did not re-check, so a file they load that is gone is not hidden", async () => {
    const a = await agent();
    const appJs = 'import "./chunk.js"; console.log(1)';
    const { body: p } = await publish(a.auth, {
      html: '<!doctype html><title>t</title><script type="module" src="app.js"></script>',
      assets: [
        { path: "app.js", content: appJs },
        { path: "chunk.js", content: "export const x = 1" },
      ],
    });
    expect(p.warnings).toEqual([]);
    // chunk.js is left out; app.js, which imports it, is reused by sha256 and not re-read.
    const res = await put(a.auth, p.id, {
      base_version: 1,
      html: '<!doctype html><title>t2</title><script type="module" src="app.js"></script>',
      assets: [{ path: "app.js", sha256: await sha256Of(appJs) }],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatchObject({ code: "not_scanned", file: "app.js", count: 1 });
    expect(body.warnings[0].message).toMatch(/reused unchanged .* were not re-checked/);
    expect(body.warnings[0].message).toMatch(/No action needed$/);

    // A carry-forward (no assets sent) says the same; sending the bytes checks them instead.
    const carried = await json(
      await put(a.auth, p.id, { base_version: 2, html: "<!doctype html><title>t3</title>" }),
    );
    expect(carried.warnings).toMatchObject([{ code: "not_scanned", count: 1 }]);
    const sent = await json(
      await put(a.auth, p.id, {
        base_version: 3,
        html: '<!doctype html><title>t4</title><script type="module" src="app.js"></script>',
        assets: [{ path: "app.js", content: appJs }],
      }),
    );
    expect(sent.warnings.map((w: { code: string }) => w.code)).toEqual(["missing_file"]);
  });
});

describe("the stager (as the bundle path uses it)", () => {
  it("dedupes identical files within one upload and strips a top directory", async () => {
    const { a, p } = await seed();
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    const enc = new TextEncoder();
    await stager.add("dist/index.html", enc.encode("<!doctype html><title>Built</title>"));
    await stager.add("dist/a.js", enc.encode("console.log(1)"));
    await stager.add("dist/b.js", enc.encode("console.log(1)"));
    await stager.add("dist/style.css", enc.encode(CSS));
    const staged = await stager.finish({ stripPrefix: "dist/" });
    expect(staged.entries.map((e) => e.path)).toEqual(["index.html", "a.js", "b.js", "style.css"]);
    // a.js written once (under its raw path), b.js points at it, style.css reuses v1's object.
    expect(staged).toMatchObject({ written: 2, reused: 2 });
    const keys = await r2Keys(staged.prefix);
    expect(keys.sort()).toEqual([`${staged.prefix}dist/a.js`, `${staged.prefix}index.html`].sort());
    const result = await commitStaged(ctx, target, staged);
    expect(result).toMatchObject({ version: 2, warnings: [] });
    expect(await (await serve(p.id, "/b.js")).text()).toBe("console.log(1)");
    expect(await (await serve(p.id, "/a.js")).text()).toBe("console.log(1)");
    expect(await (await serve(p.id, "/")).text()).toContain("Built");
  });

  it("parses a bundled page's capabilities, as the inline path does", async () => {
    const { a, p } = await seed();
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    await stager.add(
      "site/index.html",
      new TextEncoder().encode(
        '<!doctype html><meta name="plinth-capabilities" content="data viewer"><title>Poll</title>',
      ),
    );
    await stager.add("site/app.js", new TextEncoder().encode("1"));
    const r = await commitStaged(ctx, target, await stager.finish({ stripPrefix: "site/" }));
    const caps = (await versionRow(p.id, r.version))?.capabilities;
    expect(caps).not.toBeNull();
    expect(JSON.parse(caps ?? "{}")).toMatchObject({ data: true, viewer: true });
  });

  it("a doc bundle goes through the doc's rules: Markdown source, images only, index.html reserved", async () => {
    const a = await agent();
    const doc = await publish(a.auth, { type: "doc", html: undefined, content: "# One\n" });
    const ctx = serviceCtxFor(agentPrincipal(a));
    const stage = async (files: Record<string, string | Uint8Array>, strip?: string) => {
      const target = await updateTarget(ctx, doc.body.id, {});
      const stager = await openStager(ctx, target);
      try {
        for (const [path, body] of Object.entries(files))
          await stager.add(path, typeof body === "string" ? new TextEncoder().encode(body) : body);
        return await commitStaged(ctx, target, await stager.finish({ stripPrefix: strip }));
      } catch (e) {
        await stager.abort();
        throw e;
      }
    };
    const ok = await stage(
      { "notes/content.md": "# Two\n", "notes/img/dot.png": pngBytes },
      "notes/",
    );
    expect(ok.version).toBe(2);
    expect(await (await storedFile(doc.body.id, 2, "content.md"))?.text()).toBe("# Two\n");
    await expect(stage({ "content.md": "# x\n", "app.js": "1" })).rejects.toMatchObject({
      code: "invalid_input",
      details: { path: "app.js" },
    });
    await expect(stage({ "content.md": "# x\n", "index.html": "<p>x</p>" })).rejects.toMatchObject({
      code: "invalid_input",
      details: { path: "index.html" },
    });
    await expect(
      stage({ "d/content.md": "<!doctype html><p>not markdown</p>" }, "d/"),
    ).rejects.toMatchObject({ code: "invalid_input", details: { field: "content" } });
    await expect(
      stage({ "d/content.md": "# x\n", "d/index.html": "<p>x</p>" }, "d/"),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await versionRow(doc.body.id, 3)).toBeNull();
  });

  it("refuses an upload with no source file at its top, and leaves nothing behind", async () => {
    const { a, p } = await seed();
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    await stager.add("dist/index.html", new TextEncoder().encode("<p>x</p>"));
    await stager.add("package.json", new TextEncoder().encode("{}"));
    await expect(stager.finish()).rejects.toMatchObject({
      code: "invalid_input",
      details: { reason: "no_entry_file" },
    });
    await stager.abort();
    expect(await r2Keys(stager.prefix)).toEqual([]);
  });

  it("collects bad paths (up to 20) and refuses duplicates", async () => {
    const { a, p } = await seed();
    const ctx = serviceCtxFor(agentPrincipal(a));
    const stager = await openStager(ctx, await updateTarget(ctx, p.id, {}));
    const b = new TextEncoder().encode("x");
    await stager.add("index.html", b);
    for (let i = 0; i < 25; i++) await stager.add(`bad name ${i}.txt`, b);
    await stager.add("ok.txt", b);
    await stager.add("ok.txt", b);
    const err = await stager.finish().catch((e) => e);
    expect(err.code).toBe("invalid_input");
    expect(err.details.paths).toHaveLength(20);
    expect(err.details.paths[0]).toMatchObject({ path: "bad name 0.txt" });
    await stager.abort();
  });
});

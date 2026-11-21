// copy_files (docs/spec.md "Copying files from another artifact"): a publish, update or upload
// copies files from other artifacts the caller can view into the version, on the server. Each
// source is read as the caller through policy.ts (`view`), checked once at publish time; the copy
// is the target's own file from then on. A token limited to one artifact cannot copy.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { designSystemCss, parseDesignSystem } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { accessGrants } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { nowIso } from "../src/lib/time.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import acme from "./fixtures/design-systems/acme.json";
import {
  agent,
  call,
  createToken,
  db,
  json,
  manifestOf,
  mcpClient,
  publish,
  r2Keys,
  storedFile,
  tool,
} from "./helpers.ts";

type Json = Record<string, any>;
type Agent = Awaited<ReturnType<typeof agent>>;

const ACME = JSON.stringify(acme);
const MONO = "wOF2-acme-mono-bytes";
const LOGO = "<svg xmlns='http://www.w3.org/2000/svg'/>";
const PAGE = "<!doctype html><title>Page</title><h1>Hi</h1>";

/** An unlisted page with one stylesheet and one image, owned by `a`. */
async function sourcePage(a: Agent, visibility = "unlisted") {
  const { res, body } = await publish(a.auth, {
    title: "Source",
    visibility,
    assets: [
      { path: "css/brand.css", content: "body{color:#123456}" },
      { path: "img/logo.svg", content: LOGO },
    ],
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body as Json;
}

/** The Acme design system with its font file, private unless the test says otherwise. */
async function designSystem(a: Agent, visibility = "allowlist") {
  const { res, body } = await publish(a.auth, {
    html: undefined,
    title: "Acme UI",
    type: "design_system",
    content: ACME,
    visibility,
    assets: [{ path: "fonts/acme-mono.woff2", content: MONO }],
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body as Json;
}

const post = (a: Agent, body: Json) => publish(a.auth, { title: "Target", html: PAGE, ...body });

const put = async (a: Agent, id: string, body: Json) => {
  const res = await call(`/api/v1/artifacts/${id}`, {
    method: "PUT",
    headers: { ...a.auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: await json(res) };
};

const text = async (id: string, n: number, path: string) =>
  (await storedFile(id, n, path))?.text() ?? null;

describe("copy_files on publish", () => {
  it("copies a file from another artifact into the new version, under the target's own prefix", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const { res, body } = await post(a, {
      copy_files: [{ artifact: src.id, path: "img/logo.svg", to: "brand/logo.svg" }],
    });
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(await text(body.id, 1, "brand/logo.svg")).toBe(LOGO);
    // The bytes live under the target's root: deleting the source keeps the copy.
    const keys = await r2Keys(`artifacts/${body.id}/`);
    expect(keys.some((k) => k.endsWith("/brand/logo.svg"))).toBe(true);
    const m = (await manifestOf(body.id, 1)).find((e) => e.path === "brand/logo.svg");
    expect(m).toMatchObject({
      content_type: "image/svg+xml",
      copied_from: { artifact: src.id, version: 1, path: "img/logo.svg" },
    });
    expect(body.copied_from).toEqual([
      {
        artifact: src.id,
        version: 1,
        copied_at: m?.copied_from?.copied_at,
        files: [{ path: "brand/logo.svg", from: "img/logo.svg" }],
      },
    ]);
    const del = await call(`/api/v1/artifacts/${src.id}`, { method: "DELETE", headers: a.auth });
    expect(del.status).toBe(204);
    expect(await text(body.id, 1, "brand/logo.svg")).toBe(LOGO);
  });

  it("takes an id, a slug or the app link, and `to` defaults to the source path", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    for (const address of [src.slug, src.url, `${src.url}?v=1#top`]) {
      const { res, body } = await post(a, {
        copy_files: [{ artifact: address, path: "css/brand.css" }],
      });
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(await text(body.id, 1, "css/brand.css")).toBe("body{color:#123456}");
    }
    const bad = await post(a, {
      copy_files: [{ artifact: "https://elsewhere.example/a/x", path: "css/brand.css" }],
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("copy_bad_address");
  });

  it("copies from a given version", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const v2 = await put(a, src.id, {
      html: PAGE,
      assets: [{ path: "css/brand.css", content: "body{color:#abcdef}" }],
    });
    expect(v2.res.status).toBe(200);
    const old = await post(a, {
      copy_files: [{ artifact: src.id, path: "css/brand.css", version: 1 }],
    });
    expect(await text(old.body.id, 1, "css/brand.css")).toBe("body{color:#123456}");
    const cur = await post(a, { copy_files: [{ artifact: src.id, path: "css/brand.css" }] });
    expect(await text(cur.body.id, 1, "css/brand.css")).toBe("body{color:#abcdef}");
    const gone = await post(a, {
      copy_files: [{ artifact: src.id, path: "css/brand.css", version: 9 }],
    });
    expect(gone.res.status).toBe(404);
  });

  it("answers a source the caller cannot view exactly like a missing one", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const stranger = await agent();
    const hidden = await post(stranger, {
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    const missing = await post(stranger, {
      copy_files: [{ artifact: "z".repeat(20), path: "img/logo.svg" }],
    });
    expect(hidden.res.status).toBe(404);
    expect(missing.res.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    // A viewer it is shared with may copy.
    await db()
      .insert(accessGrants)
      .values({
        artifactId: src.id,
        email: stranger.user.email,
        role: "viewer",
        createdAt: nowIso(),
      })
      .run();
    const ok = await post(stranger, { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("refuses a token limited to one artifact before any lookup", async () => {
    const a = await agent();
    const target = await sourcePage(a);
    const bound = await createToken(a.user.id, { artifactId: target.id });
    const auth = { Authorization: `Bearer ${bound.token}` };
    for (const artifact of [target.id, "z".repeat(20)]) {
      const r = await put({ ...a, auth } as Agent, target.id, {
        html: PAGE,
        base_version: 1,
        copy_files: [{ artifact, path: "img/logo.svg", to: "x.svg" }],
      });
      expect(r.res.status).toBe(403);
      expect(r.body.error.details).toMatchObject({ reason: "token_bound", field: "copy_files" });
    }
  });

  it("refuses a missing file, a changed type, a file the target type does not take, and repeats", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const cases: [Json[], number, string][] = [
      [[{ artifact: src.id, path: "nope.css" }], 400, "copy_missing_file"],
      [[{ artifact: src.id, path: "img/logo.svg", to: "logo.html" }], 400, "copy_type_mismatch"],
      [
        [
          { artifact: src.id, path: "img/logo.svg", to: "a.svg" },
          { artifact: src.id, path: "img/logo.svg", to: "a.svg" },
        ],
        400,
        "copy_twice",
      ],
    ];
    for (const [copy_files, status, reason] of cases) {
      const r = await post(a, { copy_files });
      expect(r.res.status, JSON.stringify(r.body)).toBe(status);
      expect(r.body.error.details.reason).toBe(reason);
    }
    // A doc takes images only: a stylesheet is refused by the doc's own asset rule.
    const doc = await publish(a.auth, {
      html: undefined,
      type: "doc",
      content: "# Notes",
      copy_files: [{ artifact: src.id, path: "css/brand.css" }],
    });
    expect(doc.res.status).toBe(400);
    expect(doc.body.error.details).toMatchObject({ type: "doc", path: "css/brand.css" });
    // Beside an asset at the same path: the path is listed twice.
    const twice = await post(a, {
      assets: [{ path: "img/logo.svg", content: "<svg/>" }],
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    expect(twice.res.status).toBe(400);
  });

  it("copies from at most four artifact versions in one call", async () => {
    const a = await agent();
    const srcs = [];
    for (let i = 0; i < 5; i++) srcs.push(await sourcePage(a));
    const r = await post(a, {
      copy_files: srcs.map((s, i) => ({ artifact: s.id, path: "img/logo.svg", to: `l${i}.svg` })),
    });
    expect(r.res.status).toBe(400);
    expect(r.body.error.details.reason).toBe("copy_too_many_sources");
  });
});

describe("copy_files on update", () => {
  it("adds to the current files when no assets are sent, replacing one at the same path", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const page = await publish(a.auth, {
      assets: [
        { path: "img/logo.svg", content: "<svg>old</svg>" },
        { path: "app.js", content: "1" },
      ],
    });
    const r = await put(a, page.body.id, {
      html: PAGE,
      base_version: 1,
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(await text(page.body.id, 2, "img/logo.svg")).toBe(LOGO);
    expect(await text(page.body.id, 2, "app.js")).toBe("1");
    // A later update that copies nothing carries the copy and its record.
    const v3 = await put(a, page.body.id, { html: `${PAGE}<p>3</p>`, base_version: 2 });
    expect(v3.res.status).toBe(200);
    const m = (await manifestOf(page.body.id, 3)).find((e) => e.path === "img/logo.svg");
    expect(m?.copied_from).toMatchObject({ artifact: src.id, version: 1, path: "img/logo.svg" });
    const got = await json(await call(`/api/v1/artifacts/${page.body.id}`, { headers: a.auth }));
    expect(got.copied_from).toEqual([
      expect.objectContaining({
        artifact: src.id,
        version: 1,
        title: "Source",
        current_version: 1,
        files: [{ path: "img/logo.svg", from: "img/logo.svg" }],
      }),
    ]);
    expect(JSON.stringify(got)).not.toContain("stored_at");
  });

  it("names the source in get_artifact only to someone who may view it now", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const page = await post(owner, {
      visibility: "unlisted",
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    const stranger = await agent();
    const got = await json(
      await call(`/api/v1/artifacts/${page.body.id}`, { headers: stranger.auth }),
    );
    expect(got.copied_from).toEqual([
      expect.objectContaining({ artifact: src.id, title: null, current_version: null }),
    ]);
  });
});

describe("installing a design system", () => {
  it("get_design_system lists the files and the copy_files that install them", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system`, { headers: a.auth }),
    );
    expect(read.files).toEqual([
      "system.json",
      "tokens.css",
      "fonts.css",
      "components.css",
      "tokens.json",
      "fonts/acme-mono.woff2",
    ]);
    expect(read.install).toEqual({
      folder: "ds/acme",
      copy_files: [
        "fonts.css",
        "tokens.css",
        "components.css",
        "tokens.json",
        "fonts/acme-mono.woff2",
      ].map((path) => ({ artifact: ds.id, path, to: `ds/acme/${path}`, version: 1 })),
      stylesheets: ["ds/acme/fonts.css", "ds/acme/tokens.css", "ds/acme/components.css"],
    });
  });

  it("a page installs it with install.copy_files: generated CSS and JSON, and the font file", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system`, { headers: a.auth }),
    );
    const head = read.install.stylesheets.map((h: string) => `<link rel="stylesheet" href="${h}">`);
    const html = `<!doctype html><head><title>App</title><meta name="plinth-design-system" content="${ds.id}@1">${head.join("")}</head><body>x</body>`;
    const { res, body } = await publish(a.auth, { html, copy_files: read.install.copy_files });
    expect(res.status, JSON.stringify(body)).toBe(201);
    // No missing_file warning: every url() in the copied CSS resolves inside ds/acme/.
    expect(body.warnings.filter((w: Json) => w.code === "missing_file")).toEqual([]);
    const parsed = parseDesignSystem(ACME);
    if (!parsed.ok) throw new Error("fixture");
    const css = await text(body.id, 1, "ds/acme/tokens.css");
    expect(css).toBe(
      `/* Plinth design system ${ds.id} v1: tokens. Generated from system.json. */\n${designSystemCss(parsed.value)}\n`,
    );
    expect(await text(body.id, 1, "ds/acme/fonts.css")).toContain(
      'src:url("fonts/acme-mono.woff2") format("woff2")',
    );
    expect(await text(body.id, 1, "ds/acme/fonts/acme-mono.woff2")).toBe(MONO);
    const tokens = JSON.parse((await text(body.id, 1, "ds/acme/tokens.json")) ?? "{}");
    expect(tokens).toMatchObject({
      format: "plinth.design-system-tokens/1",
      design_system: { id: ds.id, version: 1 },
      prefix: "acme",
    });
    expect(tokens.tokens.find((t: Json) => t.path === "color.accent")).toMatchObject({
      css_var: "--acme-color-accent",
      value: "#3355ff",
      dark: "#6b8cff",
    });
    const got = await json(await call(`/api/v1/artifacts/${body.id}`, { headers: a.auth }));
    expect(got.design_system).toEqual({
      id: ds.id,
      title: "Acme UI",
      version: 1,
      current_version: 1,
    });
    expect(got.copied_from).toHaveLength(1);
    expect(got.copied_from[0].files).toHaveLength(5);
  });

  it("works over MCP with the same input", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const c = await mcpClient(a.token);
    const read = await tool(c, "get_design_system", { id: ds.id, include: ["css"] });
    const r = await tool(c, "publish_artifact", {
      title: "From MCP",
      html: PAGE,
      copy_files: read.data.install.copy_files,
    });
    await c.close();
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(await text(r.data.id, 1, "ds/acme/tokens.css")).toMatch(/--acme-color-brand-500/);
  });

  it("a design takes the CSS but refuses the font files, with the design's own rule", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const content =
      `<meta name="plinth-design-system" content="${ds.id}@1">\n` +
      '<link rel="stylesheet" href="ds/acme/tokens.css">\n' +
      '<!-- artboard id="home" name="Home" size="iphone" -->\n<div>Home</div>\n';
    const ok = await publish(a.auth, {
      html: undefined,
      type: "design",
      content,
      copy_files: [{ artifact: ds.id, path: "tokens.css", to: "ds/acme/tokens.css" }],
    });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(201);
    const font = await publish(a.auth, {
      html: undefined,
      type: "design",
      content,
      copy_files: [{ artifact: ds.id, path: "fonts/acme-mono.woff2", to: "ds/acme/fonts/a.woff2" }],
    });
    expect(font.res.status).toBe(400);
    expect(font.body.error.message).toMatch(/opaque origin/);
  });
});

describe("copy_files on start_upload", () => {
  async function upload(a: Agent, input: Json, files: { name: string; data: string }[]) {
    const start = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const t = await json(start);
    if (start.status !== 201 && start.status !== 200) return { status: start.status, body: t };
    const req = new Request(t.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.upload_token}` },
      body: tar(files),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as never, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await json(res) };
  }

  it("copies beside the bundle's files, which a prefix strip does not move", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const r = await upload(
      a,
      { copy_files: [{ artifact: src.id, path: "img/logo.svg", to: "brand/logo.svg" }] },
      [
        { name: "dist/index.html", data: PAGE },
        { name: "dist/app.js", data: "1" },
      ],
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.bundle.stripped_prefix).toBe("dist/");
    expect((await manifestOf(r.body.id, 1)).map((e) => e.path).sort()).toEqual([
      "app.js",
      "brand/logo.svg",
      "index.html",
    ]);
    expect(await text(r.body.id, 1, "brand/logo.svg")).toBe(LOGO);
    expect(r.body.copied_from).toEqual([
      expect.objectContaining({
        artifact: src.id,
        files: [{ path: "brand/logo.svg", from: "img/logo.svg" }],
      }),
    ]);
  });

  it("refuses a ticket whose source the caller cannot view, before minting", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const stranger = await agent();
    const r = await upload(
      stranger,
      { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] },
      [],
    );
    expect(r.status).toBe(404);
  });
});

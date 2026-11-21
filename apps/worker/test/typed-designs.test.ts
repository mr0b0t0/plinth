// The design type: an agent sends a design's source (shared <head> tags, then artboards) in content
// over MCP or REST and Plinth stores design.html plus its images, CSS, JS and video. The content
// host serves the strict typed shell, the design's files (cross-origin readable, never as HTML)
// and, behind the content pass, the board loader each artboard frame opens with an opaque origin
// in every isolation mode. Checked here: both wires, every fix-it refusal (inline and bundled),
// assets, update, restore, titles, warnings and what the content host serves.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DESIGN_LIMITS, DESIGN_MESSAGES, TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { boardLoaderHtml } from "../src/content/boardLoader.ts";
import { contentCsp, OPAQUE_SANDBOX } from "../src/content/csp.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { titleFromSource } from "../src/services/stage.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import {
  agent,
  call,
  config,
  contentOrigin,
  enterContent,
  json,
  manifestOf,
  mcpClient,
  publish,
  r2Keys,
  storedFile,
  tool,
  versionRow,
} from "./helpers.ts";

const PNG = "iVBORw0KGgo=";
const DESIGN = [
  "<title>Launch kit</title>",
  '<link rel="stylesheet" href="brand.css">',
  "",
  '<!-- artboard id="home" name="Home" size="iphone" section="Mobile" -->',
  '<main><img src="img/hero.png" alt=""><h1>Ship faster</h1></main>',
  "",
  '<!-- artboard id="post" name="Launch post" size="instagram-post" background="#0b0b0f" -->',
  "<div>Now live</div>",
  "",
  '<!-- artboard id="mrec" name="Ad 300x250" width="300" height="250" section="Ads" -->',
  '<a href="https://example.com" target="_blank">Try it</a>',
].join("\n");
const ASSETS = [
  { path: "img/hero.png", content: PNG, encoding: "base64" },
  { path: "brand.css", content: "h1{color:#2f5bea}", content_type: "text/css" },
];

const LOADER = "/__plinth/frames/design/board.html";

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const publishDesign = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, { html: undefined, type: "design", content: DESIGN, assets: ASSETS, ...body });

const detail = async (auth: Record<string, string>, ref: string, n?: number) =>
  json(
    await call(n ? `/api/v1/artifacts/${ref}/versions/${n}` : `/api/v1/artifacts/${ref}`, {
      headers: auth,
    }),
  );

function errorOf(r: { res: Response; body: any }) {
  expect(r.res.status).toBe(400);
  return r.body.error;
}

function payloadOf(html: string) {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html);
  expect(m, "payload block").not.toBeNull();
  return JSON.parse(m?.[1] ?? "null");
}

async function run(url: string, init: RequestInit = {}, vars?: Record<string, string>) {
  const ctx = createExecutionContext();
  const e = vars ? { ...(env as unknown as Record<string, unknown>), ...vars } : env;
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    e as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const directives = (res: Response) =>
  (res.headers.get("content-security-policy") ?? "").split(";").map((d) => d.trim());

describe("designs over REST", () => {
  it("publishes design.html plus its assets, no index.html, type design everywhere", async () => {
    const a = await agent();
    const { res, body } = await publishDesign(a.auth);
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ version: 1, type: "design", warnings: [] });
    const manifest = await manifestOf(body.id, 1);
    expect(manifest.map((m) => [m.path, m.content_type])).toEqual([
      ["design.html", "text/html; charset=utf-8"],
      ["img/hero.png", "image/png"],
      ["brand.css", "text/css; charset=utf-8"],
    ]);
    const v1 = await versionRow(body.id, 1);
    expect(await r2Keys(v1?.r2Prefix ?? "-")).not.toContain(`${v1?.r2Prefix}index.html`);
    expect(await (await storedFile(body.id, 1, "design.html"))?.text()).toBe(DESIGN);
    const d = await detail(a.auth, body.slug);
    expect(d).toMatchObject({ type: "design", content: DESIGN, source_path: "design.html" });
    expect("html" in d).toBe(false);
    const list = await json(await call("/api/v1/artifacts", { headers: a.auth }));
    expect(list.items.find((i: { id: string }) => i.id === body.id)).toMatchObject({
      type: "design",
    });
  });

  it("takes its title from the shared <title>, else the first board's name", async () => {
    expect(titleFromSource(TYPE_REGISTRY.design, DESIGN)).toBe("Launch kit");
    expect(
      titleFromSource(TYPE_REGISTRY.design, '<!-- artboard name="Poster &amp; co" size="a4" -->'),
    ).toBe("Poster & co");
    expect(titleFromSource(TYPE_REGISTRY.design, "<p>no boards</p>")).toBeNull();
  });

  it("refuses every mismatch and every design it cannot hold, with a fix-it message", async () => {
    const a = await agent();
    expect(
      errorOf(await publishDesign(a.auth, { content: undefined, html: DESIGN })),
    ).toMatchObject({
      message: "type design takes design HTML in content, not html",
      details: { type: "design", field: "html" },
    });
    expect(errorOf(await publishDesign(a.auth, { content: "<p>x</p>" }))).toMatchObject({
      message: DESIGN_MESSAGES.noBoards,
      details: { type: "design", field: "content", issues: [{ line: 0 }] },
    });
    expect(
      errorOf(await publishDesign(a.auth, { content: "<!doctype html><html><p>x</p></html>" })),
    ).toMatchObject({ message: DESIGN_MESSAGES.wholeDocument });
    const two = errorOf(
      await publishDesign(a.auth, {
        content: '<!-- artboard name="A" size="iphon" -->\n<!-- artboard name="B" x="1" -->',
      }),
    );
    expect(two.message).toMatch(/^Line 1: "iphon" is not a size preset\..*\(and 1 more problem\)$/);
    expect(two.details.issues.map((i: { line: number }) => i.line)).toEqual([1, 2]);
    const many = Array.from(
      { length: 61 },
      (_, i) => `<!-- artboard name="B${i}" size="ad-mobile-banner" -->`,
    ).join("\n");
    expect(errorOf(await publishDesign(a.auth, { content: many })).message).toBe(
      "A design has at most 60 artboards; this one has 61. Split it into two designs.",
    );
    const big = `<!-- artboard name="A" size="a4" -->\n${"x".repeat(2 * 1024 * 1024)}`;
    expect((await publishDesign(a.auth, { content: big, assets: [] })).res.status).toBe(413);
  });

  it("takes images, CSS, JS and video, and refuses fonts, data and HTML with what to do", async () => {
    const a = await agent();
    const ok = await publishDesign(a.auth, {
      assets: [
        ...ASSETS,
        {
          path: "logo.svg",
          content: "<svg xmlns='http://www.w3.org/2000/svg'/>",
          content_type: "image/svg+xml",
        },
        { path: "app.js", content: "window.x=1", content_type: "text/javascript" },
        { path: "intro.mp4", content: "AAAA", encoding: "base64", content_type: "video/mp4" },
      ],
    });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(201);
    const refused: [Record<string, unknown>, string | RegExp][] = [
      [
        { path: "brand.woff2", content: "AAAA", encoding: "base64", content_type: "font/woff2" },
        /^Artboards cannot load font files from the artifact/,
      ],
      [
        { path: "f.ttf", content: "AAAA", encoding: "base64", content_type: "font/ttf" },
        /Use Google Fonts or a data: URL in @font-face\.$/,
      ],
      [
        { path: "data.json", content: "{}", content_type: "application/json" },
        "Artboards cannot fetch files: put data inline in a <script>.",
      ],
      [
        { path: "page.html", content: "<p>x</p>", content_type: "text/html" },
        "A design's assets are images (png, jpg, gif, webp, avif, svg), CSS, JS and mp4/webm video.",
      ],
      [
        { path: "design.html", content: "x", content_type: "text/html" },
        "design.html and index.html belong to the design, not its assets",
      ],
      [
        { path: "index.html", content: "x", content_type: "text/html" },
        "design.html and index.html belong to the design, not its assets",
      ],
    ];
    for (const [asset, message] of refused) {
      const e = errorOf(await publishDesign(a.auth, { assets: [asset] }));
      if (typeof message === "string") expect(e.message, String(asset.path)).toBe(message);
      else expect(e.message, String(asset.path)).toMatch(message);
      expect(e.details).toMatchObject({ type: "design", field: "assets" });
    }
  });

  it("updates with content and base_version, refuses a stale base and html, restores v1 as v3", async () => {
    const a = await agent();
    const { body: p } = await publishDesign(a.auth);
    const two = '<!-- artboard name="Only" size="a4" -->\n<img src="img/hero.png" alt="">';
    const up = await put(a.auth, p.id, { content: two, base_version: 1 });
    expect(up.status).toBe(200);
    expect(await json(up)).toMatchObject({ version: 2, type: "design" });
    // Assets are carried forward when an update leaves them out.
    expect((await manifestOf(p.id, 2)).map((m) => m.path).sort()).toEqual([
      "brand.css",
      "design.html",
      "img/hero.png",
    ]);
    expect((await put(a.auth, p.id, { content: two, base_version: 1 })).status).toBe(409);
    const html = await put(a.auth, p.id, { html: "<p>x</p>" });
    expect(html.status).toBe(400);
    expect((await json(html)).error.message).toBe(
      "This artifact is a design: send its design HTML as content. The type cannot change.",
    );
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ version: 3, type: "design", warnings: [] });
    expect(await detail(a.auth, p.id)).toMatchObject({ version: 3, content: DESIGN });
  });

  it("warns about a module script with the artboard wording and a missing board image", async () => {
    const a = await agent();
    const content = [
      '<!-- artboard name="App" size="iphone" -->',
      '<script type="module" src="app.js"></script>',
      '<img src="img/missing.png" alt="">',
    ].join("\n");
    const { res, body } = await publishDesign(a.auth, {
      content,
      assets: [{ path: "app.js", content: "export {}", content_type: "text/javascript" }],
    });
    expect(res.status).toBe(201);
    expect(config().contentIsolation).toBe("origin");
    const codes = body.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain("missing_file");
    expect(body.warnings.find((w: { code: string }) => w.code === "opaque_module")).toMatchObject({
      file: "design.html",
      message:
        "Artboards run with an opaque origin: module scripts, crossorigin links and web fonts from the artifact fail. Use classic scripts, Google Fonts or data: fonts.",
    });
    expect(body.warnings.find((w: { code: string }) => w.code === "missing_file")).toMatchObject({
      ref: "img/missing.png",
    });
  });

  it("gives no opaque_module for Google Fonts' embed, a data: font or a CDN script with crossorigin", async () => {
    const a = await agent();
    for (const shared of [
      [
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">',
      ],
      ["<style>@font-face { font-family: Brand; src: url(data:font/woff2;base64,AAAA); }</style>"],
      [
        '<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>',
      ],
    ]) {
      const content = [
        ...shared,
        '<!-- artboard name="Post" size="instagram-post" -->',
        "<p>Hi</p>",
      ];
      const { res, body } = await publishDesign(a.auth, {
        content: content.join("\n"),
        assets: [],
      });
      expect(res.status).toBe(201);
      expect(body.warnings, shared.join(" ")).toEqual([]);
    }
  });
});

describe("designs through start_upload", () => {
  it("refuses a bundle whose design.html has no boards, with the same message", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const started = await tool(mcp, "start_upload", { title: "Bundle", type: "design" });
    expect(started.isError, started.text).toBe(false);
    const { upload_url, upload_token } = started.data;
    const res = await run(upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${upload_token}` },
      body: tar([
        { name: "design.html", data: "<p>no boards</p>" },
        { name: "img/a.png", data: "png" },
      ]),
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toMatchObject({
      code: "invalid_input",
      message: DESIGN_MESSAGES.noBoards,
      details: { type: "design", field: "content" },
    });
    await mcp.close();
  });
});

describe("designs over MCP", () => {
  it("publishes, reads and updates a design, and the tools describe designs", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", {
      title: "Kit",
      type: "design",
      content: DESIGN,
      assets: ASSETS,
    });
    expect(pub.isError, pub.text).toBe(false);
    expect(pub.data).toMatchObject({ version: 1, type: "design" });
    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data).toMatchObject({ type: "design", content: DESIGN, source_path: "design.html" });
    const up = await tool(mcp, "update_artifact", {
      id: pub.data.id,
      content: '<!-- artboard name="One" size="a4" -->\n<p>v2</p>',
      base_version: 1,
      note: "One board",
    });
    expect(up.data).toMatchObject({ version: 2, type: "design" });

    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("publish_artifact")).toContain(
      'Pass type "design" with content for visual designs',
    );
    expect(byName.get("publish_artifact")).toContain("Up to 60 artboards, 2 MB.");
    expect(byName.get("publish_artifact")).toContain('height="auto" with a size or width');
    expect(byName.get("publish_artifact")).toContain('a link href="#board=<id>"');
    expect(byName.get("get_artifact")).toContain('For type "design", content is its artboard HTML');
    expect(byName.get("update_artifact")).toContain("content (artboard HTML) for a design");
    expect(mcp.getInstructions()).toContain(
      'For a visual design at fixed sizes (app screens, posters, social posts, ads, banners), publish type "design" with design HTML in content instead of writing HTML: Plinth renders it as artboards on a canvas.',
    );
    await mcp.close();
  });
});

describe("designs on the content host", () => {
  async function opened(body: Record<string, unknown> = {}) {
    const a = await agent();
    const { body: p } = await publishDesign(a.auth, body);
    const { cookie } = await enterContent(p.id);
    const get = (path: string, headers: Record<string, string> = {}) =>
      call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "", ...headers } });
    return { a, p, get, cookie: cookie ?? "" };
  }

  it("serves the shell with the strict CSP and a design payload, escaped", async () => {
    const evil = `<title></title><script>alert(1)</script>\n<!-- artboard name="A" size="a4" -->\n</script><script>alert(2)</script>`;
    const { p, get } = await opened({ content: evil, assets: [], title: "</title><b>x" });
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    const html = await res.text();
    expect(html).toContain(
      '<main id="__plinth-design" class="plinth-design" tabindex="-1"></main>',
    );
    expect(html).toContain('<script src="/__plinth/types/design/design.js"></script>');
    expect(html).toContain("<title>&lt;/title&gt;&lt;b&gt;x</title>");
    expect(html.match(/<script/gi)?.length).toBe(2);
    expect(payloadOf(html)).toEqual({
      v: 1,
      type: "design",
      path: "design.html",
      app_origin: config().appOrigin,
      text: evil,
      version: 1,
    });
    expect(p.type).toBe("design");
  });

  it("names the version it shows in the payload, so boards load that version's files", async () => {
    const { a, p, get } = await opened();
    await put(a.auth, p.id, { content: '<!-- artboard name="Two" size="a4" -->', base_version: 1 });
    // The root shows the current version; a version path shows its own, also under review mode.
    expect(payloadOf(await (await get("/")).text()).version).toBe(2);
    expect(payloadOf(await (await get("/__plinth/v/1/")).text()).version).toBe(1);
    expect(payloadOf(await (await get("/__plinth/v/1/?plinth-review=1")).text()).version).toBe(1);
    expect(payloadOf(await (await get("/__plinth/v/2/")).text()).version).toBe(2);
    // A capture pass is bound to its version: the root serves that one, and the payload says so.
    const c = config();
    const name = contentCookieName(c, new URL(contentOrigin(p.id)));
    const capture = await signContentCookie(
      c,
      p.id,
      await accessEpoch(p.id),
      undefined,
      "capture",
      1,
    );
    const shot = await call(`${contentOrigin(p.id)}/`, {
      headers: { Cookie: `${name}=${capture}` },
    });
    expect(shot.status).toBe(200);
    const shown = payloadOf(await shot.text());
    expect(shown.text).toBe(DESIGN);
    expect(shown.version).toBe(1);
  });

  it("serves older versions, design.html as text and files cross-origin readable, with no script", async () => {
    const { a, p, get } = await opened();
    await put(a.auth, p.id, { content: '<!-- artboard name="Two" size="a4" -->', base_version: 1 });
    expect(payloadOf(await (await get("/__plinth/v/1/")).text()).text).toBe(DESIGN);
    const noScript = contentCsp(config(), { scripts: "none" });
    for (const path of [
      "/design.html",
      "/__plinth/v/1/design.html",
      "/design.html?plinth-review=1",
    ]) {
      const src = await get(path);
      expect(src.status, path).toBe(200);
      expect(src.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(src.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(src.headers.get("content-security-policy"), path).toBe(noScript);
      // No board loads the source (the shell carries it inline), so it stays same-origin.
      expect(src.headers.get("cross-origin-resource-policy"), path).toBe("same-origin");
      expect(await src.text(), path).not.toContain("bridge.js");
    }
    for (const path of ["/img/hero.png", "/brand.css", "/__plinth/v/1/img/hero.png"]) {
      const f = await get(path);
      expect(f.status, path).toBe(200);
      expect(f.headers.get("content-security-policy"), path).toBe(noScript);
      expect(f.headers.get("cross-origin-resource-policy"), path).toBe("cross-origin");
    }
  });

  it("keeps an HTML artifact's and a doc's files same-origin only", async () => {
    const a = await agent();
    const { body: page } = await publish(a.auth, {
      assets: [{ path: "img/a.png", content: PNG, encoding: "base64" }],
    });
    const { cookie } = await enterContent(page.id);
    const img = await call(`${contentOrigin(page.id)}/img/a.png`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("serves the board loader only with this design's pass: default scripts, one sandbox, framed by the shell and the app", async () => {
    const { p, get } = await opened();
    const res = await get(LOADER, { "sec-fetch-dest": "iframe" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const d = directives(res);
    expect(d.filter((x) => x.startsWith("sandbox"))).toEqual([OPAQUE_SANDBOX]);
    expect(OPAQUE_SANDBOX).not.toContain("allow-same-origin");
    // Under origin isolation the shell has the artifact's own origin: 'self' and the app name
    // every ancestor, so no other site can frame the loader and paint into it.
    expect(d.filter((x) => x.startsWith("frame-ancestors"))).toEqual([
      `frame-ancestors 'self' ${config().appOrigin}`,
    ]);
    expect(d).toContain(
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'${config()
        .cdnAllowlist.map((h) => ` https://${h}`)
        .join("")}`,
    );
    expect(await res.text()).toBe(boardLoaderHtml());
    const head = await call(`${contentOrigin(p.id)}${LOADER}`, {
      method: "HEAD",
      headers: { Cookie: (await enterContent(p.id)).cookie ?? "" },
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("keeps one sandbox directive under opaque isolation, where an opaque shell frames it", async () => {
    const { p, cookie } = await opened();
    const res = await run(
      `${contentOrigin(p.id)}${LOADER}`,
      { headers: { Cookie: cookie, "sec-fetch-dest": "iframe" } },
      { CONTENT_ISOLATION: "opaque" },
    );
    expect(res.status).toBe(200);
    expect(directives(res).filter((x) => x.startsWith("sandbox"))).toEqual([OPAQUE_SANDBOX]);
    // No source can name an opaque shell.
    expect(directives(res).some((x) => x.startsWith("frame-ancestors"))).toBe(false);
  });

  it("refuses the loader without a pass, at the top level, for other types and other files", async () => {
    const { p, get } = await opened();
    const bare = await call(`${contentOrigin(p.id)}${LOADER}`, {
      headers: { "sec-fetch-dest": "iframe" },
    });
    expect(bare.status).toBe(401);
    expect(await bare.text()).toMatch(/Reload the page/);
    const top = await get(LOADER, { "sec-fetch-dest": "document" });
    expect(top.status).toBe(302);
    expect(top.headers.get("location")).toMatch(new RegExp(`^${config().appOrigin}/a/${p.id}`));
    for (const path of [
      "/__plinth/frames/design/other.html",
      "/__plinth/frames/design/",
      "/__plinth/frames/doc/board.html",
      "/__plinth/types/design/board.html",
      "/__plinth/frames/design/board.html/x",
    ]) {
      expect((await get(path, { "sec-fetch-dest": "iframe" })).status, path).toBe(404);
    }
    // An HTML page and a doc never get the loader, even with their own pass.
    const a = await agent();
    const { body: page } = await publish(a.auth);
    const { body: doc } = await publish(a.auth, { html: undefined, type: "doc", content: "# D" });
    for (const id of [page.id, doc.id]) {
      const { cookie } = await enterContent(id);
      const res = await call(`${contentOrigin(id)}${LOADER}`, {
        headers: { Cookie: cookie ?? "", "sec-fetch-dest": "iframe" },
      });
      expect(res.status, id).toBe(404);
    }
    // Another artifact's pass is no pass for this one.
    const { cookie: other } = await enterContent(page.id);
    const foreign = await call(`${contentOrigin(p.id)}${LOADER}`, {
      headers: { Cookie: other ?? "", "sec-fetch-dest": "iframe" },
    });
    expect(foreign.status).toBe(401);
  });

  it("gives a preview pass for one version the loader, and capture passes too", async () => {
    const { a, p } = await opened();
    await put(a.auth, p.id, { content: '<!-- artboard name="Two" size="a4" -->', base_version: 1 });
    const c = config();
    const name = contentCookieName(c, new URL(contentOrigin(p.id)));
    const art = await json(await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth }));
    expect(art.version).toBe(2);
    const row = await versionRow(p.id, 1);
    expect(row).not.toBeNull();
    const epoch = await accessEpoch(p.id);
    const preview = await signContentCookie(c, p.id, epoch, undefined, "preview", 1);
    const res = await call(`${contentOrigin(p.id)}${LOADER}`, {
      headers: { Cookie: `${name}=${preview}`, "sec-fetch-dest": "iframe" },
    });
    expect(res.status).toBe(200);
    expect(directives(res).some((x) => x.startsWith("frame-ancestors"))).toBe(false);
    // The preview pass still opens only its own version's files.
    const v1img = await call(`${contentOrigin(p.id)}/__plinth/v/1/img/hero.png`, {
      headers: { Cookie: `${name}=${preview}` },
    });
    expect(v1img.status).toBe(200);
    expect(
      (
        await call(`${contentOrigin(p.id)}/img/hero.png`, {
          headers: { Cookie: `${name}=${preview}` },
        })
      ).status,
    ).toBe(404);
    const capture = await signContentCookie(c, p.id, epoch, undefined, "capture", 1);
    const cap = await call(`${contentOrigin(p.id)}${LOADER}`, {
      headers: { Cookie: `${name}=${capture}`, "sec-fetch-dest": "iframe" },
    });
    expect(cap.status).toBe(200);
    expect(directives(cap).filter((x) => x.startsWith("frame-ancestors"))).toEqual([
      `frame-ancestors 'self' ${c.appOrigin}`,
    ]);
  });

  it("serves design.js and design.css without a cookie, and nothing else under the type", async () => {
    const { p } = await opened();
    const js = await call(`${contentOrigin(p.id)}/__plinth/types/design/design.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("content-security-policy")).toBe(contentCsp(config()));
    const src = await js.text();
    expect(src.length).toBeGreaterThan(1000);
    // The renderer itself, not the SPA's index.html (it carries the board document's doctype).
    expect(src.trimStart().startsWith("<")).toBe(false);
    expect(src).toContain("plinth-board");
    const css = await call(`${contentOrigin(p.id)}/__plinth/types/design/design.css`);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(await css.text()).toContain(".plinth-design");
    for (const path of ["/__plinth/types/design/doc.js", "/__plinth/types/design/index.html"]) {
      expect((await call(`${contentOrigin(p.id)}${path}`)).status, path).toBe(404);
    }
  });
});

describe("the board loader page", () => {
  it("renders only what its parent window posts, once, and never reads an origin", () => {
    const html = boardLoaderHtml();
    expect(html).toContain("if (window.parent === window) return;");
    expect(html).toContain("if (done || event.source !== parentWindow) return;");
    expect(html).toContain('d.source !== SOURCE || d.v !== VERSION || d.type !== "render"');
    expect(html).toContain('var SOURCE = "plinth-board";');
    expect(html).not.toContain("APP_ORIGIN");
    expect(html.match(/<script/g)?.length).toBe(1);
  });

  it("measures only a fluid board, and turns #board= links into a goto without following them", () => {
    const html = boardLoaderHtml();
    expect(html).toContain("var fluid = d.fluid === true;");
    expect(html).toContain("var report = fluid ? watchHeight() : null;");
    expect(html).toContain(`var MAX_HEIGHT = ${DESIGN_LIMITS.maxAutoHeight};`);
    expect(html).toContain('var LINK_PREFIX = "#board=";');
    expect(html).toContain("event.preventDefault();");
    expect(html).toContain('post("goto", { board: id });');
    // The link's own attribute, never the URL its <base> resolves it to.
    expect(html).toContain('el.getAttribute("href")');
    // Its listeners go on after document.open, which clears a window's listeners.
    expect(html.indexOf("document.close();")).toBeLessThan(html.indexOf("followLinks();\n"));
  });
});

async function accessEpoch(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT access_epoch AS e FROM artifacts WHERE id = ?1")
    .bind(id)
    .first<{ e: number }>();
  return row?.e ?? 0;
}

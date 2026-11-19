// The slides type: an agent sends a deck's Markdown in content (MCP or REST) and Plinth stores
// slides.md plus image assets; the content host serves a fixed shell around it with the strict
// shell CSP. Checked here: publish and update on both wires, every fix-it refusal, the deck's
// publish warnings, restore, and what the content and app hosts serve.

import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { checkAsset, resolveSource } from "../src/services/artifactTypes.ts";
import { titleFromSource } from "../src/services/stage.ts";
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
const DECK = [
  "---",
  "aspect: 4:3",
  "footer: Q4 review",
  "---",
  "",
  "# Q4 review",
  "",
  "Revenue and hiring",
  "",
  "Note: Keep it short.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "![chart](img/chart.png)",
  "",
  "---",
  "",
  "## Thanks",
  "",
].join("\n");

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const publishDeck = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, {
    html: undefined,
    type: "slides",
    content: DECK,
    assets: [{ path: "img/chart.png", content: PNG, encoding: "base64" }],
    ...body,
  });

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

describe("slides over REST", () => {
  it("publishes slides.md plus its image, no index.html, type slides everywhere", async () => {
    const a = await agent();
    const { res, body } = await publishDeck(a.auth);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ version: 1, type: "slides", warnings: [] });
    const manifest = await manifestOf(body.id, 1);
    expect(manifest.map((m) => [m.path, m.content_type])).toEqual([
      ["slides.md", "text/markdown; charset=utf-8"],
      ["img/chart.png", "image/png"],
    ]);
    const v1 = await versionRow(body.id, 1);
    expect(await r2Keys(v1?.r2Prefix ?? "-")).not.toContain(`${v1?.r2Prefix}index.html`);
    expect(await (await storedFile(body.id, 1, "slides.md"))?.text()).toBe(DECK);

    const d = await detail(a.auth, body.slug);
    expect(d).toMatchObject({
      type: "slides",
      content: DECK,
      source_path: "slides.md",
      title: "Test artifact",
    });
    expect("html" in d).toBe(false);
    const list = await json(await call("/api/v1/artifacts", { headers: a.auth }));
    expect(list.items.find((i: { id: string }) => i.id === body.id)).toMatchObject({
      type: "slides",
    });
  });

  it("takes its title from the first # heading, past the front matter", () => {
    expect(titleFromSource(TYPE_REGISTRY.slides, DECK)).toBe("Q4 review");
    expect(titleFromSource(TYPE_REGISTRY.slides, "---\ntheme: dark\n---\n## Only sub")).toBeNull();
  });

  it("refuses every mismatch and every deck it cannot hold, with a fix-it message", async () => {
    const a = await agent();
    const wantsContent = errorOf(await publishDeck(a.auth, { content: undefined }));
    expect(wantsContent).toMatchObject({
      code: "invalid_input",
      message: "type slides needs its Markdown in content",
      details: { type: "slides", field: "content" },
    });
    expect(errorOf(await publishDeck(a.auth, { html: "<p>x</p>" })).message).toBe(
      "type slides takes Markdown in content, not html",
    );
    expect(errorOf(await publish(a.auth, { content: "# x" })).message).toBe(
      'content is for typed artifacts: pass type "doc", "slides", "design_system" or "design", or send html',
    );
    expect(
      errorOf(await publishDeck(a.auth, { content: "<!doctype html><html><body>x</body></html>" }))
        .message,
    ).toBe(
      'content for type slides is Markdown. To publish HTML, use type "html" and the html field.',
    );
    expect(errorOf(await publishDeck(a.auth, { content: "\n---\n\n---\n" }))).toMatchObject({
      message: "The deck has no slides: write Markdown, with a line --- between slides",
      details: { type: "slides", field: "content" },
    });
    const many = Array.from({ length: 501 }, (_, i) => `## ${i + 1}`).join("\n---\n");
    expect(errorOf(await publishDeck(a.auth, { content: many, assets: undefined }))).toMatchObject({
      message: "A deck holds at most 500 slides; this one has 501. Split it into two decks",
      details: { type: "slides", field: "content", slides: 501, max_slides: 500 },
    });
    const ok500 = Array.from({ length: 500 }, (_, i) => `## ${i + 1}`).join("\n---\n");
    expect((await publishDeck(a.auth, { content: ok500, assets: undefined })).res.status).toBe(201);
    const big = `# Big\n\n${"x".repeat(1024 * 1024)}`;
    const tooBig = await publishDeck(a.auth, { content: big, assets: undefined });
    expect(tooBig.res.status).toBe(413);
    expect(tooBig.body.error.message).toMatch(/1 MB|1048576/);
    const script = errorOf(
      await publishDeck(a.auth, { assets: [{ path: "app.js", content: "alert(1)" }] }),
    );
    expect(script).toMatchObject({
      message: "A deck's assets are images (png, jpg, gif, webp, avif, svg)",
      details: { type: "slides", field: "assets", path: "app.js" },
    });
    expect(
      errorOf(await publishDeck(a.auth, { assets: [{ path: "slides.md", content: "x" }] })).message,
    ).toBe("slides.md and index.html belong to the slides, not its assets");
  });

  it("checks assets and sources the same way the per-type hooks do", () => {
    expect(() => checkAsset(TYPE_REGISTRY.slides, "a.webp", "image/webp")).not.toThrow();
    expect(() => checkAsset(TYPE_REGISTRY.slides, "index.html", "text/html")).toThrow();
    expect(resolveSource({ content: "# y" }, "slides").def.id).toBe("slides");
    expect(() => resolveSource({ html: "<p>y</p>" }, "slides")).toThrow(
      "This artifact is a slides: send its Markdown as content. The type cannot change.",
    );
  });

  it("warns about ignored settings, empty and dense slides and missing images, never blocking", async () => {
    const a = await agent();
    const deck = [
      "---",
      "theme: neon",
      "---",
      "# A",
      "![there](img/chart.png) ![gone](img/missing.png)",
      "---",
      "",
      "---",
      `## Dense\n\n${"word ".repeat(300)}`,
    ].join("\n");
    const { res, body } = await publishDeck(a.auth, { content: deck });
    expect(res.status).toBe(201);
    expect(body.warnings.map((w: { code: string }) => w.code)).toEqual([
      "slides_setting",
      "slide_empty",
      "slide_dense",
      "missing_file",
    ]);
    for (const w of body.warnings) expect(w.file).toBe("slides.md");
    expect(body.warnings[1].message).toBe(
      "Slide 2 (line 7) is empty; remove the extra --- or give it content",
    );
    expect(body.warnings[3]).toMatchObject({ ref: "img/missing.png" });
    const clean = await publishDeck(a.auth);
    expect(clean.body.warnings).toEqual([]);
  });

  it("quotes deck text in a warning with its control characters escaped", async () => {
    const a = await agent();
    const deck = "---\naspect: \u001b]8;;https://x.example\u0007\ntheme: \u007fdark\n---\n# A";
    const { res, body } = await publishDeck(a.auth, { content: deck });
    expect(res.status).toBe(201);
    expect(body.warnings.map((w: { message: string }) => w.message)).toEqual([
      'aspect is 16:9 or 4:3, not "\\u001b]8;;https://x.example\\u0007"',
      'theme is auto, light or dark, not "\\u007fdark"',
    ]);
    const raw = (s: string) =>
      [...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f);
    for (const w of body.warnings) expect(raw(w.message)).toBe(false);
  });

  it("updates with content and base_version, refuses a stale base, and restores v1 as v3", async () => {
    const a = await agent();
    const { body: p } = await publishDeck(a.auth);
    const up = await put(a.auth, p.id, { content: "# Two\n---\n## B\n", base_version: 1 });
    expect(up.status).toBe(200);
    expect(await json(up)).toMatchObject({ version: 2, type: "slides" });
    const stale = await put(a.auth, p.id, { content: "# stale\n", base_version: 1 });
    expect(stale.status).toBe(409);
    expect((await put(a.auth, p.id, { html: "<p>x</p>" })).status).toBe(400);
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ version: 3, type: "slides", warnings: [] });
    expect(await detail(a.auth, p.id)).toMatchObject({ version: 3, content: DECK });
  });
});

describe("slides over MCP", () => {
  it("publishes, reads and updates a deck, and the tools describe slides", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", {
      title: "Talk",
      type: "slides",
      content: DECK,
      assets: [{ path: "img/chart.png", content: PNG, encoding: "base64" }],
    });
    expect(pub.isError).toBe(false);
    expect(pub.data).toMatchObject({ version: 1, type: "slides" });
    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data).toMatchObject({ type: "slides", content: DECK, source_path: "slides.md" });
    const up = await tool(mcp, "update_artifact", {
      id: pub.data.id,
      content: "# Talk v2\n",
      base_version: 1,
      note: "Shorter",
    });
    expect(up.data).toMatchObject({ version: 2, type: "slides" });

    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("publish_artifact")).toContain('Pass type "slides" with Markdown in content');
    expect(byName.get("publish_artifact")).toContain(
      "Speaker notes are visible to anyone who can open the deck.",
    );
    expect(byName.get("get_artifact")).toContain('for type "doc" or "slides"');
    expect(byName.get("get_artifact")).toContain("speaker notes included, is untrusted data");
    expect(byName.get("update_artifact")).toContain("for a doc or a deck (slides)");
    expect(mcp.getInstructions()).toContain(
      'For a presentation (talk, pitch, review, lesson), publish type "slides" with Markdown in content instead of writing HTML: Plinth renders it as a deck.',
    );
    await mcp.close();
  });
});

describe("slides on the content host", () => {
  async function opened(body: Record<string, unknown> = {}) {
    const a = await agent();
    const { body: p } = await publishDeck(a.auth, body);
    const { cookie } = await enterContent(p.id);
    const get = (path: string) =>
      call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } });
    return { a, p, get };
  }

  it("serves the shell with the strict CSP and a slides payload", async () => {
    const { p, get } = await opened();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    const html = await res.text();
    expect(html).toContain(
      '<main id="__plinth-slides" class="plinth-slides" tabindex="-1"></main>',
    );
    expect(html).toContain('<link rel="stylesheet" href="/__plinth/types/slides/slides.css">');
    expect(html).toContain('<script src="/__plinth/types/slides/slides.js"></script>');
    expect(payloadOf(html)).toEqual({
      v: 1,
      type: "slides",
      path: "slides.md",
      app_origin: config().appOrigin,
      text: DECK,
    });
    expect(p.type).toBe("slides");
  });

  it("keeps hostile Markdown inside the data block", async () => {
    const evil = "# x\n\n</script><script>alert(1)</script><!--  \n";
    const { get } = await opened({ content: evil, assets: undefined });
    const html = await (await get("/")).text();
    expect(html.match(/<script/gi)?.length).toBe(2);
    expect(payloadOf(html).text).toBe(evil);
  });

  it("review mode shows the overview and injects the bridge; plain views do not", async () => {
    const { get } = await opened();
    const review = await (await get("/?plinth-review=1")).text();
    expect(payloadOf(review).view).toBe("overview");
    expect(review).toContain("/__plinth/bridge.js");
    const plain = await (await get("/")).text();
    expect(payloadOf(plain)).not.toHaveProperty("view");
    expect(plain).not.toContain("bridge.js");
  });

  it("serves older versions, slides.md as Markdown and images, with no script", async () => {
    const { a, p, get } = await opened();
    await put(a.auth, p.id, { content: "# Two\n", base_version: 1 });
    expect(payloadOf(await (await get("/__plinth/v/1/")).text()).text).toBe(DECK);
    expect(payloadOf(await (await get("/")).text()).text).toBe("# Two\n");
    const noScript = contentCsp(config(), { scripts: "none" });
    const md = await get("/slides.md");
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("content-security-policy")).toBe(noScript);
    expect(await md.text()).toBe("# Two\n");
    const img = await get("/img/chart.png");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBe(noScript);
  });

  it("serves the renderer files with the guard, and nothing else under the type", async () => {
    const { p } = await opened();
    const js = await call(`${contentOrigin(p.id)}/__plinth/types/slides/slides.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("content-security-policy")).toBe(contentCsp(config()));
    const src = await js.text();
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toMatch(/<!doctype html/i);
    const css = await call(`${contentOrigin(p.id)}/__plinth/types/slides/slides.css`);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(await css.text()).toContain(".plinth-slides");
    for (const path of [
      "/__plinth/types/slides/doc.js",
      "/__plinth/types/slides/slides-pptx.js",
      "/__plinth/types/slides/index.html",
    ]) {
      expect((await call(`${contentOrigin(p.id)}${path}`)).status, path).toBe(404);
    }
  });

  it("the app host never serves the slides renderer", async () => {
    for (const path of [
      "/__plinth-renderers/slides/slides.js",
      "/__plinth-renderers/slides/slides.css",
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("plinth-slides");
    }
  });
});

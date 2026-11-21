// HTML decks (type "slides" with deck.json): an agent sends the index in content and the slides,
// deck.css and images as assets, or a folder with deck.json at its top. Checked here: what the
// version stores and get_artifact returns, every refusal with its file and line, the warnings,
// updates that reuse slides by sha256 or carry them, restore, switching formats, the content
// host's shell and files, the embed loader, and the view gate's no_editor.
import { env } from "cloudflare:workers";
import { HTML_DECK_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { embedLoaderCsp } from "../src/content/embedLoader.ts";
import { fileKey } from "../src/services/storage.ts";
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
  storedFile,
  tool,
  versionRow,
} from "./helpers.ts";

const PNG = "iVBORw0KGgo=";
const INDEX = JSON.stringify({ title: "Launch deck", order: ["cover", "plan"], cover: "cover" });
const CSS = "body { font-family: Inter, sans-serif } .dark { background: #14213d; color: #fbfbf8 }";
const COVER =
  '<section id="cover" class="dark"><h1>Launch</h1><img src="images/hero.png" alt="Hero" style="width:400px; height:200px"><aside>Open strong.</aside></section>';
const PLAN =
  '<section id="plan"><h2>Plan</h2><ul><li class="fragment">One</li><li class="fragment">Two</li></ul><x-embed style="position:absolute; left:128px; top:600px; width:400px; height:200px"><script>document.body.textContent = "live"</script></x-embed></section>';

const files = (over: Record<string, string | null> = {}) => {
  const all: Record<string, string | null> = {
    "deck.css": CSS,
    "slides/cover.html": COVER,
    "slides/plan.html": PLAN,
    ...over,
  };
  const out: Record<string, unknown>[] = [];
  for (const [path, content] of Object.entries(all))
    if (content !== null) out.push({ path, content });
  out.push({ path: "images/hero.png", content: PNG, encoding: "base64" });
  return out;
};

async function sha(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const pngBytes = () => Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));

const publishHtmlDeck = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, { html: undefined, type: "slides", content: INDEX, assets: files(), ...body });

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const detail = async (auth: Record<string, string>, ref: string) =>
  json(await call(`/api/v1/artifacts/${ref}`, { headers: auth }));

function payloadOf(html: string) {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html);
  expect(m, "payload block").not.toBeNull();
  return JSON.parse(m?.[1] ?? "null");
}

function refusal(r: { res: Response; body: any }) {
  expect(r.res.status).toBe(400);
  return r.body.error;
}

describe("an HTML deck over REST", () => {
  it("stores deck.json as the source, beside deck.css, the slides and the images", async () => {
    const a = await agent();
    const { res, body } = await publishHtmlDeck(a.auth);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ version: 1, type: "slides" });
    expect(body.warnings.filter((w: { code: string }) => w.code !== "not_scanned")).toEqual([]);
    const manifest = await manifestOf(body.id, 1);
    expect(manifest.map((m) => [m.path, m.content_type])).toEqual([
      ["deck.json", "application/json; charset=utf-8"],
      ["deck.css", "text/css; charset=utf-8"],
      ["slides/cover.html", "text/html; charset=utf-8"],
      ["slides/plan.html", "text/html; charset=utf-8"],
      ["images/hero.png", "image/png"],
    ]);
    expect(await (await storedFile(body.id, 1, "deck.json"))?.text()).toBe(INDEX);
    const d = await detail(a.auth, body.id);
    expect(d).toMatchObject({ type: "slides", content: INDEX, source_path: "deck.json" });
    expect(d.files).toEqual([
      { path: "deck.css", content: CSS },
      { path: "slides/cover.html", content: COVER },
      { path: "slides/plan.html", content: PLAN },
    ]);
    expect(d.assets.map((x: { path: string }) => x.path)).toEqual([
      "deck.css",
      "slides/cover.html",
      "slides/plan.html",
      "images/hero.png",
    ]);
  });

  it("refuses a slide the renderer may not show, naming its file and line", async () => {
    const a = await agent();
    const script = refusal(
      await publishHtmlDeck(a.auth, {
        assets: files({
          "slides/plan.html": '<section id="plan">\n<p onclick="x()">Hi</p>\n</section>',
        }),
      }),
    );
    expect(script.message).toBe(
      "slides/plan.html (line 2) <p> has an event handler (onclick): no script runs on a slide",
    );
    expect(script.details.issues).toEqual([
      { file: "slides/plan.html", line: 2, message: expect.stringContaining("event handler") },
    ]);
    const css = refusal(
      await publishHtmlDeck(a.auth, {
        assets: files({ "deck.css": "@import url(https://x.example/a.css);" }),
      }),
    );
    expect(css.message).toMatch(/^deck\.css may not use @import/);
    const caps = refusal(
      await publishHtmlDeck(a.auth, {
        assets: files({
          "slides/plan.html": `<section id="plan">${"<p>x</p>".repeat(HTML_DECK_LIMITS.maxBoxes + 1)}</section>`,
        }),
      }),
    );
    expect(caps.message).toMatch(/more than 200 boxes/);
    const id = refusal(
      await publishHtmlDeck(a.auth, {
        assets: files({ "slides/plan.html": '<section id="other"></section>' }),
      }),
    );
    expect(id.message).toMatch(/must have id="plan"/);
    const index = refusal(await publishHtmlDeck(a.auth, { content: "{ nope" }));
    expect(index.message).toMatch(/^deck\.json is not JSON/);
    expect(index.details.field).toBe("content");
  });

  it("keeps each format's files in their places", async () => {
    const a = await agent();
    const page = refusal(
      await publishHtmlDeck(a.auth, {
        assets: [...files(), { path: "page.html", content: "<p>x</p>" }],
      }),
    );
    expect(page.message).toMatch(/^page\.html: an HTML deck's slides are slides\/<id>\.html/);
    const md = refusal(
      await publish(a.auth, {
        html: undefined,
        type: "slides",
        content: "# Talk\n",
        assets: [{ path: "deck.css", content: CSS }],
      }),
    );
    expect(md.message).toMatch(/^deck\.css: a Markdown deck's files are images/);
    const js = refusal(
      await publishHtmlDeck(a.auth, { assets: [...files(), { path: "app.js", content: "x" }] }),
    );
    expect(js.details).toMatchObject({ field: "assets", path: "app.js" });
  });

  it("warns, never blocking, about markup that shows differently and files the deck lacks", async () => {
    const a = await agent();
    const { res, body } = await publishHtmlDeck(a.auth, {
      assets: [
        { path: "deck.css", content: CSS },
        {
          path: "slides/cover.html",
          content:
            '<section id="cover"><blockquote>Q</blockquote><img src="images/gone.png" alt=""></section>',
        },
        { path: "slides/plan.html", content: PLAN },
      ],
    });
    expect(res.status).toBe(201);
    const by = (code: string) => body.warnings.filter((w: { code: string }) => w.code === code);
    expect(by("slide_markup")).toEqual([
      expect.objectContaining({
        file: "slides/cover.html",
        message: expect.stringContaining("<blockquote> shows as a plain box"),
      }),
    ]);
    expect(by("missing_file")).toEqual([
      expect.objectContaining({ file: "slides/cover.html", ref: "images/gone.png" }),
    ]);
  });

  it("updates one slide with the rest reused by sha256, carries them without assets, and restores", async () => {
    const a = await agent();
    const { body: p } = await publishHtmlDeck(a.auth);
    const plan2 = PLAN.replace("<h2>Plan</h2>", "<h2>Plan, v2</h2>");
    const up = await put(a.auth, p.id, {
      content: INDEX,
      base_version: 1,
      assets: [
        { path: "deck.css", sha256: await sha(CSS) },
        { path: "slides/cover.html", sha256: await sha(COVER) },
        { path: "slides/plan.html", content: plan2 },
        { path: "images/hero.png", sha256: await sha(pngBytes()) },
      ],
    });
    expect(up.status).toBe(200);
    const v2 = await json(up);
    expect(v2.stored).toMatchObject({ files: 5, reused: 3 });
    expect((await detail(a.auth, p.id)).files[2]).toEqual({
      path: "slides/plan.html",
      content: plan2,
    });
    // Without assets every file is carried, and checked again from storage.
    const carried = await put(a.auth, p.id, {
      content: JSON.stringify({ title: "Renamed", order: ["plan", "cover"] }),
      base_version: 2,
    });
    expect(carried.status).toBe(200);
    expect(await json(carried)).toMatchObject({ version: 3 });
    // A carried slide the new index does not list still shows, last, with a note.
    const shorter = await json(
      await put(a.auth, p.id, { content: JSON.stringify({ order: ["cover"] }), base_version: 3 }),
    );
    expect(shorter.warnings.map((w: { message: string }) => w.message).join()).toMatch(
      /slides\/plan\.html is not in order/,
    );
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 4 }),
    });
    expect(r.status).toBe(201);
    const restored = await detail(a.auth, p.id);
    expect(restored).toMatchObject({ version: 5, source_path: "deck.json", content: INDEX });
    expect(
      restored.files.find((f: { path: string }) => f.path === "slides/plan.html").content,
    ).toBe(PLAN);
  });

  it("carries the slides, deck.css and named files an update's asset list leaves out", async () => {
    const a = await agent();
    const { body: p } = await publishHtmlDeck(a.auth, {
      assets: [...files(), { path: "images/unused.png", content: PNG, encoding: "base64" }],
    });
    const plan2 = PLAN.replace("<h2>Plan</h2>", "<h2>Plan, v2</h2>");
    // Only the changed slide, as Claude sends it: the rest of the deck stays.
    const up = await put(a.auth, p.id, {
      content: INDEX,
      base_version: 1,
      assets: [{ path: "slides/plan.html", content: plan2 }],
    });
    expect(up.status, JSON.stringify(await up.clone().json())).toBe(200);
    expect((await manifestOf(p.id, 2)).map((m) => m.path).sort()).toEqual([
      "deck.css",
      "deck.json",
      "images/hero.png",
      "slides/cover.html",
      "slides/plan.html",
    ]);
    const d = await detail(a.auth, p.id);
    expect(d.files).toEqual([
      { path: "deck.css", content: CSS },
      { path: "slides/cover.html", content: COVER },
      { path: "slides/plan.html", content: plan2 },
    ]);
    // A slide the new order drops, sent nowhere, leaves the deck; so does a file nothing names.
    const drop = await put(a.auth, p.id, {
      content: JSON.stringify({ title: "Launch deck", order: ["cover"] }),
      base_version: 2,
      assets: [{ path: "slides/cover.html", sha256: await sha(COVER) }],
    });
    expect(drop.status).toBe(200);
    expect((await manifestOf(p.id, 3)).map((m) => m.path).sort()).toEqual([
      "deck.css",
      "deck.json",
      "images/hero.png",
      "slides/cover.html",
    ]);
    // A new slide arrives with the index that places it; the others carry.
    const add = await put(a.auth, p.id, {
      content: JSON.stringify({ title: "Launch deck", order: ["cover", "end"] }),
      base_version: 3,
      assets: [{ path: "slides/end.html", content: '<section id="end"><h2>End</h2></section>' }],
    });
    expect(add.status).toBe(200);
    expect((await detail(a.auth, p.id)).files.map((f: { path: string }) => f.path)).toEqual([
      "deck.css",
      "slides/cover.html",
      "slides/end.html",
    ]);
  });

  it("switches an HTML deck to Markdown with assets omitted, keeping only its images", async () => {
    const a = await agent();
    const { body: p } = await publishHtmlDeck(a.auth);
    const md = await put(a.auth, p.id, {
      content: "# Talk\n\n![](images/hero.png)\n",
      base_version: 1,
    });
    expect(md.status, JSON.stringify(await md.clone().json())).toBe(200);
    expect((await manifestOf(p.id, 2)).map((m) => m.path)).toEqual([
      "slides.md",
      "images/hero.png",
    ]);
    expect(await detail(a.auth, p.id)).toMatchObject({ source_path: "slides.md" });
  });

  it("restores a Markdown deck whose text starts with { as Markdown, by its stored file", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: "# Talk\n",
    });
    // A version stored before deck.json existed, whose slides.md happens to start with "{".
    const legacy = "{.lead} opening line\n\n# Talk\n";
    const v1 = await versionRow(p.id, 1);
    const entry = (await manifestOf(p.id, 1)).find((m) => m.path === "slides.md");
    if (!v1 || !entry) throw new Error("no version 1");
    await env.FILES.put(fileKey(p.id, v1, entry), legacy);
    await put(a.auth, p.id, { content: "# Other\n", base_version: 1 });
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(await detail(a.auth, p.id)).toMatchObject({
      version: 3,
      source_path: "slides.md",
      content: legacy,
    });
  });

  it("refuses a deck text file past its byte cap from its size, before reading it", async () => {
    const a = await agent();
    const big = `<section id="plan"><p>${"x".repeat(HTML_DECK_LIMITS.maxSlideBytes)}</p></section>`;
    const r = refusal(
      await publishHtmlDeck(a.auth, { assets: files({ "slides/plan.html": big }) }),
    );
    expect(r.message).toBe("slides/plan.html is over 256 KB: split the slide");
    expect(r.details.issues).toEqual([
      { file: "slides/plan.html", message: "is over 256 KB: split the slide" },
    ]);
  });

  it("publishes a whole Claude-shaped deck: project/ paths, a design system's copy, format keys", async () => {
    const a = await agent();
    const index = JSON.stringify({
      v: 5,
      createdOnFiles: { v: 1, at: "2026-11-21T10:00:00Z" },
      lists: "css",
      format: { v: 1, shared: ["project/deck.css"] },
      title: "Q3",
      cover: "cover",
      order: ["cover", "plan"],
      sections: { s1: { description: "Numbers", start: "cover" } },
      faces: { brand: { family: "Brand Sans", src: "project/ds/brand/fonts/Brand.woff2" } },
      designSystems: [
        {
          title: "Brand",
          namespace: "brand",
          artifact: "https://claude.ai/artifact/x",
          version: null,
          copiedAt: "2026-11-21T10:00:00Z",
        },
      ],
    });
    const { res, body } = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: index,
      assets: [
        {
          path: "deck.css",
          content:
            ":root { --brand: #123456 } .hero { background: url(project/ds/brand/assets/bg.png) }",
        },
        {
          path: "slides/cover.html",
          content:
            '<section id="cover" class="hero"><img src="project/ds/brand/assets/logo.png" alt="Logo"><h1 style="font-family: \'Brand Sans\'">Q3</h1><aside>Hello.</aside></section>',
        },
        { path: "slides/plan.html", content: '<section id="plan"><h2>Plan</h2></section>' },
        { path: "ds/brand/tokens.json", content: "{}" },
        { path: "ds/brand/fonts/Brand.woff2", content: "d09GMgABAAA=", encoding: "base64" },
        { path: "ds/brand/assets/logo.png", content: PNG, encoding: "base64" },
        { path: "ds/brand/assets/bg.png", content: PNG, encoding: "base64" },
      ],
    });
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.warnings.filter((w: { code: string }) => w.code === "missing_file")).toEqual([]);
  });

  it("switches a Markdown deck to an HTML deck and back, the format following the source", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: "# Talk\n",
    });
    const html = await put(a.auth, p.id, { content: INDEX, assets: files(), base_version: 1 });
    expect(html.status).toBe(200);
    expect(await detail(a.auth, p.id)).toMatchObject({ source_path: "deck.json" });
    const md = await put(a.auth, p.id, { content: "# Talk again\n", assets: [], base_version: 2 });
    expect(md.status).toBe(200);
    const d = await detail(a.auth, p.id);
    expect(d).toMatchObject({ source_path: "slides.md", content: "# Talk again\n" });
    expect(d).not.toHaveProperty("files");
  });

  it("publishes a folder with deck.json at its top through start_upload", async () => {
    const a = await agent();
    const mint = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "slides" }),
    });
    expect(mint.status).toBe(201);
    const t = await json(mint);
    expect(t.next).toContain("slides.md or deck.json at its top");
    const res = await call(t.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.upload_token}` },
      body: tar([
        { name: "deck/deck.json", data: INDEX },
        { name: "deck/deck.css", data: CSS },
        { name: "deck/slides/cover.html", data: COVER },
        { name: "deck/slides/plan.html", data: PLAN },
        { name: "deck/images/hero.png", data: "png" },
      ]),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect((await manifestOf(body.id, 1))[0]?.path).toBe("deck.json");
    // A folder publish with no title takes deck.json's.
    expect((await detail(a.auth, body.id)).title).toBe("Launch deck");
  });
});

describe("an HTML deck over MCP", () => {
  it("publishes with deck.json in content and reads the slide files back", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", {
      title: "Launch",
      type: "slides",
      content: INDEX,
      assets: files(),
    });
    expect(pub.isError, pub.text).toBe(false);
    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data.source_path).toBe("deck.json");
    expect(got.data.files.map((f: { path: string }) => f.path)).toEqual([
      "deck.css",
      "slides/cover.html",
      "slides/plan.html",
    ]);
    await mcp.close();
  });
});

describe("an HTML deck on the content host", () => {
  async function opened() {
    const a = await agent();
    const { body: p } = await publishHtmlDeck(a.auth);
    const { cookie } = await enterContent(p.id);
    const get = (path: string, headers: Record<string, string> = {}) =>
      call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "", ...headers } });
    return { a, p, get };
  }

  it("embeds deck.css and every slide in the shell's payload, under the strict shell CSP", async () => {
    const { get } = await opened();
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    const html = await res.text();
    const payload = payloadOf(html);
    expect(payload).toMatchObject({ type: "slides", path: "deck.json", text: INDEX });
    expect(payload.files).toEqual({
      "deck.css": CSS,
      "slides/cover.html": COVER,
      "slides/plan.html": PLAN,
    });
    // The embed's script stays inside the data block.
    expect(html.match(/<script/gi)?.length).toBe(2);
  });

  it("serves a slide file as text, never as a page", async () => {
    const { get } = await opened();
    const slide = await get("/slides/plan.html");
    expect(slide.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(slide.headers.get("content-security-policy")).toContain("script-src 'none'");
    const index = await get("/deck.json");
    expect(index.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("serves the embed loader behind the pass: allow-scripts only, no network, framed by the app", async () => {
    const { get, p } = await opened();
    const res = await get("/__plinth/frames/slides/embed.html");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(embedLoaderCsp(config(), "app"));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain(`frame-ancestors 'self' ${config().appOrigin}`);
    expect(csp.endsWith("sandbox allow-scripts")).toBe(true);
    expect(csp).not.toContain("allow-same-origin");
    const page = await res.text();
    expect(page).toContain("event.source !== parentWindow");
    expect(page).toContain("plinth-slide-embed");
    // No pass: not served.
    const bare = await call(`${contentOrigin(p.id)}/__plinth/frames/slides/embed.html`);
    expect(bare.status).not.toBe(200);
    // Another type's frame name is not the deck's.
    expect((await get("/__plinth/frames/slides/board.html")).status).toBe(404);
    expect((await get("/__plinth/frames/design/board.html")).status).toBe(404);
  });

  it("tells the viewer there is no source editor, only for an HTML deck", async () => {
    const { a, p } = await opened();
    const gate = await json(await call(`/api/v1/view/${p.id}`, { headers: a.auth }));
    expect(gate).toMatchObject({ status: "ok", no_editor: true });
    const { body: md } = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: "# Talk\n",
    });
    const mdGate = await json(await call(`/api/v1/view/${md.id}`, { headers: a.auth }));
    expect(mdGate.status).toBe("ok");
    expect(mdGate).not.toHaveProperty("no_editor");
  });
});

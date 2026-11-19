// The design_system type: system.json (format plinth.design-system/1) plus image and font assets,
// published over MCP, REST and start_upload bundles, refused with every problem and its path, and
// served on the content host as Plinth's fixed renderer shell.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OPAQUE_SANDBOX } from "../src/content/csp.ts";
import worker from "../src/index.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import acme from "./fixtures/design-systems/acme.json";
import {
  APP,
  agent,
  call,
  contentOrigin,
  enterContent,
  json,
  manifestOf,
  mcpClient,
  publish,
  storedFile,
  tool,
} from "./helpers.ts";

const ACME = JSON.stringify(acme, null, 2);
const PNG = "iVBORw0KGgo=";
const WOFF2 = "d09GMgABAAAAAA==";
const ASSETS = [
  { path: "img/logo.png", content: PNG, encoding: "base64" },
  { path: "fonts/acme-mono.woff2", content: WOFF2, encoding: "base64" },
];

type Json = Record<string, any>;
const variant = (f: (ds: Json) => void) => {
  const ds = JSON.parse(ACME) as Json;
  f(ds);
  return JSON.stringify(ds);
};

const publishDs = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, {
    html: undefined,
    title: "Acme UI",
    type: "design_system",
    content: ACME,
    assets: ASSETS,
    ...body,
  });

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function run(input: string, init: RequestInit = {}, vars: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const url = input.startsWith("http") ? input : `${APP}${input}`;
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const scriptSrc = (csp: string | null) =>
  (csp ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));

describe("publishing a design system", () => {
  it("stores system.json and its assets, and returns type design_system", async () => {
    const a = await agent();
    const { res, body } = await publishDs(a.auth);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ type: "design_system", version: 1 });
    expect(body.warnings).toEqual([]);
    const paths = (await manifestOf(body.id, 1)).map((e) => [e.path, e.content_type]);
    expect(paths).toEqual([
      ["system.json", "application/json; charset=utf-8"],
      ["img/logo.png", "image/png"],
      ["fonts/acme-mono.woff2", "font/woff2"],
    ]);
    expect(await (await storedFile(body.id, 1, "system.json"))?.text()).toBe(ACME);
    const detail = await json(await call(`/api/v1/artifacts/${body.id}`, { headers: a.auth }));
    expect(detail).toMatchObject({
      type: "design_system",
      title: "Acme UI",
      source_path: "system.json",
      content: ACME,
    });
    expect(detail.html).toBeUndefined();
    expect(detail.assets.map((x: Json) => x.path)).toEqual([
      "img/logo.png",
      "fonts/acme-mono.woff2",
    ]);
  });

  it("publishes over MCP with the same result", async () => {
    const a = await agent();
    const c = await mcpClient(a.token);
    const r = await tool(c, "publish_artifact", {
      title: "Acme",
      type: "design_system",
      content: ACME,
      assets: ASSETS,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ type: "design_system", version: 1, warnings: [] });
    const got = await tool(c, "get_artifact", { id: r.data.id });
    expect(got.data).toMatchObject({ type: "design_system", content: ACME });
  });

  it("refuses html, invalid JSON, a wrong format and a whole HTML document, with every problem", async () => {
    const a = await agent();
    const withHtml = await publish(a.auth, {
      type: "design_system",
      content: ACME,
      html: "<p>x</p>",
    });
    expect(withHtml.res.status).toBe(400);
    expect(withHtml.body.error.details).toMatchObject({ type: "design_system", field: "html" });

    for (const [content, path] of [
      ["{ not json", ""],
      ["<!doctype html><html><body>x</body></html>", ""],
      [
        variant((d) => {
          d.format = "plinth.design-system/9";
        }),
        "format",
      ],
      [
        variant((d) => {
          d.colour = 1;
        }),
        "colour",
      ],
      [
        variant((d) => {
          d.tokens.color.bg.$value = "red;x";
        }),
        "tokens.color.bg.$value",
      ],
      [
        variant((d) => {
          d.css = "</style><script>";
        }),
        "css",
      ],
    ] as const) {
      const r = await publishDs(a.auth, { content });
      expect(r.res.status, content.slice(0, 40)).toBe(400);
      const err = r.body.error;
      expect(err.code).toBe("invalid_input");
      expect(err.message).toMatch(/^system\.json is not a valid design system \(\d+ problems?\)/);
      expect(err.details).toMatchObject({ type: "design_system", field: "content" });
      expect(err.details.next).toContain("Design systems");
      expect(err.details.errors.map((e: Json) => e.path)).toContain(path);
    }
    // The same refusal over MCP.
    const c = await mcpClient(a.token);
    const viaMcp = await tool(c, "publish_artifact", {
      title: "x",
      type: "design_system",
      content: variant((d) => {
        d.colour = 1;
      }),
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.data.error.details.errors[0].path).toBe("colour");
  });

  it("takes images and fonts as assets and refuses scripts and stylesheets with its asset rule", async () => {
    const a = await agent();
    for (const asset of [
      { path: "app.js", content: "x" },
      { path: "extra.css", content: "a{}" },
      { path: "page.html", content: "<p>x</p>" },
    ]) {
      const r = await publishDs(a.auth, { assets: [asset] });
      expect(r.res.status, asset.path).toBe(400);
      expect(r.body.error.message).toBe(
        "A design system's assets are images (png, jpg, gif, webp, avif, svg) and fonts (woff2, woff, ttf, otf)",
      );
    }
    const reserved = await publishDs(a.auth, { assets: [{ path: "index.html", content: "x" }] });
    expect(reserved.res.status).toBe(400);
    expect(reserved.body.error.message).toBe(
      "system.json and index.html belong to the design_system, not its assets",
    );
  });

  it("warns about inert markup, a missing font file and no dark theme", async () => {
    const a = await agent();
    const content = variant((d) => {
      delete d.themes;
      d.components[0].examples.push({ name: "Bad", html: '<img src="x" onerror="alert(1)">' });
    });
    const { res, body } = await publishDs(a.auth, { content, assets: [ASSETS[0]] });
    expect(res.status).toBe(201);
    expect(body.warnings.map((w: Json) => [w.code, w.file, w.path])).toEqual([
      ["ds_inert_markup", "system.json", "components[0].examples[2].html"],
      ["ds_no_dark_theme", "system.json", "themes"],
      ["ds_missing_font", "system.json", "fonts[1].src"],
    ]);
  });

  it("updates keep the type, conflicts are refused, restores publish the old JSON", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a.auth);
    const v2 = variant((d) => {
      d.tokens.color.bg.$value = "#fafafa";
    });
    const ok = await put(a.auth, p.id, { content: v2, base_version: 1 });
    expect(ok.status).toBe(200);
    expect((await json(ok)).version).toBe(2);
    // Assets were carried forward.
    expect((await manifestOf(p.id, 2)).map((e) => e.path)).toContain("fonts/acme-mono.woff2");
    const stale = await put(a.auth, p.id, { content: ACME, base_version: 1 });
    expect(stale.status).toBe(409);
    const html = await put(a.auth, p.id, { html: "<p>x</p>" });
    expect(html.status).toBe(400);
    expect((await json(html)).error.message).toMatch(
      /This artifact is a design_system: send its design system JSON as content/,
    );
    const restored = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(restored.status).toBe(201);
    expect(await (await storedFile(p.id, 3, "system.json"))?.text()).toBe(ACME);
  });

  it("publishes a start_upload bundle with system.json at the top, and refuses one without it", async () => {
    const a = await agent();
    const mint = async () => {
      const res = await call("/api/v1/uploads", {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "design_system" }),
      });
      expect(res.status).toBe(201);
      return json(res);
    };
    const t = await mint();
    const ok = await call(t.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.upload_token}` },
      body: tar([
        { name: "system.json", data: ACME },
        { name: "img/logo.png", data: "png" },
        { name: "fonts/acme-mono.woff2", data: "woff2" },
      ]),
    });
    expect(ok.status).toBe(201);
    const done = await json(ok);
    expect(done).toMatchObject({ type: "design_system", version: 1, warnings: [] });

    const t2 = await mint();
    const missing = await call(t2.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t2.upload_token}` },
      body: tar([{ name: "fonts/acme-mono.woff2", data: "woff2" }]),
    });
    expect(missing.status).toBe(400);
    expect((await json(missing)).error.message).toBe("The bundle has no system.json at its top");

    const t3 = await mint();
    const invalid = await call(t3.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t3.upload_token}` },
      body: tar([
        {
          name: "system.json",
          data: variant((d) => {
            d.colour = 1;
          }),
        },
      ]),
    });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).error.details.errors[0].path).toBe("colour");
  });

  it("has no live editing and no room, and lists by type", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a.auth);
    const { body: page } = await publish(a.auth, { title: "Page" });
    const gate = await json(await call(`/api/v1/view/${p.id}`, { headers: a.auth }));
    expect(gate.status).toBe("ok");
    expect(gate.live).toBeUndefined();
    expect(gate.data).toBeUndefined();
    const list = await json(
      await call("/api/v1/artifacts?type=design_system", { headers: a.auth }),
    );
    expect(list.items.map((i: Json) => i.id)).toEqual([p.id]);
    const pages = await json(await call("/api/v1/artifacts?type=html", { headers: a.auth }));
    expect(pages.items.map((i: Json) => i.id)).toEqual([page.id]);
    const bad = await call("/api/v1/artifacts?type=deck", { headers: a.auth });
    expect(bad.status).toBe(400);
    const c = await mcpClient(a.token);
    const viaMcp = await tool(c, "list_artifacts", { type: "design_system" });
    expect(viaMcp.data.items.map((i: Json) => i.id)).toEqual([p.id]);
  });

  it("serves its JSON as text at /a/<slug>/source", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a.auth, { visibility: "unlisted" });
    const res = await run(`/a/${p.slug}/source`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(ACME);
  });
});

describe("a design system on the content host", () => {
  async function opened(vars: Record<string, unknown> | null = null) {
    const a = await agent();
    const { body: p } = await publishDs(a.auth, { visibility: "unlisted" });
    if (!vars) {
      const { cookie } = await enterContent(p.id);
      return { p, cookie: cookie ?? "" };
    }
    const gate = await json(await run(`/api/v1/view/${p.id}`, {}, vars));
    const enter = await run(gate.enter_url, {}, vars);
    return { p, cookie: (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }

  it("serves the renderer shell at / under script-src 'self', header and meta", async () => {
    const { p, cookie } = await opened();
    const res = await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(scriptSrc(res.headers.get("content-security-policy"))).toBe("script-src 'self'");
    const html = await res.text();
    expect(html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">',
    );
    expect(html).toContain('<script src="/__plinth/types/design_system/ds.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/__plinth/types/design_system/ds.css">');
    const payload = JSON.parse(
      /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html)?.[1] ??
        "null",
    );
    expect(payload).toMatchObject({ v: 1, type: "design_system", path: "system.json", text: ACME });
  });

  it("serves system.json and the assets with script-src 'none'", async () => {
    const { p, cookie } = await opened();
    const sys = await call(`${contentOrigin(p.id)}/system.json`, { headers: { Cookie: cookie } });
    expect(sys.status).toBe(200);
    expect(sys.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(scriptSrc(sys.headers.get("content-security-policy"))).toBe("script-src 'none'");
    expect(await sys.text()).toBe(ACME);
    const font = await call(`${contentOrigin(p.id)}/fonts/acme-mono.woff2`, {
      headers: { Cookie: cookie },
    });
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(scriptSrc(font.headers.get("content-security-policy"))).toBe("script-src 'none'");
  });

  it("serves exactly ds.js and ds.css under /__plinth/types/design_system/, and nothing on the app host", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const js = await call(`${contentOrigin(p.id)}/__plinth/types/design_system/ds.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    const src = await js.text();
    expect(src.length).toBeGreaterThan(1000);
    // The built bundle, not the SPA's index.html.
    expect(src).not.toMatch(/^\s*<!doctype html/i);
    const css = await call(`${contentOrigin(p.id)}/__plinth/types/design_system/ds.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(await css.text()).toContain(".ds-layout");
    for (const path of [
      "/__plinth/types/design_system/x.js",
      "/__plinth/types/design_system/doc.js",
      "/__plinth/types/design_system/",
      "/__plinth/types/design_system/ds.js/x",
    ]) {
      expect((await call(`${contentOrigin(p.id)}${path}`)).status, path).toBe(404);
    }
    for (const path of [
      "/__plinth-renderers/design_system/ds.js",
      "/__plinth/types/design_system/ds.js",
    ]) {
      const res = await call(`${APP}${path}`);
      expect(await res.text(), path).not.toContain("plinthRenderer_design_system");
      expect(res.headers.get("content-type") ?? "", path).not.toMatch(/javascript/);
    }
  });

  it("carries the opaque sandbox under CONTENT_ISOLATION=opaque", async () => {
    const vars = { CONTENT_ISOLATION: "opaque" };
    const { p, cookie } = await opened(vars);
    const res = await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } }, vars);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(OPAQUE_SANDBOX);
    expect(csp).not.toContain("allow-same-origin");
    expect(scriptSrc(csp)).toBe("script-src 'self'");
  });
});

// Typed artifacts on the content host (docs/superpowers/specs/2026-11-14-typed-outputs-doc-design.md,
// "Content host"): a doc's page is a fixed shell with the Markdown embedded as escaped JSON and a
// strict CSP, and the renderer files come from ASSETS under /__plinth/types/<id>/, guarded so the
// SPA fallback can never be served there.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { contentCsp, OPAQUE_SANDBOX } from "../src/content/csp.ts";
import { artifacts } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import {
  APP,
  agent,
  call,
  config,
  contentOrigin,
  db,
  enterContent,
  json,
  publish,
} from "./helpers.ts";

const MD = "# Plan\n\nSome *prose*.\n\n![dot](img/dot.png)\n";
const PNG = "iVBORw0KGgo=";

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

function directives(csp: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of (csp ?? "").split(";").map((s) => s.trim())) {
    if (!d) continue;
    const i = d.indexOf(" ");
    out.set(i < 0 ? d : d.slice(0, i), d);
  }
  return out;
}

/** The JSON payload a shell embeds. */
function payloadOf(html: string) {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html);
  expect(m, "payload block").not.toBeNull();
  return JSON.parse(m?.[1] ?? "null");
}

/** Publish a doc and open it through the gate (under `vars`); returns the content cookie. */
async function openedDoc(
  body: Record<string, unknown> = {},
  vars: Record<string, unknown> | null = null,
) {
  const a = await agent();
  const { res, body: p } = await publish(a.auth, {
    html: undefined,
    type: "doc",
    content: MD,
    assets: [{ path: "img/dot.png", content: PNG, encoding: "base64" }],
    ...body,
  });
  expect(res.status).toBe(201);
  if (!vars) {
    const { cookie } = await enterContent(p.id);
    return { a, p, cookie: cookie ?? "" };
  }
  const gate = await json(await run(`/api/v1/view/${p.id}`, {}, vars));
  const enter = await run(gate.enter_url, {}, vars);
  const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { a, p, cookie };
}

const get = (id: string, path: string, cookie: string, init: RequestInit = {}) =>
  call(`${contentOrigin(id)}${path}`, { ...init, headers: { Cookie: cookie, ...init.headers } });

describe("doc shell on the content host", () => {
  it("GET / serves the shell: strict CSP, embedded payload, escaped title, no ETag", async () => {
    const { p, cookie } = await openedDoc({ title: 'Plan <b>"&' });
    const res = await get(p.id, "/", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const csp = res.headers.get("content-security-policy");
    const d = directives(csp);
    expect(d.get("script-src")).toBe("script-src 'self'");
    expect(d.get("script-src")).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    // Every other directive is the artifact default.
    const base = directives(contentCsp(config()));
    for (const [k, v] of base) if (k !== "script-src") expect(d.get(k), k).toBe(v);
    expect([...d.keys()]).toEqual([...base.keys()]);

    const html = await res.text();
    expect(html).toContain("<title>Plan &lt;b&gt;&quot;&amp;</title>");
    expect(html).toContain('<link rel="stylesheet" href="/__plinth/types/doc/doc.css">');
    expect(html).toContain('<script src="/__plinth/types/doc/doc.js"></script>');
    expect(payloadOf(html)).toEqual({
      v: 1,
      type: "doc",
      path: "content.md",
      app_origin: config().appOrigin,
      text: MD,
    });
    // /index.html is the same page.
    const again = await get(p.id, "/index.html", cookie);
    expect(await again.text()).toBe(html);
  });

  it("Markdown cannot break out of the data block", async () => {
    const evil = "# x\n\n</script><script>alert(1)</script><!-- \u2028 & done\n";
    const { p, cookie } = await openedDoc({ content: evil, assets: undefined });
    const html = await (await get(p.id, "/", cookie)).text();
    expect(html.match(/<script/gi)?.length).toBe(2);
    expect(payloadOf(html).text).toBe(evil);
  });

  it("/__plinth/v/1/ serves version 1 after an update; / serves the current one", async () => {
    const { a, p, cookie } = await openedDoc({ content: "# One\n", assets: undefined });
    const up = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Two\n", base_version: 1 }),
    });
    expect(up.status).toBe(200);
    const v1 = await get(p.id, "/__plinth/v/1/", cookie);
    expect(v1.status).toBe(200);
    expect(payloadOf(await v1.text()).text).toBe("# One\n");
    expect(payloadOf(await (await get(p.id, "/", cookie)).text()).text).toBe("# Two\n");
    expect(payloadOf(await (await get(p.id, "/__plinth/v/2/", cookie)).text()).text).toBe(
      "# Two\n",
    );
  });

  it("content.md is served raw as Markdown and images as themselves, with no script", async () => {
    const { p, cookie } = await openedDoc();
    const noScript = contentCsp(config(), { scripts: "none" });
    const md = await get(p.id, "/content.md", cookie);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    expect(md.headers.get("content-security-policy")).toBe(noScript);
    expect(await md.text()).toBe(MD);
    const img = await get(p.id, "/img/dot.png", cookie);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBe(noScript);
    // Review mode never rewrites anything but the shell.
    const reviewed = await get(p.id, "/content.md?plinth-review=1", cookie);
    expect(await reviewed.text()).toBe(MD);
  });

  it("an SVG asset opened as a document runs no script (script-src 'none')", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
    const { p, cookie } = await openedDoc({
      assets: [{ path: "diagram.svg", content: svg }],
    });
    for (const vars of [{}, { CONTENT_ISOLATION: "opaque" }]) {
      const res = await run(
        `${contentOrigin(p.id)}/diagram.svg`,
        { headers: { Cookie: cookie } },
        vars,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      const d = directives(res.headers.get("content-security-policy"));
      expect(d.get("script-src")).toBe("script-src 'none'");
      expect(d.get("script-src")).not.toContain("unsafe-inline");
    }
    // The opaque sandbox stays on as well.
    const o = await run(
      `${contentOrigin(p.id)}/diagram.svg`,
      { headers: { Cookie: cookie } },
      { CONTENT_ISOLATION: "opaque" },
    );
    expect(directives(o.headers.get("content-security-policy")).get("sandbox")).toBe(
      OPAQUE_SANDBOX,
    );
    // An html artifact's SVG keeps the default content CSP.
    const a = await agent();
    const { body: page } = await publish(a.auth, {
      assets: [{ path: "diagram.svg", content: svg }],
    });
    const { cookie: pageCookie } = await enterContent(page.id);
    const own = await get(page.id, "/diagram.svg", pageCookie ?? "");
    expect(own.headers.get("content-security-policy")).toBe(contentCsp(config()));
  });

  it("?plinth-review=1 injects the comments bridge into the shell", async () => {
    const { p, cookie } = await openedDoc();
    const res = await get(p.id, "/?plinth-review=1", cookie);
    const html = await res.text();
    expect(html).toContain('<script src="/__plinth/bridge.js" data-plinth-bridge></script>');
    expect(html.match(/<script/gi)?.length).toBe(3);
    expect(directives(res.headers.get("content-security-policy")).get("script-src")).toBe(
      "script-src 'self'",
    );
  });

  it("HEAD on the shell has headers and no body", async () => {
    const { p, cookie } = await openedDoc();
    const res = await get(p.id, "/", cookie, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(directives(res.headers.get("content-security-policy")).get("script-src")).toBe(
      "script-src 'self'",
    );
    expect(await res.text()).toBe("");
  });

  it("without the cookie the shell is not served", async () => {
    const { p } = await openedDoc();
    const res = await call(`${contentOrigin(p.id)}/`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/open/${p.id}`);
  });

  it("a public doc may be indexed, like a public page", async () => {
    const { p, cookie } = await openedDoc();
    await db().update(artifacts).set({ visibility: "public" }).where(eq(artifacts.id, p.id)).run();
    const off = await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } });
    expect(off.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const on = await run(
      `${contentOrigin(p.id)}/`,
      { headers: { Cookie: cookie } },
      { ALLOW_PUBLIC_VISIBILITY: "true" },
    );
    expect(on.status).toBe(200);
    expect(on.headers.get("x-robots-tag")).toBeNull();
  });

  it("an artifact type this instance does not know is not served", async () => {
    const { p, cookie } = await openedDoc();
    await db()
      .update(artifacts)
      .set({ type: "deck" as never })
      .where(eq(artifacts.id, p.id))
      .run();
    for (const path of ["/", "/content.md", "/img/dot.png"]) {
      const res = await get(p.id, path, cookie);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("This artifact's type is not supported by this instance");
    }
  });

  it("html artifacts are served as before", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<!doctype html><h1>Page</h1>" });
    const { cookie } = await enterContent(p.id);
    const res = await get(p.id, "/", cookie ?? "");
    expect(await res.text()).toBe("<!doctype html><h1>Page</h1>");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(res.headers.get("etag")).not.toBeNull();
  });
});

describe("renderer files on the content host", () => {
  it("doc.js and doc.css are served without a cookie, with content headers", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const js = await call(`${contentOrigin(p.id)}/__plinth/types/doc/doc.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(js.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // The built bundle, not the SPA's index.html: fails loudly if the web build did not emit it.
    const src = await js.text();
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toMatch(/<!doctype html/i);
    const css = await call(`${contentOrigin(p.id)}/__plinth/types/doc/doc.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(await css.text()).toContain(".plinth-doc");
    const head = await call(`${contentOrigin(p.id)}/__plinth/types/doc/doc.js`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("renderer files carry the ASSETS ETag and revalidate with a 304", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    for (const f of ["doc.js", "doc.css"]) {
      const url = `${contentOrigin(p.id)}/__plinth/types/doc/${f}`;
      const first = await call(url);
      expect(first.status, f).toBe(200);
      await first.text();
      const etag = first.headers.get("etag");
      expect(etag, f).toBeTruthy();
      expect(first.headers.get("cache-control")).toBe("private, no-cache");
      const again = await call(url, { headers: { "If-None-Match": etag ?? "" } });
      expect(again.status, f).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("content-security-policy")).toBe(contentCsp(config()));
      expect(await again.text()).toBe("");
      const stale = await call(url, { headers: { "If-None-Match": '"stale"' } });
      expect(stale.status, f).toBe(200);
      expect((await stale.text()).length).toBeGreaterThan(100);
    }
  });

  it("a stubbed ASSETS ETag is passed through, weak or strong", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const vars = {
      ASSETS: {
        fetch: async () =>
          new Response("x", { headers: { "Content-Type": "text/javascript", ETag: '"abc"' } }),
      },
    };
    const url = `${contentOrigin(p.id)}/__plinth/types/doc/doc.js`;
    const ok = await run(url, {}, vars);
    expect(ok.headers.get("etag")).toBe('"abc"');
    for (const inm of ['"abc"', 'W/"abc"', '"x", "abc"', "*"]) {
      const res = await run(url, { headers: { "If-None-Match": inm } }, vars);
      expect(res.status, inm).toBe(304);
    }
    const none = {
      ASSETS: {
        fetch: async () => new Response("x", { headers: { "Content-Type": "text/javascript" } }),
      },
    };
    const plain = await run(url, { headers: { "If-None-Match": "*" } }, none);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("etag")).toBeNull();
  });

  it("only the files the registry lists are served", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    for (const path of [
      "/__plinth/types/doc/x.js",
      "/__plinth/types/deck/doc.js",
      "/__plinth/types/html/doc.js",
      "/__plinth/types/__proto__/doc.js",
      "/__plinth/types/doc/",
      "/__plinth/types/doc/doc.js/x",
      "/__plinth/types/doc/index.html",
    ]) {
      const res = await call(`${contentOrigin(p.id)}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-security-policy"), path).toBe(contentCsp(config()));
    }
  });

  it("refuses what ASSETS returns when it is not the expected type (the SPA fallback)", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const spa = {
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><div id=root></div>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },
    };
    const missing = {
      ASSETS: { fetch: async () => new Response("nope", { status: 404 }) },
    };
    const swapped = {
      ASSETS: {
        fetch: async () =>
          new Response("body{}", { headers: { "Content-Type": "text/css; charset=utf-8" } }),
      },
    };
    for (const vars of [spa, missing]) {
      for (const f of ["doc.js", "doc.css"]) {
        const res = await run(`${contentOrigin(p.id)}/__plinth/types/doc/${f}`, {}, vars);
        expect(res.status, f).toBe(404);
        expect(await res.text()).not.toContain("root");
      }
    }
    // A stylesheet is never served as the script.
    const res = await run(`${contentOrigin(p.id)}/__plinth/types/doc/doc.js`, {}, swapped);
    expect(res.status).toBe(404);
  });

  it("the ASSETS request is built from the registry, not the request path", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const seen: string[] = [];
    const vars = {
      ASSETS: {
        fetch: async (req: Request | string) => {
          seen.push(typeof req === "string" ? req : req.url);
          return new Response("x", { headers: { "Content-Type": "text/javascript" } });
        },
      },
    };
    const res = await run(`${contentOrigin(p.id)}/__plinth/types/doc/doc.js?x=1`, {}, vars);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://assets.invalid/__plinth-renderers/doc/doc.js"]);
  });

  it("the app host never serves renderer files", async () => {
    for (const path of [
      "/__plinth-renderers/doc/doc.js",
      "/__plinth-renderers/doc/doc.css",
      "/__plinth-renderers/",
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("plinth-doc");
    }
  });
});

describe("doc shell under opaque isolation and the path fallback", () => {
  const OPAQUE = { CONTENT_ISOLATION: "opaque" };

  it("opaque: the shell keeps the sandbox (no allow-same-origin) and CORP cross-origin", async () => {
    const { p, cookie } = await openedDoc({}, OPAQUE);
    const res = await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } }, OPAQUE);
    expect(res.status).toBe(200);
    const d = directives(res.headers.get("content-security-policy"));
    expect(d.get("sandbox")).toBe(OPAQUE_SANDBOX);
    expect(d.get("sandbox")).not.toContain("allow-same-origin");
    expect(d.get("script-src")).toBe("script-src 'self'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(payloadOf(await res.text()).text).toBe(MD);
    const opaqueConfig = parseConfig({ ...(env as unknown as Record<string, unknown>), ...OPAQUE });
    const js = await run(`${contentOrigin(p.id)}/__plinth/types/doc/doc.js`, {}, OPAQUE);
    expect(js.status).toBe(200);
    expect(js.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(js.headers.get("content-security-policy")).toBe(contentCsp(opaqueConfig));
  });

  it("path fallback: renderer URLs are prefixed with /__content/<id>", async () => {
    const vars = { STAGING_CONTENT_FALLBACK: "true" };
    const { p, cookie } = await openedDoc({}, vars);
    const res = await run(`/__content/${p.id}/`, { headers: { Cookie: cookie } }, vars);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<link rel="stylesheet" href="/__content/${p.id}/__plinth/types/doc/doc.css">`,
    );
    expect(html).toContain(`<script src="/__content/${p.id}/__plinth/types/doc/doc.js"></script>`);
    expect(directives(res.headers.get("content-security-policy")).get("sandbox")).toBe(
      OPAQUE_SANDBOX,
    );
    const js = await run(`/__content/${p.id}/__plinth/types/doc/doc.js`, {}, vars);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    const reviewed = await run(
      `/__content/${p.id}/?plinth-review=1`,
      { headers: { Cookie: cookie } },
      vars,
    );
    expect(await reviewed.text()).toContain(
      `<script src="/__content/${p.id}/__plinth/bridge.js" data-plinth-bridge></script>`,
    );
  });
});

describe("contentCsp", () => {
  it("default output is unchanged", () => {
    const c = config();
    const cdn = c.cdnAllowlist.map((h) => `https://${h}`).join(" ");
    const expected = [
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${cdn}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors 'self' ${c.appOrigin}`,
    ].join("; ");
    expect(contentCsp(c)).toBe(expected);
    expect(contentCsp(c, {})).toBe(expected);
  });

  it("scripts: 'none' changes script-src only", () => {
    const c = config();
    expect(contentCsp(c, { scripts: "none" })).toBe(
      contentCsp(c).replace(/script-src [^;]*/, "script-src 'none'"),
    );
  });

  it("scripts: 'self' changes script-src only, and keeps the opaque sandbox", () => {
    const c = config();
    const strict = contentCsp(c, { scripts: "self" });
    const def = contentCsp(c);
    expect(strict).toBe(def.replace(/script-src [^;]*/, "script-src 'self'"));
    const o = parseConfig({
      ...(env as unknown as Record<string, unknown>),
      CONTENT_ISOLATION: "opaque",
    });
    const opaqueStrict = contentCsp(o, { scripts: "self" });
    expect(opaqueStrict.endsWith(`; ${OPAQUE_SANDBOX}`)).toBe(true);
    expect(opaqueStrict).toBe(contentCsp(o).replace(/script-src [^;]*/, "script-src 'self'"));
  });
});

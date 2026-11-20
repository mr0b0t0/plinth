// A deck's .pptx writer is a lazy renderer file: /__plinth/types/slides/slides-pptx.js is served
// on content origins like the deck's own script (from ASSETS, cookie-less, the default content CSP,
// the Content-Type guard and the ETag), never on the app host, and only because the registry lists
// it: no other name under the type is served, and an SPA fallback or a stylesheet from ASSETS is
// refused.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { rendererFiles, TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import worker from "../src/index.ts";
import { APP, agent, call, config, contentOrigin, publish } from "./helpers.ts";

const DECK = "# Q4 review\n\n---\n\n## Revenue\n";

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

async function deck() {
  const a = await agent();
  const { body } = await publish(a.auth, { html: undefined, type: "slides", content: DECK });
  return body as { id: string };
}

describe("the .pptx writer file", () => {
  it("is listed for slides only, as a script", () => {
    expect(rendererFiles(TYPE_REGISTRY.slides)).toEqual([
      { name: "slides.js", contentType: "text/javascript" },
      { name: "slides.css", contentType: "text/css" },
      { name: "slides-pptx.js", contentType: "text/javascript" },
    ]);
    expect(TYPE_REGISTRY.slides.fileExports).toEqual(["pptx"]);
    for (const t of ["html", "doc", "design_system"] as const) {
      expect(TYPE_REGISTRY[t].renderer?.lazy).toBeUndefined();
      expect(TYPE_REGISTRY[t].fileExports).toBeUndefined();
    }
  });

  it("is served on the deck's origin like the deck's script, with no cookie", async () => {
    const p = await deck();
    const res = await call(`${contentOrigin(p.id)}/__plinth/types/slides/slides-pptx.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const src = await res.text();
    // The bundled writer: PptxGenJS's own markers, an IIFE, no page markup.
    expect(src.length).toBeGreaterThan(100_000);
    expect(src).toContain("ppt/presentation.xml");
    expect(src.startsWith("(function(){")).toBe(true);
    expect(src).not.toMatch(/<!doctype html/i);
    const etag = res.headers.get("etag");
    if (etag) {
      const again = await call(`${contentOrigin(p.id)}/__plinth/types/slides/slides-pptx.js`, {
        headers: { "If-None-Match": etag },
      });
      expect(again.status).toBe(304);
    }
  });

  it("is the only extra file: no other name, and not under another type", async () => {
    const p = await deck();
    for (const path of [
      "/__plinth/types/slides/pptx.js",
      "/__plinth/types/slides/pptx.ts",
      "/__plinth/types/slides/slides-pptx.css",
      "/__plinth/types/slides/slides-pptx.js.map",
      "/__plinth/types/doc/slides-pptx.js",
      "/__plinth/types/design_system/slides-pptx.js",
    ]) {
      const res = await call(`${contentOrigin(p.id)}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses an SPA fallback, a missing file or a stylesheet from ASSETS", async () => {
    const p = await deck();
    const url = `${contentOrigin(p.id)}/__plinth/types/slides/slides-pptx.js`;
    for (const response of [
      () =>
        new Response("<!doctype html><div id=root></div>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      () => new Response("nope", { status: 404 }),
      () => new Response("body{}", { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    ]) {
      const res = await run(url, {}, { ASSETS: { fetch: async () => response() } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("root");
    }
  });

  it("is never served on the app host", async () => {
    const res = await call("/__plinth-renderers/slides/slides-pptx.js");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("ppt/presentation.xml");
  });
});

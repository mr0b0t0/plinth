// Editor preview loader (/__plinth/preview on content hosts): served only on artifact subdomains,
// with the content headers, embedding the exact app origin, never posting to "*", and accepting
// messages only from the app origin and the parent window.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import {
  PREVIEW_MESSAGE_SOURCE,
  previewLoaderHtml,
  servePreviewLoader,
} from "../src/content/preview.ts";
import worker from "../src/index.ts";
import { APP, agent, CONTENT_HOST, call, config, contentOrigin, publish } from "./helpers.ts";

const PATH = "/__plinth/preview";

/** The inline script of the loader page. */
function loaderScript(html: string): string {
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error("no inline script in the loader");
  return m[1];
}

describe("preview loader", () => {
  it("is served on an artifact subdomain with the content CSP and headers, without a cookie", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`${contentOrigin(p.id)}${PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("permissions-policy")).toBeTruthy();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    expect(text).toBe(previewLoaderHtml(config()));
    // No artifact data: the page is the same for every artifact.
    expect(text).not.toContain(p.id);
    expect(text).not.toContain("<h1>Hello</h1>");
  });

  it("allows its inline script under the content CSP and may only be framed by the app", () => {
    const csp = contentCsp(config());
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toContain(`frame-ancestors 'self' ${config().appOrigin}`);
  });

  it("is never served by the app host or the bare content host", async () => {
    const app = await call(`${APP}${PATH}`);
    expect(await app.text()).not.toContain(PREVIEW_MESSAGE_SOURCE);
    const root = await call(`http://${CONTENT_HOST}${PATH}`);
    expect(root.status).toBe(404);
    expect(await root.text()).not.toContain(PREVIEW_MESSAGE_SOURCE);
    const other = await call(`http://not-an-artifact.${CONTENT_HOST}${PATH}`);
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain(PREVIEW_MESSAGE_SOURCE);
  });

  it("embeds the exact app origin and never uses '*' as a postMessage target", () => {
    const script = loaderScript(previewLoaderHtml(config()));
    expect(script).toContain(`var APP_ORIGIN = ${JSON.stringify(config().appOrigin)};`);
    expect(script).toContain(`var SOURCE = ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)};`);
    expect(script).toContain(`var MAX_BYTES = ${LIMITS.maxHtmlBytes};`);
    expect(script).not.toMatch(/["'`]\*["'`]/);
    const posts = script.match(/postMessage\([^;]*\);/g) ?? [];
    expect(posts.length).toBe(1);
    for (const p of posts) expect(p).toMatch(/, APP_ORIGIN\);$/);
  });

  it("checks event.origin and event.source before anything else, and validates shape and size", () => {
    const script = loaderScript(previewLoaderHtml(config()));
    const handler = script.slice(script.indexOf("function onMessage"));
    const originCheck = handler.indexOf(
      "if (event.origin !== APP_ORIGIN || event.source !== parentWindow) return;",
    );
    expect(originCheck).toBeGreaterThan(0);
    expect(originCheck).toBeLessThan(handler.indexOf("event.data"));
    expect(handler).toContain('d.type !== "render"');
    expect(handler).toContain('typeof d.html !== "string" || tooLarge(d.html)');
    expect(handler.indexOf("tooLarge(d.html)")).toBeLessThan(handler.indexOf("document.write"));
    // The app origin is embedded as a JSON string, so a hostile value cannot break out.
    const hostile = previewLoaderHtml({ ...config(), appOrigin: 'https://x.test";alert(1);"' });
    expect(hostile).toContain('var APP_ORIGIN = "https://x.test\\";alert(1);\\"";');
  });

  it("runs as expected: renders only messages from the app origin and the parent window", async () => {
    const script = loaderScript(previewLoaderHtml(config()));
    const appOrigin = config().appOrigin;
    // A minimal stand-in for the browser objects the loader touches.
    const posted: { msg: unknown; target: string }[] = [];
    const written: string[] = [];
    const listeners = new Map<string, (e: unknown) => void>();
    const parent = {
      postMessage: (msg: unknown, target: string) => posted.push({ msg, target }),
    };
    let url = "/__plinth/preview";
    const win = {
      parent,
      location: {
        get pathname() {
          return url;
        },
      },
      history: { replaceState: (_s: unknown, _t: string, u: string) => (url = u) },
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const doc = {
      open: () => written.push("<open>"),
      write: (s: string) => written.push(s),
      close: () => written.push("<close>"),
    };
    new Function("window", "document", "TextEncoder", script)(win, doc, TextEncoder);

    expect(posted).toEqual([
      { msg: { source: PREVIEW_MESSAGE_SOURCE, v: 1, type: "ready" }, target: appOrigin },
    ]);
    const render = (html: unknown) => ({
      source: PREVIEW_MESSAGE_SOURCE,
      v: 1,
      type: "render",
      html,
    });
    const send = (e: unknown) => listeners.get("message")?.(e);
    send({ origin: "https://evil.example", source: parent, data: render("<p>evil</p>") });
    send({ origin: appOrigin, source: {}, data: render("<p>not the parent</p>") });
    send({ origin: appOrigin, source: parent, data: "<p>a string</p>" });
    send({ origin: appOrigin, source: parent, data: { ...render("<p>v2</p>"), v: 2 } });
    send({ origin: appOrigin, source: parent, data: render(42) });
    send({ origin: appOrigin, source: parent, data: render("x".repeat(LIMITS.maxHtmlBytes + 1)) });
    // Multi-byte characters count in UTF-8 bytes, not string length.
    send({
      origin: appOrigin,
      source: parent,
      data: render("é".repeat(LIMITS.maxHtmlBytes / 2 + 1)),
    });
    expect(written).toEqual([]);

    send({ origin: appOrigin, source: parent, data: render("<p>draft</p>") });
    expect(written).toEqual(["<open>", "<p>draft</p>", "<close>"]);
    // Relative URLs resolve against the artifact root, like the published page.
    expect(url).toBe("/");
    // One render per loader; the listener is gone.
    expect(listeners.has("message")).toBe(false);
  });

  it("does nothing outside a frame", () => {
    const script = loaderScript(previewLoaderHtml(config()));
    const posted: unknown[] = [];
    const win: Record<string, unknown> = { addEventListener: () => posted.push("listen") };
    win.parent = win;
    new Function("window", "document", "TextEncoder", script)(win, {}, TextEncoder);
    expect(posted).toEqual([]);
  });

  it("is reachable through a one-time enter link whose next is the loader", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const gate = (await (
      await call(`/api/v1/view/${p.id}?next=${encodeURIComponent(PATH)}`, { headers: a.auth })
    ).json()) as { status: string; enter_url: string };
    expect(gate.status).toBe("ok");
    const enter = await call(gate.enter_url);
    expect(enter.status).toBe(302);
    expect(enter.headers.get("location")).toBe(PATH);
    expect(enter.headers.get("set-cookie")).toContain("plinth_content=");
  });

  it("works in the staging path fallback, where it points at the artifact's path root", async () => {
    const vars = { STAGING_CONTENT_FALLBACK: "true" };
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${APP}/__content/${p.id}${PATH}`, { redirect: "manual" }),
      { ...env, ...vars } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox ");
    expect(csp).not.toContain("allow-same-origin");
    expect(await res.text()).toContain(PREVIEW_MESSAGE_SOURCE);
  });

  it("servePreviewLoader returns the loader with the content headers", async () => {
    const res = servePreviewLoader(config());
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(await res.text()).toBe(previewLoaderHtml(config()));
  });
});

import { BRIDGE_MESSAGE_SOURCE } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { bridgeScriptSource } from "../src/content/bridge.ts";
import { contentCsp } from "../src/content/csp.ts";
import { agent, call, config, contentOrigin, enterContent, publish } from "./helpers.ts";

const TAG = '<script src="/__plinth/bridge.js" data-plinth-bridge></script>';

async function openArtifact(body: Record<string, unknown>) {
  const a = await agent();
  const { body: p } = await publish(a.auth, body);
  const { cookie } = await enterContent(p.slug);
  const get = (path: string) =>
    call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } });
  return { p, get };
}

describe("review-mode bridge injection", () => {
  it("adds the bridge script before </head> only in review mode", async () => {
    const html =
      "<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>";
    const { get, p } = await openArtifact({ html });
    const plain = await get("/");
    expect(await plain.text()).toBe(html);
    const review = await get("/?plinth-review=1");
    expect(review.status).toBe(200);
    const text = await review.text();
    expect(text).toBe(html.replace("</head>", `${TAG}</head>`));
    // A document names its own live-room origin in connect-src (rooms are on in tests).
    expect(review.headers.get("content-security-policy")).toBe(
      contentCsp(config(), { socket: `ws://${new URL(contentOrigin(p.id)).host}` }),
    );
    expect(review.headers.get("etag")).toBeNull();
    // Permanent version links get it too.
    expect(await (await get("/__plinth/v/1/?plinth-review=1")).text()).toContain(TAG);
  });

  it("appends to the document when there is no <head> or no </head>", async () => {
    const html = "<!doctype html><h1>No head</h1>";
    const { get } = await openArtifact({ html });
    expect(await (await get("/?plinth-review=1")).text()).toBe(`${html}${TAG}`);

    const open = "<!doctype html><head><title>x</title><body><p>unclosed head</p>";
    const second = await openArtifact({ html: open });
    expect(await (await second.get("/?plinth-review=1")).text()).toBe(`${open}${TAG}`);
  });

  it("injects once, and never into non-HTML files", async () => {
    const html = "<head></head><svg><head></head></svg>";
    const { get } = await openArtifact({
      html,
      assets: [
        { path: "app.js", content: "console.log('</head>')" },
        { path: "page.html", content: "<head></head><p>second page</p>" },
      ],
    });
    const text = await (await get("/?plinth-review=1")).text();
    expect(text.split("data-plinth-bridge").length - 1).toBe(1);
    expect(await (await get("/app.js?plinth-review=1")).text()).toBe("console.log('</head>')");
    expect(await (await get("/page.html?plinth-review=1")).text()).toContain(TAG);
  });
});

describe("bridge script", () => {
  it("is served on content hosts with the content headers", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`${contentOrigin(p.id)}/__plinth/bridge.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("permissions-policy")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe(bridgeScriptSource(config()));
  });

  it("embeds the exact app origin and never posts to '*'", () => {
    const src = bridgeScriptSource(config());
    expect(src).toContain(`var APP_ORIGIN = ${JSON.stringify(config().appOrigin)};`);
    expect(src).toContain(`var SOURCE = ${JSON.stringify(BRIDGE_MESSAGE_SOURCE)};`);
    expect(src).not.toMatch(/["'`]\*["'`]/);
    const posts = [...src.matchAll(/\.postMessage\(([^)]*)\)/g)].map((m) => m[1]);
    expect(posts).toEqual(["msg, APP_ORIGIN"]);
    expect(src).toContain("parentWindow = window.parent");
    // Strict checks on incoming messages: origin, source window, tag and version.
    expect(src).toContain("e.origin !== APP_ORIGIN || e.source !== parentWindow");
    expect(src).toContain("d.source !== SOURCE || d.v !== VERSION");
    // Only active inside a frame.
    expect(src).toContain("if (window.parent === window) return;");
  });

  it("escapes the origin as a JS string literal", () => {
    const origin = 'https://evil.example"; alert(1); "</script>';
    const src = bridgeScriptSource({ ...config(), appOrigin: origin });
    expect(src).toContain(`var APP_ORIGIN = ${JSON.stringify(origin)};`);
    expect(src).not.toContain('"https://evil.example";');
  });
});

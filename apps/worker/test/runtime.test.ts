// /__plinth/runtime.js: the static script that gives pages window.plinth. It holds no artifact data
// and no configuration but the instance's public app origin, so it is served without a content
// cookie. The origin is embedded once as a JSON string, for the app channel (page comments and
// dictation).
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { runtimeScript } from "../src/content/runtime.ts";
import { agent, call, config, contentOrigin, publish } from "./helpers.ts";

const RUNTIME_SCRIPT = runtimeScript(config());

describe("/__plinth/runtime.js", () => {
  it("is served without a cookie, as JavaScript with the content headers", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`${contentOrigin(p.id)}/__plinth/runtime.js`, {
      headers: { "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    expect(body).toBe(RUNTIME_SCRIPT);
    expect(body).toContain("window.plinth");
    // Any artifact id, even one that does not exist, gets the same script.
    const other = await call(`${contentOrigin("a".repeat(20))}/__plinth/runtime.js`);
    expect(other.status).toBe(200);
    expect(await other.text()).toBe(body);
    // Only GET and HEAD.
    const post = await call(`${contentOrigin(p.id)}/__plinth/runtime.js`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("contains no secret, and no configuration value but the app origin", () => {
    const c = config();
    // Page comments and dictation post to the app that frames the page: its public origin, as a
    // JSON string, once. Nothing else from the configuration is in the script.
    const origin = `var APP_ORIGIN = ${JSON.stringify(c.appOrigin)};`;
    expect(RUNTIME_SCRIPT.split(origin).length).toBe(2);
    expect(RUNTIME_SCRIPT.split(c.appOrigin).length).toBe(2);
    const rest = RUNTIME_SCRIPT.replace(origin, "");
    const values = [
      c.tokenSigningKey,
      c.sessionSecret,
      "test-session-secret",
      "test-token-signing-key",
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    for (const v of values) expect(rest, v).not.toContain(v);
    // No other host or URL.
    for (const v of [c.appOrigin, c.appHost, c.contentHost, "localhost"]) {
      expect(rest, v).not.toContain(v);
    }
    expect(rest).not.toMatch(/https?:\/\//);
    // Shared data, the live room, page comments and dictation together; still one small static
    // file (about 45 KiB).
    expect(RUNTIME_SCRIPT.length).toBeLessThan(48 * 1024);
  });

  it("speaks the API it is served next to", () => {
    for (const s of [
      "/__plinth/api/v1",
      "x-plinth-data",
      "plinth:expired",
      '"same-origin"',
      "no-store",
      "visibilitychange",
      "~me",
      '"/room"',
      "/__plinth/room/v1/page",
      "plinth.room.v1",
    ]) {
      expect(RUNTIME_SCRIPT, s).toContain(s);
    }
  });
});

// /__plinth/runtime.js: the static script that gives pages window.plinth. It holds no artifact data
// and no configuration, so it is served without a content cookie.
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { RUNTIME_SCRIPT } from "../src/content/runtime.ts";
import { agent, call, config, contentOrigin, publish } from "./helpers.ts";

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

  it("contains no secret or configuration value", () => {
    const c = config();
    const values = [
      c.tokenSigningKey,
      c.sessionSecret,
      c.appOrigin,
      c.appHost,
      c.contentHost,
      "localhost",
      "test-session-secret",
      "test-token-signing-key",
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    for (const v of values) expect(RUNTIME_SCRIPT, v).not.toContain(v);
    expect(RUNTIME_SCRIPT).not.toMatch(/https?:\/\//);
    expect(RUNTIME_SCRIPT.length).toBeLessThan(16 * 1024);
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
    ]) {
      expect(RUNTIME_SCRIPT, s).toContain(s);
    }
  });
});

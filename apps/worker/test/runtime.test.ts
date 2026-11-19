// /__plinth/runtime.js: the static script that gives pages window.plinth. It holds no artifact data
// and no secrets, so it is served without a content cookie. Its one configuration value is the
// public app origin, embedded once as a JSON string for dictation's app channel.
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
    const secrets = [
      c.tokenSigningKey,
      c.sessionSecret,
      "test-session-secret",
      "test-token-signing-key",
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    for (const v of secrets) expect(RUNTIME_SCRIPT, v).not.toContain(v);
    // The app origin, once, as a JSON string (dictation's app channel); no other host or URL.
    const line = `var APP_ORIGIN = ${JSON.stringify(c.appOrigin)};`;
    expect(RUNTIME_SCRIPT.split(line).length).toBe(2);
    const rest = RUNTIME_SCRIPT.replace(line, "");
    for (const v of [c.appOrigin, c.appHost, c.contentHost, "localhost"]) {
      expect(rest, v).not.toContain(v);
    }
    expect(rest).not.toMatch(/https?:\/\//);
    // Shared data and the live room together; still one small static file.
    expect(RUNTIME_SCRIPT.length).toBeLessThan(32 * 1024);
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

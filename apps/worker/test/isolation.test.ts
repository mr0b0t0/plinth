// Opaque content isolation (CONTENT_ISOLATION=opaque) at the response level, and the `__Host-`
// prefix on every app cookie (what keeps another host on a shared parent domain from overwriting
// them).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { COOKIES, HOST_COOKIE_PREFIX } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { OPAQUE_SANDBOX } from "../src/content/csp.ts";
import worker from "../src/index.ts";
import { appCookieName, serializeCookie } from "../src/lib/cookies.ts";
import { APP, agent, call, contentOrigin, json, publish } from "./helpers.ts";

const OPAQUE = { CONTENT_ISOLATION: "opaque" };

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

function sandboxOf(csp: string | null): string | null {
  const d = (csp ?? "").split(";").map((s) => s.trim());
  return d.find((s) => s === "sandbox" || s.startsWith("sandbox ")) ?? null;
}

/** Publish, open through the gate, and return the content cookie, all under `vars`. */
async function opened(vars: Record<string, unknown>, html = "<!doctype html><h1>Hi</h1>") {
  const owner = await agent();
  const { body: p } = await publish(owner.auth, {
    html,
    assets: [{ path: "style.css", content: "h1{color:red}" }],
  });
  const gate = await json(await run(`/api/v1/view/${p.id}`, { headers: owner.auth }, vars));
  const enter = await run(gate.enter_url, {}, vars);
  const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { p, enter, cookie };
}

describe("opaque content isolation", () => {
  it("every content response carries the CSP sandbox without allow-same-origin", async () => {
    const { p, enter, cookie } = await opened(OPAQUE);
    const page = await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } }, OPAQUE);
    const css = await run(
      `${contentOrigin(p.id)}/style.css`,
      { headers: { Cookie: cookie } },
      OPAQUE,
    );
    const denied = await run(`${contentOrigin(p.id)}/`, {}, OPAQUE);
    const missing = await run(
      `${contentOrigin(p.id)}/nope.html`,
      { headers: { Cookie: cookie } },
      OPAQUE,
    );
    const preview = await run(`${contentOrigin(p.id)}/__plinth/preview`, {}, OPAQUE);
    const bridge = await run(`${contentOrigin(p.id)}/__plinth/bridge.js`, {}, OPAQUE);
    expect(page.status).toBe(200);
    expect(css.status).toBe(200);
    for (const res of [enter, page, css, denied, missing, preview, bridge]) {
      const sandbox = sandboxOf(res.headers.get("content-security-policy"));
      expect(sandbox).toBe(OPAQUE_SANDBOX);
      expect(sandbox).not.toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-top-navigation");
      // Its own subresources must load in an opaque-origin document (CORP same-origin would
      // block them); the cookie still gates them.
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    }
    expect(denied.status).toBe(302);
  });

  it("origin isolation (the default) adds no sandbox and keeps CORP same-origin", async () => {
    const { p, cookie } = await opened({});
    const page = await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(sandboxOf(page.headers.get("content-security-policy"))).toBeNull();
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("keeps per-artifact cookies: one artifact's cookie opens nothing on another", async () => {
    const a = await opened(OPAQUE);
    const b = await opened(OPAQUE);
    const cross = await run(`${contentOrigin(b.p.id)}/`, { headers: { Cookie: a.cookie } }, OPAQUE);
    expect(cross.status).toBe(302);
    expect(cross.headers.get("location")).toContain(`/open/${b.p.id}`);
  });

  it("the app tells the SPA the effective mode", async () => {
    expect((await json(await run("/api/v1/config"))).content_isolation).toBe("origin");
    expect((await json(await run("/api/v1/config", {}, OPAQUE))).content_isolation).toBe("opaque");
    const fallback = await json(
      await run("/api/v1/config", {}, { STAGING_CONTENT_FALLBACK: "true" }),
    );
    expect(fallback).toMatchObject({ content_path_fallback: true, content_isolation: "opaque" });
  });
});

describe("app cookies use the __Host- prefix", () => {
  it("every app cookie name is __Host- prefixed; the content cookie is not an app cookie", () => {
    for (const name of [
      COOKIES.session,
      COOKIES.csrf,
      COOKIES.viewer,
      COOKIES.passwordPassPrefix,
    ]) {
      expect(name.startsWith(HOST_COOKIE_PREFIX)).toBe(true);
    }
    expect(COOKIES.content.startsWith(HOST_COOKIE_PREFIX)).toBe(false);
  });

  it("GET /config sets __Host-plinth_csrf: Secure, Path=/, no Domain", async () => {
    const res = await call("/api/v1/config");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^__Host-plinth_csrf=[^;]+; Path=\/; /);
    expect(sc).toMatch(/; Secure/);
    expect(sc).not.toMatch(/Domain=/i);
  });

  it("the CSRF check reads the prefixed cookie only", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, {
      visibility: "password",
      password: "pw-123456",
    });
    const post = (cookie: string) =>
      call(`/api/v1/view/${p.slug}/password`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "x-plinth-csrf": "tok",
          Origin: APP,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: "pw-123456" }),
      });
    // An unprefixed cookie is what another host on a shared parent domain could plant.
    expect((await post("plinth_csrf=tok")).status).toBe(403);
    const ok = await post("__Host-plinth_csrf=tok");
    expect(ok.status).toBe(200);
    // The password pass is a __Host- cookie too.
    const sc = ok.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(new RegExp(`^__Host-plinth_pw_${p.id}=[^;]+; Path=/; `));
    expect(sc).toMatch(/; Secure/);
  });

  it("refuses to build a __Host- cookie the browser would drop", () => {
    expect(() => serializeCookie("__Host-x", "1", { secure: false })).toThrow(/__Host-/);
    expect(() => serializeCookie("__Host-x", "1", { secure: true, path: "/a/" })).toThrow();
    expect(serializeCookie("__Host-x", "1", { secure: true })).toBe(
      "__Host-x=1; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("drops the prefix only where Secure cookies cannot be set (plain http, not localhost)", () => {
    const base = {
      ENVIRONMENT: "staging",
      CONTENT_HOST: "content.example.net",
      SESSION_SECRET: "s".repeat(40),
      TOKEN_SIGNING_KEY: "t".repeat(40),
    };
    const https = parseConfig({ ...base, APP_HOST: "app.example.com", PUBLIC_SCHEME: "https" });
    const local = parseConfig({ ...base, APP_HOST: "app.localhost:8787", PUBLIC_SCHEME: "http" });
    const lan = parseConfig({ ...base, APP_HOST: "plinth.lan:8080", PUBLIC_SCHEME: "http" });
    expect(appCookieName(https, "session")).toBe("__Host-plinth_session");
    expect(appCookieName(local, "csrf")).toBe("__Host-plinth_csrf");
    expect(appCookieName(lan, "session")).toBe("plinth_session");
    expect(appCookieName(lan, "passwordPassPrefix")).toBe("plinth_pw_");
  });
});

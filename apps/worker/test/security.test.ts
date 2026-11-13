// Security acceptance criteria (docs/build-prompt.md, "Security requirements"): one describe block
// per bullet, named after it, asserting on real responses from the Worker's fetch handler.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { COOKIES } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appCsp } from "../src/app/headers.ts";
import { ConfigError, parseConfig } from "../src/config.ts";
import { contentCsp } from "../src/content/csp.ts";
import { accessGrants, artifacts, reports, versions } from "../src/db/schema.ts";
import worker, { app } from "../src/index.ts";
import {
  APP,
  agent,
  browserSession,
  CONTENT_HOST,
  call,
  config,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  publish,
  uniqueEmail,
} from "./helpers.ts";

/** The Worker's fetch handler with extra vars, waiting for its waitUntil work. */
async function run(
  input: string,
  init: RequestInit = {},
  vars: Record<string, unknown> = {},
): Promise<Response> {
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

let ipCounter = 0;
const freshIp = () => {
  ipCounter += 1;
  return `192.0.2.${ipCounter % 250}`;
};

const EVIL = "https://evil.example";
const CSRF = "csrf-security-suite";
/** Anonymous browser that passes the CSRF check (so authorization is what is tested). */
const anonymousBrowser = () => ({
  Cookie: `${COOKIES.csrf}=${CSRF}`,
  "x-plinth-csrf": CSRF,
  Origin: APP,
  "Content-Type": "application/json",
  "cf-connecting-ip": freshIp(),
});

const MARKER = "plinth-user-html-marker-7c1f";
const USER_HTML = `<!doctype html><title>x</title><p>${MARKER}</p><script>document.title="pwned"</script>`;

/** Fill a Hono route pattern with values that exist where it matters. */
function fill(path: string, ref: string): string {
  return path
    .replace(":ref", ref)
    .replace(":n", "1")
    .replace(/:[a-z_]+/g, "x0000000000000000000");
}

/** Unique unsafe (state-changing) routes on the app, from the live Hono route table. */
function unsafeRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (r.path.includes("*")) continue;
    const methods =
      r.method === "ALL"
        ? ["POST"]
        : ["POST", "PUT", "PATCH", "DELETE"].includes(r.method)
          ? [r.method]
          : [];
    for (const method of methods) {
      const key = `${method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, path: r.path });
    }
  }
  return out;
}

/** Valid bodies for known routes, so a refusal is about CSRF or authorization, not validation. */
function bodyFor(method: string, path: string): unknown {
  const p = path.replace(/^\/api\/v1/, "");
  const known: Record<string, unknown> = {
    "POST /artifacts": { title: "x", html: "<p>x</p>" },
    "PUT /artifacts/:ref": { html: "<p>defaced</p>" },
    "PATCH /artifacts/:ref": { title: "renamed" },
    "PUT /artifacts/:ref/visibility": { visibility: "unlisted" },
    "PUT /artifacts/:ref/sharing": { grants: [] },
    "POST /artifacts/:ref/versions/:n/restore": {},
    "POST /artifacts/:ref/report": { reason: "spam" },
    "POST /artifacts/:ref/comments": { body: "hello" },
    "POST /view/:ref/password": { password: "secret99" },
    "POST /view/:ref/email": { email: "someone@example.com" },
    "POST /view/:ref/code": { email: "someone@example.com", code: "123456" },
    "POST /admin/reports/:id": { state: "actioned" },
  };
  return known[`${method} ${p}`] ?? {};
}

const sendBody = (method: string, path: string, headers: Record<string, string>, ref: string) =>
  run(fill(path, ref), {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(bodyFor(method, path)),
  });

function directives(csp: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of (csp ?? "").split(";")) {
    const [name, ...values] = d.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe("Artifact responses on content hosts carry a Content Security Policy (CDN allowlist, fonts, own files, connect-src self), nosniff and a restrictive Permissions-Policy", () => {
  it("the policy has exactly the required sources", () => {
    const d = directives(contentCsp(config()));
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'wasm-unsafe-eval'",
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
      "https://unpkg.com",
      "https://cdn.tailwindcss.com",
      "https://code.jquery.com",
      "https://cdn.plot.ly",
    ]);
    expect(d.get("style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
    ]);
    expect(d.get("font-src")).toEqual(["'self'", "https://fonts.gstatic.com", "data:"]);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("media-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    // No source anywhere opens the network beyond the artifact and the allowlist.
    for (const [, values] of d) {
      for (const v of values) expect(["*", "http:", "https:", "ws:", "wss:"]).not.toContain(v);
    }
  });

  it("is on every content response: HTML, assets, redirects, enter, errors, other methods", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      html: USER_HTML,
      assets: [{ path: "app.css", content: "p{}" }],
    });
    const gate = await json(await call(`/api/v1/view/${p.id}`));
    const enter = await call(gate.enter_url);
    const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const withCookie = { headers: { Cookie: cookie } };
    const o = contentOrigin(p.id);
    const responses: [string, Response][] = [
      ["enter (302)", enter],
      ["enter replay (403)", await call(gate.enter_url)],
      ["html", await call(`${o}/`, withCookie)],
      ["asset", await call(`${o}/app.css`, withCookie)],
      ["HEAD", await call(`${o}/`, { ...withCookie, method: "HEAD" })],
      ["missing file (404)", await call(`${o}/nope.js`, withCookie)],
      ["missing version (404)", await call(`${o}/__plinth/v/7/`, withCookie)],
      ["version redirect (301)", await call(`${o}/__plinth/v/1`, withCookie)],
      ["bad path (400)", await call(`${o}/a%2f..%2fb`, withCookie)],
      ["gate redirect (302)", await call(`${o}/`)],
      ["POST (405)", await call(`${o}/`, { method: "POST" })],
      ["reserved (404)", await call(`${o}/__plinth/secret`, withCookie)],
      ["bare content host", await call(`http://${CONTENT_HOST}/`)],
      ["non-artifact subdomain", await call(`http://www.${CONTENT_HOST}/api/v1/me`)],
      ["unknown artifact", await call(`${contentOrigin("a".repeat(20))}/`)],
    ];
    const expected = contentCsp(config());
    for (const [name, res] of responses) {
      expect(res.headers.get("content-security-policy"), name).toBe(expected);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      const pp = res.headers.get("permissions-policy") ?? "";
      for (const f of [
        "camera",
        "microphone",
        "geolocation",
        "payment",
        "usb",
        "display-capture",
      ]) {
        expect(pp, `${name}: ${f}`).toContain(`${f}=()`);
      }
      // Every listed feature is switched off, none is granted.
      expect(
        pp.split(",").every((x) => x.trim().endsWith("=()")),
        name,
      ).toBe(true);
      expect(res.headers.get("x-robots-tag"), name).toBe("noindex, nofollow");
      expect(res.headers.get("cross-origin-resource-policy"), name).toBe("same-origin");
    }
  });

  it("a custom CDN_ALLOWLIST replaces the default script hosts, in the policy and on responses", async () => {
    const custom = parseConfig({
      ...(env as unknown as Record<string, unknown>),
      CDN_ALLOWLIST: "cdn.example.com, static.example.org",
    });
    const scripts = directives(contentCsp(custom)).get("script-src") ?? [];
    expect(scripts).toContain("https://cdn.example.com");
    expect(scripts).toContain("https://static.example.org");
    expect(scripts).not.toContain("https://unpkg.com");
    const res = await run(`http://${CONTENT_HOST}/`, {}, { CDN_ALLOWLIST: "cdn.example.com" });
    const live = directives(res.headers.get("content-security-policy")).get("script-src") ?? [];
    expect(live).toContain("https://cdn.example.com");
    expect(live).not.toContain("https://cdn.jsdelivr.net");
  });
});

describe("Iframes that show artifacts use a sandbox without allow-top-navigation and without allow-same-origin toward the app", () => {
  // The <iframe sandbox> attribute is rendered by the React app and checked by the end-to-end
  // suite. Here: what the Worker controls about who may frame what.
  it("content may only be framed by the app origin (and itself)", async () => {
    const res = await call(`http://${CONTENT_HOST}/`);
    const d = directives(res.headers.get("content-security-policy"));
    expect(d.get("frame-ancestors")).toEqual(["'self'", APP]);
  });

  it("the app frames only content subdomains, and nothing may frame the app", async () => {
    const d = directives(appCsp(config()));
    expect(d.get("frame-src")).toEqual([`http://*.${CONTENT_HOST}`]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    const res = await call("/healthz");
    expect(res.headers.get("content-security-policy")).toBe(appCsp(config()));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("One artifact cannot read another artifact's cookies, storage or files; a viewer token for artifact A is rejected on artifact B", () => {
  it("each artifact is its own origin, never the app's", async () => {
    const a = await agent();
    const { body: pa } = await publish(a.auth);
    const { body: pb } = await publish(a.auth);
    const ga = await json(await call(`/api/v1/view/${pa.id}`));
    const gb = await json(await call(`/api/v1/view/${pb.id}`));
    const oa = new URL(ga.enter_url).origin;
    const ob = new URL(gb.enter_url).origin;
    expect(oa).toBe(contentOrigin(pa.id));
    expect(ob).toBe(contentOrigin(pb.id));
    expect(oa).not.toBe(ob);
    expect(oa).not.toBe(APP);
  });

  it("the content cookie is host-only, HttpOnly, Secure, partitioned and scoped to /", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { enter } = await enterContent(p.id);
    const sc = enter?.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(
      /^plinth_content=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=None; Partitioned$/,
    );
    expect(sc).not.toMatch(/Domain=/i);
  });

  it("a token for A is refused on B; a cookie for A (or one re-labelled for B) opens nothing on B", async () => {
    const a = await agent();
    const { body: pa } = await publish(a.auth, { html: "<p>A</p>" });
    const { body: pb } = await publish(a.auth, { html: "<p>B secret</p>" });
    const ga = await json(await call(`/api/v1/view/${pa.id}`));
    const token = new URL(ga.enter_url).searchParams.get("t") ?? "";
    const onB = await call(`${contentOrigin(pb.id)}/__plinth/enter?t=${encodeURIComponent(token)}`);
    expect(onB.status).toBe(403);
    expect(onB.headers.get("set-cookie")).toBeNull();

    const { cookie } = await enterContent(pa.id);
    const value = (cookie ?? "").split("=").slice(1).join("=");
    const res = await call(`${contentOrigin(pb.id)}/`, { headers: { Cookie: cookie ?? "" } });
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("B secret");

    // Re-label A's cookie for B without the key: the signature no longer matches.
    const [body, sig] = value.split(".");
    const payload = JSON.parse(atob((body ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    const forgedBody = btoa(JSON.stringify({ ...payload, a: pb.id }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = await call(`${contentOrigin(pb.id)}/`, {
      headers: { Cookie: `plinth_content=${forgedBody}.${sig}` },
    });
    expect(forged.status).toBe(302);
  });

  it("a cookie tossed onto the parent domain cannot shadow an artifact's real cookie", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<p>real</p>" });
    const { cookie } = await enterContent(p.id);
    const res = await call(`${contentOrigin(p.id)}/`, {
      headers: { Cookie: `plinth_content=tossed.junk; ${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>real</p>");
  });

  it("file paths cannot escape the artifact's version prefix in R2", async () => {
    const a = await agent();
    const secret = `other-artifact-secret-${Math.random()}`;
    const { body: victim } = await publish(a.auth, {
      html: "<p>victim</p>",
      assets: [{ path: "secret.txt", content: secret }],
    });
    const { body: p } = await publish(a.auth, { html: "<p>attacker</p>" });
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>attacker v2</p>" }),
    });
    const { cookie } = await enterContent(p.id);
    const v = victim.id;
    const attempts = [
      `/../../${v}/v1/secret.txt`,
      `/%2e%2e/%2e%2e/${v}/v1/secret.txt`,
      `/..%2f..%2f${v}%2fv1%2fsecret.txt`,
      `/%2e%2e%2f%2e%2e%2f${v}%2fv1%2fsecret.txt`,
      `/x/..%2f..%2f..%2f${v}/v1/secret.txt`,
      `/..%5c..%5c${v}%5cv1%5csecret.txt`,
      `/..\\..\\${v}\\v1\\secret.txt`,
      `//..//..//${v}/v1/secret.txt`,
      `//secret.txt`,
      `/%252e%252e%252f%252e%252e%252f${v}%252fv1%252fsecret.txt`,
      `/__plinth/v/1/..%2f..%2f..%2f${v}%2fv1%2fsecret.txt`,
      `/__plinth/v/2/..%2fv1%2findex.html`,
      `/__plinth/v/0/`,
      `/__plinth/v/3/`,
      `/__plinth/v/-1/`,
      `/__plinth/v/99999999999/`,
      `/secret.txt`,
      `/secret.txt%00.html`,
      `/%00`,
      `/%`,
      `/%5F%5Fplinth/v/1/index.html`,
      `/./index.html%2f.`,
    ];
    for (const path of attempts) {
      const res = await call(`${contentOrigin(p.id)}${path}`, {
        headers: { Cookie: cookie ?? "" },
      });
      const body = await res.text();
      expect(body, path).not.toContain(secret);
      expect(body, path).not.toContain("victim");
      expect([301, 400, 404], path).toContain(res.status);
    }
  });
});

describe("No route on a content host serves app pages or accepts app cookies; no route on the app host serves raw user HTML", () => {
  const appPaths = [
    "/",
    "/dashboard",
    "/login",
    "/design",
    "/index.html",
    "/api/v1/me",
    "/api/v1/config",
    "/api/v1/artifacts",
    "/mcp",
    "/oauth/authorize",
    "/oauth/token",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/healthz",
    "/openapi.json",
    "/favicon.svg",
    "/theme.js",
  ];

  function isAppResponse(res: Response, body: string): boolean {
    return (
      body.includes('<div id="root">') ||
      body.includes('"environment"') ||
      body.includes('"error":{"code"') ||
      res.headers.get("content-security-policy") === appCsp(config())
    );
  }

  it("content hosts never answer with the SPA, the API, MCP or OAuth, with or without app cookies", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: USER_HTML });
    const session = await browserSession(owner.user.id);
    const { cookie } = await enterContent(p.id);
    const hosts = [
      `http://${CONTENT_HOST}`,
      `http://www.${CONTENT_HOST}`,
      `http://app.${CONTENT_HOST}`,
      contentOrigin(p.id),
    ];
    const cookieSets = [
      { name: "none", headers: {} },
      { name: "app session", headers: session.headers },
      { name: "content cookie", headers: { Cookie: cookie ?? "" } },
    ];
    for (const host of hosts) {
      for (const c of cookieSets) {
        for (const path of appPaths) {
          const res = await call(`${host}${path}`, { headers: c.headers });
          const body = await res.text();
          const where = `${host}${path} (${c.name})`;
          expect(isAppResponse(res, body), where).toBe(false);
          expect(res.headers.get("content-security-policy"), where).toBe(contentCsp(config()));
          // The only 200 on a content host is the artifact's own file, with its content cookie.
          if (res.status === 200) {
            expect([
              `${contentOrigin(p.id)}/ (content cookie)`,
              `${contentOrigin(p.id)}/index.html (content cookie)`,
            ]).toContain(where);
            expect(body).toBe(USER_HTML);
          }
        }
      }
    }
  });

  it("an app session cookie sent to a content host grants nothing and changes nothing", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, {
      html: USER_HTML,
      visibility: "allowlist",
      emails: [owner.user.email],
    });
    const session = await browserSession(owner.user.id);
    const res = await call(`${contentOrigin(p.id)}/`, { headers: session.headers });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/open/${p.id}?next=%2F`);
    expect(res.headers.get("set-cookie")).toBeNull();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const write = await call(`${contentOrigin(p.id)}/api/v1/artifacts/${p.id}`, {
        method,
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<p>defaced</p>", title: "defaced" }),
      });
      expect(write.status).toBe(405);
    }
    const row = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(row).toMatchObject({ currentVersion: 1, deletedAt: null });
  });

  it("the app host never serves an artifact's HTML as a page", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: USER_HTML });
    const session = await browserSession(owner.user.id);
    const paths = [
      `/a/${p.slug}`,
      `/a/${p.slug}/v/1`,
      `/a/${p.slug}/edit`,
      `/open/${p.id}`,
      `/__content/${p.id}/`,
      `/__content/${p.id}/index.html`,
      `/artifacts/${p.id}/v1/index.html`,
      `/__plinth/v/1/`,
      `/${p.id}/`,
      `/api/v1/view/${p.id}`,
      `/api/v1/artifacts/${p.id}`,
      `/api/v1/artifacts/${p.id}/versions/1`,
    ];
    for (const path of paths) {
      for (const headers of [{}, session.headers, owner.auth]) {
        const res = await call(path, { headers });
        const body = await res.text();
        const type = res.headers.get("content-type") ?? "";
        if (body.includes(MARKER)) {
          // Only the API carries the source, as a JSON string the browser never renders.
          expect(type, path).toMatch(/^application\/json/);
          expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
          expect(path.startsWith("/api/v1/artifacts/"), path).toBe(true);
        }
        if (type.includes("text/html")) {
          expect(res.headers.get("content-security-policy"), path).toBe(appCsp(config()));
        }
      }
    }
  });

  it("only the staging path fallback serves content from the app host, sandboxed to an opaque origin", async () => {
    const vars = { STAGING_CONTENT_FALLBACK: "true" };
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: USER_HTML });
    const { body: other } = await publish(owner.auth, { html: "<p>other</p>" });
    const gate = await json(await run(`/api/v1/view/${p.id}`, {}, vars));
    expect(gate.enter_url.startsWith(`${APP}/__content/${p.id}/__plinth/enter?`)).toBe(true);
    const enter = await run(gate.enter_url, {}, vars);
    expect(enter.headers.get("location")).toBe(`/__content/${p.id}/`);
    const sc = enter.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`Path=/__content/${p.id}/;`);
    const cookie = sc.split(";")[0] ?? "";
    const page = await run(`/__content/${p.id}/`, { headers: { Cookie: cookie } }, vars);
    expect(await page.text()).toBe(USER_HTML);
    const d = directives(page.headers.get("content-security-policy"));
    expect(d.get("sandbox")).toBeDefined();
    expect(d.get("sandbox")).not.toContain("allow-same-origin");
    expect(d.get("sandbox")).not.toContain("allow-top-navigation");
    // The path-scoped cookie for one artifact opens nothing under another's path.
    const cross = await run(`/__content/${other.id}/`, { headers: { Cookie: cookie } }, vars);
    expect(cross.status).toBe(302);
  });
});

describe("All state-changing app routes have CSRF protection", () => {
  // Escaping user text and sanitizing comment markdown belong to the comments workstream's tests.
  it("every unsafe /api/v1 route refuses a cookie request with a foreign Origin or without the CSRF header", async () => {
    const owner = await createUser();
    const pat = await createToken(owner.id);
    const { body: p } = await publish({ Authorization: `Bearer ${pat.token}` });
    const session = await browserSession(owner.id);
    const routes = unsafeRoutes().filter((r) => r.path.startsWith("/api/v1/"));
    expect(routes.length).toBeGreaterThan(8);
    const variants: [string, Record<string, string>][] = [
      ["foreign Origin, valid token", { ...session.headers, Origin: EVIL }],
      ["foreign Origin, no token", { Cookie: session.cookie, Origin: EVIL }],
      ["same Origin, no header", { Cookie: session.cookie, Origin: APP }],
      ["no Origin, wrong header", { Cookie: session.cookie, "x-plinth-csrf": "guess" }],
      [
        "no CSRF cookie",
        { Cookie: session.cookie.split(";")[0] ?? "", "x-plinth-csrf": CSRF, Origin: APP },
      ],
    ];
    for (const r of routes) {
      for (const [name, headers] of variants) {
        const res = await sendBody(
          r.method,
          r.path,
          { ...headers, "cf-connecting-ip": freshIp() },
          p.id,
        );
        const where = `${r.method} ${r.path} (${name})`;
        expect(res.status, where).toBe(403);
        expect((await json(res)).error.code, where).toBe("csrf");
      }
    }
    // Nothing changed.
    const row = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(row).toMatchObject({ title: "Test artifact", currentVersion: 1, deletedAt: null });
  });

  it("routes outside /api/v1 that take writes do not read cookies at all", async () => {
    const owner = await createUser();
    const session = await browserSession(owner.id);
    const routes = unsafeRoutes().filter((r) => !r.path.startsWith("/api/v1/"));
    expect(routes.map((r) => r.path)).toContain("/mcp");
    for (const r of routes) {
      const without = await sendBody(r.method, r.path, { Origin: EVIL }, "x");
      const withCookies = await sendBody(
        r.method,
        r.path,
        { ...session.headers, Origin: EVIL },
        "x",
      );
      expect(withCookies.status, `${r.method} ${r.path}`).toBe(without.status);
      expect(withCookies.status, `${r.method} ${r.path}`).not.toBe(200);
    }
  });

  it("the same request with the CSRF header from the app origin goes through (control)", async () => {
    const owner = await createUser();
    const pat = await createToken(owner.id);
    const { body: p } = await publish({ Authorization: `Bearer ${pat.token}` });
    const session = await browserSession(owner.id);
    const res = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PATCH",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed by owner" }),
    });
    expect(res.status).toBe(200);
  });

  it("bearer requests carry no ambient credentials and need no CSRF token", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, Origin: EVIL, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>v2</p>" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("Authorization is checked on every read and write, in one shared policy module, never only in the UI", () => {
  const artifactRoutes = () => {
    const seen = new Set<string>();
    return app.routes
      .filter((r) => r.path.startsWith("/api/v1/artifacts/:ref") && r.method !== "ALL")
      .filter((r) => {
        const k = `${r.method} ${r.path}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  };

  it("on an allowlist artifact, strangers get 403/404 and anonymous callers 401/403/404 on every artifact route", async () => {
    const owner = await agent();
    const listed = uniqueEmail("listed");
    const { body: p } = await publish(owner.auth, {
      html: USER_HTML,
      visibility: "allowlist",
      emails: [listed],
    });
    const stranger = await agent();
    const strangerSession = await browserSession(stranger.user.id);
    const routes = artifactRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const callers: [string, () => Record<string, string>, number[]][] = [
      ["stranger agent", () => ({ ...stranger.auth, "cf-connecting-ip": freshIp() }), [403, 404]],
      [
        "stranger session",
        () => ({ ...strangerSession.headers, "cf-connecting-ip": freshIp() }),
        [403, 404],
      ],
      ["anonymous", anonymousBrowser, [401, 403, 404]],
    ];
    for (const r of routes) {
      for (const [name, headers, allowed] of callers) {
        const res = await sendBody(r.method, r.path, headers(), p.id);
        const body = await res.text();
        const where = `${r.method} ${r.path} as ${name}`;
        expect(allowed, `${where}: ${res.status}`).toContain(res.status);
        expect(body, where).not.toContain(MARKER);
      }
    }
    await expectUnchanged(p.id, listed);
  });

  it("on an unlisted artifact, anyone may view, but strangers cannot write", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: USER_HTML });
    const stranger = await agent();
    const writes = artifactRoutes().filter(
      (r) => r.method !== "GET" && !r.path.endsWith("/report"),
    );
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const r of writes) {
      for (const [name, headers, allowed] of [
        ["stranger", { ...stranger.auth }, [403, 404]],
        ["anonymous", anonymousBrowser(), [401, 403, 404]],
      ] as const) {
        const res = await sendBody(r.method, r.path, headers, p.id);
        expect(
          allowed as readonly number[],
          `${r.method} ${r.path} as ${name}: ${res.status}`,
        ).toContain(res.status);
      }
    }
    await expectUnchanged(p.id, null, "unlisted");
  });

  it("agents are limited by their token scopes", async () => {
    const owner = await createUser();
    const write = await createToken(owner.id);
    const readOnly = await createToken(owner.id, { scopes: "artifacts:read" });
    const { body: p } = await publish({ Authorization: `Bearer ${write.token}` });
    const ro = { Authorization: `Bearer ${readOnly.token}` };
    expect((await call(`/api/v1/artifacts/${p.id}`, { headers: ro })).status).toBe(200);
    const res = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...ro, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>x</p>" }),
    });
    expect(res.status).toBe(403);
    const mcp = await mcpClient(readOnly.token);
    const r = (await mcp.callTool({
      name: "update_artifact",
      arguments: { id: p.id, html: "<p>x</p>" },
    })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    await mcp.close();
  });
});

async function expectUnchanged(id: string, listed: string | null, visibility = "allowlist") {
  const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
  expect(row).toMatchObject({
    title: "Test artifact",
    currentVersion: 1,
    visibility,
    deletedAt: null,
    takenDownAt: null,
  });
  const vs = await db().select().from(versions).where(eq(versions.artifactId, id)).all();
  expect(vs).toHaveLength(1);
  const grants = await db()
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.artifactId, id))
    .all();
  expect(grants.map((g) => g.email)).toEqual(listed ? [listed] : []);
  if (visibility !== "unlisted") {
    expect(await db().select().from(reports).where(eq(reports.artifactId, id)).all()).toEqual([]);
  }
}

describe("Rate limits on login codes, password attempts, publishes and comment creation", () => {
  // Covered here: password attempts and publishes (viewer codes in viewer.test.ts, reports in
  // reports.test.ts). Login codes belong to the accounts workstream, comments to the comments one.
  it("password attempts: the 11th attempt in an hour is refused even with the right password", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      visibility: "password",
      password: "correct horse",
    });
    const ip = freshIp();
    const attempt = (password: string, from = ip) =>
      call(`/api/v1/view/${p.id}/password`, {
        method: "POST",
        headers: { ...anonymousBrowser(), "cf-connecting-ip": from },
        body: JSON.stringify({ password }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt(`wrong-${i}`)).status).toBe(403);
    const blocked = await attempt("correct horse");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    // Another network is not affected.
    expect((await attempt("correct horse", freshIp())).status).toBe(200);
  });

  it("publishes per hour are capped by MAX_PUBLISHES_PER_HOUR, for new artifacts, updates and restores", async () => {
    const vars = { MAX_PUBLISHES_PER_HOUR: "3" };
    const a = await agent();
    const post = () =>
      run(
        "/api/v1/artifacts",
        {
          method: "POST",
          headers: { ...a.auth, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "t", html: "<p>x</p>" }),
        },
        vars,
      );
    const first = await post();
    const { id } = await json(first);
    expect(first.status).toBe(201);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const over = await post();
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe("rate_limited");
    const update = await run(
      `/api/v1/artifacts/${id}`,
      {
        method: "PUT",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<p>y</p>" }),
      },
      vars,
    );
    expect(update.status).toBe(429);
    const restore = await run(
      `/api/v1/artifacts/${id}/versions/1/restore`,
      { method: "POST", headers: { ...a.auth, "Content-Type": "application/json" }, body: "{}" },
      vars,
    );
    expect(restore.status).toBe(429);
  });
});

describe("Secrets never appear in logs, URLs (other than the one-time viewer token exchange) or client bundles", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("the viewer token travels only in the enter URL; the redirect and the page never carry it", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: USER_HTML });
    expect(JSON.stringify(p)).not.toContain(a.token);
    const gate = await json(await call(`/api/v1/view/${p.id}`));
    const token = new URL(gate.enter_url).searchParams.get("t") ?? "";
    expect(token.length).toBeGreaterThan(40);
    const enter = await call(gate.enter_url);
    const location = enter.headers.get("location") ?? "";
    expect(location).toBe("/");
    expect(location).not.toContain(token);
    const cookieValue = ((enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "").split("=")[1];
    expect(cookieValue).not.toBe(token);
    expect(enter.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await call(`${contentOrigin(p.id)}/`, {
      headers: { Cookie: `plinth_content=${cookieValue}` },
    });
    const all = `${await page.text()}${JSON.stringify([...page.headers])}`;
    expect(all).not.toContain(token);
  });

  it("cookies that prove access are HttpOnly, so artifact script cannot read them", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { visibility: "password", password: "secret99" });
    const pw = await call(`/api/v1/view/${p.id}/password`, {
      method: "POST",
      headers: anonymousBrowser(),
      body: JSON.stringify({ password: "secret99" }),
    });
    expect(pw.headers.get("set-cookie")).toMatch(/^plinth_pw_[a-z0-9]{20}=[^;]+;.*; HttpOnly;/);
    const enter = await call((await json(pw)).enter_url);
    expect(enter.headers.get("set-cookie")).toMatch(/; HttpOnly;/);
  });

  it("nothing secret is logged across publish, view, password, viewer codes, reports and errors", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "),
        );
      });
      spies.push(spy);
    }
    const a = await agent();
    const password = "pa55word-never-logged";
    const listed = uniqueEmail("log");
    const { body: p } = await publish(a.auth, { visibility: "password", password });
    const { body: q } = await publish(a.auth, { visibility: "allowlist", emails: [listed] });
    const pw = await call(`/api/v1/view/${p.id}/password`, {
      method: "POST",
      headers: anonymousBrowser(),
      body: JSON.stringify({ password }),
    });
    const gate = await json(pw);
    const token = new URL(gate.enter_url).searchParams.get("t") ?? "";
    const enter = await call(gate.enter_url);
    const contentCookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await call(`${contentOrigin(p.id)}/`, { headers: { Cookie: contentCookie } });
    const viewerHeaders = anonymousBrowser();
    await run(`/api/v1/view/${q.id}/email`, {
      method: "POST",
      headers: viewerHeaders,
      body: JSON.stringify({ email: listed }),
    });
    await run(`/api/v1/artifacts/${q.id}/report`, {
      method: "POST",
      headers: anonymousBrowser(),
      body: JSON.stringify({ reason: "x" }),
    });
    // An internal error on each host.
    const broken = { DB: brokenD1() };
    await run(`/api/v1/view/${p.id}`, {}, broken);
    await run(`${contentOrigin(p.id)}/`, { headers: { Cookie: contentCookie } }, broken);

    // The spy does see the Worker's logs (the console email provider logs in development).
    expect(lines.some((l) => l.includes("[email:console]"))).toBe(true);
    const log = lines.join("\n");
    const c = config();
    for (const secret of [
      c.sessionSecret,
      c.tokenSigningKey,
      a.token,
      password,
      token,
      contentCookie.split("=")[1] ?? "",
    ]) {
      expect(secret.length).toBeGreaterThan(5);
      expect(log).not.toContain(secret);
    }
  });

  it("the client bundle served by the app contains no server secret", async () => {
    // scripts/check-bundle-secrets.mjs scans apps/web/dist after a build; this checks what the
    // Worker actually serves when the bundle is present.
    const index = await call("/");
    const html = await index.text();
    const sources = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map(
      (m) => m[1] ?? "",
    );
    const c = config();
    const bodies = [html];
    for (const src of sources) bodies.push(await (await call(src)).text());
    for (const body of bodies) {
      for (const secret of [c.sessionSecret, c.tokenSigningKey, "plinth_pat_", "plinth_at_"]) {
        expect(body).not.toContain(secret);
      }
    }
  });
});

describe("Production refuses to run when the app and content hosts share a registrable domain", () => {
  const prod = {
    ENVIRONMENT: "production",
    PUBLIC_SCHEME: "https",
    EMAIL_PROVIDER: "sendgrid",
    SENDGRID_API_KEY: "SG.test-key-for-config",
    DEV_OUTBOX: "false",
  };

  it("parseConfig throws for a shared registrable domain", () => {
    const e = env as unknown as Record<string, unknown>;
    expect(() =>
      parseConfig({
        ...e,
        ...prod,
        APP_HOST: "plinth.example.com",
        CONTENT_HOST: "usercontent.example.com",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...e, ...prod, APP_HOST: "a.example.co.uk", CONTENT_HOST: "b.example.co.uk" }),
    ).toThrow(/registrable domain/);
  });

  it("every request gets a 500, on both hosts, without leaking configuration values", async () => {
    const vars = {
      ...prod,
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "usercontent.example.com",
    };
    const urls = [
      "https://plinth.example.com/healthz",
      "https://plinth.example.com/",
      "https://plinth.example.com/api/v1/config",
      "https://plinth.example.com/mcp",
      `https://${"b".repeat(20)}.usercontent.example.com/`,
      "https://usercontent.example.com/",
    ];
    for (const url of urls) {
      const res = await run(url, {}, vars);
      expect(res.status, url).toBe(500);
      const body = await res.text();
      expect(body, url).toMatch(/registrable domain/);
      expect(body, url).not.toContain(config().sessionSecret);
      expect(body, url).not.toContain("SG.test-key-for-config");
    }
  });

  it("separate registrable domains run (control)", async () => {
    const vars = { ...prod, APP_HOST: "plinth.example.com", CONTENT_HOST: "plinthcontent.net" };
    const res = await run("https://plinth.example.com/healthz", {}, vars);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, environment: "production" });
  });
});

/** A D1 binding whose every query fails, to exercise error paths. */
function brokenD1(): D1Database {
  const fail = () => {
    throw new Error("D1_ERROR: simulated failure");
  };
  return {
    prepare: fail,
    batch: fail,
    exec: fail,
    dump: fail,
    withSession: fail,
  } as unknown as D1Database;
}

describe("Error responses never include stack traces", () => {
  it("content host: a failure is a plain 500 with the content headers", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await run(`${contentOrigin(p.id)}/`, {}, { DB: brokenD1() });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("Something went wrong. Try again later.");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
  });

  it("app host: a failure is a generic JSON error", async () => {
    const res = await run("/api/v1/view/some-artifact", {}, { DB: brokenD1() });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(body).not.toMatch(/D1_ERROR|\bat\s+\S+\s+\(|\.ts:\d+/);
  });
});

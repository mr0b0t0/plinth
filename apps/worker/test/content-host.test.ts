// Gate and content-host hardening: the enter exchange, redirect targets, versions, paths, methods.
import { env } from "cloudflare:workers";
import { TTL } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveFilePath } from "../src/content/serve.ts";
import { safeNext } from "../src/content/tokens.ts";
import { artifacts } from "../src/db/schema.ts";
import { randomString, signToken } from "../src/lib/crypto.ts";
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

const enterWith = (id: string, token: string, next: string) =>
  call(
    `${contentOrigin(id)}/__plinth/enter?t=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`,
  );

async function freshToken(id: string, epoch = 1, extra: Record<string, unknown> = {}) {
  return signToken(config().tokenSigningKey, {
    k: "enter",
    a: id,
    e: epoch,
    n: randomString(24),
    exp: Date.now() + TTL.viewerTokenMs,
    ...extra,
  });
}

describe("safeNext keeps redirects on the artifact's own origin", () => {
  it.each([
    ["/", "/"],
    ["/page.html?x=1#top", "/page.html?x=1#top"],
    ["/__plinth/v/2/", "/__plinth/v/2/"],
    ["/a/../b", "/b"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ])("keeps %s", (input, out) => {
    expect(safeNext(input)).toBe(out);
  });

  it.each([
    "",
    "page.html",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r//evil.example",
    "/ /evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/\u0000x",
    `/${"a".repeat(3000)}`,
  ])("refuses %j", (input) => {
    expect(safeNext(input)).toBe("/");
  });

  it("refuses null and undefined", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("the enter exchange", () => {
  it("never redirects off the artifact's origin, whatever next says", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    for (const next of [
      "/\t/evil.example",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
    ]) {
      const res = await enterWith(p.id, await freshToken(p.id), next);
      expect(res.status, next).toBe(302);
      expect(res.headers.get("location"), next).toBe("/");
    }
    const ok = await enterWith(p.id, await freshToken(p.id), "/deep/page.html?q=1");
    expect(ok.headers.get("location")).toBe("/deep/page.html?q=1");
  });

  it("the gate cleans next too, and adds review mode after it", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const bad = await json(
      await call(`/api/v1/view/${p.id}?next=${encodeURIComponent("/\t/evil.example")}`),
    );
    expect(new URL(bad.enter_url).searchParams.get("next")).toBe("/");
    const review = await json(await call(`/api/v1/view/${p.id}?review=1&next=%2Fx.html%3Fa%3D1`));
    expect(new URL(review.enter_url).searchParams.get("next")).toBe("/x.html?a=1&plinth-review=1");
    const hashed = await json(await call(`/api/v1/view/${p.id}?review=1&next=%2Fx.html%23part`));
    expect(new URL(hashed.enter_url).searchParams.get("next")).toBe("/x.html?plinth-review=1#part");
    const version = await json(await call(`/api/v1/view/${p.id}?version=1`));
    expect(new URL(version.enter_url).searchParams.get("next")).toBe("/__plinth/v/1/");
    const beyond = await json(await call(`/api/v1/view/${p.id}?version=99`));
    expect(beyond.artifact.version).toBe(1);
  });

  it("refuses a token issued before access changed", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const gate = await json(await call(`/api/v1/view/${p.id}`));
    await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "password", password: "secret99" }),
    });
    const res = await call(gate.enter_url);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses tokens for deleted or taken-down artifacts", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { body: q } = await publish(a.auth);
    const gp = await json(await call(`/api/v1/view/${p.id}`));
    const gq = await json(await call(`/api/v1/view/${q.id}`));
    await call(`/api/v1/artifacts/${p.id}`, { method: "DELETE", headers: a.auth });
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, q.id))
      .run();
    expect((await call(gp.enter_url)).status).toBe(403);
    expect((await call(gq.enter_url)).status).toBe(403);
  });

  it("refuses expired, tampered and wrong-kind tokens", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const expired = await freshToken(p.id, 1, { exp: Date.now() - 1 });
    expect((await enterWith(p.id, expired, "/")).status).toBe(403);
    const good = await freshToken(p.id);
    const tampered = `${good.slice(0, -2)}${good.endsWith("A") ? "B" : "A"}A`;
    expect((await enterWith(p.id, tampered, "/")).status).toBe(403);
    const otherKey = await signToken("a-different-key-0123456789abcdef0123456789", {
      k: "enter",
      a: p.id,
      e: 1,
      n: randomString(24),
      exp: Date.now() + 60_000,
    });
    expect((await enterWith(p.id, otherKey, "/")).status).toBe(403);
    // A content cookie or a password pass is not an enter token.
    const { cookie } = await enterContent(p.id);
    const cookieValue = (cookie ?? "").split("=").slice(1).join("=");
    expect((await enterWith(p.id, cookieValue, "/")).status).toBe(403);
    const pwPass = await signToken(config().tokenSigningKey, {
      k: "pw",
      a: p.id,
      e: 1,
      exp: Date.now() + 60_000,
    });
    expect((await enterWith(p.id, pwPass, "/")).status).toBe(403);
    expect((await call(`${contentOrigin(p.id)}/__plinth/enter`)).status).toBe(403);
  });

  it("a token is single use even when two requests race", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const gate = await json(await call(`/api/v1/view/${p.id}`));
    const results = await Promise.all([
      call(gate.enter_url),
      call(gate.enter_url),
      call(gate.enter_url),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 403, 403]);
  });
});

describe("serving files", () => {
  it("sends the browser to the app gate with the path and query it asked for", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const res = await call(`${contentOrigin(p.id)}/page.html?a=1&b=2`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${APP}/open/${p.id}?next=${encodeURIComponent("/page.html?a=1&b=2")}`,
    );
  });

  it("HEAD answers like GET without a body; other methods get 405", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<p>head</p>" });
    const { cookie } = await enterContent(p.id);
    const head = await call(`${contentOrigin(p.id)}/`, {
      method: "HEAD",
      headers: { Cookie: cookie ?? "" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("etag")).toBeTruthy();
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await call(`${contentOrigin(p.id)}/`, {
        method,
        headers: { Cookie: cookie ?? "" },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
    }
  });

  it("serves directories' index.html, old versions by path, and nothing under the reserved prefix", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      html: "<p>one</p>",
      assets: [{ path: "docs/index.html", content: "<p>docs</p>" }],
    });
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>two</p>" }),
    });
    const { cookie } = await enterContent(p.id);
    const get = (path: string) =>
      call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } });
    expect(await (await get("/docs/")).text()).toBe("<p>docs</p>");
    expect(await (await get("/__plinth/v/1/")).text()).toBe("<p>one</p>");
    expect(await (await get("/")).text()).toBe("<p>two</p>");
    const slash = await get("/__plinth/v/1?x=1");
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe("/__plinth/v/1/?x=1");
    expect((await get("/__plinth/enter-not")).status).toBe(404);
    expect((await get("/__plinth/v/3/")).status).toBe(404);
    expect((await get("/__plinth/v/0/")).status).toBe(404);
  });

  it("a taken-down artifact serves nothing, even with a cookie issued before", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { cookie } = await enterContent(p.id);
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, p.id))
      .run();
    const res = await call(`${contentOrigin(p.id)}/__plinth/v/1/`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(res.status).toBe(404);
  });

  it("noindex unless the artifact is public on an instance that allows public visibility", async () => {
    const { createExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/index.ts")).default;
    const a = await agent();
    const { body: p } = await publish(a.auth);
    await db().update(artifacts).set({ visibility: "public" }).where(eq(artifacts.id, p.id)).run();
    const { cookie } = await enterContent(p.id);
    const get = (vars: Record<string, string>) =>
      worker.fetch(
        new Request(`${contentOrigin(p.id)}/`, { headers: { Cookie: cookie ?? "" } }),
        { ...env, ...vars } as never,
        createExecutionContext(),
      );
    const off = await get({});
    expect(off.status).toBe(200);
    expect(off.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const on = await get({ ALLOW_PUBLIC_VISIBILITY: "true" });
    expect(on.status).toBe(200);
    expect(on.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("resolveFilePath", () => {
  it.each([
    ["/", "index.html"],
    ["/a.css", "a.css"],
    ["/img/dot.png", "img/dot.png"],
    ["/docs/", "docs/index.html"],
    ["/my%20file.txt", "my file.txt"],
  ])("maps %s to %s", (input, out) => {
    expect(resolveFilePath(input)).toBe(out);
  });

  it.each([
    "/../x",
    "/a/../../x",
    "/a/%2e%2e/x",
    "/..%2fx",
    "/%2e%2e%2fx",
    "/a%5c..%5cx",
    "/a\\..\\x",
    "//x",
    "/a//b",
    "/./a",
    "/a%00.html",
    "/%",
    "/%E0%A4%A",
    "/__plinth/v/1/x",
    "/%5F%5Fplinth/x",
    "x",
  ])("refuses %j", (input) => {
    expect(resolveFilePath(input)).toBeNull();
  });
});

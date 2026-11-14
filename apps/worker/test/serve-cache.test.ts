// Serving cost and caching on the content host: the in-isolate version cache, strong sha256 ETags
// answered with a 304 only after every access check and without touching R2, immutable caching
// for versioned non-HTML files only, opaque isolation unchanged, and stored_at confined to the
// artifact's own prefix.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { IMMUTABLE_CACHE } from "../src/content/serve.ts";
import { clearVersionCache, versionCacheStats } from "../src/content/versionCache.ts";
import { artifacts, versions } from "../src/db/schema.ts";
import { fileKey } from "../src/services/storage.ts";
import {
  agent,
  call,
  contentOrigin,
  db,
  enterContent,
  fetchWith,
  json,
  manifestOf,
  publish,
  sha256Of,
  spy,
  versionRow,
} from "./helpers.ts";

const CSS = "h1{color:red}";

async function seed(extra: Record<string, unknown> = {}) {
  const a = await agent();
  const { body: p } = await publish(a.auth, {
    assets: [{ path: "style.css", content: CSS }],
    ...extra,
  });
  const { cookie } = await enterContent(p.id);
  return { a, p, cookie: cookie ?? "" };
}

/** A content request through the Worker with spied bindings (and optional vars). */
async function content(
  id: string,
  path: string,
  headers: Record<string, string>,
  vars: Record<string, string> = {},
) {
  const files = spy(env.FILES);
  const d1 = spy(env.DB);
  const res = await fetchWith(
    { FILES: files.proxy, DB: d1.proxy, ...vars },
    `${contentOrigin(id)}${path}`,
    {
      headers,
    },
  );
  const sql = d1.calls.filter((c) => c.method === "prepare").map((c) => String(c.arg));
  return { res, r2: files.calls.map((c) => c.method), sql };
}

const versionQueries = (sql: string[]) => sql.filter((s) => /from "versions"/i.test(s));

beforeEach(() => clearVersionCache());

describe("the version cache", () => {
  it("serves a second request without a version-row query, but still reads the artifact row", async () => {
    const { p, cookie } = await seed();
    const first = await content(p.id, "/style.css", { Cookie: cookie });
    expect(first.res.status).toBe(200);
    expect(versionQueries(first.sql)).toHaveLength(1);
    const second = await content(p.id, "/style.css", { Cookie: cookie });
    expect(second.res.status).toBe(200);
    expect(await second.res.text()).toBe(CSS);
    expect(versionQueries(second.sql)).toHaveLength(0);
    // Access is never cached: the artifact row is read on every request.
    expect(second.sql.some((s) => /from "artifacts"/i.test(s))).toBe(true);
    expect(versionCacheStats().entries).toBeGreaterThan(0);
  });

  it("never serves a version the artifact row does not publish, cached or not", async () => {
    const { a, p, cookie } = await seed();
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>" }),
    });
    expect((await content(p.id, "/__plinth/v/2/", { Cookie: cookie })).res.status).toBe(200);
    // Taken down: the cached version is unreachable.
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, p.id))
      .run();
    expect((await content(p.id, "/__plinth/v/2/", { Cookie: cookie })).res.status).toBe(404);
  });
});

describe("ETag and 304", () => {
  it("sends a strong ETag from the manifest's sha256 and answers a match with a 304 and no R2 call", async () => {
    const { p, cookie } = await seed();
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    const first = await content(p.id, "/style.css", { Cookie: cookie });
    expect(first.res.headers.get("etag")).toBe(etag);
    expect(first.res.headers.get("cache-control")).toBe("private, no-cache");
    // The spy sees R2 calls: a plain 200 is one GET.
    expect(first.r2).toEqual(["get"]);

    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const again = await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": inm });
      expect(again.res.status, inm).toBe(304);
      expect(again.r2, inm).toEqual([]);
      expect(await again.res.text()).toBe("");
      // The 304 carries the same security headers as the 200.
      for (const h of [
        "content-security-policy",
        "x-content-type-options",
        "cross-origin-resource-policy",
        "referrer-policy",
        "permissions-policy",
      ]) {
        expect(again.res.headers.get(h), h).toBe(first.res.headers.get(h));
      }
      expect(again.res.headers.get("etag")).toBe(etag);
    }
    const stale = await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": '"nope"' });
    expect(stale.res.status).toBe(200);
    expect(await stale.res.text()).toBe(CSS);
  });

  it("checks access before any 304: an old cookie after a change, or none, never gets one", async () => {
    const { a, p, cookie } = await seed();
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    expect(
      (await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": etag })).res.status,
    ).toBe(304);
    // Revoked: a visibility change bumps the access epoch, which ends every content cookie.
    const vis = await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "allowlist" }),
    });
    expect(vis.status).toBe(200);
    const framed = await content(p.id, "/style.css", {
      Cookie: cookie,
      "If-None-Match": etag,
      "Sec-Fetch-Dest": "iframe",
    });
    expect(framed.res.status).toBe(401);
    expect(framed.r2).toEqual([]);
    const plain = await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": etag });
    expect(plain.res.status).toBe(302);
    const none = await content(p.id, "/style.css", { "If-None-Match": etag });
    expect(none.res.status).toBe(302);
  });

  it("a takedown answers 404, not 304", async () => {
    const { p, cookie } = await seed();
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, p.id))
      .run();
    const r = await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": etag });
    expect(r.res.status).toBe(404);
  });

  it("is never cross-artifact: another artifact's cookie with the same bytes' ETag gets no 304", async () => {
    const one = await seed();
    const two = await seed();
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    const r = await content(two.p.id, "/style.css", { Cookie: one.cookie, "If-None-Match": etag });
    expect(r.res.status).toBe(302);
    const own = await content(two.p.id, "/style.css", {
      Cookie: two.cookie,
      "If-None-Match": etag,
    });
    expect(own.res.status).toBe(304);
  });

  it("a file stored before hashes keeps R2's ETag and revalidates with one HEAD", async () => {
    const { p, cookie } = await seed();
    const v1 = await versionRow(p.id, 1);
    const entries = (await manifestOf(p.id, 1)).map(({ sha256: _s, ...rest }) => rest);
    await db()
      .update(versions)
      .set({ manifest: JSON.stringify(entries) })
      .where(eq(versions.id, v1?.id ?? ""))
      .run();
    const first = await content(p.id, "/style.css", { Cookie: cookie });
    const etag = first.res.headers.get("etag") ?? "";
    expect(etag).not.toMatch(/sha256-/);
    expect(etag).toBeTruthy();
    const again = await content(p.id, "/style.css", { Cookie: cookie, "If-None-Match": etag });
    expect(again.res.status).toBe(304);
    expect(again.r2).toEqual(["head"]);
  });

  it("review-mode HTML has no ETag and is never answered with a 304", async () => {
    const { p, cookie } = await seed();
    const plain = await content(p.id, "/", { Cookie: cookie });
    const etag = plain.res.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"sha256-/);
    const review = await content(p.id, "/?plinth-review", {
      Cookie: cookie,
      "If-None-Match": etag,
    });
    expect(review.res.status).toBe(200);
    expect(review.res.headers.get("etag")).toBeNull();
    expect(review.res.headers.get("cache-control")).toBe("private, no-cache");
  });
});

describe("Cache-Control", () => {
  it("immutable only for versioned non-HTML files; HTML and current paths stay no-cache; never public", async () => {
    const { p, cookie } = await seed({
      assets: [
        { path: "style.css", content: CSS },
        { path: "page.html", content: "<p>p</p>" },
      ],
    });
    const cc = async (path: string) =>
      (await content(p.id, path, { Cookie: cookie })).res.headers.get("cache-control");
    expect(await cc("/__plinth/v/1/style.css")).toBe(IMMUTABLE_CACHE);
    expect(await cc("/__plinth/v/1/")).toBe("private, no-cache");
    expect(await cc("/__plinth/v/1/page.html")).toBe("private, no-cache");
    expect(await cc("/style.css")).toBe("private, no-cache");
    expect(await cc("/")).toBe("private, no-cache");
    for (const path of ["/__plinth/v/1/style.css", "/style.css", "/", "/nope.css"]) {
      expect(await cc(path), path).not.toMatch(/public/);
    }
    // A 304 on a versioned file keeps the immutable policy.
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    const r = await content(p.id, "/__plinth/v/1/style.css", {
      Cookie: cookie,
      "If-None-Match": etag,
    });
    expect(r.res.status).toBe(304);
    expect(r.res.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
  });

  it("opaque isolation is unchanged: R2's ETag, no-cache everywhere, no early 304", async () => {
    const { p, cookie } = await seed();
    const opaque = { CONTENT_ISOLATION: "opaque" };
    const r = await content(p.id, "/__plinth/v/1/style.css", { Cookie: cookie }, opaque);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("private, no-cache");
    expect(r.res.headers.get("etag")).not.toMatch(/sha256-/);
    expect(r.res.headers.get("content-security-policy")).toMatch(/sandbox allow-scripts/);
    const etag = `"sha256-${await sha256Of(CSS)}"`;
    const again = await content(
      p.id,
      "/__plinth/v/1/style.css",
      { Cookie: cookie, "If-None-Match": etag },
      opaque,
    );
    expect(again.res.status).toBe(200);
  });
});

describe("stored_at is confined to the artifact", () => {
  it("a tampered stored_at or prefix gives 404, never another object", async () => {
    const { a, p, cookie } = await seed();
    const other = await seed();
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>" }),
    });
    const v2 = await versionRow(p.id, 2);
    const good = await manifestOf(p.id, 2);
    const original = good.find((e) => e.path === "style.css")?.stored_at ?? "";
    expect(original).toMatch(/^v1\.[a-z0-9]{12}\/style\.css$/);
    const otherV1 = await versionRow(other.p.id, 1);
    const otherRel = (otherV1?.r2Prefix ?? "").slice(`artifacts/${other.p.id}/`.length);
    const tamper = async (storedAt: string, r2Prefix = v2?.r2Prefix ?? "") => {
      const m = good.map((e) => (e.path === "style.css" ? { ...e, stored_at: storedAt } : e));
      await db()
        .update(versions)
        .set({ manifest: JSON.stringify(m), r2Prefix })
        .where(eq(versions.id, v2?.id ?? ""))
        .run();
      clearVersionCache();
      return (await content(p.id, "/style.css", { Cookie: cookie })).res.status;
    };
    expect(await tamper(original)).toBe(200);
    for (const bad of [
      "v1/../style.css",
      "v1//style.css",
      "v1/./style.css",
      "v3/style.css",
      "v0/style.css",
      `../${other.p.id}/${otherRel}style.css`,
      `${otherRel}style.css/../../../${other.p.id}/${otherRel}style.css`,
      "",
    ]) {
      expect(await tamper(bad), bad).toBe(404);
    }
    // A version row whose prefix names another artifact serves nothing of either.
    expect(await tamper(original, otherV1?.r2Prefix ?? "")).toBe(404);
    expect(() =>
      fileKey(
        p.id,
        { number: 2, r2Prefix: `artifacts/${p.id}/` },
        { path: "x", size_bytes: 1, content_type: "x" },
      ),
    ).toThrow();
  });

  it("stored_at never appears in the API's output", async () => {
    const { a, p } = await seed();
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>" }),
    });
    expect((await manifestOf(p.id, 2)).some((e) => e.stored_at)).toBe(true);
    for (const path of [
      `/api/v1/artifacts/${p.id}`,
      `/api/v1/artifacts/${p.id}/versions/2`,
      `/api/v1/artifacts/${p.id}/versions`,
      "/api/v1/artifacts",
    ]) {
      const text = await (await call(path, { headers: a.auth })).text();
      expect(text, path).not.toContain("stored_at");
      expect(text, path).not.toMatch(/v1\.[a-z0-9]{12}\//);
    }
    const detail = await json(await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth }));
    expect(Object.keys(detail.assets[0]).sort()).toEqual([
      "content_type",
      "path",
      "sha256",
      "size_bytes",
    ]);
  });
});

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../src/db/schema.ts";
import { updateArtifact } from "../src/services/artifacts.ts";
import {
  APP,
  agent,
  agentPrincipal,
  browserSession,
  call,
  db,
  json,
  manifestOf,
  publish,
  serviceCtxFor,
  storedFile,
  versionRow,
} from "./helpers.ts";

const MB = 1024 * 1024;

/** POST /api/v1/artifacts against the Worker with some env vars over the test env. */
async function publishWith(
  auth: Record<string, string>,
  vars: Record<string, string>,
  body: Record<string, unknown>,
) {
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const worker = (await import("../src/index.ts")).default;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${APP}/api/v1/artifacts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test artifact",
        html: "<!doctype html><h1>Hello</h1>",
        visibility: "unlisted",
        ...body,
      }),
    }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, body: await json(res) };
}

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("artifacts over REST", () => {
  it("publishes version 1 and stores its files under the version's own prefix", async () => {
    const a = await agent();
    const { res, body } = await publish(a.auth, {
      assets: [
        { path: "style.css", content: "h1{color:red}" },
        { path: "img/dot.png", content: "iVBORw0KGgo=", encoding: "base64" },
      ],
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ version: 1, visibility: "unlisted" });
    expect(body.id).toMatch(/^[a-z0-9]{20}$/);
    expect(body.url).toBe(`http://app.localhost:8787/a/${body.slug}`);
    expect(body.content_url).toBe(`http://${body.id}.content.localhost:8787/`);
    expect(await (await storedFile(body.id, 1, "index.html"))?.text()).toContain("Hello");
    expect(await storedFile(body.id, 1, "img/dot.png")).not.toBeNull();
    // New versions are written under a unique per-attempt prefix, and a first version owns every
    // object it lists (nothing to reuse yet).
    const v1 = await versionRow(body.id, 1);
    expect(v1?.r2Prefix).toMatch(new RegExp(`^artifacts/${body.id}/v1\\.[a-z0-9]{12}/$`));
    expect(await env.FILES.get(`${v1?.r2Prefix}index.html`)).not.toBeNull();
    expect((await manifestOf(body.id, 1)).every((e) => e.stored_at === undefined)).toBe(true);
    expect(body.stored).toMatchObject({ files: 3, written: 3, reused: 0 });
  });

  it("update creates a new immutable version and keeps assets when omitted", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "a.css", content: "x" }] });
    const res = await put(a.auth, p.id, { html: "<p>v2</p>", note: "second" });
    expect(res.status).toBe(200);
    expect((await json(res)).version).toBe(2);
    expect(await (await storedFile(p.id, 1, "index.html"))?.text()).toContain("Hello");
    expect(await (await storedFile(p.id, 2, "index.html"))?.text()).toBe("<p>v2</p>");
    expect(await (await storedFile(p.id, 2, "a.css"))?.text()).toBe("x");
    const get = await json(await call(`/api/v1/artifacts/${p.slug}`, { headers: a.auth }));
    expect(get).toMatchObject({
      version: 2,
      html: "<p>v2</p>",
      current_version: 2,
      version_count: 2,
    });
    const v1 = await json(await call(`/api/v1/artifacts/${p.id}/versions/1`, { headers: a.auth }));
    expect(v1.html).toContain("Hello");
    const versions = await json(
      await call(`/api/v1/artifacts/${p.id}/versions`, { headers: a.auth }),
    );
    expect(versions.items.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(versions.items[0]).toMatchObject({
      note: "second",
      author: { kind: "connection", label: "Test token" },
    });
  });

  it("rejects a stale base_version with a conflict and does not overwrite", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    expect((await put(a.auth, p.id, { html: "<p>2</p>", base_version: 1 })).status).toBe(200);
    const stale = await put(a.auth, p.id, { html: "<p>stale</p>", base_version: 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({
      code: "conflict",
      details: { current_version: 2 },
    });
    const get = await json(await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth }));
    expect(get.html).toBe("<p>2</p>");
  });

  it("concurrent updates with the same base_version have exactly one winner", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => put(a.auth, p.id, { html: `<p>${i}</p>`, base_version: 1 })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it("restore publishes the old content as the next version", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { html: "<p>one</p>" });
    await put(a.auth, p.id, { html: "<p>two</p>" });
    const r = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: a.auth,
    });
    expect(r.status).toBe(201);
    expect((await json(r)).version).toBe(3);
    const get = await json(await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth }));
    expect(get).toMatchObject({ version: 3, html: "<p>one</p>" });
    const versions = await json(
      await call(`/api/v1/artifacts/${p.id}/versions`, { headers: a.auth }),
    );
    expect(versions.items[0]).toMatchObject({
      number: 3,
      restored_from: 1,
      note: "Restored from v1",
    });
    expect(versions.items).toHaveLength(3);
  });

  it("enforces size limits", async () => {
    const a = await agent();
    const big = await publish(a.auth, { html: "x".repeat(5 * 1024 * 1024 + 1) });
    expect(big.res.status).toBe(413);
    // MAX_VERSION_BYTES set low, so the per-version total is reached well under the body limit.
    const total = await publishWith(
      a.auth,
      { MAX_VERSION_BYTES: String(2 * MB) },
      {
        assets: Array.from({ length: 3 }, (_, i) => ({
          path: `f${i}.txt`,
          content: "y".repeat(0.9 * MB),
        })),
      },
    );
    expect(total.res.status).toBe(413);
    expect(total.body.error).toMatchObject({
      code: "payload_too_large",
      details: { limit_bytes: 2 * MB },
    });
  });

  it("enforces MAX_ASSETS_PER_VERSION", async () => {
    const a = await agent();
    const assets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    const vars = { MAX_ASSETS_PER_VERSION: "3" };
    expect((await publishWith(a.auth, vars, { assets: assets(3) })).res.status).toBe(201);
    const over = await publishWith(a.auth, vars, { assets: assets(4) });
    expect(over.res.status).toBe(413);
    expect(over.body.error).toMatchObject({
      code: "payload_too_large",
      details: { limit: 3, count: 4 },
    });
  });

  it("rejects bad asset paths", async () => {
    const a = await agent();
    for (const path of ["../x.css", "/abs.css", "__plinth/x.js", "a/../../b", "index.html"]) {
      const r = await publish(a.auth, { assets: [{ path, content: "x" }] });
      expect(r.res.status, path).toBe(400);
    }
  });

  it("enforces the quota: env default, and a per-user override", async () => {
    const a = await agent();
    await db().update(users).set({ artifactLimit: 2 }).where(eq(users.id, a.user.id)).run();
    expect((await publish(a.auth)).res.status).toBe(201);
    expect((await publish(a.auth)).res.status).toBe(201);
    const third = await publish(a.auth);
    expect(third.res.status).toBe(403);
    expect(third.body.error).toMatchObject({ code: "quota_exceeded", details: { limit: 2 } });
    const me = await json(await call("/api/v1/me", { headers: a.auth }));
    expect(me).toMatchObject({ artifact_limit: 2, artifact_count: 2 });
    const b = await agent();
    const meB = await json(await call("/api/v1/me", { headers: b.auth }));
    expect(meB.artifact_limit).toBe(100);
  });

  it("deleting frees quota and makes the artifact not found", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    expect(
      (await call(`/api/v1/artifacts/${p.id}`, { method: "DELETE", headers: a.auth })).status,
    ).toBe(204);
    expect((await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth })).status).toBe(404);
  });

  it("another user cannot read or update an unlisted artifact through the API", async () => {
    const a = await agent();
    const b = await agent();
    const { body: p } = await publish(a.auth, { visibility: "allowlist" });
    expect((await call(`/api/v1/artifacts/${p.id}`, { headers: b.auth })).status).toBe(404);
    expect((await put(b.auth, p.id, { html: "<p>x</p>" })).status).toBe(404);
    const { body: u } = await publish(a.auth);
    // Unlisted: readable by anyone with the link, but not editable.
    expect((await call(`/api/v1/artifacts/${u.id}`, { headers: b.auth })).status).toBe(200);
    expect((await put(b.auth, u.id, { html: "<p>x</p>" })).status).toBe(403);
  });

  it("lists only the caller's artifacts (and shared ones), with search", async () => {
    const a = await agent();
    const b = await agent();
    await publish(a.auth, { title: "Quarterly chart" });
    await publish(a.auth, { title: "Other thing" });
    await publish(b.auth, { title: "Quarterly secret" });
    const all = await json(await call("/api/v1/artifacts", { headers: a.auth }));
    expect(all.items).toHaveLength(2);
    const q = await json(await call("/api/v1/artifacts?query=quarterly", { headers: a.auth }));
    expect(q.items.map((x: { title: string }) => x.title)).toEqual(["Quarterly chart"]);
  });

  it("set_visibility with password and allowlist", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const noPw = await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "password" }),
    });
    expect(noPw.status).toBe(400);
    const ok = await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "allowlist", emails: ["Friend@Example.com"] }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).visibility).toBe("allowlist");
  });

  it("public visibility is refused unless the instance enables it", async () => {
    const a = await agent();
    const r = await publish(a.auth, { visibility: "public" });
    expect(r.res.status).toBe(403);
    expect(r.body.error.code).toBe("feature_disabled");
  });

  it("requires auth, and rejects revoked or unknown tokens", async () => {
    expect((await call("/api/v1/artifacts")).status).toBe(401);
    expect(
      (await call("/api/v1/artifacts", { headers: { Authorization: "Bearer plinth_pat_nope" } }))
        .status,
    ).toBe(401);
  });

  it("cookie-authenticated writes need the CSRF header", async () => {
    const a = await agent();
    const s = await browserSession(a.user.id);
    const body = JSON.stringify({ title: "t", html: "<p>x</p>" });
    const noCsrf = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { Cookie: s.cookie, "Content-Type": "application/json" },
      body,
    });
    expect(noCsrf.status).toBe(403);
    expect((await json(noCsrf)).error.code).toBe("csrf");
    const crossOrigin = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { ...s.headers, Origin: "http://evil.example", "Content-Type": "application/json" },
      body,
    });
    expect(crossOrigin.status).toBe(403);
    const ok = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body,
    });
    expect(ok.status).toBe(201);
    const versions = await json(
      await call(`/api/v1/artifacts/${(await json(ok)).id}/versions`, { headers: s.headers }),
    );
    expect(versions.items[0].author.kind).toBe("user");
  });
});

// Categories (docs/spec.md "Categories"): agents set one when they publish, and every write snaps
// the name onto the owner's existing spelling.
describe("categories on publish, update and list", () => {
  type ListBody = {
    items: { id: string; category: string | null }[];
    categories: { name: string; count: number }[];
  };
  const list = async (auth: Record<string, string>, params = "") => {
    const r = await call(`/api/v1/artifacts${params}`, { headers: auth });
    expect(r.status).toBe(200);
    return json<ListBody>(r);
  };
  const storedCategory = async (id: string) =>
    (
      await env.DB.prepare("SELECT category FROM artifacts WHERE id = ?")
        .bind(id)
        .first<{ category: string | null }>()
    )?.category;

  it("publish stores the name, echoes it, and snaps a near-duplicate onto the first spelling", async () => {
    const a = await agent();
    const first = await publish(a.auth, { category: "  acme-site " });
    expect(first.res.status).toBe(201);
    expect(first.body.category).toBe("acme-site");
    expect(await storedCategory(first.body.id)).toBe("acme-site");
    for (const spelling of ["Acme Site", "ACME_site", "acme   site"]) {
      const next = await publish(a.auth, { category: spelling });
      expect(next.body.category, spelling).toBe("acme-site");
    }
    // "." is not folded: a different name.
    const other = await publish(a.auth, { category: "acme.site" });
    expect(other.body.category).toBe("acme.site");
    const { categories } = await list(a.auth);
    expect(categories).toEqual([
      { name: "acme-site", count: 4 },
      { name: "acme.site", count: 1 },
    ]);
  });

  it("an omitted category is null and not echoed; a bad name is 400 with field category", async () => {
    const a = await agent();
    const plain = await publish(a.auth);
    expect(plain.body).not.toHaveProperty("category");
    expect(await storedCategory(plain.body.id)).toBeNull();
    for (const bad of ["a\u202Eb", "zero\u200Bwidth", "bell\u0007"]) {
      const r = await publish(a.auth, { category: bad });
      expect(r.res.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error).toMatchObject({ code: "invalid_input", details: { field: "category" } });
      expect(JSON.stringify(r.body)).not.toContain(bad);
    }
    // Line breaks and line or paragraph separators are whitespace: they fold into one space.
    const folded = await publish(a.auth, { category: "line\u2028sep\nnext" });
    expect(folded.body.category).toBe("line sep next");
    // Empty and too long are refused by the schema, on the category field.
    for (const bad of ["   ", "x".repeat(61)]) {
      const r = await publish(a.auth, { category: bad });
      expect(r.res.status).toBe(400);
      expect(r.body.error.details.issues[0].path).toEqual(["category"]);
    }
    expect((await list(a.auth)).items).toHaveLength(2);
  });

  it("categories counts live artifacts, most-used first, whatever the query; deleted ones drop out", async () => {
    const a = await agent();
    const b1 = await publish(a.auth, { title: "Beta one", category: "Beta" });
    await publish(a.auth, { title: "Beta two", category: "Beta" });
    await publish(a.auth, { title: "Alpha one", category: "Alpha" });
    await publish(a.auth, { title: "Loose" });
    const expected = [
      { name: "Beta", count: 2 },
      { name: "Alpha", count: 1 },
    ];
    expect((await list(a.auth)).categories).toEqual(expected);
    const none = await list(a.auth, "?query=no-such-title");
    expect(none.items).toEqual([]);
    expect(none.categories).toEqual(expected);
    expect(
      (await call(`/api/v1/artifacts/${b1.body.id}`, { method: "DELETE", headers: a.auth })).status,
    ).toBe(204);
    expect((await list(a.auth)).categories).toEqual([
      { name: "Alpha", count: 1 },
      { name: "Beta", count: 1 },
    ]);
  });

  it("the category filter matches by key and keeps the categories list whole", async () => {
    const a = await agent();
    const one = await publish(a.auth, { category: "Client Work" });
    const two = await publish(a.auth, { category: "client-work" });
    await publish(a.auth, { category: "Other" });
    await publish(a.auth);
    const r = await list(a.auth, `?category=${encodeURIComponent("CLIENT_WORK")}`);
    expect(r.items.map((i) => i.id).sort()).toEqual([one.body.id, two.body.id].sort());
    expect(r.items.every((i) => i.category === "Client Work")).toBe(true);
    expect(r.categories).toHaveLength(2);
    const nothing = await list(a.auth, "?category=Nope");
    expect(nothing.items).toEqual([]);
    expect(nothing.categories).toHaveLength(2);
    // Filters compose with the title query.
    expect((await list(a.auth, "?category=Other&query=no-such")).items).toEqual([]);
    // An empty filter is no filter.
    expect((await list(a.auth, "?category=")).items).toHaveLength(4);
  });

  it("the owner sets it with update_artifact (PUT), and respelling a one-artifact category works", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { category: "acme" });
    const up = await put(a.auth, p.id, { html: "<p>v2</p>", base_version: 1, category: "Acme" });
    expect(up.status).toBe(200);
    const out = await json(up);
    expect(out).toMatchObject({ version: 2, category: "Acme" });
    expect(await storedCategory(p.id)).toBe("Acme");
    // Leaving it out keeps it, and the result does not echo it.
    const keep = await json(await put(a.auth, p.id, { html: "<p>v3</p>", base_version: 2 }));
    expect(keep).not.toHaveProperty("category");
    expect(await storedCategory(p.id)).toBe("Acme");
    // With another artifact in "Acme", a new spelling snaps onto it.
    const { body: q } = await publish(a.auth);
    const snapped = await json(await put(a.auth, q.id, { html: "<p>q2</p>", category: "ACME" }));
    expect(snapped.category).toBe("Acme");
  });

  it("a stale base_version is 409 and leaves the category unchanged", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { category: "Before" });
    expect((await put(a.auth, p.id, { html: "<p>v2</p>", base_version: 1 })).status).toBe(200);
    const stale = await put(a.auth, p.id, { html: "<p>x</p>", base_version: 1, category: "After" });
    expect(stale.status).toBe(409);
    expect(await storedCategory(p.id)).toBe("Before");
    expect((await list(a.auth)).categories).toEqual([{ name: "Before", count: 1 }]);
  });

  it("a failed commit leaves the category unchanged", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { category: "Before" });
    const DB = new Proxy(env.DB, {
      get(t, prop) {
        if (prop === "batch") {
          return async () => {
            throw new Error("injected: batch failed");
          };
        }
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB } });
    await expect(
      updateArtifact(ctx, { id: p.id, html: "<p>lost</p>", category: "After" }),
    ).rejects.toThrow(/injected/);
    expect(await storedCategory(p.id)).toBe("Before");
    expect(await versionRow(p.id, 2)).toBeFalsy();
  });
});

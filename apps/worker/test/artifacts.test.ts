import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../src/db/schema.ts";
import { agent, browserSession, call, db, json, publish } from "./helpers.ts";

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("artifacts over REST", () => {
  it("publishes version 1 with unlisted default and stores files in R2", async () => {
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
    expect(await (await env.FILES.get(`artifacts/${body.id}/v1/index.html`))?.text()).toContain(
      "Hello",
    );
    expect(await env.FILES.get(`artifacts/${body.id}/v1/img/dot.png`)).not.toBeNull();
  });

  it("update creates a new immutable version and keeps assets when omitted", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "a.css", content: "x" }] });
    const res = await put(a.auth, p.id, { html: "<p>v2</p>", note: "second" });
    expect(res.status).toBe(200);
    expect((await json(res)).version).toBe(2);
    expect(await (await env.FILES.get(`artifacts/${p.id}/v1/index.html`))?.text()).toContain(
      "Hello",
    );
    expect(await (await env.FILES.get(`artifacts/${p.id}/v2/index.html`))?.text()).toBe(
      "<p>v2</p>",
    );
    expect(await (await env.FILES.get(`artifacts/${p.id}/v2/a.css`))?.text()).toBe("x");
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
    const total = await publish(a.auth, {
      assets: Array.from({ length: 6 }, (_, i) => ({
        path: `f${i}.txt`,
        content: "y".repeat(4.5 * 1024 * 1024),
      })),
    });
    expect(total.res.status).toBe(413);
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

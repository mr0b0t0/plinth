// GET /api/v1/categories and the session-only POST /api/v1/categories/rename (docs/spec.md
// "Categories"): the caller's own names only, and renaming, merging or clearing in bulk is the
// signed-in owner's alone, never a bearer token's.
import { env } from "cloudflare:workers";
import { COOKIES, CSRF_HEADER, LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { APP, agent, browserSession, call, createToken, json, publish } from "./helpers.ts";

const stored = async (id: string) =>
  (await env.DB.prepare("SELECT category, updated_at FROM artifacts WHERE id = ?")
    .bind(id)
    .first<{ category: string | null; updated_at: string }>()) ?? null;

const rename = (headers: Record<string, string>, body: unknown) =>
  call("/api/v1/categories/rename", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const categories = async (headers: Record<string, string>) => {
  const r = await call("/api/v1/categories", { headers });
  expect(r.status).toBe(200);
  return (await json<{ items: { name: string; count: number }[] }>(r)).items;
};

/** An owner with a bearer token and a browser session. */
async function owner() {
  const a = await agent();
  const session = await browserSession(a.user.id);
  return { ...a, session: session.headers, cookie: session.cookie };
}

describe("POST /api/v1/categories/rename", () => {
  it("a session rename moves every artifact in the category, matched by key, without touching updated_at", async () => {
    const o = await owner();
    const one = await publish(o.auth, { category: "acme" });
    const two = await publish(o.auth, { category: "acme" });
    const other = await publish(o.auth, { category: "Other" });
    const before = await stored(one.body.id);
    const r = await rename(o.session, { from: "ACME", to: "Acme Site" });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ updated: 2, category: "Acme Site" });
    expect((await stored(one.body.id))?.category).toBe("Acme Site");
    expect((await stored(two.body.id))?.category).toBe("Acme Site");
    expect((await stored(other.body.id))?.category).toBe("Other");
    expect((await stored(one.body.id))?.updated_at).toBe(before?.updated_at);
    expect(await categories(o.auth)).toEqual([
      { name: "Acme Site", count: 2 },
      { name: "Other", count: 1 },
    ]);
  });

  it("respelling a category in place keeps the new spelling (it does not snap back onto itself)", async () => {
    const o = await owner();
    const p = await publish(o.auth, { category: "acme" });
    expect(await json(await rename(o.session, { from: "acme", to: "Acme" }))).toEqual({
      updated: 1,
      category: "Acme",
    });
    expect((await stored(p.body.id))?.category).toBe("Acme");
  });

  it("a merge lands on the existing spelling", async () => {
    const o = await owner();
    const a = await publish(o.auth, { category: "Client One" });
    const b = await publish(o.auth, { category: "Client Two" });
    await publish(o.auth, { category: "Client Two" });
    const r = await json(await rename(o.session, { from: "Client One", to: "client_two" }));
    expect(r).toEqual({ updated: 1, category: "Client Two" });
    expect((await stored(a.body.id))?.category).toBe("Client Two");
    expect((await stored(b.body.id))?.category).toBe("Client Two");
    expect(await categories(o.auth)).toEqual([{ name: "Client Two", count: 3 }]);
  });

  it("to: null clears the category", async () => {
    const o = await owner();
    const p = await publish(o.auth, { category: "Gone" });
    const r = await json(await rename(o.session, { from: "gone", to: null }));
    expect(r).toEqual({ updated: 1, category: null });
    expect((await stored(p.body.id))?.category).toBeNull();
    expect(await categories(o.auth)).toEqual([]);
  });

  it("deleted artifacts are left alone", async () => {
    const o = await owner();
    const live = await publish(o.auth, { category: "Mixed" });
    const dead = await publish(o.auth, { category: "Mixed" });
    expect(
      (await call(`/api/v1/artifacts/${dead.body.id}`, { method: "DELETE", headers: o.auth }))
        .status,
    ).toBe(204);
    expect(await json(await rename(o.session, { from: "Mixed", to: "Kept" }))).toEqual({
      updated: 1,
      category: "Kept",
    });
    expect((await stored(live.body.id))?.category).toBe("Kept");
    expect((await stored(dead.body.id))?.category).toBe("Mixed");
  });

  it("a bearer token gets 403 and changes nothing, even with every scope", async () => {
    const o = await owner();
    const p = await publish(o.auth, { category: "Mine" });
    const r = await rename(o.auth, { from: "Mine", to: "Theirs" });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toMatchObject({
      code: "forbidden",
      message: "Rename categories in the app",
    });
    expect((await stored(p.body.id))?.category).toBe("Mine");
  });

  it("a cookie request without the CSRF header, or from a foreign Origin, gets 403 csrf", async () => {
    const o = await owner();
    const p = await publish(o.auth, { category: "Mine" });
    for (const headers of [
      { Cookie: o.cookie, Origin: APP } as Record<string, string>,
      { ...o.session, Origin: "https://evil.example" },
    ]) {
      const r = await rename(headers, { from: "Mine", to: "Theirs" });
      expect(r.status).toBe(403);
      expect((await json(r)).error.code).toBe("csrf");
    }
    expect((await stored(p.body.id))?.category).toBe("Mine");
  });

  it("nobody signed in gets 401", async () => {
    const r = await call("/api/v1/categories/rename", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${COOKIES.csrf}=t`,
        [CSRF_HEADER]: "t",
        Origin: APP,
      },
      body: JSON.stringify({ from: "x", to: "y" }),
    });
    expect(r.status).toBe(401);
  });

  it("another owner's category with the same name is untouched", async () => {
    const o = await owner();
    const someone = await agent();
    const mine = await publish(o.auth, { category: "Shared Name" });
    const theirs = await publish(someone.auth, { category: "Shared Name" });
    expect(await json(await rename(o.session, { from: "Shared Name", to: null }))).toEqual({
      updated: 1,
      category: null,
    });
    expect((await stored(mine.body.id))?.category).toBeNull();
    expect((await stored(theirs.body.id))?.category).toBe("Shared Name");
    // A merge never snaps onto another owner's spelling either.
    await publish(o.auth, { category: "x" });
    expect(await json(await rename(o.session, { from: "x", to: "SHARED NAME" }))).toEqual({
      updated: 1,
      category: "SHARED NAME",
    });
  });

  it("an unknown from gives updated: 0; a bad to is 400", async () => {
    const o = await owner();
    await publish(o.auth, { category: "Real" });
    expect(await json(await rename(o.session, { from: "No Such", to: "Real" }))).toEqual({
      updated: 0,
      category: "Real",
    });
    for (const body of [
      { from: "Real", to: "a‮b" },
      { from: "Real", to: "   " },
      { from: "Real", to: "x".repeat(61) },
      { from: "", to: "y" },
      { from: "Real" },
    ]) {
      const r = await rename(o.session, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await json(r)).error.code).toBe("invalid_input");
    }
    expect(await categories(o.auth)).toEqual([{ name: "Real", count: 1 }]);
  });
});

describe("GET /api/v1/categories", () => {
  it("returns only the caller's names, to a session and to a bearer token with artifacts:read", async () => {
    const o = await owner();
    const someone = await agent();
    await publish(o.auth, { category: "Beta" });
    await publish(o.auth, { category: "Beta" });
    await publish(o.auth, { category: "Alpha" });
    await publish(someone.auth, { category: "Not Yours" });
    const expected = [
      { name: "Beta", count: 2 },
      { name: "Alpha", count: 1 },
    ];
    expect(await categories(o.session)).toEqual(expected);
    expect(await categories(o.auth)).toEqual(expected);
    const readOnly = await createToken(o.user.id, { scopes: "artifacts:read" });
    expect(await categories({ Authorization: `Bearer ${readOnly.token}` })).toEqual(expected);
    expect(await categories(someone.auth)).toEqual([{ name: "Not Yours", count: 1 }]);
  });

  it("a token without artifacts:read gets 403; nobody signed in gets 401", async () => {
    const o = await owner();
    const writeOnly = await createToken(o.user.id, { scopes: "mentions" });
    const r = await call("/api/v1/categories", {
      headers: { Authorization: `Bearer ${writeOnly.token}` },
    });
    expect(r.status).toBe(403);
    expect((await call("/api/v1/categories")).status).toBe(401);
  });
});

describe("several stored spellings of one name", () => {
  // Writes always snap, but two publishes that resolve before either commits can still store two
  // spellings with one key. Written here with SQL, as such a race leaves them.
  async function legacy() {
    const o = await owner();
    const a = await publish(o.auth, { category: "acme" });
    const b = await publish(o.auth, { category: "acme" });
    const c = await publish(o.auth, { category: "Other" });
    await env.DB.prepare("UPDATE artifacts SET category = 'Acme' WHERE id = ?1")
      .bind(c.body.id)
      .run();
    return { o, ids: [a.body.id, b.body.id, c.body.id] as string[] };
  }

  it("are listed as one category with the counts summed, under the most-used spelling", async () => {
    const { o } = await legacy();
    expect(await categories(o.auth)).toEqual([{ name: "acme", count: 3 }]);
    const list = await json(await call("/api/v1/artifacts", { headers: o.auth }));
    expect(list.categories).toEqual([{ name: "acme", count: 3 }]);
  });

  it("are all found by the category filter", async () => {
    const { o, ids } = await legacy();
    const r = await json(await call("/api/v1/artifacts?category=ACME", { headers: o.auth }));
    expect(r.items.map((i: { id: string }) => i.id).sort()).toEqual([...ids].sort());
  });

  it("a new publish snaps onto the most-used spelling", async () => {
    const { o } = await legacy();
    const p = await publish(o.auth, { category: "ACME" });
    expect(p.body.category).toBe("acme");
  });

  it("a rename moves every spelling", async () => {
    const { o, ids } = await legacy();
    expect(await json(await rename(o.session, { from: "Acme", to: "Client" }))).toEqual({
      updated: 3,
      category: "Client",
    });
    for (const id of ids) expect((await stored(id))?.category).toBe("Client");
    expect(await categories(o.auth)).toEqual([{ name: "Client", count: 3 }]);
  });
});

describe("the categories list cap", () => {
  it("keeps the most-used names when there are more than LIMITS.maxCategoriesListed", async () => {
    const o = await owner();
    // The busiest project, published normally, and then more single-use names than the cap,
    // inserted in one statement. The busy name sorts last by name, so only the count keeps it.
    await publish(o.auth, { category: "zzz busiest" });
    await publish(o.auth, { category: "zzz busiest" });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
       INSERT INTO artifacts (id, owner_id, slug, title, current_version, visibility, access_epoch,
         created_at, updated_at, category)
       SELECT 'cf' || lower(hex(randomblob(6))) || printf('%04d', i), ?1, 'capfill-' || i || '-' || ?1, 'Filler', 0,
         'allowlist', 1, ?2, ?2, 'name ' || printf('%04d', i) FROM n`,
    )
      .bind(o.user.id, now, LIMITS.maxCategoriesListed + 5)
      .run();
    const listed = await categories(o.auth);
    expect(listed).toHaveLength(LIMITS.maxCategoriesListed);
    expect(listed[0]).toEqual({ name: "zzz busiest", count: 2 });
    // Ties after it are kept by name.
    expect(listed[1]).toEqual({ name: "name 0001", count: 1 });
    expect(listed.at(-1)).toEqual({
      name: `name ${String(LIMITS.maxCategoriesListed - 1).padStart(4, "0")}`,
      count: 1,
    });
    const list = await json(await call("/api/v1/artifacts?limit=0", { headers: o.auth }));
    expect(list.categories).toEqual(listed);
  });
});

describe("list_artifacts limit", () => {
  it("limit 0 returns only the categories; a limit caps the items; a bad one is 400", async () => {
    const o = await owner();
    await publish(o.auth, { category: "One" });
    await publish(o.auth, { category: "One" });
    await publish(o.auth);
    const none = await json(await call("/api/v1/artifacts?limit=0", { headers: o.auth }));
    expect(none).toEqual({ items: [], categories: [{ name: "One", count: 2 }] });
    const two = await json(await call("/api/v1/artifacts?limit=2", { headers: o.auth }));
    expect(two.items).toHaveLength(2);
    expect((await json(await call("/api/v1/artifacts", { headers: o.auth }))).items).toHaveLength(
      3,
    );
    for (const bad of ["-1", "501", "x", "1.5"]) {
      const r = await call(`/api/v1/artifacts?limit=${bad}`, { headers: o.auth });
      expect(r.status, bad).toBe(400);
    }
  });
});

describe("names with no letters", () => {
  it("a name made only of spaces, '-' and '_' is refused on publish and on PATCH", async () => {
    const o = await owner();
    for (const bad of ["-", "_", "- _", "－"]) {
      const r = await publish(o.auth, { category: bad });
      expect(r.res.status, bad).toBe(400);
      expect(r.body.error).toMatchObject({ code: "invalid_input", details: { field: "category" } });
    }
    const p = await publish(o.auth, { category: "Real" });
    const r = await call(`/api/v1/artifacts/${p.body.id}`, {
      method: "PATCH",
      headers: { ...o.session, "Content-Type": "application/json" },
      body: JSON.stringify({ category: "__" }),
    });
    expect(r.status).toBe(400);
    expect((await stored(p.body.id))?.category).toBe("Real");
    expect((await json(await rename(o.session, { from: "Real", to: "-" }))).error.code).toBe(
      "invalid_input",
    );
  });

  it("line breaks and separators are stored as one space, not refused", async () => {
    const o = await owner();
    const p = await publish(o.auth, { category: "acme site\nweb" });
    expect(p.res.status).toBe(201);
    expect(p.body.category).toBe("acme site web");
  });
});

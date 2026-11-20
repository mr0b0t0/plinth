// Migration 0013's columns are written on every category write path, the Drizzle mirror matches
// the new tables, and ALLOW_CATEGORY_SHARING defaults on.
import { env } from "cloudflare:workers";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  artifacts,
  categoryGrants,
  categoryShares,
  loginCodes,
  personalCategories,
  users,
} from "../src/db/schema.ts";
import { categoryRow, filed, owner, run, send, shareCategory } from "./category-helpers.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import { call, json } from "./helpers.ts";

const columns = async (table: string) =>
  (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results
    .map((c) => c.name)
    .sort();
const mirrored = (t: SQLiteTable) =>
  Object.values(getTableColumns(t))
    .map((c) => c.name)
    .sort();

describe("schema mirror: category sharing (migration 0013)", () => {
  it("matches the tables and the added columns", async () => {
    for (const [name, t] of [
      ["category_shares", categoryShares],
      ["category_grants", categoryGrants],
      ["personal_categories", personalCategories],
      ["artifacts", artifacts],
      ["users", users],
      ["login_codes", loginCodes],
    ] as const) {
      expect(await columns(name), name).toEqual(mirrored(t));
    }
    expect(await columns("artifacts")).toEqual(
      expect.arrayContaining([
        "category_key",
        "category_rev",
        "category_review",
        "category_review_share",
      ]),
    );
  });

  it("refuses a review without its share, an editor category grant and a stray review value", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    await expect(
      env.DB.prepare("UPDATE artifacts SET category_review = 'shared' WHERE id = ?1")
        .bind(a.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE artifacts SET category_review = 'public', category_review_share = 's' WHERE id = ?1",
      )
        .bind(a.id)
        .run(),
    ).rejects.toThrow();
    const made = await shareCategory(o, "Acme", []);
    await expect(
      env.DB.prepare(
        "INSERT INTO category_grants (share_id, email, role, created_at) VALUES (?1, 'e@example.com', 'editor', 'now')",
      )
        .bind(made.share.id)
        .run(),
    ).rejects.toThrow();
  });
});

describe("category_key and category_rev on every write", () => {
  it("publish, update, PATCH, rename and an upload ticket all write the key; a key change bumps the rev", async () => {
    const o = await owner();
    const a = await filed(o, "Acme Site");
    expect(await categoryRow(a.id)).toMatchObject({ category_key: "acme site", category_rev: 0 });
    await send("PUT", `/api/v1/artifacts/${a.id}`, o.auth, {
      html: "<!doctype html><p>2</p>",
      category: "Beta",
    });
    expect(await categoryRow(a.id)).toMatchObject({
      category: "Beta",
      category_key: "beta",
      category_rev: 1,
    });
    await send("PATCH", `/api/v1/artifacts/${a.id}`, o.auth, { category: "BETA" });
    expect(await categoryRow(a.id)).toMatchObject({ category_key: "beta", category_rev: 1 });
    await send("PATCH", `/api/v1/artifacts/${a.id}`, o.auth, { category: null });
    expect(await categoryRow(a.id)).toMatchObject({
      category: null,
      category_key: null,
      category_rev: 2,
    });
    await send("PATCH", `/api/v1/artifacts/${a.id}`, o.auth, { category: "Gamma" });
    await send("POST", "/api/v1/categories/rename", o.session, { from: "gamma", to: "Delta" });
    expect(await categoryRow(a.id)).toMatchObject({
      category: "Delta",
      category_key: "delta",
      category_rev: 4,
    });

    const mint = await json(
      await send("POST", "/api/v1/uploads", o.auth, { title: "B", category: "Epsilon" }),
    );
    const bundle = await json(
      await run(mint.upload_url, {
        method: "POST",
        headers: { Authorization: `Bearer ${mint.upload_token}` },
        body: tar([{ name: "index.html", data: "<!doctype html><p>b</p>" }]),
      }),
    );
    expect(await categoryRow(bundle.id)).toMatchObject({
      category: "Epsilon",
      category_key: "epsilon",
    });
  });

  it("backfills keys written before the migration when the owner shares", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    await env.DB.prepare("UPDATE artifacts SET category_key = NULL WHERE id = ?1").bind(a.id).run();
    const made = await shareCategory(o, "Acme", []);
    expect((await categoryRow(a.id))?.category_key).toBe("acme");
    expect(made.share.counts.shared).toBe(1);
  });

  it("categories mark shared names", async () => {
    const o = await owner();
    await filed(o, "Acme");
    await filed(o, "Other");
    await shareCategory(o, "Acme", []);
    const cats = await json(await call("/api/v1/categories", { headers: o.auth }));
    expect(cats.items).toEqual(
      expect.arrayContaining([
        { name: "Acme", count: 1, shared: true },
        { name: "Other", count: 1 },
      ]),
    );
    // With the switch off nothing is marked.
    const off = await json(
      await send("GET", "/api/v1/categories", o.auth, undefined, {
        ALLOW_CATEGORY_SHARING: "false",
      }),
    );
    expect(off.items).toEqual(expect.arrayContaining([{ name: "Acme", count: 1 }]));
  });
});

describe("ALLOW_CATEGORY_SHARING", () => {
  const base = parseConfig(env as unknown as Record<string, unknown>);
  it("defaults on, and only an off value turns it off", () => {
    expect(base.allowCategorySharing).toBe(true);
    expect(typeof (env as unknown as Record<string, unknown>).ALLOW_CATEGORY_SHARING).toBe(
      "string",
    );
    const vars = { ...(env as unknown as Record<string, unknown>) };
    expect(parseConfig({ ...vars, ALLOW_CATEGORY_SHARING: "" }).allowCategorySharing).toBe(true);
    expect(parseConfig({ ...vars, ALLOW_CATEGORY_SHARING: "false" }).allowCategorySharing).toBe(
      false,
    );
    expect(parseConfig({ ...vars, ALLOW_CATEGORY_SHARING: "0" }).allowCategorySharing).toBe(false);
  });

  it("GET /config says it", async () => {
    expect((await json(await call("/api/v1/config"))).category_sharing).toBe(true);
    const off = await json(await run("/api/v1/config", {}, { ALLOW_CATEGORY_SHARING: "false" }));
    expect(off.category_sharing).toBe(false);
  });
});

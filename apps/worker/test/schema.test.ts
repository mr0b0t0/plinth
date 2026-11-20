// The Drizzle mirror (src/db/schema.ts) matches the tables the migrations create.
import { env } from "cloudflare:workers";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { artifactOpens, artifactViewTotals } from "../src/db/schema.ts";

async function columnsOf(table: string) {
  const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    notnull: number;
    pk: number;
  }>();
  return rows.results;
}

function mirrored(t: SQLiteTable) {
  return Object.values(getTableColumns(t))
    .map((c) => c.name)
    .sort();
}

describe("schema mirror: artifact stats (migrations 0010 and 0020)", () => {
  it("artifact_opens: one row per open, with who opened it and nothing about their device", async () => {
    const cols = await columnsOf("artifact_opens");
    expect(cols.map((c) => c.name).sort()).toEqual(mirrored(artifactOpens));
    expect(cols.map((c) => c.name).sort()).toEqual([
      "artifact_id",
      "email",
      "id",
      "opened_at",
      "role",
      "user_id",
      "version",
      "viewer_kind",
      "visitor",
    ]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["id"]);
    const required = cols.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(required.sort()).toEqual(["artifact_id", "opened_at", "viewer_kind"]);
    for (const c of cols) expect(c.name).not.toMatch(/ip|agent|session|referr|ua$/i);
    expect(getTableName(artifactOpens)).toBe("artifact_opens");
  });

  it("artifact_view_totals: one row per artifact with its folded opens and first day", async () => {
    const cols = await columnsOf("artifact_view_totals");
    expect(cols.map((c) => c.name).sort()).toEqual(mirrored(artifactViewTotals));
    expect(cols.map((c) => c.name).sort()).toEqual(["artifact_id", "first_day", "views"]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["artifact_id"]);
    expect(getTableName(artifactViewTotals)).toBe("artifact_view_totals");
  });

  it("the daily table is gone", async () => {
    expect(await columnsOf("artifact_view_days")).toEqual([]);
  });
});

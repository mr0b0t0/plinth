// The Drizzle mirror (src/db/schema.ts) matches the tables the migrations create.
import { env } from "cloudflare:workers";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { artifactViewDays, artifactViewTotals } from "../src/db/schema.ts";

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

describe("schema mirror: view counts (migration 0010)", () => {
  it("artifact_view_days: artifact_id and day as the key, then views", async () => {
    const cols = await columnsOf("artifact_view_days");
    expect(cols.map((c) => c.name).sort()).toEqual(mirrored(artifactViewDays));
    expect(cols.map((c) => c.name).sort()).toEqual(["artifact_id", "day", "views"]);
    expect(
      cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    ).toEqual(["artifact_id", "day"]);
    for (const c of cols) expect(c.notnull, c.name).toBe(1);
    expect(getTableName(artifactViewDays)).toBe("artifact_view_days");
  });

  it("artifact_view_totals: one row per artifact with its folded views and first day", async () => {
    const cols = await columnsOf("artifact_view_totals");
    expect(cols.map((c) => c.name).sort()).toEqual(mirrored(artifactViewTotals));
    expect(cols.map((c) => c.name).sort()).toEqual(["artifact_id", "first_day", "views"]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["artifact_id"]);
    expect(getTableName(artifactViewTotals)).toBe("artifact_view_totals");
  });

  it("stores nothing about who opened a page", async () => {
    const names = [
      ...(await columnsOf("artifact_view_days")),
      ...(await columnsOf("artifact_view_totals")),
    ].map((c) => c.name);
    for (const n of names) expect(n).not.toMatch(/ip|email|user|session|agent|referr/i);
  });
});

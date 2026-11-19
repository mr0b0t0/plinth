// Migration 0015 (data sources and provenance): the Drizzle mirror, the CHECKs, the open-task
// uniqueness, and the six provenance columns on artifact_docs, which no trigger counts.
import { env } from "cloudflare:workers";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { artifactDocs, dataRefreshTasks, dataSources } from "../src/db/schema.ts";
import { agent, publish } from "./helpers.ts";

async function columns(table: string): Promise<string[]> {
  const r = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return r.results.map((c) => c.name).sort();
}
const mirrored = (t: SQLiteTable) =>
  Object.values(getTableColumns(t))
    .map((c) => c.name)
    .sort();

async function source(artifactId: string, extra: Record<string, string> = {}) {
  const v = {
    requestable_by: "editor",
    target_client_type: "claude",
    ...extra,
  };
  return env.DB.prepare(
    `INSERT INTO data_sources (artifact_id, source_id, label, connector, recipe, collection,
       requestable_by, target_client_type, config_hash, created_at, updated_at)
     VALUES (?1, 's', 'L', 'C', 'R', 'c', ?2, ?3, 'h', 't', 't')`,
  )
    .bind(artifactId, v.requestable_by, v.target_client_type)
    .run();
}

describe("schema: data sources (migration 0015)", () => {
  it("mirrors the tables and the provenance columns in Drizzle", async () => {
    expect(await columns("data_sources")).toEqual(mirrored(dataSources));
    expect(await columns("data_refresh_tasks")).toEqual(mirrored(dataRefreshTasks));
    expect(await columns("artifact_docs")).toEqual(mirrored(artifactDocs));
    for (const c of [
      "source_id",
      "source_label",
      "source_connector",
      "source_ref",
      "fetched_at",
      "source_connection",
    ]) {
      expect(await columns("artifact_docs")).toContain(c);
    }
  });

  it("refuses unknown roles, client types, outcomes, reasons, channels and states", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await expect(source(body.id, { requestable_by: "admin" })).rejects.toThrow();
    await expect(source(body.id, { target_client_type: "gemini" })).rejects.toThrow();
    await source(body.id);
    await expect(
      env.DB.prepare("UPDATE data_sources SET last_outcome = 'maybe' WHERE artifact_id = ?1")
        .bind(body.id)
        .run(),
    ).rejects.toThrow();
    const task = (id: string, extra: string) =>
      env.DB.prepare(
        `INSERT INTO data_refresh_tasks (id, artifact_id, source_id, config_hash, reason, requested_via, state, created_at, expires_at)
         VALUES (?1, ?2, 's', 'h', ${extra}, 't', 't')`,
      )
        .bind(id, body.id)
        .run();
    await expect(task("t1", "'whim', 'app', 'pending'")).rejects.toThrow();
    await expect(task("t2", "'request', 'email', 'pending'")).rejects.toThrow();
    await expect(task("t3", "'request', 'app', 'lost'")).rejects.toThrow();
    await task("t4", "'request', 'app', 'pending'");
    // One open task per source.
    await expect(task("t5", "'schedule', 'schedule', 'claimed'")).rejects.toThrow();
    await task("t6", "'schedule', 'schedule', 'done'");
    // A task names a source that exists, and goes with it.
    await expect(
      env.DB.prepare(
        `INSERT INTO data_refresh_tasks (id, artifact_id, source_id, config_hash, reason, requested_via, created_at, expires_at)
         VALUES ('t7', ?1, 'nope', 'h', 'request', 'app', 't', 't')`,
      )
        .bind(body.id)
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM data_sources WHERE artifact_id = ?1").bind(body.id).run();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM data_refresh_tasks WHERE artifact_id = ?1",
    )
      .bind(body.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("has the indexes the queries use", async () => {
    const r = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('data_sources', 'data_refresh_tasks') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual([
      "data_refresh_open",
      "data_refresh_requested_by",
      "data_refresh_state",
      "data_sources_schedule",
      "data_sources_target",
    ]);
    // The gate's read of figures from removed sources uses an index of stamped documents only.
    const stamped = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'artifact_docs_stamped'",
    ).first<{ sql: string }>();
    expect(stamped?.sql).toMatch(/WHERE source_id IS NOT NULL/);
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT d.collection, d.source_id, count(*) FROM artifact_docs d
        WHERE d.artifact_id = ?1 AND d.source_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM data_sources s WHERE s.artifact_id = ?1
                            AND s.source_id = d.source_id AND s.collection = d.collection)
        GROUP BY d.collection, d.source_id, d.source_label, d.source_connector`,
    )
      .bind("x")
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("artifact_docs_stamped");
  });
});

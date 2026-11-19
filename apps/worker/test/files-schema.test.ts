// Migration 0014 (files people add to a page): the Drizzle mirror, the CHECKs that keep markup
// types and unknown states out, the indexes and the triggers.
import { env } from "cloudflare:workers";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { artifactFiles, artifactFileUsage } from "../src/db/schema.ts";
import { setup } from "./files-helpers.ts";

const columns = async (t: string) =>
  (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results
    .map((c) => c.name)
    .sort();
const mirrored = (t: SQLiteTable) =>
  Object.values(getTableColumns(t))
    .map((c) => c.name)
    .sort();

const insert = (artifactId: string, over: Record<string, unknown> = {}) => {
  const v = {
    id: Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20),
    content_type: "image/png",
    state: "pending",
    size: 10,
    parts: 1,
    via: "page",
    role: "viewer",
    ...over,
  };
  return env.DB.prepare(
    `INSERT INTO artifact_files (id, artifact_id, r2_key, name, content_type, size_bytes, state,
       parts, created_by_email, created_by_role, created_via, created_at, expires_at)
     VALUES (?1, ?2, 'k', 'n', ?3, ?4, ?5, ?6, 'a@example.org', ?7, ?8, 't', 0)`,
  )
    .bind(v.id, artifactId, v.content_type, v.size, v.state, v.parts, v.role, v.via)
    .run();
};

describe("schema: files people add to a page (migration 0014)", () => {
  it("mirrors both tables in Drizzle", async () => {
    expect(await columns("artifact_files")).toEqual(mirrored(artifactFiles));
    expect(await columns("artifact_file_usage")).toEqual(mirrored(artifactFileUsage));
  });

  it("refuses markup and other types, unknown states, roles and writers, and empty files", async () => {
    const { id } = await setup();
    await insert(id);
    for (const over of [
      { content_type: "image/svg+xml" },
      { content_type: "text/html" },
      { content_type: "application/octet-stream" },
      { state: "uploading" },
      { size: 0 },
      { parts: 0 },
      { via: "agent" },
      { role: "admin" },
    ]) {
      await expect(insert(id, over), JSON.stringify(over)).rejects.toThrow();
    }
    // The row needs a live artifact.
    await expect(insert("z".repeat(20))).rejects.toThrow();
  });

  it("has the list, uploader, sweep and erase indexes and the three triggers", async () => {
    const names = async (type: string) =>
      (
        await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = ?1 AND tbl_name = 'artifact_files'",
        )
          .bind(type)
          .all<{ name: string }>()
      ).results
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_"))
        .sort();
    expect(await names("index")).toEqual([
      "artifact_files_created_by",
      "artifact_files_list",
      "artifact_files_sweep",
      "artifact_files_uploader",
    ]);
    expect(await names("trigger")).toEqual([
      "artifact_files_ad",
      "artifact_files_ai",
      "artifact_files_au_state",
    ]);
  });
});

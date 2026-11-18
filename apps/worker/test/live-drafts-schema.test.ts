// Live doc drafts foundations (#36): migration 0011_live_drafts, its CHECKs, the cascade from the
// artifact, SET NULL from the editing user, and the indexes the cleanup paths use.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { liveDrafts } from "../src/db/schema.ts";
import { agent, createUser, db, publish } from "./helpers.ts";

const D1 = () => env.DB;
const NOW = "2026-11-18T00:00:00.000Z";

function insertDraft(
  artifactId: string,
  over: Partial<{
    base_version: number;
    size_bytes: number;
    rev: number;
    conflict_version: number | null;
    updated_by_user: string | null;
  }> = {},
) {
  const v = {
    base_version: 1,
    size_bytes: 7,
    rev: 1,
    conflict_version: null,
    updated_by_user: null,
    ...over,
  };
  return D1()
    .prepare(
      `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, conflict_version,
         updated_by_user, created_at, updated_at)
       VALUES (?, ?, '# Draft', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      artifactId,
      v.base_version,
      v.size_bytes,
      v.rev,
      v.conflict_version,
      v.updated_by_user,
      NOW,
      NOW,
    )
    .run();
}

async function newDoc() {
  const a = await agent();
  const { body } = await publish(a.auth, { type: "doc", content: "# Doc\n", html: undefined });
  expect(typeof body.id).toBe("string");
  return { owner: a, id: body.id as string };
}

describe("migration 0011_live_drafts", () => {
  it("applies: the table, its columns and both indexes exist", async () => {
    const cols = await D1().prepare("PRAGMA table_info(live_drafts)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual([
      "artifact_id",
      "base_version",
      "content",
      "size_bytes",
      "rev",
      "conflict_version",
      "updated_by_user",
      "created_at",
      "updated_at",
    ]);
    const objects = await D1()
      .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'live_drafts' ORDER BY name")
      .all<{ type: string; name: string }>();
    const names = objects.results.map((o) => `${o.type}:${o.name}`);
    for (const want of [
      "table:live_drafts",
      "index:live_drafts_updated",
      "index:live_drafts_editor",
    ]) {
      expect(names).toContain(want);
    }
    // Its name keeps it out of the shared-data objects (artifact_d%), so 0005's tests are untouched.
    expect(names.some((n) => n.includes("artifact_d"))).toBe(false);
  });

  it("holds one draft per artifact, readable through the drizzle mirror", async () => {
    const { id } = await newDoc();
    await insertDraft(id, { rev: 3, base_version: 1, conflict_version: 2 });
    await expect(insertDraft(id)).rejects.toThrow(/UNIQUE|PRIMARY/i);
    const rows = await db().select().from(liveDrafts).all();
    expect(rows.find((r) => r.artifactId === id)).toEqual({
      artifactId: id,
      baseVersion: 1,
      content: "# Draft",
      sizeBytes: 7,
      rev: 3,
      conflictVersion: 2,
      updatedByUser: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("refuses a base version below 1, a negative size, a rev below 1 and an unknown artifact", async () => {
    const { id } = await newDoc();
    await expect(insertDraft(id, { base_version: 0 })).rejects.toThrow(/CHECK/i);
    await expect(insertDraft(id, { size_bytes: -1 })).rejects.toThrow(/CHECK/i);
    await expect(insertDraft(id, { rev: 0 })).rejects.toThrow(/CHECK/i);
    await expect(insertDraft("no-such-artifact")).rejects.toThrow(/FOREIGN KEY/i);
    await expect(insertDraft(id, { updated_by_user: "no-such-user" })).rejects.toThrow(
      /FOREIGN KEY/i,
    );
    // None of them left a row.
    const n = await D1()
      .prepare("SELECT count(*) AS n FROM live_drafts WHERE artifact_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("goes with its artifact (erase cascades) and outlives its editor's account", async () => {
    const { id } = await newDoc();
    const editor = await createUser();
    await insertDraft(id, { updated_by_user: editor.id });
    await D1().prepare("DELETE FROM users WHERE id = ?").bind(editor.id).run();
    const kept = await D1()
      .prepare("SELECT updated_by_user FROM live_drafts WHERE artifact_id = ?")
      .bind(id)
      .first<{ updated_by_user: string | null }>();
    expect(kept).toEqual({ updated_by_user: null });

    await D1().prepare("DELETE FROM artifacts WHERE id = ?").bind(id).run();
    const gone = await D1()
      .prepare("SELECT count(*) AS n FROM live_drafts WHERE artifact_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
  });

  it("goes with its owner's account, through the owner's artifacts", async () => {
    const { owner, id } = await newDoc();
    await insertDraft(id, { updated_by_user: owner.user.id });
    await D1().prepare("DELETE FROM users WHERE id = ?").bind(owner.user.id).run();
    const gone = await D1()
      .prepare("SELECT count(*) AS n FROM live_drafts WHERE artifact_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
  });

  it("the retention and per-editor lookups use the indexes", async () => {
    const plan = async (sql: string) =>
      (await D1().prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results
        .map((r) => r.detail)
        .join(" | ");
    expect(
      await plan("SELECT artifact_id FROM live_drafts WHERE updated_at < '2026-01-01'"),
    ).toMatch(/live_drafts_updated/);
    expect(
      await plan("UPDATE live_drafts SET updated_by_user = NULL WHERE updated_by_user = 'u'"),
    ).toMatch(/live_drafts_editor/);
  });
});

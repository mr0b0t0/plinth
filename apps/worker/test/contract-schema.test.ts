// Migrations 0006 (versions.stored_bytes), 0007 (upload_tickets) and 0009 (categories): they apply,
// and the ticket table's CHECK constraints refuse rows that would break the ticket rules.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/crypto.ts";
import { agent, publish } from "./helpers.ts";

const D1 = () => env.DB;
const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 30 * 60 * 1000).toISOString();

interface TicketRow {
  credential: string;
  connection_id: string | null;
  admin_token_hash: string | null;
  mode: string;
  artifact_id: string | null;
  base_version: number | null;
  state?: string;
}

function insertTicket(userId: string, t: TicketRow) {
  return D1()
    .prepare(
      `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id,
         admin_token_hash, scopes, mode, artifact_id, artifact_type, base_version, state,
         created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'artifacts:write', ?, ?, 'html', ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      newId(),
      userId,
      t.credential,
      t.connection_id,
      t.admin_token_hash,
      t.mode,
      t.artifact_id,
      t.base_version,
      t.state ?? "open",
      NOW,
      LATER,
    )
    .run();
}

describe("migration 0006_stored_bytes", () => {
  it("adds versions.stored_bytes; a new version records the bytes it wrote", async () => {
    const cols = await D1().prepare("PRAGMA table_info(versions)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("stored_bytes");
    const a = await agent();
    const { body } = await publish(a.auth);
    const row = await D1()
      .prepare("SELECT stored_bytes, size_bytes FROM versions WHERE artifact_id = ?")
      .bind(body.id)
      .first<{ stored_bytes: number | null; size_bytes: number }>();
    expect(row?.size_bytes).toBeGreaterThan(0);
    // A first version writes every file it has.
    expect(row?.stored_bytes).toBe(row?.size_bytes);
  });
});

describe("migration 0007_upload_tickets", () => {
  it("creates the table and its indexes", async () => {
    const objects = await D1()
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'upload_tickets%'")
      .all<{ type: string; name: string }>();
    const names = objects.results.map((o) => `${o.type}:${o.name}`);
    for (const want of [
      "table:upload_tickets",
      "index:upload_tickets_user",
      "index:upload_tickets_receiving",
      "index:upload_tickets_reserved",
      "index:upload_tickets_expires",
    ]) {
      expect(names).toContain(want);
    }
  });

  it("accepts a connection publish ticket and an admin update ticket", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await insertTicket(a.user.id, {
      credential: "connection",
      connection_id: a.connectionId,
      admin_token_hash: null,
      mode: "publish",
      artifact_id: null,
      base_version: null,
    });
    await insertTicket(a.user.id, {
      credential: "admin",
      connection_id: null,
      admin_token_hash: "h",
      mode: "update",
      artifact_id: body.id,
      base_version: 1,
    });
  });

  it("refuses rows that break the credential, mode or state rules", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const ok: TicketRow = {
      credential: "connection",
      connection_id: a.connectionId,
      admin_token_hash: null,
      mode: "update",
      artifact_id: body.id,
      base_version: 1,
    };
    for (const bad of [
      { ...ok, connection_id: null },
      { ...ok, admin_token_hash: "h" },
      { ...ok, credential: "admin", connection_id: null },
      { ...ok, credential: "session" },
      { ...ok, base_version: null },
      { ...ok, mode: "publish" },
      { ...ok, mode: "other" },
      { ...ok, state: "running" },
    ]) {
      await expect(insertTicket(a.user.id, bad), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it("keeps why a ticket ended (dead_reason: conflict or taken_down, only on a dead ticket)", async () => {
    const cols = await D1().prepare("PRAGMA table_info(upload_tickets)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("dead_reason");
    const a = await agent();
    const { body } = await publish(a.auth);
    const insert = (state: string, reason: string | null) =>
      D1()
        .prepare(
          `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id, scopes,
             mode, artifact_id, artifact_type, base_version, state, dead_reason, created_at, expires_at)
           VALUES (?, ?, ?, 'connection', ?, 'artifacts:write', 'update', ?, 'html', 1, ?, ?, ?, ?)`,
        )
        .bind(newId(), newId(), a.user.id, a.connectionId, body.id, state, reason, NOW, LATER)
        .run();
    await insert("dead", "conflict");
    await insert("dead", "taken_down");
    await insert("dead", null);
    await expect(insert("dead", "other")).rejects.toThrow();
    await expect(insert("open", "conflict")).rejects.toThrow();
  });
});

describe("migration 0010_view_counts", () => {
  const day = (artifactId: string, d: string, views: number) =>
    D1()
      .prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?, ?, ?)")
      .bind(artifactId, d, views)
      .run();
  const total = (artifactId: string, views: number, firstDay: string) =>
    D1()
      .prepare("INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?, ?, ?)")
      .bind(artifactId, views, firstDay)
      .run();

  it("creates both tables WITHOUT ROWID and with no secondary index", async () => {
    const objects = await D1()
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name LIKE 'artifact_view_%' ORDER BY name",
      )
      .all<{ type: string; name: string; sql: string | null }>();
    const tables = objects.results.filter((o) => o.type === "table");
    expect(tables.map((t) => t.name)).toEqual(["artifact_view_days", "artifact_view_totals"]);
    for (const t of tables) expect(t.sql).toMatch(/WITHOUT ROWID\s*$/);
    // Only the primary keys' automatic indexes (none for WITHOUT ROWID): one write per open.
    expect(objects.results.filter((o) => o.type === "index" && o.sql !== null)).toEqual([]);
  });

  it("accepts real counts and refuses a malformed day or a negative count", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await day(body.id, "2026-11-18", 3);
    await total(body.id, 10, "2026-08-01");
    for (const bad of ["2026-1-18", "18-11-2026", "2026-11-18T00:00:00Z", "", "abcd-ef-gh"]) {
      await expect(day(body.id, bad, 1), bad).rejects.toThrow();
    }
    await expect(day(body.id, "2026-11-17", -1)).rejects.toThrow();
    const b = await publish(a.auth);
    for (const bad of ["2026/08/01", "2026-08-1", ""]) {
      await expect(total(b.body.id, 1, bad), bad).rejects.toThrow();
    }
    await expect(total(b.body.id, -1, "2026-08-01")).rejects.toThrow();
  });

  it("one row per artifact per day, and only for an artifact that exists", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await day(body.id, "2026-11-18", 1);
    await expect(day(body.id, "2026-11-18", 1)).rejects.toThrow();
    await expect(day("no-such-artifact", "2026-11-18", 1)).rejects.toThrow();
    await expect(total("no-such-artifact", 1, "2026-11-18")).rejects.toThrow();
describe("migration 0009_categories", () => {
  interface Col {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }

  it("adds a nullable category column to artifacts and upload_tickets, with no default", async () => {
    for (const table of ["artifacts", "upload_tickets"]) {
      const cols = await D1().prepare(`PRAGMA table_info(${table})`).all<Col>();
      const col = cols.results.find((c) => c.name === "category");
      expect(col, table).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    }
  });

  it("puts no CHECK on either column (the Worker validates the text)", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const odd = "x".repeat(500);
    await D1().prepare("UPDATE artifacts SET category = ? WHERE id = ?").bind(odd, body.id).run();
    const row = await D1()
      .prepare("SELECT category FROM artifacts WHERE id = ?")
      .bind(body.id)
      .first<{ category: string | null }>();
    expect(row?.category).toBe(odd);
    await insertTicket(a.user.id, {
      credential: "connection",
      connection_id: a.connectionId,
      admin_token_hash: null,
      mode: "publish",
      artifact_id: null,
      base_version: null,
    });
    await D1()
      .prepare("UPDATE upload_tickets SET category = ? WHERE user_id = ?")
      .bind(odd, a.user.id)
      .run();
  });

  it("creates the partial index artifacts_owner_category", async () => {
    const idx = await D1()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .bind("artifacts_owner_category")
      .first<{ sql: string }>();
    expect(idx?.sql).toMatch(/ON artifacts\s*\(owner_id, category\)/);
    expect(idx?.sql).toMatch(/deleted_at IS NULL AND category IS NOT NULL/);
  });

  it("leaves a new artifact uncategorised", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const row = await D1()
      .prepare("SELECT category FROM artifacts WHERE id = ?")
      .bind(body.id)
      .first<{ category: string | null }>();
    expect(row?.category).toBeNull();
  });
});

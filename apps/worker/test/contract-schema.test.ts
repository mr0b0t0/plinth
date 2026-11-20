// Migrations 0006 (versions.stored_bytes), 0007 (upload_tickets), 0009 (categories), 0010 and 0020
// (artifact stats): they apply, and their CHECK constraints refuse rows that would break the rules.
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

describe("migration 0010_view_counts (the all-time totals that remain)", () => {
  const total = (artifactId: string, views: number, firstDay: string) =>
    D1()
      .prepare("INSERT INTO artifact_view_totals (artifact_id, views, first_day) VALUES (?, ?, ?)")
      .bind(artifactId, views, firstDay)
      .run();

  it("accepts real totals and refuses a malformed day, a negative count or no artifact", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await total(body.id, 10, "2026-08-01");
    const b = await publish(a.auth);
    for (const bad of ["2026/08/01", "2026-08-1", ""]) {
      await expect(total(b.body.id, 1, bad), bad).rejects.toThrow();
    }
    await expect(total(b.body.id, -1, "2026-08-01")).rejects.toThrow();
    await expect(total("no-such-artifact", 1, "2026-11-18")).rejects.toThrow();
  });
});

describe("migration 0020_artifact_opens", () => {
  const MIGRATION = "0020_artifact_opens.sql";
  const insertOpen = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return D1()
      .prepare(
        `INSERT INTO artifact_opens (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
      .bind(...Object.values(cols))
      .run();
  };

  it("indexes opens by artifact and time, by time, and by person", async () => {
    const idx = await D1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifact_opens' AND sql IS NOT NULL ORDER BY name",
      )
      .all<{ name: string }>();
    expect(idx.results.map((r) => r.name)).toEqual([
      "artifact_opens_artifact_time",
      "artifact_opens_email",
      "artifact_opens_time",
      "artifact_opens_user",
    ]);
  });

  it("keeps each kind of viewer to its own column", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const at = "2026-11-19T10:00:00.000Z";
    const base = { artifact_id: body.id, opened_at: at, version: 1 };
    await insertOpen({ ...base, viewer_kind: "user", user_id: a.user.id, role: "editor" });
    await insertOpen({ ...base, viewer_kind: "email", email: "x@example.com", role: "viewer" });
    await insertOpen({ ...base, viewer_kind: "anonymous", visitor: "v".repeat(22), role: "link" });
    await insertOpen({ ...base, viewer_kind: "unknown", version: null });
    const bad: Record<string, unknown>[] = [
      { ...base, viewer_kind: "someone" },
      { ...base, viewer_kind: "anonymous", user_id: a.user.id },
      { ...base, viewer_kind: "anonymous", email: "x@example.com" },
      { ...base, viewer_kind: "email" },
      { ...base, viewer_kind: "user", visitor: "v".repeat(22) },
      { ...base, viewer_kind: "unknown", role: "owner" },
      { ...base, viewer_kind: "unknown", version: 0 },
      { ...base, viewer_kind: "unknown", opened_at: "yesterday" },
      { ...base, viewer_kind: "unknown", artifact_id: "no-such-artifact" },
      { ...base, viewer_kind: "user", user_id: "no-such-user" },
    ];
    for (const row of bad) await expect(insertOpen(row), JSON.stringify(row)).rejects.toThrow();
  });

  it("turns each old daily count into that many unknown opens on its day, then drops the table", async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name === MIGRATION);
    expect(m, "the migration is applied in tests").toBeDefined();
    const queries = m?.queries ?? [];
    const copy = queries.find((q) => q.includes("FROM artifact_view_days"));
    const drop = queries.find((q) => /DROP TABLE artifact_view_days/.test(q));
    expect(copy).toBeDefined();
    expect(drop).toBeDefined();
    // The old table as 0010 made it, holding counts for two artifacts (and a zero row).
    const old = env.TEST_MIGRATIONS.find((x) => x.name === "0010_view_counts.sql");
    const create = old?.queries.find((sql) => sql.includes("CREATE TABLE artifact_view_days"));
    expect(create).toBeDefined();
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { body: q } = await publish(a.auth);
    await D1()
      .prepare(create as string)
      .run();
    try {
      await D1().batch([
        D1()
          .prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?, ?, ?)")
          .bind(p.id, "2026-09-01", 3),
        D1()
          .prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?, ?, ?)")
          .bind(p.id, "2026-09-02", 1),
        D1()
          .prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?, ?, ?)")
          .bind(q.id, "2026-10-05", 250),
        D1()
          .prepare("INSERT INTO artifact_view_days (artifact_id, day, views) VALUES (?, ?, ?)")
          .bind(q.id, "2026-10-06", 0),
      ]);
      await D1()
        .prepare(copy as string)
        .run();
      await D1()
        .prepare(drop as string)
        .run();
    } finally {
      await D1().prepare("DROP TABLE IF EXISTS artifact_view_days").run();
    }
    const rows = await D1()
      .prepare(
        `SELECT artifact_id, opened_at, count(*) AS n, max(viewer_kind) AS kind,
                max(version) AS version, max(user_id) AS user_id, max(email) AS email,
                max(visitor) AS visitor, max(role) AS role
           FROM artifact_opens WHERE artifact_id IN (?, ?) GROUP BY artifact_id, opened_at
          ORDER BY opened_at`,
      )
      .bind(p.id, q.id)
      .all();
    const none = {
      kind: "unknown",
      version: null,
      user_id: null,
      email: null,
      visitor: null,
      role: null,
    };
    expect(rows.results).toEqual([
      { artifact_id: p.id, opened_at: "2026-09-01T00:00:00.000Z", n: 3, ...none },
      { artifact_id: p.id, opened_at: "2026-09-02T00:00:00.000Z", n: 1, ...none },
      { artifact_id: q.id, opened_at: "2026-10-05T00:00:00.000Z", n: 250, ...none },
    ]);
  });
});

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

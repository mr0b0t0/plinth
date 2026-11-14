// Migrations 0006 (versions.stored_bytes) and 0007 (upload_tickets): they apply, and the ticket
// table's CHECK constraints refuse rows that would break the ticket rules.
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
  it("adds versions.stored_bytes, NULL for versions written the old way", async () => {
    const cols = await D1().prepare("PRAGMA table_info(versions)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("stored_bytes");
    const a = await agent();
    const { body } = await publish(a.auth);
    const row = await D1()
      .prepare("SELECT stored_bytes, size_bytes FROM versions WHERE artifact_id = ?")
      .bind(body.id)
      .first<{ stored_bytes: number | null; size_bytes: number }>();
    expect(row?.stored_bytes).toBeNull();
    expect(row?.size_bytes).toBeGreaterThan(0);
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
});

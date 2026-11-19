// Every table that names an artifact, a person or an address has an answer for what happens to its
// rows when the artifact is deleted or taken down (services/cleanup.ts), when the artifact is
// erased, and when the person is erased (scripts/admin-lib.mjs). The answer is a statement, a
// foreign key that cascades or sets null, or a listed reason to keep it. A migration that adds such
// a table without one fails here.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ERASE_ARTIFACT_STEPS,
  ERASE_USER_KEPT,
  ERASE_USER_STEPS,
  eraseArtifactSql,
  eraseUserSql,
} from "../scripts/admin-lib.mjs";
import { ARTIFACT_KEPT, ARTIFACT_WIPE } from "../src/services/cleanup.ts";

interface Column {
  name: string;
}
interface ForeignKey {
  table: string;
  from: string;
  on_delete: string;
}

async function schema() {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`,
  ).all<{ name: string }>();
  const out: { table: string; columns: string[]; fks: ForeignKey[] }[] = [];
  for (const { name } of tables.results) {
    const cols = await env.DB.prepare(`PRAGMA table_info(${name})`).all<Column>();
    const fks = await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all<ForeignKey>();
    out.push({ table: name, columns: cols.results.map((c) => c.name), fks: fks.results });
  }
  return out;
}

const isArtifactColumn = (c: string) => c === "artifact_id" || c.endsWith("_artifact_id");
const isEmailColumn = (c: string) => c === "email" || c.endsWith("_email");
const isUserColumn = (c: string) =>
  c === "user_id" || c.endsWith("_user_id") || c.endsWith("_user") || c === "owner_id";
const releases = (fk: ForeignKey | undefined) =>
  fk !== undefined && ["CASCADE", "SET NULL"].includes(fk.on_delete.toUpperCase());

const wipeTables = new Set(ARTIFACT_WIPE.flatMap((s) => s.tables));
const keptTables = new Set(Object.keys(ARTIFACT_KEPT));
const eraseArtifactTables = new Set(ERASE_ARTIFACT_STEPS.map((s) => s.table));
const eraseUserTables = new Set(ERASE_USER_STEPS.map((s) => s.table));
const eraseUserKept = new Set(Object.keys(ERASE_USER_KEPT));

describe("cleanup and erase registries cover the schema", () => {
  it("names only tables that exist", async () => {
    const tables = new Set((await schema()).map((t) => t.table));
    for (const t of [
      ...wipeTables,
      ...keptTables,
      ...eraseArtifactTables,
      ...eraseUserTables,
      ...eraseUserKept,
    ]) {
      expect(tables.has(t), t).toBe(true);
    }
    // A table is either wiped or kept, never both.
    for (const t of wipeTables) expect(keptTables.has(t), t).toBe(false);
    // Each erase ends with the row it is about, which returns what it erased.
    expect(ERASE_USER_STEPS.at(-1)?.table).toBe("users");
    expect(ERASE_ARTIFACT_STEPS.at(-1)?.table).toBe("artifacts");
  });

  it("every table with an artifact column: wiped or kept on delete, and released on erase", async () => {
    let seen = 0;
    for (const { table, columns, fks } of await schema()) {
      for (const c of columns.filter(isArtifactColumn)) {
        seen++;
        const label = `${table}.${c}`;
        expect(wipeTables.has(table) || keptTables.has(table), `${label}: delete`).toBe(true);
        const fk = fks.find((f) => f.from === c && f.table === "artifacts");
        expect(releases(fk) || eraseArtifactTables.has(table), `${label}: erase`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("every table with a person's id or address: released when the person is erased", async () => {
    let seen = 0;
    for (const { table, columns, fks } of await schema()) {
      for (const c of columns) {
        const fk = fks.find((f) => f.from === c && f.table === "users");
        if (!fk && !isUserColumn(c) && !isEmailColumn(c)) continue;
        seen++;
        const label = `${table}.${c}`;
        const handled = eraseUserTables.has(table) || eraseUserKept.has(table);
        if (isEmailColumn(c)) expect(handled, `${label}: an address needs a step`).toBe(true);
        else
          expect(releases(fk) || handled, `${label}: a user id needs a step or a key`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });
});

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Steps added after the step lists, each with the feature that added it. The golden hash covers
 * every other step, so an addition changes no statement that was there before.
 */
const ADDED_USER_STEPS = new Set([
  // Category sharing (0013): the address on other people's category shares.
  "category_grants",
  // Files people add to a page (0014): their uploads on other people's pages.
  "artifact_files",
  // Data sources (0015): the refreshes they asked for on other people's pages.
  "data_refresh_tasks",
  // Page requests (0016): requests filed under their address, named apart from comments' step.
  "page_requests",
]);

describe("erase statements (golden)", () => {
  it("are the same SQL as before they became step lists", async () => {
    // sha256 of eraseUserSql and eraseArtifactSql at 94ea515, before the step lists.
    const before = ERASE_USER_STEPS.filter((s) => !ADDED_USER_STEPS.has(s.name ?? s.table))
      .map((s) => s.sql("ann@example.com"))
      .join("; ");
    expect(await sha256(before)).toBe(
      "d1c1b5c742a92e1f3e2d5efcc84597ad150a85556ad214376634066678260c64",
    );
    // The added steps run before the users row.
    expect(eraseUserSql("ann@example.com")).toContain(
      "DELETE FROM category_grants WHERE email = 'ann@example.com'; DELETE FROM login_codes",
    );
    expect(await sha256(eraseArtifactSql("my-slug"))).toBe(
      "5b613326da8856a70c08b9768528910074b204f4fdd64bd11d8ddeab391a9ed4",
    );
  });
});

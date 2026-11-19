// The checked-in migrations (migrations/*.sql, as the test pool reads them): numbers are unique,
// and no migration uses a table that only a higher-numbered migration creates, so they apply in
// number order on every instance. Gaps in the numbers are fine (0003 was never used).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const CREATE_RE = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi;
const USE_RE =
  /\b(?:REFERENCES|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|FROM|JOIN|ALTER\s+TABLE|ON)\s+["`]?(\w+)/gi;

/** SQL without comments, so a table named in a comment does not count as used. */
const stripComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

function numbered() {
  return env.TEST_MIGRATIONS.map((m) => {
    const match = NAME_RE.exec(m.name);
    return {
      name: m.name,
      n: match ? Number(match[1]) : Number.NaN,
      sql: stripComments(m.queries.join("\n")),
    };
  });
}

describe("migrations", () => {
  it("are named NNNN_name.sql with unique numbers, applied in number order", () => {
    const all = numbered();
    expect(all.length).toBeGreaterThan(5);
    for (const m of all) expect(Number.isInteger(m.n), m.name).toBe(true);
    const numbers = all.map((m) => m.n);
    expect(new Set(numbers).size, numbers.join(", ")).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("never use a table that a higher-numbered migration creates", () => {
    const all = numbered();
    const createdIn = new Map<string, number>();
    for (const m of all) {
      for (const [, t] of m.sql.matchAll(CREATE_RE)) {
        const name = (t as string).toLowerCase();
        expect(createdIn.has(name), `${m.name} creates ${name} again`).toBe(false);
        createdIn.set(name, m.n);
      }
    }
    expect(createdIn.size).toBeGreaterThan(10);
    for (const m of all) {
      for (const [, t] of m.sql.matchAll(USE_RE)) {
        const at = createdIn.get((t as string).toLowerCase());
        if (at === undefined) continue;
        expect(at, `${m.name} uses ${t}, created in migration ${at}`).toBeLessThanOrEqual(m.n);
      }
    }
  });
});

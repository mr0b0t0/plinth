import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  changesFromOutput,
  parseArgs,
  setLimitSql,
  UsageError,
  validateEmail,
  validateLimit,
} from "../scripts/admin-lib.mjs";
import { users } from "../src/db/schema.ts";
import { agent, db, publish } from "./helpers.ts";

describe("admin CLI: set-limit", () => {
  it("parses arguments and builds the wrangler command", () => {
    const r = parseArgs(["--", "set-limit", "Ann@Example.com", "250", "--remote"]);
    expect(r).toMatchObject({
      help: false,
      email: "ann@example.com",
      limit: 250,
      target: "remote",
    });
    if (r.help) throw new Error("unexpected help");
    expect(r.wranglerArgs).toEqual([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      "UPDATE users SET artifact_limit = 250 WHERE email = 'ann@example.com' RETURNING email",
    ]);
    const d = parseArgs(["set-limit", "a@b.co", "default", "--local", "--env", "staging"]);
    if (d.help) throw new Error("unexpected help");
    expect(d.sql).toContain("artifact_limit = NULL");
    expect(d.wranglerArgs.slice(-2)).toEqual(["--env", "staging"]);
    expect(parseArgs([])).toEqual({ help: true });
  });

  it("refuses anything that is not a plain email or whole number", () => {
    for (const bad of [
      "x'; DROP TABLE users;--@a.b",
      "a@b",
      "a b@c.d",
      'a"@b.c',
      "a@b.c;",
      "",
      `${"a".repeat(250)}@b.co`,
    ]) {
      expect(() => validateEmail(bad), bad).toThrow(UsageError);
    }
    for (const bad of ["-1", "1.5", "1e3", "0x10", "10; DROP", "", "01", "9999999999"]) {
      expect(() => validateLimit(bad), bad).toThrow(UsageError);
    }
    expect(validateLimit("0")).toBe(0);
    expect(validateLimit("DEFAULT")).toBeNull();
    expect(() => parseArgs(["set-limit", "a@b.co", "5"])).toThrow(/--local or --remote/);
    expect(() => parseArgs(["set-limit", "a@b.co", "5", "--local", "--remote"])).toThrow();
    expect(() => parseArgs(["drop", "a@b.co", "5", "--local"])).toThrow(/Unknown command/);
    expect(() => parseArgs(["set-limit", "a@b.co", "5", "--local", "--env", "x;y"])).toThrow();
  });

  it("the generated SQL sets and clears the override, and the quota follows", async () => {
    const a = await agent();
    const email = a.user.email;
    const run = (sql: string) => env.DB.prepare(sql).all<{ email: string }>();

    const set = await run(setLimitSql(validateEmail(email), validateLimit("1")));
    expect(set.results).toEqual([{ email }]);
    const row = await db().select().from(users).where(eq(users.id, a.user.id)).get();
    expect(row?.artifactLimit).toBe(1);
    expect((await publish(a.auth)).res.status).toBe(201);
    const over = await publish(a.auth);
    expect(over.res.status).toBe(403);
    expect(over.body.error.code).toBe("quota_exceeded");

    await run(setLimitSql(validateEmail(email), validateLimit("default")));
    const cleared = await db().select().from(users).where(eq(users.id, a.user.id)).get();
    expect(cleared?.artifactLimit).toBeNull();
    expect((await publish(a.auth)).res.status).toBe(201);

    const none = await run(setLimitSql("nobody@example.com", 5));
    expect(none.results).toEqual([]);
    expect(changesFromOutput(JSON.stringify([{ results: none.results, success: true }]))).toBe(0);
    expect(changesFromOutput(JSON.stringify([{ results: [{ email }], success: true }]))).toBe(1);
    expect(changesFromOutput("not json")).toBeNull();
  });
});

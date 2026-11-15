import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  artifactKeysSql,
  changesFromOutput,
  eraseArtifactSql,
  eraseUserSql,
  keysFromRows,
  parseArgs,
  resultSets,
  setLimitSql,
  UsageError,
  userKeysSql,
  validateArtifactRef,
  validateEmail,
  validateLimit,
} from "../scripts/admin-lib.mjs";
import { accessGrants, artifacts, comments, users, versions } from "../src/db/schema.ts";
import { nowIso } from "../src/lib/time.ts";
import { agent, call, db, json, publish, versionRow } from "./helpers.ts";

describe("admin CLI: set-limit", () => {
  it("parses arguments and builds the wrangler command", () => {
    const r = parseArgs(["--", "set-limit", "Ann@Example.com", "250", "--remote"]);
    expect(r).toMatchObject({
      help: false,
      email: "ann@example.com",
      limit: 250,
      target: "remote",
    });
    if (r.help || r.command !== "set-limit") throw new Error("unexpected parse");
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
    if (d.help || d.command !== "set-limit") throw new Error("unexpected parse");
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

/** Run a `;`-joined statement list the way `wrangler d1 execute --command` does. */
async function runStatements(sql: string) {
  const out = [];
  for (const stmt of sql.split("; ")) out.push((await env.DB.prepare(stmt).all()).results);
  return out;
}

async function storedKeys(sql: string) {
  const rows = (await env.DB.prepare(sql).all()).results as { prefix: string; manifest: string }[];
  return keysFromRows(rows);
}

describe("admin CLI: erase-user and erase-artifact", () => {
  it("parses both commands with --config, --bucket and --dry-run", () => {
    const r = parseArgs([
      "erase-user",
      "Ann@Example.com",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      "--bucket",
      "plinth-files",
      "--dry-run",
    ]);
    if (r.help || r.command !== "erase-user") throw new Error("unexpected parse");
    expect(r).toMatchObject({ subject: "ann@example.com", target: "remote", dryRun: true });
    expect(r.keysArgs).toContain("--config");
    expect(r.bucket).toBe("plinth-files");
    expect(r.deleteObjectArgs("plinth-files", "artifacts/abc/v1/index.html")).toEqual([
      "r2",
      "object",
      "delete",
      "plinth-files/artifacts/abc/v1/index.html",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
    ]);
    const a = parseArgs(["erase-artifact", "q3-revenue-4k2j9x0aq1", "--local"]);
    if (a.help || a.command !== "erase-artifact") throw new Error("unexpected parse");
    expect(a.subject).toBe("q3-revenue-4k2j9x0aq1");
  });

  it("refuses anything but a plain email, id or slug, and a sane config path", () => {
    expect(() => validateArtifactRef("x'; DROP TABLE users; --")).toThrow(UsageError);
    expect(() => parseArgs(["erase-user", "a@b.co"])).toThrow(/--local or --remote/);
    expect(() => parseArgs(["erase-user", "a@b.co", "--local", "--config", "../x.json"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["erase-user", "a@b.co", "--local", "--bucket", "Bad_Name"])).toThrow(
      UsageError,
    );
  });

  it("keeps only keys in Plinth's own layout", () => {
    expect(
      keysFromRows([
        {
          prefix: "artifacts/abc/v1/",
          manifest: JSON.stringify([
            { path: "index.html" },
            { path: "img/a.png" },
            { path: "../x" },
          ]),
        },
        { prefix: "artifacts/abc/v2/", manifest: "not json" },
      ]),
    ).toEqual(["artifacts/abc/v1/index.html", "artifacts/abc/v1/img/a.png"]);
    expect(resultSets('[{"results":[{"id":"u1"}]},{"results":[]}]')).toEqual([[{ id: "u1" }], []]);
  });

  it("erase-user removes the person and everything theirs, and nothing of anyone else", async () => {
    const owner = await agent();
    const other = await agent();
    const { body: mine } = await publish(owner.auth, { title: "Mine" });
    await publish(owner.auth, { title: "Mine too" });
    const { body: theirs } = await publish(other.auth, { title: "Theirs" });
    // The person was given commenter access to someone else's artifact and commented there.
    await db()
      .insert(accessGrants)
      .values({
        artifactId: theirs.id,
        email: owner.user.email,
        role: "commenter",
        createdAt: nowIso(),
      })
      .run();
    const res = await call(`/api/v1/artifacts/${theirs.slug}/comments`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "My note on their page" }),
    });
    expect(res.status).toBe(201);

    const keys = await storedKeys(userKeysSql(owner.user.email));
    expect(keys).toContain(`${(await versionRow(mine.id, 1))?.r2Prefix}index.html`);
    for (const k of keys) expect(await env.FILES.head(k)).not.toBeNull();

    const sets = await runStatements(eraseUserSql(owner.user.email));
    expect(sets[sets.length - 1]).toHaveLength(1);

    expect(
      await db().select().from(users).where(eq(users.id, owner.user.id)).get(),
    ).toBeUndefined();
    expect(
      await db().select().from(artifacts).where(eq(artifacts.ownerId, owner.user.id)).all(),
    ).toEqual([]);
    expect(
      await db().select().from(versions).where(eq(versions.artifactId, mine.id)).all(),
    ).toEqual([]);
    expect(
      await db().select().from(comments).where(eq(comments.artifactId, theirs.id)).all(),
    ).toEqual([]);
    expect(
      await db().select().from(accessGrants).where(eq(accessGrants.email, owner.user.email)).all(),
    ).toEqual([]);
    // The other person's artifact is untouched.
    expect(
      await db().select().from(artifacts).where(eq(artifacts.id, theirs.id)).get(),
    ).toBeDefined();
  });

  it("erase-artifact removes one artifact with its versions, by id or slug", async () => {
    const owner = await agent();
    const { body: a } = await publish(owner.auth, { title: "Gone soon" });
    expect(await storedKeys(artifactKeysSql(a.slug))).toEqual([
      `${(await versionRow(a.id, 1))?.r2Prefix}index.html`,
    ]);
    const erased = (await runStatements(eraseArtifactSql(a.slug))).at(-1);
    expect(erased).toHaveLength(1);
    expect(await db().select().from(versions).where(eq(versions.artifactId, a.id)).all()).toEqual(
      [],
    );
    const again = (await runStatements(eraseArtifactSql(a.id))).at(-1);
    expect(again).toHaveLength(0);
  });

  it("erase-artifact also removes the upload ticket that published it, with its title", async () => {
    const owner = await agent();
    const { body: a } = await publish(owner.auth, { title: "Gone soon" });
    const now = new Date().toISOString();
    // A used publish-mode ticket names the artifact only through result_artifact_id.
    await env.DB.prepare(
      `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id, scopes, mode,
         artifact_type, title, state, attempts, result_artifact_id, result_version, created_at,
         expires_at, used_at)
       SELECT ?1, ?2, c.user_id, 'connection', c.id, 'artifacts:write', 'publish', 'html',
              'Secret project name', 'used', 1, ?3, 1, ?4, ?4, ?4
         FROM agent_connections c WHERE c.user_id = (SELECT owner_id FROM artifacts WHERE id = ?3)
        LIMIT 1`,
    )
      .bind("t".repeat(20), "h".repeat(64), a.id, now)
      .run();
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM upload_tickets WHERE result_artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(before?.n).toBe(1);
    const erased = (await runStatements(eraseArtifactSql(a.slug))).at(-1);
    expect(erased).toHaveLength(1);
    const after = await env.DB.prepare(
      "SELECT count(*) AS n FROM upload_tickets WHERE result_artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

// Shared data (docs/superpowers/specs/2026-11-14-shared-state-design.md section 11).
describe("admin CLI: shared data", () => {
  const POLL = '<!doctype html><title>Poll</title><meta name="plinth-capabilities" content="data">';
  const ops = (auth: Record<string, string>, ref: string, list: unknown[]) =>
    call(`/api/v1/artifacts/${ref}/data`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ops: list }),
    });
  const docsOf = async (artifactId: string) =>
    (
      await env.DB.prepare(
        "SELECT doc_id, created_by_email, updated_by_email, updated_by_role, updated_by_label FROM artifact_docs WHERE artifact_id = ?1 ORDER BY doc_id",
      )
        .bind(artifactId)
        .all<{
          doc_id: string;
          created_by_email: string | null;
          updated_by_email: string | null;
          updated_by_role: string | null;
          updated_by_label: string | null;
        }>()
    ).results;

  it("erase-user deletes the person's documents and scrubs their edits on others' artifacts", async () => {
    const sql = eraseUserSql("ann@example.com");
    const statements = sql.split("; ");
    const del = "DELETE FROM artifact_docs WHERE created_by_email = 'ann@example.com'";
    const scrub =
      "UPDATE artifact_docs SET updated_by_email = NULL, updated_by_role = NULL, updated_by_label = NULL WHERE updated_by_email = 'ann@example.com'";
    expect(statements).toContain(del);
    expect(statements).toContain(scrub);
    const users = statements.findIndex((s) => s.startsWith("DELETE FROM users"));
    expect(statements.indexOf(del)).toBeLessThan(users);
    expect(statements.indexOf(scrub)).toBeLessThan(users);

    const owner = await agent();
    const person = await agent();
    const { body: a } = await publish(owner.auth, { html: POLL });
    await db()
      .insert(accessGrants)
      .values({ artifactId: a.id, email: person.user.email, role: "editor", createdAt: nowIso() })
      .run();
    expect(
      (
        await ops(owner.auth, a.id, [
          { op: "set", collection: "rows", doc_id: "o1", data: { n: 1 }, if_rev: 0 },
        ])
      ).status,
    ).toBe(200);
    const res = await ops(person.auth, a.id, [
      { op: "set", collection: "rows", doc_id: "p1", data: { n: 2 }, if_rev: 0 },
      { op: "set", collection: "rows", doc_id: "o1", data: { n: 3 }, if_rev: 1 },
    ]);
    expect((await json(res)).results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
    // The person's agent connection label was stamped on their edit of o1.
    expect((await docsOf(a.id)).find((d) => d.doc_id === "o1")?.updated_by_label).toBeTruthy();

    const sets = await runStatements(eraseUserSql(person.user.email));
    expect(sets[sets.length - 1]).toHaveLength(1);
    expect(await docsOf(a.id)).toEqual([
      {
        doc_id: "o1",
        created_by_email: owner.user.email,
        updated_by_email: null,
        updated_by_role: null,
        updated_by_label: null,
      },
    ]);
    // The usage row still matches the documents (the triggers ran).
    const usage = await env.DB.prepare(
      "SELECT docs, bytes FROM artifact_data_usage WHERE artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ docs: number; bytes: number }>();
    const sum = await env.DB.prepare(
      "SELECT count(*) AS docs, coalesce(sum(size_bytes), 0) AS bytes FROM artifact_docs WHERE artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ docs: number; bytes: number }>();
    expect(usage).toEqual(sum);
  });

  it("erase-artifact removes the artifact's documents and usage row by cascade", async () => {
    const owner = await agent();
    const { body: a } = await publish(owner.auth, { html: POLL });
    await ops(owner.auth, a.id, [
      { op: "set", collection: "rows", doc_id: "o1", data: { n: 1 }, if_rev: 0 },
    ]);
    expect(await docsOf(a.id)).toHaveLength(1);
    const erased = (await runStatements(eraseArtifactSql(a.id))).at(-1);
    expect(erased).toHaveLength(1);
    expect(await docsOf(a.id)).toEqual([]);
    const usage = await env.DB.prepare(
      "SELECT count(*) AS n FROM artifact_data_usage WHERE artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(usage?.n).toBe(0);
  });
});

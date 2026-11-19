// The admin CLI's storage helpers with the commit-last layout: stored_at keys, sweep-orphans, and
// delete and erase leaving nothing under artifacts/<id>/.

import { env } from "cloudflare:workers";
import { TTL } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  artifactKeysSql,
  artifactRootOf,
  deleteRoots,
  eraseArtifactSql,
  eraseUserSql,
  filesBucket,
  keysFromRows,
  MIN_SWEEP_MINUTES,
  orphanPrefixes,
  parseArgs,
  parseResultSets,
  rootsFromRows,
  SweepRefused,
  sweepOrphans,
  TOMBSTONE_SQL,
  UsageError,
  userKeysSql,
  versionPrefixesSql,
} from "../scripts/admin-lib.mjs";
import { STAGING_SWEEP_AFTER_MS, STAGING_SWEEP_CLAIM_MS } from "../src/services/attempts.ts";
import { commitStaged, openStager, updateTarget } from "../src/services/stage.ts";
import {
  agent,
  agentPrincipal,
  call,
  fetchWith,
  manifestOf,
  publish,
  r2Keys,
  serviceCtxFor,
  sha256Of,
  storedFile,
  versionRow,
} from "./helpers.ts";

async function rows(sql: string) {
  return (await env.DB.prepare(sql).all()).results as {
    artifact_id: string;
    prefix: string | null;
    manifest: string | null;
  }[];
}

async function runStatements(sql: string) {
  for (const stmt of sql.split("; ")) await env.DB.prepare(stmt).all();
}

/** An artifact with a reused file (stored_at), a carried one, and a leftover attempt prefix. */
async function layered() {
  const a = await agent();
  const { body: p } = await publish(a.auth, {
    assets: [
      { path: "a.css", content: "a" },
      { path: "b.css", content: "b" },
    ],
  });
  const put = (body: Record<string, unknown>) =>
    call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await put({
    html: "<p>2</p>",
    assets: [
      { path: "renamed.css", sha256: await sha256Of("a") },
      { path: "c.css", content: "c" },
    ],
  });
  await put({ html: "<p>3</p>" });
  const orphan = `artifacts/${p.id}/v4.zzzzzzzzzzzz/`;
  await env.FILES.put(`${orphan}index.html`, "<p>never committed</p>");
  return { a, p, orphan };
}

describe("admin-lib keys", () => {
  it("keysFromRows resolves stored_at against the artifact root and accepts nonce prefixes", () => {
    const id = "abcdefghij0123456789";
    expect(
      keysFromRows([
        {
          prefix: `artifacts/${id}/v2.aaaaaaaaaaaa/`,
          manifest: JSON.stringify([
            { path: "index.html" },
            { path: "x.css", stored_at: "v1/x.css" },
            { path: "y.css", stored_at: "v1.bbbbbbbbbbbb/y.css" },
            { path: "bad1.css", stored_at: "v1/../../other/v1/x.css" },
            { path: "bad2.css", stored_at: "../other/v1/x.css" },
            { path: "bad3.css", stored_at: 5 },
          ]),
        },
        { prefix: null, manifest: null },
        { prefix: "elsewhere/v1/", manifest: JSON.stringify([{ path: "index.html" }]) },
      ]),
    ).toEqual([
      `artifacts/${id}/v2.aaaaaaaaaaaa/index.html`,
      `artifacts/${id}/v1/x.css`,
      `artifacts/${id}/v1.bbbbbbbbbbbb/y.css`,
    ]);
    expect(artifactRootOf(`artifacts/${id}/v3.cccccccccccc/`)).toBe(`artifacts/${id}/`);
    expect(artifactRootOf("artifacts/x/../")).toBeNull();
    expect(rootsFromRows([{ artifact_id: id }, { artifact_id: "nope'" }])).toEqual([
      `artifacts/${id}/`,
    ]);
  });

  it("every object the versions point to is listed, reused ones included", async () => {
    const { p } = await layered();
    const keys = await keysFromRows(await rows(artifactKeysSql(p.id)));
    const v1 = await versionRow(p.id, 1);
    expect(keys).toContain(`${v1?.r2Prefix}a.css`);
    for (const n of [1, 2, 3]) {
      for (const e of await manifestOf(p.id, n)) {
        expect(keys.some((k) => k.endsWith(e.stored_at ?? `${e.path}`))).toBe(true);
      }
    }
    for (const k of keys) expect(await env.FILES.head(k), k).not.toBeNull();
  });
});

describe("sweep-orphans", () => {
  it("parses its options", () => {
    const r = parseArgs([
      "sweep-orphans",
      "--remote",
      "--artifact",
      "Q3-Revenue",
      "--older-than-minutes",
      "120",
      "--dry-run",
      "--config",
      "wrangler.production.jsonc",
    ]);
    if (r.help || r.command !== "sweep-orphans") throw new Error("unexpected parse");
    expect(r).toMatchObject({ artifact: "q3-revenue", minAgeMs: 120 * 60_000, dryRun: true });
    expect(r.prefixesArgs).toContain(versionPrefixesSql("q3-revenue"));
    expect(r.prefixesArgs).toContain("--config");
    const all = parseArgs(["sweep-orphans", "--local"]);
    if (all.help || all.command !== "sweep-orphans") throw new Error("unexpected parse");
    expect(all).toMatchObject({ artifact: null, minAgeMs: 60 * 60_000, dryRun: false });
    expect(() => parseArgs(["sweep-orphans"])).toThrow(/--local or --remote/);
    expect(() => parseArgs(["sweep-orphans", "--local", "--older-than-minutes", "0"])).toThrow(
      UsageError,
    );
    // Below the floor an upload that is still streaming could lose its files.
    expect(() =>
      parseArgs([
        "sweep-orphans",
        "--local",
        "--older-than-minutes",
        String(MIN_SWEEP_MINUTES - 1),
      ]),
    ).toThrow(/45 or more/);
    // Above a ticket's whole lifetime, not only the receiving lease: a slow bundle can commit
    // until the ticket expires.
    expect(MIN_SWEEP_MINUTES * 60_000).toBeGreaterThanOrEqual(TTL.uploadTicketMs + 15 * 60_000);
    const floor = parseArgs([
      "sweep-orphans",
      "--local",
      "--older-than-minutes",
      String(MIN_SWEEP_MINUTES),
    ]);
    if (floor.help || floor.command !== "sweep-orphans") throw new Error("unexpected parse");
    expect(floor.minAgeMs).toBe(MIN_SWEEP_MINUTES * 60_000);
    // No bucket unless --bucket: it comes from the config the database comes from.
    expect(all.bucket).toBeNull();
    expect(() => parseArgs(["sweep-orphans", "--local", "--artifact", "x'; --"])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(["set-limit", "a@b.co", "3", "--local", "--artifact", "abc"])).toThrow(
      /--artifact is for sweep-orphans/,
    );
  });

  it("deletes only unreferenced prefixes older than the threshold, never a committed one", async () => {
    const { p, orphan } = await layered();
    const later = Date.now() + 2 * 3600_000;
    const swept = await sweepOrphans(env.FILES, {
      root: `artifacts/${p.id}/`,
      now: later,
      minAgeMs: 3600_000,
      dryRun: false,
      loadRows: () => rows(versionPrefixesSql(p.id)),
    });
    expect(swept).toEqual([{ prefix: orphan, files: 1 }]);
    expect(await r2Keys(orphan)).toEqual([]);
    // Every committed version's objects are still there.
    for (const k of keysFromRows(await rows(artifactKeysSql(p.id))))
      expect(await env.FILES.head(k), k).not.toBeNull();
  });

  it("a sweep at the floor never takes the files of an upload its ticket may still commit", async () => {
    // A slow bundle's early files reach R2 at once; the ticket may commit up to 30 minutes after
    // it was minted. A sweep at --older-than-minutes MIN_SWEEP_MINUTES, run as late as the
    // ticket allows, must leave those files alone.
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    const enc = new TextEncoder();
    await stager.add("a.js", enc.encode("console.log('a')"));
    await stager.add("b.css", enc.encode("h1{}"));
    const swept = await sweepOrphans(env.FILES, {
      root: `artifacts/${p.id}/`,
      now: Date.now() + TTL.uploadTicketMs - 1000,
      minAgeMs: MIN_SWEEP_MINUTES * 60_000,
      dryRun: false,
      loadRows: () => rows(versionPrefixesSql(p.id)),
    });
    expect(swept).toEqual([]);
    await stager.add("index.html", enc.encode("<!doctype html><script src=a.js></script>"));
    const r = await commitStaged(ctx, target, await stager.finish());
    expect(r.version).toBe(2);
    expect(await storedFile(p.id, 2, "a.js")).not.toBeNull();
    expect(await storedFile(p.id, 2, "b.css")).not.toBeNull();
  });

  it("deletes nothing when the database answer is empty or names nothing in the bucket", async () => {
    const { p } = await layered();
    const before = (await r2Keys(`artifacts/${p.id}/`)).sort();
    const opts = {
      now: Date.now() + 2 * 3600_000,
      minAgeMs: 3600_000,
      dryRun: false,
    };
    for (const root of ["artifacts/", `artifacts/${p.id}/`]) {
      // No rows (an empty or wrong database): every file would look orphaned.
      await expect(
        sweepOrphans(env.FILES, { ...opts, root, loadRows: async () => [] }),
      ).rejects.toThrow(SweepRefused);
      // Rows of another instance: none of the prefixes they name is in this bucket.
      await expect(
        sweepOrphans(env.FILES, {
          ...opts,
          root,
          loadRows: async () => [
            { artifact_id: "zzzzzzzzzzzzzzzzzzzz", prefix: "artifacts/zzzzzzzzzzzzzzzzzzzz/v1/" },
          ],
        }),
      ).rejects.toThrow(/different instances/);
      // An answer that is not rows at all.
      await expect(
        sweepOrphans(env.FILES, {
          ...opts,
          root,
          loadRows: async () => null as unknown as { prefix?: unknown }[],
        }),
      ).rejects.toThrow(SweepRefused);
    }
    expect((await r2Keys(`artifacts/${p.id}/`)).sort()).toEqual(before);
  });

  it("reads the rows after listing, so a version that commits meanwhile keeps its files", async () => {
    const { p, orphan } = await layered();
    const order: string[] = [];
    const bucket = {
      list: async (o: { prefix: string; cursor?: string }) => {
        order.push("list");
        return env.FILES.list(o);
      },
      delete: async (keys: string[]) => {
        order.push("delete");
        return env.FILES.delete(keys);
      },
    };
    const swept = await sweepOrphans(bucket, {
      root: `artifacts/${p.id}/`,
      now: Date.now() + 2 * 3600_000,
      minAgeMs: 3600_000,
      dryRun: false,
      loadRows: async () => {
        order.push("rows");
        // The attempt prefix committed between the listing and this read.
        return [...(await rows(versionPrefixesSql(p.id))), { artifact_id: p.id, prefix: orphan }];
      },
    });
    expect(swept).toEqual([]);
    expect(order).toEqual(["list", "rows"]);
    expect(await r2Keys(orphan)).toHaveLength(1);
  });

  it("parseResultSets tells unparseable output apart from no rows", () => {
    expect(parseResultSets("not json")).toBeNull();
    expect(parseResultSets("")).toBeNull();
    expect(parseResultSets("[]")).toBeNull();
    expect(parseResultSets(JSON.stringify([{ error: "boom" }]))).toBeNull();
    expect(parseResultSets(JSON.stringify([{ results: [] }]))).toEqual([[]]);
    expect(parseResultSets(JSON.stringify({ results: [{ prefix: "x" }] }))).toEqual([
      [{ prefix: "x" }],
    ]);
  });

  it("the bucket is the FILES binding of the database's own config and environment", () => {
    // What wrangler resolves for `--config wrangler.staging.jsonc` (docs/staging.md).
    const staging = [
      { binding: "OTHER", bucket_name: "plinth-files" },
      { binding: "FILES", bucket_name: "plinth-staging" },
    ];
    expect(filesBucket(staging, null)).toBe("plinth-staging");
    expect(filesBucket(staging, "plinth-staging")).toBe("plinth-staging");
    // --bucket that disagrees with the config is refused, never used.
    expect(() => filesBucket(staging, "plinth-files")).toThrow(/different instances/);
    // An environment section without a FILES bucket is refused, not defaulted.
    expect(() => filesBucket([], null)).toThrow(UsageError);
    expect(() => filesBucket(undefined, null)).toThrow(UsageError);
    expect(() => filesBucket([{ binding: "FILES", bucket_name: "Bad_Name" }], null)).toThrow(
      UsageError,
    );
  });

  it("groups by top-level prefix and keeps a young prefix", () => {
    const id = "abcdefghij0123456789";
    const now = Date.parse("2026-11-14T12:00:00Z");
    const objects = [
      { key: `artifacts/${id}/v1/index.html`, uploaded: "2026-11-14T08:00:00Z" },
      { key: `artifacts/${id}/v2.aaaaaaaaaaaa/index.html`, uploaded: "2026-11-14T08:00:00Z" },
      { key: `artifacts/${id}/v2.aaaaaaaaaaaa/x/y.css`, uploaded: "2026-11-14T08:00:00Z" },
      { key: `artifacts/${id}/v3.bbbbbbbbbbbb/index.html`, uploaded: "2026-11-14T11:50:00Z" },
      { key: `artifacts/${id}/stray`, uploaded: "2026-11-14T08:00:00Z" },
    ];
    const out = orphanPrefixes(objects, new Set([`artifacts/${id}/v1/`]), {
      now,
      minAgeMs: 3600_000,
    });
    expect(out.map((g) => [g.prefix, g.keys.length])).toEqual([
      [`artifacts/${id}/v2.aaaaaaaaaaaa/`, 2],
    ]);
  });
});

describe("after delete or erase, R2 holds nothing under artifacts/<id>/", () => {
  it("DELETE /artifacts/:ref removes every object, reused origins and leftovers included", async () => {
    const { a, p } = await layered();
    expect((await r2Keys(`artifacts/${p.id}/`)).length).toBeGreaterThan(0);
    const res = await fetchWith({}, `/api/v1/artifacts/${p.id}`, {
      method: "DELETE",
      headers: a.auth,
    });
    expect(res.status).toBe(204);
    expect(await r2Keys(`artifacts/${p.id}/`)).toEqual([]);
  });

  it("erase-artifact: the listed keys, then the rest of the root, then the rows", async () => {
    const { p } = await layered();
    const found = await rows(artifactKeysSql(p.id));
    const keys = keysFromRows(found);
    await env.FILES.delete(keys);
    // What no version row names (the leftover attempt) is still there until the root sweep.
    expect((await r2Keys(`artifacts/${p.id}/`)).length).toBe(1);
    expect(await deleteRoots(env.FILES, rootsFromRows(found))).toBe(1);
    await runStatements(eraseArtifactSql(p.id));
    expect(await r2Keys(`artifacts/${p.id}/`)).toEqual([]);
  });

  it("erase-artifact and erase-user park the artifacts' staging attempt rows as tombstones", async () => {
    const owner = await agent();
    const { body: one } = await publish(owner.auth, { title: "one" });
    const { body: two } = await publish(owner.auth, { title: "two" });
    const ctx = serviceCtxFor(agentPrincipal(owner));
    for (const id of [one.id, two.id]) {
      const stager = await openStager(ctx, await updateTarget(ctx, id, {}));
      await stager.add("index.html", new TextEncoder().encode("<p>left</p>"));
      await stager.add("left.css", new TextEncoder().encode("left"));
    }
    // Live rows (unclaimed: they sort at or above "1"), and tombstones parked by D1's clock.
    const count = async (id: string, parked: boolean) =>
      (
        await env.DB.prepare(
          `SELECT count(*) AS n FROM staging_attempts WHERE artifact_id = ? AND started_at ${parked ? "<" : ">="} '1'`,
        )
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    expect(await count(one.id, false)).toBe(1);
    const before = Date.now();
    await runStatements(eraseArtifactSql(one.id));
    expect(await count(one.id, false)).toBe(0);
    expect(await count(one.id, true)).toBe(1);
    expect(await count(two.id, false)).toBe(1);
    await runStatements(eraseUserSql(owner.user.email));
    expect(await count(two.id, false)).toBe(0);
    // The tombstone is tombstoneAt by D1's clock: the sweep takes it once no attempt can put.
    const row = await env.DB.prepare(
      "SELECT started_at FROM staging_attempts WHERE artifact_id = ?",
    )
      .bind(two.id)
      .first<{ started_at: string }>();
    const at = Date.parse(row?.started_at.slice(1) ?? "");
    const hold = STAGING_SWEEP_AFTER_MS - STAGING_SWEEP_CLAIM_MS;
    expect(at).toBeGreaterThanOrEqual(before + hold - 5000);
    expect(at).toBeLessThanOrEqual(Date.now() + hold + 5000);
    expect(row?.started_at.slice(0, 1)).toBe("0");
    expect(row?.started_at.slice(1)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(TOMBSTONE_SQL).toContain(`+${hold / 60_000} minutes`);
  });

  it("erase-user: roots of artifacts with no version row are listed too", async () => {
    const owner = await agent();
    const { body: one } = await publish(owner.auth, { title: "one" });
    const { body: two } = await publish(owner.auth, { title: "two" });
    // An artifact whose only version row is gone (its objects remain).
    await env.DB.prepare("DELETE FROM versions WHERE artifact_id = ?").bind(two.id).run();
    const found = await rows(userKeysSql(owner.user.email));
    expect(rootsFromRows(found).sort()).toEqual(
      [`artifacts/${one.id}/`, `artifacts/${two.id}/`].sort(),
    );
    await env.FILES.delete(keysFromRows(found));
    await deleteRoots(env.FILES, rootsFromRows(found));
    await runStatements(eraseUserSql(owner.user.email));
    expect(await r2Keys(`artifacts/${one.id}/`)).toEqual([]);
    expect(await r2Keys(`artifacts/${two.id}/`)).toEqual([]);
  });
});

describe("erase-user and live doc drafts (#36)", () => {
  it("keeps the text of a draft on someone else's doc but not who wrote it; drafts on the user's own docs go", async () => {
    const owner = await agent();
    const editor = await agent();
    const { body: theirs } = await publish(owner.auth, {
      html: undefined,
      type: "doc",
      content: "# Theirs\n",
    });
    const { body: own } = await publish(editor.auth, {
      html: undefined,
      type: "doc",
      content: "# Own\n",
    });
    const now = new Date().toISOString();
    for (const id of [theirs.id, own.id]) {
      await env.DB.prepare(
        `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, updated_by_user, created_at, updated_at)
         VALUES (?1, 1, 'edited', 6, 2, ?2, ?3, ?3)`,
      )
        .bind(id, editor.user.id, now)
        .run();
    }
    expect(eraseUserSql(editor.user.email)).toContain(
      "UPDATE live_drafts SET updated_by_user = NULL",
    );
    await runStatements(eraseUserSql(editor.user.email));
    const row = (id: string) =>
      env.DB.prepare("SELECT content, updated_by_user FROM live_drafts WHERE artifact_id = ?1")
        .bind(id)
        .first();
    expect(await row(theirs.id)).toEqual({ content: "edited", updated_by_user: null });
    expect(await row(own.id)).toBeNull();
  });
});

describe("erase-user and data sources (0015)", () => {
  const insertSource = (artifactId: string, connectionId: string | null) =>
    env.DB.prepare(
      `INSERT INTO data_sources (artifact_id, source_id, label, connector, recipe, collection,
         target_client_type, target_connection, config_hash, confirmed_hash, created_by_connection,
         created_at, updated_at)
       VALUES (?1, 'linear', 'Open issues', 'Linear', 'count', 'issues', 'claude', ?2, 'h', 'h', ?2,
         't', 't')`,
    )
      .bind(artifactId, connectionId)
      .run();
  const insertTask = (id: string, artifactId: string, email: string | null, state = "pending") =>
    env.DB.prepare(
      `INSERT INTO data_refresh_tasks (id, artifact_id, source_id, config_hash, reason,
         requested_by_email, requested_by_role, requested_via, state, claimed_by, created_at, expires_at)
       VALUES (?1, ?2, 'linear', 'h', 'request', ?3, 'editor', 'app', ?4, NULL, 't', 't')`,
    )
      .bind(id, artifactId, email, state)
      .run();

  it("erases an owner with a pinned source and a claimed task: user, artifact, source and task go", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    await insertSource(p.id, owner.connectionId);
    await insertTask(`claimed-${p.id}`, p.id, null, "claimed");
    await env.DB.prepare("UPDATE data_refresh_tasks SET claimed_by = ?1 WHERE id = ?2")
      .bind(owner.connectionId, `claimed-${p.id}`)
      .run();
    await runStatements(eraseUserSql(owner.user.email));
    const count = async (sql: string, v: string) =>
      (await env.DB.prepare(sql).bind(v).first<{ n: number }>())?.n;
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?1", owner.user.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM artifacts WHERE id = ?1", p.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM data_sources WHERE artifact_id = ?1", p.id)).toBe(
      0,
    );
    expect(
      await count("SELECT count(*) AS n FROM data_refresh_tasks WHERE artifact_id = ?1", p.id),
    ).toBe(0);
  });

  it("erasing a person who asked for a refresh on someone else's page keeps the task, not who asked", async () => {
    const owner = await agent();
    const asker = await agent();
    const { body: p } = await publish(owner.auth);
    await insertSource(p.id, null);
    await insertTask(`asked-${p.id}`, p.id, asker.user.email);
    expect(eraseUserSql(asker.user.email)).toContain(
      "UPDATE data_refresh_tasks SET requested_by_email = NULL, requested_by_role = NULL",
    );
    await runStatements(eraseUserSql(asker.user.email));
    const row = await env.DB.prepare(
      "SELECT requested_by_email, requested_by_role, state FROM data_refresh_tasks WHERE id = ?1",
    )
      .bind(`asked-${p.id}`)
      .first();
    expect(row).toEqual({ requested_by_email: null, requested_by_role: null, state: "pending" });
  });
});

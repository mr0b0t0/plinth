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
  UsageError,
  userKeysSql,
  versionPrefixesSql,
} from "../scripts/admin-lib.mjs";
import {
  agent,
  call,
  fetchWith,
  manifestOf,
  publish,
  r2Keys,
  sha256Of,
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
    ).toThrow(/15 or more/);
    expect(MIN_SWEEP_MINUTES * 60_000).toBeGreaterThan(TTL.uploadReceivingMs);
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

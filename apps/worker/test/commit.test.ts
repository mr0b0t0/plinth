// Commit last (docs/spec.md): objects go to R2 under a unique attempt prefix, then one guarded D1
// batch commits the version, or nothing is committed and only that prefix holds leftovers.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sweepOrphans } from "../scripts/admin-lib.mjs";
import { artifacts, users, versions } from "../src/db/schema.ts";
import { publishArtifact, restoreVersion, updateArtifact } from "../src/services/artifacts.ts";
import { commitStaged, openStager, updateTarget } from "../src/services/stage.ts";
import {
  agent,
  agentPrincipal,
  call,
  contentOrigin,
  db,
  enterContent,
  json,
  publish,
  r2Keys,
  serviceCtxFor,
  spy,
  versionRow,
} from "./helpers.ts";

const enc = new TextEncoder();

async function currentVersion(id: string) {
  return (await db().select().from(artifacts).where(eq(artifacts.id, id)).get())?.currentVersion;
}

async function versionCount(id: string) {
  return (await db().select().from(versions).where(eq(versions.artifactId, id)).all()).length;
}

/** Top-level prefixes (artifacts/<id>/<segment>/) holding objects. */
async function prefixesOf(id: string) {
  return [
    ...new Set(
      (await r2Keys(`artifacts/${id}/`)).map((k) => `${k.split("/").slice(0, 3).join("/")}/`),
    ),
  ].sort();
}

/** A D1 binding whose batch() fails, as if the invocation died at the commit. */
function failingBatch(log: string[] = []) {
  return new Proxy(env.DB, {
    get(t, prop) {
      if (prop === "batch") {
        return async () => {
          log.push("batch");
          throw new Error("injected: batch failed");
        };
      }
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

describe("commit last", () => {
  it("writes every object before the one D1 batch", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const log: string[] = [];
    const files = new Proxy(env.FILES, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "put")
          return (...args: Parameters<R2Bucket["put"]>) => {
            log.push(`put ${String(args[0]).split("/").slice(2).join("/")}`);
            return (v as R2Bucket["put"]).apply(t, args);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const DB = new Proxy(env.DB, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "batch")
          return (s: D1PreparedStatement[]) => {
            log.push("batch");
            return t.batch(s);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES: files, DB } });
    const r = await updateArtifact(ctx, {
      id: p.id,
      html: "<p>2</p>",
      assets: [
        { path: "a.css", content: "a" },
        { path: "b.css", content: "b" },
      ],
    });
    expect(r.version).toBe(2);
    expect(log.at(-1)).toBe("batch");
    expect(log.filter((l) => l === "batch")).toHaveLength(1);
    const prefix = (await versionRow(p.id, 2))?.r2Prefix ?? "";
    const seg = prefix.split("/")[2];
    expect(log.slice(0, -1).sort()).toEqual(
      [`put ${seg}/a.css`, `put ${seg}/b.css`, `put ${seg}/index.html`].sort(),
    );
    expect(prefix).toMatch(/\/v2\.[a-z0-9]{12}\/$/);
  });

  it("a failed batch leaves no row, no false conflict, and only its own prefix to sweep", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "keep.css", content: "k" }] });
    const before = await prefixesOf(p.id);
    // The batch fails and the cleanup cannot run either (a killed invocation).
    const files = new Proxy(env.FILES, {
      get(t, prop) {
        if (prop === "delete") return async () => undefined;
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB: failingBatch(), FILES: files } });
    await expect(
      updateArtifact(ctx, {
        id: p.id,
        html: "<p>lost</p>",
        assets: [{ path: "new.css", content: "n" }],
      }),
    ).rejects.toThrow(/injected/);
    expect(await currentVersion(p.id)).toBe(1);
    expect(await versionCount(p.id)).toBe(1);
    const after = await prefixesOf(p.id);
    expect(after).toHaveLength(before.length + 1);
    const leftover = after.find((x) => !before.includes(x)) ?? "";
    expect(leftover).toMatch(new RegExp(`^artifacts/${p.id}/v2\\.[a-z0-9]{12}/$`));

    // The artifact is still updatable: the next writer gets v2 under its own prefix.
    const ok = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>", base_version: 1 }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).version).toBe(2);

    // sweep-orphans removes exactly the leftover prefix.
    const rows = (
      await env.DB.prepare(
        "SELECT artifact_id, r2_prefix AS prefix FROM versions WHERE artifact_id = ?",
      )
        .bind(p.id)
        .all()
    ).results;
    const loadRows = async () => rows;
    const dry = await sweepOrphans(env.FILES, {
      root: `artifacts/${p.id}/`,
      now: Date.now() + 2 * 3600_000,
      minAgeMs: 3600_000,
      dryRun: true,
      loadRows,
    });
    expect(dry.map((g) => g.prefix)).toEqual([leftover]);
    // A young leftover (a publish possibly still in flight) is left alone.
    expect(
      await sweepOrphans(env.FILES, {
        root: `artifacts/${p.id}/`,
        now: Date.now(),
        minAgeMs: 3600_000,
        dryRun: false,
        loadRows,
      }),
    ).toEqual([]);
    await sweepOrphans(env.FILES, {
      root: `artifacts/${p.id}/`,
      now: Date.now() + 2 * 3600_000,
      minAgeMs: 3600_000,
      dryRun: false,
      loadRows,
    });
    expect(await prefixesOf(p.id)).not.toContain(leftover);
    expect(await prefixesOf(p.id)).toHaveLength(2);
    // Every committed version still serves.
    const { cookie } = await enterContent(p.id);
    const get = (path: string) =>
      call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } });
    expect(await (await get("/")).text()).toBe("<p>2</p>");
    expect(await (await get("/keep.css")).text()).toBe("k");
    expect(await (await get("/__plinth/v/1/")).text()).toContain("Hello");
  });

  it("a failed publish batch creates no artifact row", async () => {
    const a = await agent();
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB: failingBatch() } });
    await expect(
      publishArtifact(ctx, { title: "never", html: "<p>x</p>", visibility: "unlisted" }),
    ).rejects.toThrow(/injected/);
    const mine = await db().select().from(artifacts).where(eq(artifacts.ownerId, a.user.id)).all();
    expect(mine).toEqual([]);
  });

  it("a failed put leaves no row and, after every put settled, nothing under the prefix", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const files = new Proxy(env.FILES, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const key = String(args[0]);
            if (key.endsWith("/bad.css")) throw new Error("injected: put failed");
            // Slow puts land after the failure: cleanup must wait for them.
            if (key.includes("/slow")) await new Promise((r) => setTimeout(r, 40));
            return (v as R2Bucket["put"]).apply(t, args);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES: files } });
    const before = await prefixesOf(p.id);
    await expect(
      updateArtifact(ctx, {
        id: p.id,
        html: "<p>2</p>",
        assets: [
          { path: "slow1.css", content: "1" },
          { path: "slow2.css", content: "2" },
          { path: "bad.css", content: "x" },
        ],
      }),
    ).rejects.toThrow(/injected/);
    await new Promise((r) => setTimeout(r, 80));
    expect(await prefixesOf(p.id)).toEqual(before);
    expect(await versionCount(p.id)).toBe(1);
  });

  it("clears a legacy orphan row (above current_version, over 10 minutes old) and retries", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const orphanPrefix = `artifacts/${p.id}/v2/`;
    await env.FILES.put(`${orphanPrefix}index.html`, "<p>orphan</p>");
    const insertOrphan = (createdAt: string) =>
      env.DB.prepare(
        `INSERT INTO versions (id, artifact_id, number, r2_prefix, size_bytes, manifest, created_at)
         VALUES (?, ?, 2, ?, 13, '[]', ?)`,
      )
        .bind(`orphan${Math.random().toString(36).slice(2, 10)}`, p.id, orphanPrefix, createdAt)
        .run();

    // A young one may be an old Worker mid-write: refused, nothing changes.
    await insertOrphan(new Date().toISOString());
    const young = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>", base_version: 1 }),
    });
    expect(young.status).toBe(409);
    expect(await env.FILES.head(`${orphanPrefix}index.html`)).not.toBeNull();

    await env.DB.prepare("UPDATE versions SET created_at = ? WHERE artifact_id = ? AND number = 2")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString(), p.id)
      .run();
    const ok = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>", base_version: 1 }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).version).toBe(2);
    expect(await env.FILES.head(`${orphanPrefix}index.html`)).toBeNull();
    expect((await versionRow(p.id, 2))?.r2Prefix).toMatch(/\/v2\.[a-z0-9]{12}\/$/);
  });
});

describe("concurrency inside the commit", () => {
  it("concurrent updates on one base give exactly one version; without a base all land", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const send = (body: Record<string, unknown>) =>
      call(`/api/v1/artifacts/${p.id}`, {
        method: "PUT",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const based = await Promise.all(
      [1, 2, 3].map((i) => send({ html: `<p>${i}</p>`, base_version: 1 })),
    );
    expect(based.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await versionCount(p.id)).toBe(2);
    // Losers left nothing: one prefix per committed version.
    expect(await prefixesOf(p.id)).toHaveLength(2);

    const free = await Promise.all([1, 2, 3].map((i) => send({ html: `<p>free ${i}</p>` })));
    expect(free.map((r) => r.status)).toEqual([200, 200, 200]);
    const numbers = await Promise.all(free.map(async (r) => (await json(r)).version));
    expect(numbers.sort()).toEqual([3, 4, 5]);
    expect(await currentVersion(p.id)).toBe(5);
  });

  it("concurrent publishes at the storage limit cannot both pass", async () => {
    const a = await agent();
    const ctx = serviceCtxFor(agentPrincipal(a), { config: { maxStorageBytesPerUser: 3_000 } });
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        publishArtifact(ctx, { title: `p${i}`, html: "x".repeat(2_000), visibility: "unlisted" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      code: "quota_exceeded",
      details: { limit_bytes: 3_000, adding_bytes: 2_000 },
    });
    expect(
      await db().select().from(artifacts).where(eq(artifacts.ownerId, a.user.id)).all(),
    ).toHaveLength(1);
  });

  it("at the artifact limit, exactly one more artifact is created", async () => {
    const a = await agent();
    await publish(a.auth, { title: "first" });
    await db().update(users).set({ artifactLimit: 2 }).where(eq(users.id, a.user.id)).run();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => publish(a.auth, { title: `p${i}` })),
    );
    expect(results.filter((r) => r.res.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.res.status !== 201))
      expect(r.body.error.code).toBe("quota_exceeded");
    const live = await db()
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ownerId, a.user.id)))
      .all();
    expect(live).toHaveLength(2);
  });
});

describe("restore and the early checks", () => {
  it("restore does one get and one put, and copies the old version's capabilities", async () => {
    const a = await agent();
    const page =
      '<!doctype html><meta name="plinth-capabilities" content="data viewer"><title>Poll</title>';
    const { body: p } = await publish(a.auth, {
      html: page,
      assets: [{ path: "a.css", content: "a" }],
    });
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>plain</p>" }),
    });
    expect((await versionRow(p.id, 2))?.capabilities).toBeNull();
    const files = spy(env.FILES);
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES: files.proxy } });
    const r = await restoreVersion(ctx, p.id, 1);
    expect(r).toMatchObject({ version: 3, warnings: [], stored: { written: 1, reused: 1 } });
    const r2Ops = files.calls.map((c) => c.method).filter((m) => m !== "list");
    expect(r2Ops.sort()).toEqual(["get", "put"]);
    expect((await versionRow(p.id, 3))?.capabilities).toBe(
      (await versionRow(p.id, 1))?.capabilities,
    );
    expect((await versionRow(p.id, 3))?.capabilities).toContain('"data":true');
  });

  it("a stale base is refused before the rate limit counts it", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>" }),
    });
    const count = async () =>
      (
        await env.DB.prepare("SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key = ?")
          .bind(`publish:${a.user.id}`)
          .first<{ n: number }>()
      )?.n;
    const before = await count();
    const files = spy(env.FILES);
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES: files.proxy } });
    await expect(
      updateArtifact(ctx, { id: p.id, html: "<p>stale</p>", base_version: 1 }),
    ).rejects.toMatchObject({ code: "conflict", details: { current_version: 2 } });
    await expect(restoreVersion(ctx, p.id, 1, 1)).rejects.toMatchObject({ code: "conflict" });
    expect(await count()).toBe(before);
    expect(files.calls).toEqual([]);
  });

  it("a commit through the stager with a stale base aborts and deletes its prefix", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>late</p>"));
    const staged = await stager.finish();
    // Someone else commits first.
    await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>first</p>", base_version: 1 }),
    });
    await expect(commitStaged(ctx, target, staged)).rejects.toMatchObject({
      code: "conflict",
      details: { current_version: 2 },
    });
    expect(await r2Keys(staged.prefix)).toEqual([]);
  });
});

describe("the storage quota counts stored bytes", () => {
  it("an update that reuses its files adds only what it writes", async () => {
    const a = await agent();
    const big = "z".repeat(1_500);
    const ctx = serviceCtxFor(agentPrincipal(a), { config: { maxStorageBytesPerUser: 3_000 } });
    const p = await publishArtifact(ctx, {
      title: "q",
      html: "x".repeat(1_000),
      assets: [{ path: "big.txt", content: big }],
      visibility: "unlisted",
    });
    // Counting logical sizes, 2,500 + 1,100 would pass 3,000; stored bytes are 2,500 + 100.
    const r = await updateArtifact(ctx, { id: p.id, html: "y".repeat(100) });
    expect(r.stored).toMatchObject({ bytes: 1_600, bytes_written: 100 });
    expect((await versionRow(p.id, 2))?.storedBytes).toBe(100);
    expect((await versionRow(p.id, 2))?.sizeBytes).toBe(1_600);
    // Writing new bytes past the limit is still refused.
    await expect(updateArtifact(ctx, { id: p.id, html: "w".repeat(300) })).resolves.toMatchObject({
      version: 3,
    });
    await expect(updateArtifact(ctx, { id: p.id, html: "v".repeat(1_000) })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    expect(await currentVersion(p.id)).toBe(3);
  });
});

describe("carry-forward and the upload ticket guard", () => {
  it("an update without assets carries every file with no asset R2 operation", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, {
      assets: [
        { path: "a.css", content: "a" },
        { path: "b/c.js", content: "c" },
      ],
    });
    const files = spy(env.FILES);
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES: files.proxy } });
    const r = await updateArtifact(ctx, { id: p.id, html: "<p>2</p>" });
    expect(r.stored).toMatchObject({ files: 3, written: 1, reused: 2 });
    expect(files.calls.map((c) => c.method)).toEqual(["put"]);
    expect(String(files.calls[0]?.arg)).toMatch(/\/index\.html$/);
  });

  /** An open ticket row for a's connection (W2 mints these; the commit only consumes them). */
  async function ticket(
    a: Awaited<ReturnType<typeof agent>>,
    artifactId: string,
    base: number,
    opts: { state?: string; expiresAt?: string } = {},
  ) {
    const id = `t${Math.random().toString(36).slice(2, 12)}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id, scopes,
         mode, artifact_id, artifact_type, base_version, state, created_at, expires_at)
       VALUES (?, ?, ?, 'connection', ?, 'artifacts:write', 'update', ?, 'html', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        `hash-${id}`,
        a.user.id,
        a.connectionId,
        artifactId,
        base,
        opts.state ?? "open",
        now,
        opts.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      )
      .run();
    return id;
  }

  async function staged(a: Awaited<ReturnType<typeof agent>>, id: string) {
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, id, { baseVersion: 1 });
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>bundle</p>"));
    return { ctx, target, staged: await stager.finish() };
  }

  it("consumes an open ticket in the same batch as the version", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const t = await ticket(a, p.id, 1);
    const s = await staged(a, p.id);
    const r = await commitStaged(s.ctx, s.target, s.staged, { ticketId: t });
    expect(r.version).toBe(2);
    const row = await env.DB.prepare(
      "SELECT state, result_artifact_id, result_version, used_at FROM upload_tickets WHERE id = ?",
    )
      .bind(t)
      .first<{
        state: string;
        result_artifact_id: string;
        result_version: number;
        used_at: string;
      }>();
    expect(row).toMatchObject({ state: "used", result_artifact_id: p.id, result_version: 2 });
    expect(row?.used_at).toBeTruthy();
  });

  it("a used, dead or expired ticket commits nothing and its objects are deleted", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    for (const [opts, reason] of [
      [{ state: "used" }, "upload_used"],
      [{ state: "dead" }, "upload_dead"],
      [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, "upload_expired"],
    ] as const) {
      const t = await ticket(a, p.id, 1, opts);
      const s = await staged(a, p.id);
      await expect(commitStaged(s.ctx, s.target, s.staged, { ticketId: t })).rejects.toMatchObject({
        details: { reason },
      });
      expect(await r2Keys(s.staged.prefix)).toEqual([]);
      expect(await currentVersion(p.id)).toBe(1);
    }
  });

  it("two commits on one ticket: exactly one wins", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const t = await ticket(a, p.id, 1);
    const one = await staged(a, p.id);
    const two = await staged(a, p.id);
    const results = await Promise.allSettled([
      commitStaged(one.ctx, one.target, one.staged, { ticketId: t }),
      commitStaged(two.ctx, two.target, two.staged, { ticketId: t }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await versionCount(p.id)).toBe(2);
  });
});

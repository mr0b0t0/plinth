// Bounded orphans (docs/spec.md, commit last): every attempt at writing a version records its
// prefix in staging_attempts before its first R2 put; the commit batch removes the row, an abort
// claims the row, removes the prefix and then the row, and the hourly scheduled sweep claims rows
// past the threshold and deletes their objects before their rows. A commit needs its row unclaimed,
// so a sweep and a commit never both proceed on one prefix.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { TTL } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { artifacts, versions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { deleteArtifact, publishArtifact, updateArtifact } from "../src/services/artifacts.ts";
import {
  OPPORTUNISTIC_SWEEP_BATCH,
  OPPORTUNISTIC_SWEEP_EVERY_MS,
  resetSweepThrottle,
  STAGING_SWEEP_AFTER_MS,
  STAGING_SWEEP_BATCH,
  STAGING_SWEEP_CLAIM_MS,
  STAGING_SWEEP_CRON,
  STAGING_SWEEP_MARGIN_MS,
  sweepSoon,
  sweepStagingAttempts,
} from "../src/services/attempts.ts";
import {
  commitStaged,
  newArtifactTarget,
  openStager,
  type StagedVersion,
  updateTarget,
} from "../src/services/stage.ts";
import { startUpload } from "../src/services/uploads.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import {
  APP,
  agent,
  agentPrincipal,
  call,
  contentOrigin,
  db,
  enterContent,
  publish,
  r2Keys,
  serviceCtxFor,
  versionRow,
} from "./helpers.ts";

const enc = new TextEncoder();
const HOUR = 60 * 60 * 1000;

type Agent = Awaited<ReturnType<typeof agent>>;

async function attemptRows(artifactId: string) {
  return (
    await env.DB.prepare(
      "SELECT prefix, artifact_id, started_at FROM staging_attempts WHERE artifact_id = ?",
    )
      .bind(artifactId)
      .all<{ prefix: string; artifact_id: string; started_at: string }>()
  ).results;
}

async function attemptRow(prefix: string) {
  return env.DB.prepare("SELECT prefix, started_at FROM staging_attempts WHERE prefix = ?")
    .bind(prefix)
    .first<{ prefix: string; started_at: string }>();
}

/** Run the Worker's scheduled handler as Cloudflare would at `at` (ms), waiting for its work. */
async function runSweep(at: number, overrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime: at, cron: STAGING_SWEEP_CRON }),
    { ...env, ...overrides } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

/** A time past the threshold for an attempt that started now. */
const later = () => Date.now() + STAGING_SWEEP_AFTER_MS + 60_000;

/** An update attempt that put files and finished staging, then was never committed or aborted. */
async function abandonedUpdate(a: Agent, id: string, files: Record<string, string> = {}) {
  const ctx = serviceCtxFor(agentPrincipal(a));
  const target = await updateTarget(ctx, id, {});
  const stager = await openStager(ctx, target);
  await stager.add("index.html", enc.encode("<p>abandoned</p>"));
  for (const [path, text] of Object.entries({ "left.css": "left", ...files }))
    await stager.add(path, enc.encode(text));
  const staged = await stager.finish();
  return { ctx, target, stager, staged };
}

async function serveFile(id: string, path: string) {
  const { cookie } = await enterContent(id);
  return call(`${contentOrigin(id)}${path}`, { headers: { Cookie: cookie ?? "" } });
}

async function versionsAt(prefix: string) {
  return (await db().select().from(versions).where(eq(versions.r2Prefix, prefix)).all()).length;
}

describe("staging attempts: constants", () => {
  it("sweeps hourly, past the ticket's lifetime plus a margin of at least 15 minutes", () => {
    expect(STAGING_SWEEP_CRON).toBe("0 * * * *");
    expect(STAGING_SWEEP_MARGIN_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(STAGING_SWEEP_AFTER_MS).toBe(TTL.uploadTicketMs + STAGING_SWEEP_MARGIN_MS);
    expect(STAGING_SWEEP_BATCH).toBeGreaterThan(0);
    expect(STAGING_SWEEP_BATCH).toBeLessThanOrEqual(50);
  });
});

describe("staging attempts: every attempt is recorded before its first put", () => {
  it("an inline update records its row before any put, and its commit batch removes it", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const log: string[] = [];
    const DB = new Proxy(env.DB, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "prepare")
          return (sql: string) => {
            if (/^\s*INSERT INTO staging_attempts/.test(sql)) log.push("row");
            return t.prepare(sql);
          };
        if (prop === "batch")
          return (s: D1PreparedStatement[]) => {
            log.push("batch");
            return t.batch(s);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "put")
          return (...args: Parameters<R2Bucket["put"]>) => {
            log.push("put");
            return (v as R2Bucket["put"]).apply(t, args);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB, FILES } });
    const r = await updateArtifact(ctx, {
      id: p.id,
      html: "<p>2</p>",
      assets: [{ path: "a.css", content: "a" }],
    });
    expect(r.version).toBe(2);
    expect(log[0]).toBe("row");
    expect(log.filter((l) => l === "row")).toHaveLength(1);
    expect(log.at(-1)).toBe("batch");
    expect(await attemptRows(p.id)).toEqual([]);
  });

  it("an inline publish (REST and MCP go through it) gets a row that its commit removes", async () => {
    const a = await agent();
    let seen: string[] = [];
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            // At the first put the row already exists.
            seen = (
              await env.DB.prepare("SELECT prefix FROM staging_attempts WHERE prefix = ?")
                .bind(`${String(args[0]).split("/").slice(0, 3).join("/")}/`)
                .all<{ prefix: string }>()
            ).results.map((r) => r.prefix);
            return (v as R2Bucket["put"]).apply(t, args);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES } });
    const r = await publishArtifact(ctx, {
      title: "Rowed",
      html: "<p>1</p>",
      visibility: "allowlist",
    });
    const v1 = await versionRow(r.id, 1);
    expect(seen).toEqual([v1?.r2Prefix]);
    expect(await attemptRows(r.id)).toEqual([]);
    // The REST path leaves no row either.
    const { body: q } = await publish(a.auth);
    expect(await attemptRows(q.id)).toEqual([]);
  });

  it("an abort deletes the prefix, then the row", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const stager = await openStager(ctx, await updateTarget(ctx, p.id, {}));
    await stager.add("index.html", enc.encode("<p>x</p>"));
    await stager.add("x.css", enc.encode("x"));
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    await stager.abort();
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });

  it("a failed abort leaves the row for the sweep", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        if (prop === "delete")
          return async () => {
            throw new Error("injected: delete failed");
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { FILES } });
    const stager = await openStager(ctx, await updateTarget(ctx, p.id, {}));
    await stager.add("index.html", enc.encode("<p>x</p>"));
    await stager.add("x.css", enc.encode("x"));
    await expect(stager.abort()).rejects.toThrow(/delete failed/);
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });
});

describe("staging attempts: the scheduled sweep", () => {
  it("deletes an abandoned attempt once it is past the threshold, and not before", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    expect(await attemptRow(stager.prefix)).not.toBeNull();

    // Before the threshold: left alone.
    await runSweep(Date.now());
    await runSweep(Date.now() + STAGING_SWEEP_AFTER_MS - 60_000);
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    expect(await attemptRow(stager.prefix)).not.toBeNull();

    // Past it: objects and row are gone, the live version is untouched.
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
    const v1 = await versionRow(p.id, 1);
    expect((await r2Keys(v1?.r2Prefix ?? "-")).length).toBe(1);
    expect((await serveFile(p.id, "/")).status).toBe(200);
  });

  it("runs through the Worker's own scheduled export", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    // The Worker's own export, as a scheduled event reaches it (not typed on the exports stub).
    const self = exports.default as unknown as {
      scheduled(o: { scheduledTime: number; cron: string }): Promise<unknown>;
    };
    await self.scheduled({ scheduledTime: later(), cron: STAGING_SWEEP_CRON });
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });

  it("bounds the work per run", async () => {
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const id = "boundedsweep00000000";
    const stmts = [];
    for (let i = 0; i < STAGING_SWEEP_BATCH + 7; i++) {
      const prefix = `artifacts/${id}/v1.${String(i).padStart(12, "0")}/`;
      await env.FILES.put(`${prefix}index.html`, "x");
      stmts.push(
        env.DB.prepare(
          "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
        ).bind(prefix, id, old),
      );
    }
    await env.DB.batch(stmts);
    await runSweep(Date.now());
    const left = await attemptRows(id);
    expect(left.length).toBe(7);
    expect((await r2Keys(`artifacts/${id}/`)).length).toBe(7);
    await runSweep(Date.now());
    expect(await attemptRows(id)).toEqual([]);
    expect(await r2Keys(`artifacts/${id}/`)).toEqual([]);
  });

  it("logs counts only, never object keys", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id, { "secret-name.css": "s" });
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log =
      console.warn =
      console.error =
        (...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        };
    try {
      await runSweep(later());
    } finally {
      Object.assign(console, orig);
    }
    expect(await attemptRow(stager.prefix)).toBeNull();
    expect(lines.join("\n")).not.toContain("secret-name");
    expect(lines.join("\n")).not.toContain("left.css");
  });
});

describe("staging attempts: committed files are never touched", () => {
  it("sweep claims first: the commit is refused (retryable), no version row, objects gone", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { ctx, target, stager, staged } = await abandonedUpdate(a, p.id);
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    const err = await commitStaged(ctx, target, staged).catch((e) => e);
    expect(err).toMatchObject({ code: "conflict" });
    expect(String(err.details?.next ?? "")).toMatch(/again/i);
    expect(await versionsAt(stager.prefix)).toBe(0);
    const art = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(art?.currentVersion).toBe(1);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    // The artifact is still updatable.
    const r = await updateArtifact(serviceCtxFor(agentPrincipal(a)), {
      id: p.id,
      html: "<p>again</p>",
      base_version: 1,
    });
    expect(r.version).toBe(2);
  });

  it("commit lands first: the sweep's claim removes nothing and no object is deleted", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { ctx, target, stager, staged } = await abandonedUpdate(a, p.id);
    const r = await commitStaged(ctx, target, staged);
    expect(r.version).toBe(2);
    expect(await attemptRow(stager.prefix)).toBeNull();
    const keys = await r2Keys(stager.prefix);
    expect(keys.length).toBe(2);
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual(keys);
    expect(await (await serveFile(p.id, "/left.css")).text()).toBe("left");
  });

  it("a commit while the sweep runs: whichever claims the row first wins, never both", async () => {
    // Interleaving 1: the commit batch runs right after the sweep has listed nothing yet, i.e.
    // just before the sweep's claim; the claim then removes nothing.
    {
      const a = await agent();
      const { body: p } = await publish(a.auth);
      const { ctx, target, stager, staged } = await abandonedUpdate(a, p.id);
      let committed: Promise<unknown> | null = null;
      const DB = new Proxy(env.DB, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t);
          if (prop === "prepare")
            return (sql: string) => {
              const stmt = t.prepare(sql);
              if (!/^\s*UPDATE staging_attempts SET started_at = \?3/.test(sql) || committed)
                return stmt;
              // The commit lands before the claim statement executes.
              committed = commitStaged(ctx, target, staged);
              return new Proxy(stmt, {
                get(s, sp) {
                  const sv = Reflect.get(s, sp, s);
                  if (sp === "bind")
                    return (...args: unknown[]) => {
                      const bound = s.bind(...args);
                      return new Proxy(bound, {
                        get(b, bp) {
                          const bv = Reflect.get(b, bp, b);
                          if (bp === "all" || bp === "run")
                            return async () => {
                              await committed;
                              return (bv as () => Promise<unknown>).call(b);
                            };
                          return typeof bv === "function" ? bv.bind(b) : bv;
                        },
                      });
                    };
                  return typeof sv === "function" ? sv.bind(s) : sv;
                },
              });
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      await runSweep(later(), { DB });
      expect(committed).not.toBeNull();
      expect(await committed).toMatchObject({ version: 2 });
      expect((await r2Keys(stager.prefix)).length).toBe(2);
      expect(await versionsAt(stager.prefix)).toBe(1);
      expect(await (await serveFile(p.id, "/left.css")).text()).toBe("left");
    }
    // Interleaving 2: the commit runs right after the sweep's claim and before its deletes.
    {
      const a = await agent();
      const { body: p } = await publish(a.auth);
      const { ctx, target, stager, staged } = await abandonedUpdate(a, p.id);
      let result: unknown = null;
      const FILES = new Proxy(env.FILES, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t);
          if (prop === "list")
            return async (...args: Parameters<R2Bucket["list"]>) => {
              if (result === null) result = await commitStaged(ctx, target, staged).catch((e) => e);
              return (v as R2Bucket["list"]).apply(t, args);
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      await runSweep(later(), { FILES });
      expect(result).toMatchObject({ code: "conflict" });
      expect(await versionsAt(stager.prefix)).toBe(0);
      expect(await r2Keys(stager.prefix)).toEqual([]);
      const art = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
      expect(art?.currentVersion).toBe(1);
    }
  });

  it("a row whose prefix a version names (an anomaly) loses only its row", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "keep.css", content: "k" }] });
    const v1 = await versionRow(p.id, 1);
    const prefix = v1?.r2Prefix ?? "-";
    const keys = await r2Keys(prefix);
    await env.DB.prepare(
      "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
    )
      .bind(prefix, p.id, new Date(Date.now() - 2 * HOUR).toISOString())
      .run();
    await runSweep(Date.now());
    expect(await attemptRow(prefix)).toBeNull();
    expect(await r2Keys(prefix)).toEqual(keys);
  });

  it("files reused by stored_at from an older prefix stay, even when only a stored_at names it", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "keep.css", content: "k" }] });
    const v1 = await versionRow(p.id, 1);
    const prefix = v1?.r2Prefix ?? "-";
    // v2 reuses keep.css: its manifest points into v1's prefix.
    const ctx = serviceCtxFor(agentPrincipal(a));
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("k")))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await updateArtifact(ctx, {
      id: p.id,
      html: "<p>2</p>",
      assets: [{ path: "keep.css", sha256: sha }],
    });
    const v2 = await versionRow(p.id, 2);
    expect(v2?.manifest).toContain(`"stored_at":"${prefix.split("/")[2]}/keep.css"`);
    // Only the stored_at names v1's prefix now.
    await env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(v1?.id).run();
    await env.DB.prepare(
      "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
    )
      .bind(prefix, p.id, new Date(Date.now() - 2 * HOUR).toISOString())
      .run();
    await runSweep(Date.now());
    expect(await attemptRow(prefix)).toBeNull();
    expect(await r2Keys(`${prefix}keep.css`)).toHaveLength(1);
    expect(await (await serveFile(p.id, "/keep.css")).text()).toBe("k");
  });

  it("legacy v<n>/ versions are untouched", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth, { assets: [{ path: "old.css", content: "o" }] });
    const v1 = await versionRow(p.id, 1);
    const legacy = `artifacts/${p.id}/v1/`;
    for (const path of ["index.html", "old.css"]) {
      const obj = await env.FILES.get(`${v1?.r2Prefix}${path}`);
      await env.FILES.put(`${legacy}${path}`, (await obj?.arrayBuffer()) ?? "");
    }
    await env.FILES.delete(await r2Keys(v1?.r2Prefix ?? "-"));
    await env.DB.prepare("UPDATE versions SET r2_prefix = ?, manifest = ? WHERE id = ?")
      .bind(
        legacy,
        JSON.stringify([
          { path: "index.html", size_bytes: 1, content_type: "text/html; charset=utf-8" },
          { path: "old.css", size_bytes: 1, content_type: "text/css; charset=utf-8" },
        ]),
        v1?.id,
      )
      .run();
    // An abandoned attempt beside it, and a stray row naming the legacy prefix.
    const { stager } = await abandonedUpdate(a, p.id);
    await env.DB.prepare(
      "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
    )
      .bind(legacy, p.id, new Date(Date.now() - 2 * HOUR).toISOString())
      .run();
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect((await r2Keys(legacy)).sort()).toEqual([`${legacy}index.html`, `${legacy}old.css`]);
    expect(await attemptRows(p.id)).toEqual([]);
    expect(await (await serveFile(p.id, "/old.css")).text()).toBe("o");
  });

  it("a first publish abandoned before its commit leaves nothing past the threshold", async () => {
    const a = await agent();
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await newArtifactTarget(ctx, { type: "html" });
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>never</p>"));
    const staged: StagedVersion = await stager.finish();
    expect(staged.prefix).toBe(stager.prefix);
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    await runSweep(later());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });
});

describe("staging attempts: deleting an artifact", () => {
  it("delete removes the artifact's attempt rows with its files", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    expect(await attemptRows(p.id)).toHaveLength(1);
    const waits: Promise<unknown>[] = [];
    const ctx = {
      ...serviceCtxFor(agentPrincipal(a)),
      waitUntil: (w: Promise<unknown>) => waits.push(w),
    };
    await deleteArtifact(ctx, p.id);
    await Promise.all(waits);
    expect(await attemptRows(p.id)).toEqual([]);
    expect(await r2Keys(stager.prefix)).toEqual([]);
  });

  it("an attempt still streaming when its artifact is deleted leaves no objects behind", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const ctx = serviceCtxFor(agentPrincipal(a));
    const target = await updateTarget(ctx, p.id, {});
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>streaming</p>"));
    await stager.add("first.css", enc.encode("first"));
    await until(async () => (await r2Keys(stager.prefix)).length === 1);
    const waits: Promise<unknown>[] = [];
    await deleteArtifact(
      { ...serviceCtxFor(agentPrincipal(a)), waitUntil: (w: Promise<unknown>) => waits.push(w) },
      p.id,
    );
    await Promise.all(waits);
    expect(await attemptRows(p.id)).toEqual([]);
    // The stager never learns its row is gone and keeps putting.
    await stager.add("big.css", enc.encode("big"));
    const staged = await stager.finish();
    await expect(commitStaged(ctx, target, staged)).rejects.toBeTruthy();
    await stager.abort();
    await runSweep(later() + HOUR);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });
});

/** Poll `check` (a few seconds at most) until it holds. */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never held");
}

/** `env.DB` whose prepare throws for SQL matching `match` (a D1 error mid-sweep). */
function dbFailing(match: RegExp) {
  return new Proxy(env.DB, {
    get(t, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          if (match.test(sql)) throw new Error("injected: D1 error");
          return t.prepare(sql);
        };
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

describe("staging attempts: a claimed row stays until its objects are gone", () => {
  it("a sweep that fails after its claim leaves the row, so the next run deletes the objects", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    const keys = await r2Keys(stager.prefix);
    expect(keys.length).toBe(2);
    // The check for versions naming the prefix fails after the claim.
    await runSweep(later(), { DB: dbFailing(/FROM versions WHERE artifact_id/) }).catch(
      () => undefined,
    );
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    expect(await r2Keys(stager.prefix)).toEqual(keys);
    // The next run once the claim's lease is over (an hourly cron run always is).
    await runSweep(later() + STAGING_SWEEP_CLAIM_MS + 1000);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });

  it("a partly failed delete never lets the attempt commit, whatever the committer's clock", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { ctx, target, stager, staged } = await abandonedUpdate(a, p.id, { "more.css": "m" });
    // R2 deletes the first key, then fails: some of the attempt's objects are gone.
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        if (prop === "delete")
          return async (keys: string | string[]) => {
            await t.delete(Array.isArray(keys) ? (keys[0] as string) : keys);
            throw new Error("injected: partial delete");
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    // The sweep's scheduledTime is past the threshold; the committer's own clock is not.
    await runSweep(later(), { FILES });
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    const err = await commitStaged(ctx, target, staged).catch((e) => e);
    expect(err).toMatchObject({ code: "conflict" });
    expect(await versionsAt(stager.prefix)).toBe(0);
    const art = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(art?.currentVersion).toBe(1);
    await runSweep(Date.now());
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });
});

describe("staging attempts: a commit batch D1 applies after reporting an error", () => {
  /** DB whose first commit batch throws without applying; `apply` runs the held batch later. */
  function heldBatch() {
    let held: D1PreparedStatement[] | null = null;
    const state = {
      async apply() {
        const h = held;
        held = [];
        if (h && h.length > 0) await env.DB.batch(h).catch(() => undefined);
      },
    };
    const DB = new Proxy(env.DB, {
      get(t, prop) {
        if (prop === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (held === null && stmts.length >= 3) {
              held = stmts;
              throw new Error("Network connection lost.");
            }
            return t.batch(stmts);
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { DB, state };
  }

  it("applied while the failed commit deletes its objects: the late batch is refused", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { DB, state } = heldBatch();
    const FILES = new Proxy(env.FILES, {
      get(t, prop) {
        if (prop === "delete")
          return async (keys: string | string[]) => {
            const r = await t.delete(keys);
            await state.apply();
            return r;
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB, FILES } });
    const target = await updateTarget(ctx, p.id, {});
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>late</p>"));
    await stager.add("late.css", enc.encode("late"));
    const staged = await stager.finish();
    await expect(commitStaged(ctx, target, staged)).rejects.toBeTruthy();
    expect(await versionsAt(stager.prefix)).toBe(0);
    const art = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(art?.currentVersion).toBe(1);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });

  it("applied before the cleanup starts: the version's objects are kept", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { DB: held, state } = heldBatch();
    // The read-back finds no version; the batch lands right after it.
    const DB = new Proxy(held, {
      get(t, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const stmt = t.prepare(sql);
            if (!/^SELECT 1 AS one FROM versions WHERE id = \?$/.test(sql)) return stmt;
            return new Proxy(stmt, {
              get(s, sp) {
                if (sp === "bind")
                  return (...args: unknown[]) => {
                    const b = s.bind(...args);
                    return new Proxy(b, {
                      get(bb, bp) {
                        if (bp === "first")
                          return async () => {
                            const r = await bb.first();
                            await state.apply();
                            return r;
                          };
                        const bv = Reflect.get(bb, bp, bb);
                        return typeof bv === "function" ? bv.bind(bb) : bv;
                      },
                    });
                  };
                const sv = Reflect.get(s, sp, s);
                return typeof sv === "function" ? sv.bind(s) : sv;
              },
            });
          };
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = serviceCtxFor(agentPrincipal(a), { env: { DB } });
    const target = await updateTarget(ctx, p.id, {});
    const stager = await openStager(ctx, target);
    await stager.add("index.html", enc.encode("<p>landed</p>"));
    await stager.add("landed.css", enc.encode("landed"));
    const staged = await stager.finish();
    await commitStaged(ctx, target, staged).catch(() => undefined);
    // Whatever the client was told, a version that landed keeps its files.
    expect(await versionsAt(stager.prefix)).toBe(1);
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    expect(await (await serveFile(p.id, "/landed.css")).text()).toBe("landed");
  });
});

// Docker, tunnel and local instances run under `wrangler dev`, which fires no cron. Minting an
// upload ticket and posting a bundle start a capped sweep through waitUntil (at most one per
// isolate per minute), on every runtime: it claims rows the same way the cron does.
describe("staging attempts: the opportunistic sweep (no cron needed)", () => {
  const OLD = () => new Date(Date.now() - STAGING_SWEEP_AFTER_MS - 60_000).toISOString();

  /** Move an attempt's start back past the threshold, as if it had been abandoned long ago. */
  async function backdate(prefix: string) {
    await env.DB.prepare("UPDATE staging_attempts SET started_at = ? WHERE prefix = ?")
      .bind(OLD(), prefix)
      .run();
  }

  /** A request through the Worker's fetch export, waiting for its waitUntil work. */
  async function fetchAndWait(req: Request) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as never, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  const mintRequest = (a: Agent, body: Record<string, unknown> = {}) =>
    new Request(`${APP}/api/v1/uploads`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** `n` abandoned rows (with one object each) under one made-up artifact id, past the threshold. */
  async function oldRows(id: string, n: number) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      const prefix = `artifacts/${id}/v1.${String(i).padStart(12, "0")}/`;
      await env.FILES.put(`${prefix}index.html`, "x");
      stmts.push(
        env.DB.prepare(
          "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
        ).bind(prefix, id, OLD()),
      );
    }
    await env.DB.batch(stmts);
  }

  it("is capped at 20 attempts and runs at most once per isolate per minute", () => {
    expect(OPPORTUNISTIC_SWEEP_BATCH).toBe(20);
    expect(OPPORTUNISTIC_SWEEP_EVERY_MS).toBe(60_000);
    expect(STAGING_SWEEP_CLAIM_MS).toBeGreaterThan(0);
    expect(STAGING_SWEEP_CLAIM_MS).toBeLessThan(STAGING_SWEEP_AFTER_MS);
  });

  it("minting a ticket clears an abandoned attempt past the threshold, and a recent one stays", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const old = await abandonedUpdate(a, p.id);
    const recent = await abandonedUpdate(a, p.id);
    await backdate(old.stager.prefix);
    resetSweepThrottle();
    const res = await fetchAndWait(mintRequest(a, { id: p.id, base_version: 1 }));
    expect(res.status).toBe(201);
    expect(await r2Keys(old.stager.prefix)).toEqual([]);
    expect(await attemptRow(old.stager.prefix)).toBeNull();
    // Younger than the threshold: untouched. The committed version: untouched.
    expect((await r2Keys(recent.stager.prefix)).length).toBe(2);
    expect(await attemptRow(recent.stager.prefix)).not.toBeNull();
    const v1 = await versionRow(p.id, 1);
    expect((await r2Keys(v1?.r2Prefix ?? "-")).length).toBe(1);
    expect((await serveFile(p.id, "/")).status).toBe(200);
  });

  it("start_upload over MCP starts it too (the service, not the route)", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    await backdate(stager.prefix);
    resetSweepThrottle();
    const started: Promise<unknown>[] = [];
    const ctx = {
      ...serviceCtxFor(agentPrincipal(a)),
      waitUntil: (w: Promise<unknown>) => void started.push(w),
    };
    await startUpload(ctx, { id: p.id, base_version: 1 });
    expect(started.length).toBe(1);
    await Promise.all(started);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });

  it("posting a bundle clears one too, and the bundle's own version commits", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    resetSweepThrottle();
    const minted = await fetchAndWait(mintRequest(a));
    expect(minted.status).toBe(201);
    const t = (await minted.json()) as { upload_url: string; upload_token: string };
    const { stager } = await abandonedUpdate(a, p.id);
    await backdate(stager.prefix);
    resetSweepThrottle();
    const res = await fetchAndWait(
      new Request(t.upload_url, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.upload_token}` },
        body: tar([{ name: "index.html", data: "<!doctype html><title>B</title><p>b</p>" }]),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; version: number };
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
    const mine = await versionRow(body.id, 1);
    expect((await r2Keys(mine?.r2Prefix ?? "-")).length).toBe(1);
    expect((await serveFile(p.id, "/")).status).toBe(200);
  });

  it("claims at most 20 attempts per run", async () => {
    const a = await agent();
    const id = "opportunisticcap0000";
    await oldRows(id, OPPORTUNISTIC_SWEEP_BATCH + 5);
    resetSweepThrottle();
    expect((await fetchAndWait(mintRequest(a))).status).toBe(201);
    expect((await attemptRows(id)).length).toBe(5);
    expect((await r2Keys(`artifacts/${id}/`)).length).toBe(5);
  });

  it("the throttle starts one sweep per isolate per minute", async () => {
    resetSweepThrottle();
    const started: Promise<unknown>[] = [];
    const wu = (w: Promise<unknown>) => void started.push(w);
    const t = Date.now();
    expect(sweepSoon(env, wu, t)).toBe(true);
    expect(sweepSoon(env, wu, t)).toBe(false);
    expect(sweepSoon(env, wu, t + OPPORTUNISTIC_SWEEP_EVERY_MS - 1)).toBe(false);
    // A clock that moved back does not start one either.
    expect(sweepSoon(env, wu, t - 1000)).toBe(false);
    expect(sweepSoon(env, wu, t + OPPORTUNISTIC_SWEEP_EVERY_MS)).toBe(true);
    expect(started.length).toBe(2);
    await Promise.all(started);

    // Through the route: a second mint within the minute leaves a fresh abandoned attempt alone.
    const a = await agent();
    const { body: p } = await publish(a.auth);
    resetSweepThrottle();
    expect((await fetchAndWait(mintRequest(a))).status).toBe(201);
    const { stager } = await abandonedUpdate(a, p.id);
    await backdate(stager.prefix);
    expect((await fetchAndWait(mintRequest(a))).status).toBe(201);
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    expect(await attemptRow(stager.prefix)).not.toBeNull();
  });

  it("a failing sweep never fails the request that started it", async () => {
    const a = await agent();
    resetSweepThrottle();
    const DB = new Proxy(env.DB, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (prop === "prepare")
          return (sql: string) => {
            if (/UPDATE staging_attempts SET started_at = \?3/.test(sql))
              throw new Error("injected: sweep claim failed");
            return t.prepare(sql);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(mintRequest(a), { ...env, DB } as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);
  });

  it("two opportunistic sweeps and the cron at once claim each row once and leave none", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const v1 = await versionRow(p.id, 1);
    const kept = await r2Keys(v1?.r2Prefix ?? "-");
    const id = "concurrentsweeps0000";
    const n = OPPORTUNISTIC_SWEEP_BATCH + 15;
    // Only this test's rows, so the counts below are this test's.
    await env.DB.prepare("DELETE FROM staging_attempts").run();
    await oldRows(id, n);
    const now = Date.now();
    const [one, two, cron] = await Promise.all([
      sweepStagingAttempts(env, now, OPPORTUNISTIC_SWEEP_BATCH),
      sweepStagingAttempts(env, now, OPPORTUNISTIC_SWEEP_BATCH),
      sweepStagingAttempts(env, now),
    ]);
    // Each row was claimed, and its objects deleted, by exactly one of the three.
    expect(one.claimed + two.claimed + cron.claimed).toBe(n);
    expect(one.deleted + two.deleted + cron.deleted).toBe(n);
    expect(one.failed + two.failed + cron.failed).toBe(0);
    expect(await attemptRows(id)).toEqual([]);
    expect(await r2Keys(`artifacts/${id}/`)).toEqual([]);
    // The committed version is untouched.
    expect(await r2Keys(v1?.r2Prefix ?? "-")).toEqual(kept);
    expect((await serveFile(p.id, "/")).status).toBe(200);
  });

  it("a claimed row is taken again only once its claim is old, so a run that died strands nothing", async () => {
    const a = await agent();
    const { body: p } = await publish(a.auth);
    const { stager } = await abandonedUpdate(a, p.id);
    await backdate(stager.prefix);
    const now = Date.now();
    // A run claims the row, then dies before deleting anything.
    await sweepStagingAttempts({ ...env, DB: dbFailing(/FROM versions WHERE artifact_id/) }, now);
    expect(await attemptRow(stager.prefix)).not.toBeNull();
    // A concurrent run inside the claim's lease leaves it to the first.
    const inside = await sweepStagingAttempts(env, now + STAGING_SWEEP_CLAIM_MS - 1000);
    expect(inside.claimed).toBe(0);
    expect((await r2Keys(stager.prefix)).length).toBe(2);
    // Past it, the next run (opportunistic or cron) finishes the job.
    const after = await sweepStagingAttempts(
      env,
      now + STAGING_SWEEP_CLAIM_MS + 1000,
      OPPORTUNISTIC_SWEEP_BATCH,
    );
    expect(after.deleted).toBe(1);
    expect(await r2Keys(stager.prefix)).toEqual([]);
    expect(await attemptRow(stager.prefix)).toBeNull();
  });
});

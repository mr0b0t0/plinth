// What happens to files people added to a page over time: the usage triggers for every state
// change, deletion and takedown of the artifact, the hourly sweep (expired uploads, the grace
// window, multipart aborts, overlapping sweeps), the opportunistic sweep, erase-user, and the
// orphan sweep that never touches files/.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FILE_LIMITS } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { eraseUserSql, orphanPrefixes } from "../scripts/admin-lib.mjs";
import worker from "../src/index.ts";
import {
  fileObjectKey,
  maybeSweepFiles,
  resetOpportunisticSweep,
  sweepArtifactFiles,
} from "../src/services/files.ts";
import {
  fileRow,
  filesApi,
  mp4,
  person,
  png,
  setup,
  takeDown,
  upload,
  usage,
} from "./files-helpers.ts";
import { BIG_BUNDLE_TIMEOUT_MS, call, r2Keys } from "./helpers.ts";

/** A row inserted by hand, in any state, with its object (when ready) in R2. */
async function row(
  artifactId: string,
  opts: {
    state: "pending" | "ready" | "deleting";
    size?: number;
    expiresAt?: number;
    completed?: boolean;
    multipartId?: string | null;
    email?: string;
  },
): Promise<string> {
  const id = Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
  const key = fileObjectKey(artifactId, id);
  await env.DB.prepare(
    `INSERT INTO artifact_files (id, artifact_id, r2_key, name, content_type, size_bytes, state,
       parts, parts_done, multipart_id, created_by_email, created_by_role, created_via, created_at,
       completed_at, expires_at)
     VALUES (?1, ?2, ?3, 'a.png', 'image/png', ?4, ?5, 1, ?6, ?7, ?8, 'viewer', 'page', ?9, ?10, ?11)`,
  )
    .bind(
      id,
      artifactId,
      key,
      opts.size ?? 100,
      opts.state,
      opts.completed ? 1 : 0,
      opts.multipartId ?? null,
      opts.email ?? "someone@example.org",
      new Date().toISOString(),
      opts.completed ? new Date().toISOString() : null,
      opts.expiresAt ?? Date.now() + FILE_LIMITS.uploadMs,
    )
    .run();
  if (opts.completed) await env.FILES.put(key, png(opts.size ?? 100));
  return id;
}

const setState = (id: string, state: string) =>
  env.DB.prepare("UPDATE artifact_files SET state = ?1 WHERE id = ?2").bind(state, id).run();

describe("usage triggers", () => {
  it("count pending and ready rows, never tombstones, and move seq on every state change", async () => {
    const { id } = await setup();
    const a = await row(id, { state: "pending", size: 100 });
    expect(await usage(id)).toEqual({ files: 1, bytes: 100, seq: 0 });
    await setState(a, "ready");
    expect(await usage(id)).toEqual({ files: 1, bytes: 100, seq: 1 });
    await setState(a, "deleting");
    expect(await usage(id)).toEqual({ files: 0, bytes: 0, seq: 2 });
    // Deleting a tombstone changes nothing.
    await env.DB.prepare("DELETE FROM artifact_files WHERE id = ?1").bind(a).run();
    expect(await usage(id)).toEqual({ files: 0, bytes: 0, seq: 2 });
    // A pending row cancelled, and a live row deleted outright (a cascade).
    const b = await row(id, { state: "pending", size: 40 });
    await setState(b, "deleting");
    expect(await usage(id)).toEqual({ files: 0, bytes: 0, seq: 3 });
    const c = await row(id, { state: "pending", size: 7 });
    await env.DB.prepare("DELETE FROM artifact_files WHERE id = ?1").bind(c).run();
    expect(await usage(id)).toEqual({ files: 0, bytes: 0, seq: 4 });
    // An update that keeps the state leaves the counter alone.
    const d = await row(id, { state: "pending", size: 9 });
    await env.DB.prepare("UPDATE artifact_files SET parts_done = 1 WHERE id = ?1").bind(d).run();
    expect(await usage(id)).toEqual({ files: 1, bytes: 9, seq: 4 });
  });
});

describe("deleting or taking down the artifact", () => {
  it("a delete tombstones the rows in its batch and its root goes with every file", async () => {
    const { owner, id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    expect(await r2Keys(`artifacts/${id}/files/`)).toEqual([fileObjectKey(id, f.id)]);
    const res = await call(`/api/v1/artifacts/${id}`, { method: "DELETE", headers: owner.auth });
    expect(res.status).toBeLessThan(300);
    expect((await fileRow(f.id))?.state).toBe("deleting");
    expect(await usage(id)).toEqual({ files: 0, bytes: 0, seq: 0 });
    await vi.waitFor(async () => expect(await r2Keys(`artifacts/${id}/`)).toEqual([]));
  });

  it("a takedown tombstones the rows, wipes the usage and deletes ready objects after its batch", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    const created = await (
      await filesApi(id, "", {
        cookie: ownerP.cookie,
        body: { name: "b.png", type: "image/png", size: 10 },
      })
    ).json<{ file: { id: string } }>();
    await takeDown(id);
    expect(await fileRow(f.id)).toBeNull();
    expect(await r2Keys(fileObjectKey(id, f.id))).toEqual([]);
    // The pending one waits for the grace window.
    expect((await fileRow(created.file.id))?.state).toBe("deleting");
    expect(
      (await env.DB.prepare("SELECT 1 FROM artifact_file_usage WHERE artifact_id = ?1")
        .bind(id)
        .first()) ?? null,
    ).toBeNull();
  });
});

describe("the sweep", () => {
  it("expires uploads past their deadline, and clears them only after the grace window", async () => {
    const { id } = await setup();
    const now = Date.now();
    const stale = await row(id, { state: "pending", expiresAt: now - 1000 });
    const fresh = await row(id, { state: "pending", expiresAt: now + 60_000 });
    let r = await sweepArtifactFiles(env, now);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await fileRow(stale))?.state).toBe("deleting");
    expect((await fileRow(fresh))?.state).toBe("pending");
    // Still inside the grace window: kept.
    r = await sweepArtifactFiles(env, now + FILE_LIMITS.tombstoneGraceMs - 5000);
    expect(await fileRow(stale)).not.toBeNull();
    r = await sweepArtifactFiles(env, now + FILE_LIMITS.tombstoneGraceMs + 1000);
    expect(await fileRow(stale)).toBeNull();
    expect((await fileRow(fresh))?.state).toBe("deleting");
  });

  it("clears a tombstone that was ready at once, and aborts a multipart upload", async () => {
    const { id } = await setup();
    const ready = await row(id, { state: "ready", completed: true });
    await setState(ready, "deleting");
    const mp = await env.FILES.createMultipartUpload(`artifacts/${id}/files/zzzzzzzzzzzzzzzzzzzz`);
    const multi = await row(id, {
      state: "deleting",
      expiresAt: Date.now() - FILE_LIMITS.tombstoneGraceMs - 1000,
      multipartId: mp.uploadId,
    });
    const abort = vi.fn(async () => undefined);
    const FILES = new Proxy(env.FILES, {
      get(t, k) {
        if (k === "resumeMultipartUpload") return () => ({ abort });
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await sweepArtifactFiles({ DB: env.DB, FILES }, Date.now());
    expect(await fileRow(ready)).toBeNull();
    expect(await fileRow(multi)).toBeNull();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(await r2Keys(fileObjectKey(id, ready))).toEqual([]);
  });

  it("never lets two overlapping sweeps take the same row", async () => {
    const { id } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await row(id, { state: "ready", completed: true });
      await setState(r, "deleting");
      ids.push(r);
    }
    const deletes: string[] = [];
    const FILES = new Proxy(env.FILES, {
      get(t, k) {
        if (k === "delete") {
          return async (key: string) => {
            deletes.push(key);
            await t.delete(key);
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const now = Date.now();
    const [a, b] = await Promise.all([
      sweepArtifactFiles({ DB: env.DB, FILES }, now, { limit: 4 }),
      sweepArtifactFiles({ DB: env.DB, FILES }, now, { limit: 4 }),
    ]);
    const mine = deletes.filter((k) => ids.some((i) => k.endsWith(i)));
    expect(new Set(mine).size).toBe(mine.length);
    expect(a.cleared + b.cleared).toBeGreaterThanOrEqual(6);
    for (const i of ids) expect(await fileRow(i)).toBeNull();
  });

  it("runs from the hourly cron", async () => {
    const { id } = await setup();
    const stale = await row(id, {
      state: "pending",
      expiresAt: Date.now() - FILE_LIMITS.tombstoneGraceMs - 60_000,
    });
    const ctl = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }),
      env as never,
      ctl,
    );
    await waitOnExecutionContext(ctl);
    // Expired by the first step; cleared once past the grace window (already the case here).
    await sweepArtifactFiles(env, Date.now());
    expect(await fileRow(stale)).toBeNull();
  });

  it("starts from an upload at most once a minute per isolate", () => {
    resetOpportunisticSweep();
    const deferred: Promise<unknown>[] = [];
    const defer = (p: Promise<unknown>) => {
      deferred.push(p);
    };
    const t = Date.now();
    expect(maybeSweepFiles(env, defer, t)).toBe(true);
    expect(maybeSweepFiles(env, defer, t + 30_000)).toBe(false);
    expect(maybeSweepFiles(env, defer, t + 61_000)).toBe(true);
    expect(deferred.length).toBe(2);
    return Promise.all(deferred);
  });
});

describe("erase-user and the orphan sweep", () => {
  it("erase-user tombstones and scrubs the person's uploads on other people's pages", async () => {
    const { id } = await setup();
    const viewer = await person(id, "viewer");
    const f = await upload(id, viewer, png(), "image/png", "mine.png");
    for (const sql of eraseUserSql(viewer.email).split("; ")) {
      if (sql.startsWith("UPDATE artifact_files")) await env.DB.prepare(sql).run();
    }
    expect(eraseUserSql(viewer.email)).toContain(
      `UPDATE artifact_files SET state = 'deleting', claimed_at = NULL, name = '', created_by_email = NULL, created_by_role = NULL WHERE created_by_email = '${viewer.email}'`,
    );
    const r = await fileRow(f.id);
    expect(r).toMatchObject({ state: "deleting", name: "", created_by_email: null });
    expect((await usage(id)).files).toBe(0);
    await sweepArtifactFiles(env, Date.now());
    expect(await fileRow(f.id)).toBeNull();
    expect(await r2Keys(fileObjectKey(id, f.id))).toEqual([]);
  });

  it("the orphan sweep never groups or deletes artifacts/<id>/files/", () => {
    const id = "a".repeat(20);
    const now = Date.parse("2026-11-19T12:00:00Z");
    const out = orphanPrefixes(
      [
        { key: `artifacts/${id}/files/bbbbbbbbbbbbbbbbbbbb`, uploaded: "2026-11-01T00:00:00Z" },
        { key: `artifacts/${id}/v9/index.html`, uploaded: "2026-11-01T00:00:00Z" },
      ],
      new Set([`artifacts/${id}/v1/`]),
      { now, minAgeMs: 3600_000 },
    );
    expect(out.map((g) => g.prefix)).toEqual([`artifacts/${id}/v9/`]);
  });
});

describe("a big upload's parts", () => {
  it(
    "stores parts at R2's multipart size and assembles them in order",
    async () => {
      const { id, ownerP } = await setup();
      const size = FILE_LIMITS.partBytes + 3;
      const bytes = mp4(size);
      const f = await upload(id, ownerP, bytes, "video/mp4", "clip.mp4");
      expect(f.created.parts).toBe(2);
      const obj = await env.FILES.get(fileObjectKey(id, f.id));
      expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    },
    BIG_BUNDLE_TIMEOUT_MS,
  );
});

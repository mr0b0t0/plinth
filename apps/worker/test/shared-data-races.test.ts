// Shared data under races: what the guarded SQL in services/data.ts promises when another write,
// a deletion or a takedown lands between a write's read and its guarded statement. Each test wraps
// env.DB so that a hook runs right after a chosen statement, using the real database. Design:
// docs/superpowers/specs/2026-11-14-shared-state-design.md sections 5 and 6.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EffectiveRole } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import { versionCapabilities } from "../src/services/artifacts.ts";
import {
  applyOps,
  clearData,
  createDoc,
  type DataTarget,
  type DataWriter,
  deleteDoc,
  getDoc,
  putDoc,
  wipeArtifactData,
} from "../src/services/data.ts";
import { APP, agent, config, publish, uniqueEmail } from "./helpers.ts";

const POLL = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-shared" content="tasks">
<p>poll</p>`;

/** The statement every write reads its document with (getDoc, and inside readState's batch). */
const READ_DOC =
  "SELECT * FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3";
const isInsert = (sql: string) => sql.trimStart().startsWith("INSERT INTO artifact_docs");

interface Hook {
  /** Run after a statement whose SQL this matches has completed. */
  match: (sql: string) => boolean;
  run: (n: number) => Promise<void>;
  /** How many times the hook may run (default once). */
  times?: number;
}

/**
 * env.DB with a hook after chosen statements, so a test can land another write between a
 * service's read and its guarded statement. The hook itself uses the real database.
 */
function raceDb(real: D1Database, hook: Hook): { d1: D1Database; runs: () => number } {
  const sqlOf = new WeakMap<object, string>();
  const realOf = new WeakMap<object, D1PreparedStatement>();
  let n = 0;
  const after = async (sql: string) => {
    if (hook.match(sql) && n < (hook.times ?? 1)) {
      n++;
      await hook.run(n);
    }
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, key) {
        if (key === "bind") {
          return (...args: unknown[]) => wrap(target.bind(...args), sql);
        }
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return async (...args: unknown[]) => {
            const r = await (target[key] as (...a: unknown[]) => Promise<unknown>)(...args);
            await after(sql);
            return r;
          };
        }
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    sqlOf.set(proxy, sql);
    realOf.set(proxy, stmt);
    return proxy;
  };
  const d1 = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      const r = await real.batch(stmts.map((s) => realOf.get(s) ?? s));
      for (const s of stmts) await after(sqlOf.get(s) ?? "");
      return r;
    },
    exec: (q: string) => real.exec(q),
  } as unknown as D1Database;
  return { d1, runs: () => n };
}

async function run(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${APP}${path}`, { redirect: "manual", ...init }),
    env as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** An artifact declaring data, its target as the services see it, and a writer per role. */
async function setup() {
  const owner = await agent();
  const { body } = await publish(owner.auth, { html: POLL });
  const id = body.id as string;
  const row = await env.DB.prepare(
    "SELECT capabilities FROM versions WHERE artifact_id = ?1 AND number = 1",
  )
    .bind(id)
    .first<{ capabilities: string | null }>();
  const target: DataTarget = {
    id,
    ownerId: owner.user.id,
    caps: versionCapabilities(row),
    type: "html",
  };
  const writer = async (role: EffectiveRole, email = uniqueEmail()): Promise<DataWriter> => ({
    email,
    role,
    viewerId: await viewerIdFor(config().tokenSigningKey, id, email),
    via: "page",
  });
  return { owner, id, target, ownerW: await writer("owner", owner.user.email), writer };
}

async function counts(artifactId: string) {
  const docs = await env.DB.prepare(
    "SELECT count(*) AS n FROM artifact_docs WHERE artifact_id = ?1",
  )
    .bind(artifactId)
    .first<{ n: number }>();
  const usage = await env.DB.prepare(
    "SELECT count(*) AS n FROM artifact_data_usage WHERE artifact_id = ?1",
  )
    .bind(artifactId)
    .first<{ n: number }>();
  return { docs: docs?.n ?? 0, usage: usage?.n ?? 0 };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

// ---------- revs never repeat ----------

describe("revs grow across the artifact", () => {
  it("a document deleted and created again never repeats a rev a reader saw", async () => {
    const { target, ownerW, writer } = await setup();
    const c = config();
    const v = await writer("viewer");
    const first = await putDoc(env.DB, c, target, v, "votes", "~me", { choice: "a" });
    expect(first.created).toBe(true);
    const seen = first.doc.rev;
    // An agent read the doc at `seen`. The viewer deletes it and creates it again.
    await deleteDoc(env.DB, c, target, v, "votes", "~me");
    const again = await putDoc(env.DB, c, target, v, "votes", "~me", { choice: "b" }, 0);
    expect(again.doc.rev).toBeGreaterThan(seen);
    // The agent's write at the rev it read is a conflict, not a silent overwrite.
    const [res] = (
      await applyOps(env.DB, c, target, ownerW, [
        { op: "set", collection: "votes", doc_id: v.viewerId, data: { choice: "x" }, if_rev: seen },
      ])
    ).results;
    expect(res).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { current_rev: again.doc.rev } },
    });
    expect((await getDoc(env.DB, target.id, "votes", v.viewerId))?.data).toBe('{"choice":"b"}');
  });

  it("clearing the data and recreating a document does not repeat a rev either", async () => {
    const { target, ownerW } = await setup();
    const c = config();
    const a = await putDoc(env.DB, c, target, ownerW, "votes", "abc", { n: 1 }, 0);
    expect(a.doc.rev).toBe(1);
    await clearData(env.DB, target.id);
    const b = await putDoc(env.DB, c, target, ownerW, "votes", "abc", { n: 2 }, 0);
    expect(b.doc.rev).toBeGreaterThan(1);
    await expectCode(putDoc(env.DB, c, target, ownerW, "votes", "abc", { n: 3 }, 1), "conflict");
    // Every rev in the artifact is distinct.
    const created = await createDoc(env.DB, c, target, ownerW, "votes", { n: 4 });
    expect(created.rev).toBeGreaterThan(b.doc.rev);
  });

  it("the runtime's update(fn) pattern (read, then set at that rev) cannot land on a recreated doc", async () => {
    const { target, writer } = await setup();
    const c = config();
    const alice = await writer("editor");
    const bob = await writer("commenter");
    await putDoc(env.DB, c, target, bob, "tasks", "t1", { n: 1 }, 0);
    const read = await getDoc(env.DB, target.id, "tasks", "t1");
    // Between alice's read and her write, bob deletes t1 and creates it again.
    await deleteDoc(env.DB, c, target, bob, "tasks", "t1");
    await putDoc(env.DB, c, target, bob, "tasks", "t1", { n: 100 }, 0);
    await expectCode(
      putDoc(env.DB, c, target, alice, "tasks", "t1", { n: 2 }, read?.rev),
      "conflict",
    );
  });
});

// ---------- writes in flight when the artifact goes away ----------

describe("a write in flight when the artifact is deleted or taken down", () => {
  it("inserts nothing after a deletion lands mid-batch", async () => {
    const { owner, id, target, ownerW } = await setup();
    // The first op's insert lands; then the owner deletes the artifact (and its data).
    const { d1, runs } = raceDb(env.DB, {
      match: isInsert,
      run: async () => {
        const res = await run(`/api/v1/artifacts/${id}`, {
          method: "DELETE",
          headers: owner.auth,
        });
        expect(res.status).toBe(204);
      },
    });
    const { results } = await applyOps(d1, config(), target, ownerW, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "b", data: { n: 2 }, if_rev: 0 },
      { op: "set", collection: "votes", data: { n: 3 }, if_rev: 0 },
      { op: "delete", collection: "votes", doc_id: "a", if_rev: 1 },
    ]);
    expect(runs()).toBe(1);
    expect(results[0]).toMatchObject({ ok: true });
    for (const r of results.slice(1)) {
      expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    // Nothing came back: no documents and no usage row on the deleted artifact.
    expect(await counts(id)).toEqual({ docs: 0, usage: 0 });
  });

  it("updates nothing after a takedown lands between the read and the write", async () => {
    const { id, target, ownerW } = await setup();
    const c = config();
    await putDoc(env.DB, c, target, ownerW, "votes", "a", { n: 1 }, 0);
    // A takedown that has not wiped yet (as if the wipe were not in the same batch): the guard
    // on the artifact alone must stop the update.
    const { d1 } = raceDb(env.DB, {
      match: (sql) => sql.startsWith(READ_DOC),
      run: async () => {
        await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
          .bind(nowIso(), id)
          .run();
      },
    });
    await expectCode(putDoc(d1, c, target, ownerW, "votes", "a", { n: 2 }), "not_found");
    expect((await getDoc(env.DB, id, "votes", "a"))?.data).toBe('{"n":1}');
    // And a create on the taken-down artifact inserts nothing, without retrying forever.
    await expectCode(putDoc(env.DB, c, target, ownerW, "votes", "b", { n: 1 }), "not_found");
    await expectCode(createDoc(env.DB, c, target, ownerW, "votes", { n: 1 }), "not_found");
    expect((await counts(id)).docs).toBe(1);
  });

  it("inserts nothing after the real takedown batch (flag plus wipe) lands mid-batch", async () => {
    const { id, target, ownerW } = await setup();
    const { d1 } = raceDb(env.DB, {
      match: isInsert,
      run: async () => {
        // The statements decideReport('actioned') batches.
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE artifacts SET taken_down_at = coalesce(taken_down_at, ?1),
               access_epoch = access_epoch + 1, updated_at = ?1 WHERE id = ?2`,
          ).bind(nowIso(), id),
          ...wipeArtifactData(env.DB, id),
        ]);
      },
    });
    const { results } = await applyOps(d1, config(), target, ownerW, [
      { op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 },
      { op: "set", collection: "votes", doc_id: "b", data: { n: 2 }, if_rev: 0 },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(await counts(id)).toEqual({ docs: 0, usage: 0 });
  });
});

// ---------- the ownership guard in SQL ----------

describe("the guarded write repeats the ownership rule", () => {
  it("an update or delete whose read is stale on the creator is forbidden by the SQL alone", async () => {
    const { id, target, writer } = await setup();
    const c = config();
    const a = await writer("commenter");
    const b = await writer("commenter");
    // "votes" is not shared: only a document's creator (or the owner, an editor) changes it.
    const x = await putDoc(env.DB, c, target, a, "votes", "x", { by: "a" }, 0);
    // Between a's read and a's write the document becomes b's at the same rev. The rev check
    // cannot tell; only the creator condition in the SQL can.
    const swap = () =>
      env.DB.prepare(
        "UPDATE artifact_docs SET created_by_email = ?1, data = ?2 WHERE artifact_id = ?3 AND doc_id = 'x'",
      )
        .bind(b.email, '{"by":"b"}', id)
        .run();
    const restore = () =>
      env.DB.prepare(
        "UPDATE artifact_docs SET created_by_email = ?1, data = ?2, rev = ?3 WHERE artifact_id = ?4 AND doc_id = 'x'",
      )
        .bind(a.email, '{"by":"a"}', x.doc.rev, id)
        .run();
    const keepRev = async () => {
      await swap();
      // The triggers moved seq, not rev; pin rev back to what a read.
      await env.DB.prepare(
        "UPDATE artifact_docs SET rev = ?1 WHERE artifact_id = ?2 AND doc_id = 'x'",
      )
        .bind(x.doc.rev, id)
        .run();
    };

    for (const ifRev of [x.doc.rev, undefined]) {
      const { d1, runs } = raceDb(env.DB, { match: (s) => s.startsWith(READ_DOC), run: keepRev });
      await expectCode(putDoc(d1, c, target, a, "votes", "x", { by: "a2" }, ifRev), "forbidden");
      expect(runs()).toBe(1);
      const doc = await getDoc(env.DB, id, "votes", "x");
      expect(doc?.data).toBe('{"by":"b"}');
      await restore();
    }
    for (const ifRev of [x.doc.rev, undefined]) {
      const { d1 } = raceDb(env.DB, { match: (s) => s.startsWith(READ_DOC), run: keepRev });
      await expectCode(deleteDoc(d1, c, target, a, "votes", "x", ifRev), "forbidden");
      expect(await getDoc(env.DB, id, "votes", "x")).not.toBeNull();
      await restore();
    }
  });

  it("a real delete and recreate by someone else between read and write: conflict, then forbidden", async () => {
    const { target, ownerW, writer } = await setup();
    const c = config();
    const a = await writer("commenter");
    const b = await writer("commenter");
    const x = await putDoc(env.DB, c, target, a, "votes", "x", { by: "a" }, 0);
    const recreate = async () => {
      await deleteDoc(env.DB, c, target, ownerW, "votes", "x");
      await putDoc(env.DB, c, target, b, "votes", "x", { by: "b" }, 0);
    };
    // With the rev a read: the recreated document has a new rev, so 409.
    const r1 = raceDb(env.DB, { match: (s) => s.startsWith(READ_DOC), run: recreate });
    await expect(
      putDoc(r1.d1, c, target, a, "votes", "x", { by: "a2" }, x.doc.rev),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await getDoc(env.DB, target.id, "votes", "x"))?.data).toBe('{"by":"b"}');
    // Make x a's again. A plain set retries after the race, reads b's document and is refused.
    await deleteDoc(env.DB, c, target, ownerW, "votes", "x");
    await putDoc(env.DB, c, target, a, "votes", "x", { by: "a" }, 0);
    const r2 = raceDb(env.DB, { match: (s) => s.startsWith(READ_DOC), run: recreate });
    await expectCode(putDoc(r2.d1, c, target, a, "votes", "x", { by: "a3" }), "forbidden");
    expect(r2.runs()).toBe(1);
    expect((await getDoc(env.DB, target.id, "votes", "x"))?.created_by_email).toBe(b.email);
  });

  it("a plain set retries on every race, then gives up with conflict", async () => {
    const { target, ownerW, writer } = await setup();
    const c = config();
    const a = await writer("commenter");
    await putDoc(env.DB, c, target, a, "tasks", "t", { n: 0 }, 0);
    // The owner changes the document after each of a's reads, every time.
    let n = 0;
    const { d1, runs } = raceDb(env.DB, {
      match: (s) => s.startsWith(READ_DOC),
      times: 10,
      run: async () => {
        n++;
        await putDoc(env.DB, c, target, ownerW, "tasks", "t", { n }, undefined);
      },
    });
    await expectCode(putDoc(d1, c, target, a, "tasks", "t", { n: -1 }), "conflict");
    // PLAIN_SET_ATTEMPTS: one try and three retries.
    expect(runs()).toBe(4);
    // A plain delete retries the same way.
    const del = raceDb(env.DB, {
      match: (s) => s.startsWith(READ_DOC),
      times: 10,
      run: async () => {
        n++;
        await putDoc(env.DB, c, target, ownerW, "tasks", "t", { n }, undefined);
      },
    });
    await expectCode(deleteDoc(del.d1, c, target, a, "tasks", "t"), "conflict");
    expect(del.runs()).toBe(4);
    expect(await getDoc(env.DB, target.id, "tasks", "t")).not.toBeNull();
  });
});

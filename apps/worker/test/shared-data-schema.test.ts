// Shared data foundations: migration 0005 (artifact_docs, the trigger-kept usage table,
// versions.capabilities) and createVersion storing each version's declared capabilities.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { versions } from "../src/db/schema.ts";
import { versionCapabilities } from "../src/services/artifacts.ts";
import { agent, browserSession, call, db, json, mcpClient, publish, tool } from "./helpers.ts";

const D1 = () => env.DB;

const DECLARED = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-shared" content="tasks">
<script src="/__plinth/runtime.js"></script><h1>Vote</h1>`;
const PLAIN = "<!doctype html><title>Plain</title><h1>Hello</h1>";
const DATA_ONLY = `<!doctype html><title>Poll</title><meta content='data' name='plinth-capabilities'><p>x</p>`;

async function capabilitiesOf(artifactId: string): Promise<Record<number, string | null>> {
  const rows = await D1()
    .prepare("SELECT number, capabilities FROM versions WHERE artifact_id = ? ORDER BY number")
    .bind(artifactId)
    .all<{ number: number; capabilities: string | null }>();
  return Object.fromEntries(rows.results.map((r) => [r.number, r.capabilities]));
}

/** A deterministic generator, so a failure replays the same statements. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function usage(artifactId: string) {
  return D1()
    .prepare("SELECT docs, bytes, seq FROM artifact_data_usage WHERE artifact_id = ?")
    .bind(artifactId)
    .first<{ docs: number; bytes: number; seq: number }>();
}

async function actual(artifactId: string) {
  return D1()
    .prepare(
      "SELECT count(*) AS docs, coalesce(sum(size_bytes), 0) AS bytes FROM artifact_docs WHERE artifact_id = ?",
    )
    .bind(artifactId)
    .first<{ docs: number; bytes: number }>();
}

const NOW = "2026-11-14T00:00:00.000Z";

function insertDoc(artifactId: string, collection: string, docId: string, size: number) {
  return D1()
    .prepare(
      `INSERT INTO artifact_docs (artifact_id, collection, doc_id, data, size_bytes, created_by_email,
         created_by_role, created_via, created_at, updated_by_email, updated_by_role, updated_via, updated_at)
       VALUES (?, ?, ?, ?, ?, 'a@example.com', 'owner', 'page', ?, 'a@example.com', 'owner', 'page', ?)`,
    )
    .bind(artifactId, collection, docId, JSON.stringify({ n: size }), size, NOW, NOW);
}

describe("migration 0005_shared_state", () => {
  it("applies: the column, both tables, three triggers and the indexes exist", async () => {
    const cols = await D1().prepare("PRAGMA table_info(versions)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("capabilities");
    const objects = await D1()
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name LIKE 'artifact_d%' ORDER BY type, name",
      )
      .all<{ type: string; name: string }>();
    const names = objects.results.map((o) => `${o.type}:${o.name}`);
    for (const want of [
      "table:artifact_docs",
      "table:artifact_data_usage",
      "trigger:artifact_docs_ai",
      "trigger:artifact_docs_au",
      "trigger:artifact_docs_ad",
      "index:artifact_docs_order",
      "index:artifact_docs_created_by",
      "index:artifact_docs_updated_by",
    ]) {
      expect(names).toContain(want);
    }
  });

  it("refuses a role or via outside the allowed values", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await expect(
      D1()
        .prepare(
          `INSERT INTO artifact_docs (artifact_id, collection, doc_id, data, size_bytes, created_by_role,
             created_via, created_at, updated_via, updated_at)
           VALUES (?, 'c', 'd', '{}', 2, 'admin', 'page', ?, 'page', ?)`,
        )
        .bind(body.id, NOW, NOW)
        .run(),
    ).rejects.toThrow();
    await expect(
      D1()
        .prepare(
          `INSERT INTO artifact_docs (artifact_id, collection, doc_id, data, size_bytes,
             created_via, created_at, updated_via, updated_at)
           VALUES (?, 'c', 'd', '{}', 2, 'script', ?, 'page', ?)`,
        )
        .bind(body.id, NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("keeps usage equal to COUNT and SUM over random writes, with seq only increasing", async () => {
    const a = await agent();
    const one = (await publish(a.auth)).body.id as string;
    const other = (await publish(a.auth)).body.id as string;
    const random = rng(20261114);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)] as T;
    const live = new Map<string, Set<string>>([
      [one, new Set()],
      [other, new Set()],
    ]);
    const lastSeq = new Map<string, number>([
      [one, 0],
      [other, 0],
    ]);
    let counter = 0;
    for (let i = 0; i < 300; i++) {
      const artifactId = random() < 0.7 ? one : other;
      const keys = live.get(artifactId) as Set<string>;
      const r = random();
      let changed = false;
      if (keys.size === 0 || r < 0.45) {
        const key = `${pick(["votes", "tasks", "notes"])}/d${counter++}`;
        const [c, d] = key.split("/") as [string, string];
        await insertDoc(artifactId, c, d, 1 + Math.floor(random() * 500)).run();
        keys.add(key);
        changed = true;
      } else if (r < 0.75) {
        const [c, d] = pick([...keys]).split("/") as [string, string];
        // meta.changes counts the trigger's row too, so it says nothing here; the doc is live.
        await D1()
          .prepare(
            "UPDATE artifact_docs SET size_bytes = ?, rev = rev + 1 WHERE artifact_id = ? AND collection = ? AND doc_id = ?",
          )
          .bind(1 + Math.floor(random() * 500), artifactId, c, d)
          .run();
        changed = true;
      } else if (r < 0.95) {
        const key = pick([...keys]);
        const [c, d] = key.split("/") as [string, string];
        await D1()
          .prepare(
            "DELETE FROM artifact_docs WHERE artifact_id = ? AND collection = ? AND doc_id = ?",
          )
          .bind(artifactId, c, d)
          .run();
        keys.delete(key);
        changed = true;
      } else {
        // A statement that touches nothing must not move the counter.
        await D1()
          .prepare("DELETE FROM artifact_docs WHERE artifact_id = ? AND doc_id = 'missing'")
          .bind(artifactId)
          .run();
      }
      const u = await usage(artifactId);
      const seq = u?.seq ?? 0;
      const prev = lastSeq.get(artifactId) as number;
      if (changed) expect(seq).toBeGreaterThan(prev);
      else expect(seq).toBe(prev);
      lastSeq.set(artifactId, seq);
      if (i % 25 === 0 || i === 299) {
        for (const id of [one, other]) {
          const want = await actual(id);
          const got = await usage(id);
          expect({ docs: got?.docs ?? 0, bytes: got?.bytes ?? 0 }).toEqual(want);
          expect(got?.docs ?? 0).toBe(live.get(id)?.size);
        }
      }
    }
  });

  it("a hard delete of the artifact cascades to its documents and usage row", async () => {
    const a = await agent();
    const id = (await publish(a.auth)).body.id as string;
    const keep = (await publish(a.auth)).body.id as string;
    await insertDoc(id, "votes", "a", 10).run();
    await insertDoc(id, "votes", "b", 20).run();
    await insertDoc(keep, "votes", "a", 5).run();
    expect(await usage(id)).toMatchObject({ docs: 2, bytes: 30 });
    await D1().prepare("DELETE FROM artifacts WHERE id = ?").bind(id).run();
    expect(await actual(id)).toEqual({ docs: 0, bytes: 0 });
    expect(await usage(id)).toBeNull();
    expect(await usage(keep)).toMatchObject({ docs: 1, bytes: 5 });
  });
});

describe("createVersion stores capabilities", () => {
  it("for publish, update_artifact, an editor save and a restore", async () => {
    const a = await agent();
    const { body } = await publish(a.auth, { html: DECLARED });
    const id = body.id as string;
    expect((await capabilitiesOf(id))[1]).not.toBeNull();
    expect(JSON.parse((await capabilitiesOf(id))[1] as string)).toEqual({
      data: true,
      viewer: true,
      shared: ["tasks"],
    });

    // update_artifact over MCP, with a page that declares nothing.
    const client = await mcpClient(a.token);
    const upd = await tool(client, "update_artifact", { id, html: PLAIN, base_version: 1 });
    expect(upd.isError).toBe(false);
    expect((await capabilitiesOf(id))[2]).toBeNull();

    // An editor save in the app (cookie session, CSRF), as EditorWorkspace sends it.
    const s = await browserSession(a.user.id);
    const save = await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: DATA_ONLY, base_version: 2 }),
    });
    expect(save.status).toBe(200);
    expect(JSON.parse((await capabilitiesOf(id))[3] as string)).toEqual({
      data: true,
      viewer: false,
      shared: [],
    });

    // A restore copies the old HTML, so it copies the old declaration too.
    const restore = await call(`/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 3 }),
    });
    expect(restore.status).toBe(201);
    expect((await json(restore)).version).toBe(4);
    const all = await capabilitiesOf(id);
    expect(all[4]).toBe(all[1]);
    const restoreOfPlain = await tool(client, "restore_version", { id, version: 2 });
    expect(restoreOfPlain.isError).toBe(false);
    expect((await capabilitiesOf(id))[5]).toBeNull();
    await client.close();
  });

  it("versions from before the migration read as NULL, and versionCapabilities parses rows", async () => {
    const a = await agent();
    const id = (await publish(a.auth, { html: DECLARED })).body.id as string;
    // A row written the way versions were written before 0005: no capabilities column at all.
    await D1()
      .prepare(
        `INSERT INTO versions (id, artifact_id, number, r2_prefix, size_bytes, manifest, created_at)
         VALUES (?, ?, 99, 'artifacts/x/v99/', 1, '[]', ?)`,
      )
      .bind(`old-${id}`, id, NOW)
      .run();
    const rows = await db().select().from(versions).all();
    const old = rows.find((r) => r.id === `old-${id}`);
    const current = rows.find((r) => r.artifactId === id && r.number === 1);
    expect(old?.capabilities).toBeNull();
    expect(versionCapabilities(old ?? null)).toBeNull();
    // Rows stored without the room fields (every row without `room`) read as no room, and rows
    // without `comments` as no page comments.
    expect(versionCapabilities(current ?? null)).toEqual({
      data: true,
      viewer: true,
      shared: ["tasks"],
      room: false,
      roomOpen: [],
      comments: false,
      people: false,
    });
    expect(versionCapabilities(null)).toBeNull();
    // Malformed stored values read as nothing declared, never as a crash.
    expect(versionCapabilities({ capabilities: "not json" })).toBeNull();
    expect(versionCapabilities({ capabilities: '{"data":"yes"}' })).toBeNull();
    // A stored `viewer` without `data` declares nothing, as parseCapabilities reads it.
    expect(versionCapabilities({ capabilities: '{"data":false,"viewer":true}' })).toBeNull();
    expect(versionCapabilities({ capabilities: '{"data":true,"viewer":false}' })).toEqual({
      data: true,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      comments: false,
      people: false,
    });
    // A room declaration, alone or with data; topics that break the rule are dropped.
    expect(
      versionCapabilities({
        capabilities:
          '{"data":false,"viewer":true,"shared":[],"room":true,"roomOpen":["cursor","*","Bad!",7]}',
      }),
    ).toEqual({
      data: false,
      viewer: true,
      shared: [],
      room: true,
      roomOpen: ["cursor", "*"],
      comments: false,
      people: false,
    });
    expect(
      versionCapabilities({ capabilities: '{"data":false,"viewer":false,"room":"yes"}' }),
    ).toBeNull();
    // Open topics count only with room.
    expect(
      versionCapabilities({
        capabilities: '{"data":true,"viewer":false,"shared":[],"roomOpen":["cursor"]}',
      }),
    ).toEqual({
      data: true,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      comments: false,
      people: false,
    });
  });
});

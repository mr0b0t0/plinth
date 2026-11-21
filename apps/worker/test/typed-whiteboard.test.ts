// The whiteboard type end to end on the Worker: publishing board.json with a starting board (the
// version keeps the settings, the blocks and arrows go into shared data once, after a data_write
// decision before staging and again after the commit), updates and restores, refusals, the
// write floor on the page's data API (read back from versions.capabilities on every request), the
// board's validation on every channel, the live room and its redeclare on a settings version, the
// viewer gate and what the content host serves.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BOARD_TOPICS, type Role, TYPE_REGISTRY } from "@plinth/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, versions } from "../src/db/schema.ts";
import { prepareBoardSource, seedBoard } from "../src/services/board.ts";
import { measureDoc } from "../src/services/data.ts";
import { titleFromSource } from "../src/services/stage.ts";
import {
  browser,
  owner as categoryOwner,
  person as categoryPerson,
  codeFor,
  shareCategory,
} from "./category-helpers.ts";
import {
  APP,
  agent,
  agentPrincipal,
  browserSession,
  call,
  contentOrigin,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  config as parseConfig,
  publish,
  r2Keys,
  serviceCtxFor,
  spy,
  storedFile,
  tool,
  versionRow,
} from "./helpers.ts";
import { connect, info, run, upgrade, within } from "./room-helpers.ts";

const BLOCKS = [
  { id: "goal", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Ship v2", color: "yellow" },
  { id: "risk", kind: "rect", x: 320, y: 0, w: 200, h: 100, text: "Risks <b>&</b>" },
  { id: "plan", kind: "ellipse", x: 0, y: 240, w: 180, h: 120, text: "" },
];
const ARROWS = [{ id: "a1", from: "goal", to: "risk", label: "blocks" }];
const SEEDED = JSON.stringify({ v: 1, blocks: BLOCKS, arrows: ARROWS });
/** The same starting board on a board whose settings open it to commenters. */
const OPEN = JSON.stringify({ v: 1, edit: "commenters", blocks: BLOCKS, arrows: ARROWS });
const SETTINGS = (edit = "editors", background = "dots") =>
  `{\n  "v": 1,\n  "background": "${background}",\n  "edit": "${edit}"\n}\n`;

const boardBody = (content: string, more: Record<string, unknown> = {}) => ({
  html: undefined,
  type: "whiteboard",
  content,
  visibility: "allowlist",
  ...more,
});

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function docRows(artifactId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifact_docs WHERE artifact_id = ?1 ORDER BY collection, doc_id",
  )
    .bind(artifactId)
    .all<Record<string, unknown>>();
  return results;
}

async function usage(artifactId: string) {
  return env.DB.prepare("SELECT docs, bytes, seq FROM artifact_data_usage WHERE artifact_id = ?1")
    .bind(artifactId)
    .first<{ docs: number; bytes: number; seq: number }>();
}

async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

async function cookieOf(id: string, headers?: Record<string, string>) {
  const { cookie, gate } = await enterContent(id, { headers });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return { cookie, gate };
}

/** A signed-in person with a grant, their content cookie and the gate they saw. */
async function person(id: string, role: Role) {
  const user = await createUser();
  await grant(id, user.email, role);
  const s = await browserSession(user.id);
  const { cookie, gate } = await cookieOf(id, s.headers);
  return { user, cookie, gate, session: s };
}

/** A request the way the runtime makes it. */
function api(id: string, path: string, cookie: string, method = "GET", body?: unknown) {
  const headers = new Headers({
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie,
  });
  if (method !== "GET") headers.set("origin", contentOrigin(id));
  if (body !== undefined) headers.set("content-type", "application/json");
  return run(`${contentOrigin(id)}/__plinth/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A board published over REST by a new agent, with its owner's content cookie. */
async function board(content = SEEDED, more: Record<string, unknown> = {}) {
  const owner = await agent();
  const { res, body } = await publish(owner.auth, boardBody(content, more));
  expect(res.status, JSON.stringify(body)).toBe(201);
  const s = await browserSession(owner.user.id);
  const { cookie } = await cookieOf(body.id, s.headers);
  return { owner, id: body.id as string, slug: body.slug as string, result: body, cookie, s };
}

const block = (over: Record<string, unknown> = {}) => ({
  kind: "note",
  x: 10,
  y: 20,
  w: 200,
  h: 140,
  text: "hi",
  ...over,
});

describe("publishing a whiteboard", () => {
  it("over MCP: the version keeps the settings, the starting board goes into shared data once", async () => {
    const a = await agent({ label: "Laptop" });
    const client = await mcpClient(a.token);
    const r = await tool(client, "publish_artifact", {
      title: "Launch board",
      type: "whiteboard",
      content: SEEDED,
    });
    await client.close();
    expect(r.isError, r.text).toBe(false);
    const id = r.data.id as string;
    expect(r.data).toMatchObject({
      type: "whiteboard",
      version: 1,
      board: { blocks: 3, arrows: 1 },
    });
    expect(r.data.warnings).toEqual([]);

    // The version: board.json with the canonical settings, nothing else, and fixed capabilities.
    expect(await (await storedFile(id, 1, "board.json"))?.text()).toBe(SETTINGS());
    const v1 = await versionRow(id, 1);
    expect(v1?.capabilities).toBe(
      JSON.stringify({
        data: true,
        viewer: true,
        shared: ["blocks", "arrows"],
        room: true,
        roomOpen: [],
        writers: "editor",
      }),
    );
    expect(await r2Keys(v1?.r2Prefix ?? "-")).toEqual([`${v1?.r2Prefix}board.json`]);

    // The documents: stamped with the publisher, exact bytes, distinct revs, seq at the top.
    const rows = await docRows(id);
    expect(rows.map((d) => [d.collection, d.doc_id])).toEqual([
      ["arrows", "a1"],
      ["blocks", "goal"],
      ["blocks", "plan"],
      ["blocks", "risk"],
    ]);
    const all = [
      ...BLOCKS.map((b) => ["blocks", b] as const),
      ...ARROWS.map((x) => ["arrows", x] as const),
    ];
    for (const [collection, { id: docId, ...data }] of all) {
      const row = rows.find((d) => d.doc_id === docId);
      expect(row?.data).toBe(JSON.stringify(data));
      expect(row?.size_bytes).toBe(
        measureDoc(parseConfig(), collection, docId, data, "whiteboard").size,
      );
      expect(row).toMatchObject({
        created_via: "agent",
        created_by_role: "owner",
        created_by_email: a.user.email,
        created_by_label: "Laptop",
        updated_via: "agent",
      });
    }
    const revs = rows.map((d) => d.rev as number);
    expect(new Set(revs).size).toBe(4);
    const u = await usage(id);
    expect(u).toMatchObject({ docs: 4, seq: Math.max(...revs) });
    // One write against the rate limits, for the whole starting board.
    const { results: buckets } = await env.DB.prepare(
      "SELECT key, count FROM rate_limits WHERE key LIKE ?1",
    )
      .bind(`data:w:${id}:%`)
      .all<{ key: string; count: number }>();
    expect(buckets.map((b) => b.count)).toEqual([1, 1]);
    // The next write's rev is above every seeded one.
    const owner = await browserSession(a.user.id);
    const { cookie } = await cookieOf(id, owner.headers);
    const res = await api(id, "/data/blocks/goal", cookie, "PUT", {
      data: block(),
      if_rev: rows.find((d) => d.doc_id === "goal")?.rev,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).rev).toBeGreaterThan(Math.max(...revs));
  });

  it("over REST from the app: the same, stamped via app", async () => {
    const user = await createUser();
    const s = await browserSession(user.id);
    const { res, body } = await publish(s.headers, boardBody(SEEDED));
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.board).toEqual({ blocks: 3, arrows: 1 });
    const rows = await docRows(body.id);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ created_via: "app", created_by_role: "owner" });
  });

  it("a board whose settings open it to commenters stores that, and the board's topics", async () => {
    const { id } = await board(OPEN);
    expect(await (await storedFile(id, 1, "board.json"))?.text()).toBe(SETTINGS("commenters"));
    expect(JSON.parse((await versionRow(id, 1))?.capabilities ?? "{}")).toMatchObject({
      roomOpen: [...BOARD_TOPICS],
      writers: "commenter",
    });
  });

  it("a board without a starting board writes no shared data and carries no board field", async () => {
    const { id, result } = await board('{"v":1,"edit":"editors","background":"grid"}');
    expect(result.board).toBeUndefined();
    expect(await docRows(id)).toEqual([]);
    expect(await (await storedFile(id, 1, "board.json"))?.text()).toBe(SETTINGS("editors", "grid"));
    expect((await versionRow(id, 1))?.capabilities).toBe(
      JSON.stringify({
        data: true,
        viewer: true,
        shared: ["blocks", "arrows"],
        room: true,
        roomOpen: [],
        writers: "editor",
      }),
    );
  });

  it("titles the board with the publish's title, never from its content", async () => {
    expect(titleFromSource(TYPE_REGISTRY.whiteboard, '{"v":1,"title":"x"}')).toBeNull();
    const { owner, result } = await board('{"v":1}', { title: "Retro" });
    const d = await json(await call(`/api/v1/artifacts/${result.id}`, { headers: owner.auth }));
    expect(d).toMatchObject({ title: "Retro", type: "whiteboard", content: SETTINGS() });
    expect(d.capabilities).toEqual(["data", "viewer", "room"]);
  });
});

describe("refusals", () => {
  it("refuses a board.json that does not parse, with its path", async () => {
    const a = await agent();
    const { res, body } = await publish(
      a.auth,
      boardBody(JSON.stringify({ v: 1, blocks: [{ ...block(), id: "x", w: 1 }] })),
    );
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({
      code: "invalid_input",
      details: { type: "whiteboard", field: "content", path: "blocks[0].w" },
    });
    expect(body.error.message).toMatch(/^board\.json: blocks\[0\]\.w: must be a whole number/);
  });

  it("refuses an agent without artifacts:write before anything is staged", async () => {
    const a = await agent({ scopes: "artifacts:read" });
    const before = await r2Keys("artifacts/");
    const { res, body } = await publish(a.auth, boardBody(SEEDED));
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
    expect(await r2Keys("artifacts/")).toEqual(before);
  });

  it("refuses the starting board through the data_write decision on the artifact to be created", async () => {
    const a = await agent();
    // A principal without artifacts:write, straight at the preparation step.
    const ctx = serviceCtxFor(agentPrincipal(a, ["artifacts:read"]));
    const p = prepareBoardSource(ctx, {
      def: TYPE_REGISTRY.whiteboard,
      text: SEEDED,
      target: {
        mode: "publish",
        artifactId: "abcdefghij0123456789",
        ownerId: a.user.id,
        visibility: "allowlist",
        hasPassword: false,
      },
    });
    await expect(p).rejects.toMatchObject({ code: "forbidden" });
    // Without a starting board nothing reaches shared data, so there is nothing to decide.
    const settingsOnly = await prepareBoardSource(ctx, {
      def: TYPE_REGISTRY.whiteboard,
      text: '{"v":1}',
      target: {
        mode: "publish",
        artifactId: "abcdefghij0123456789",
        ownerId: a.user.id,
        visibility: "allowlist",
        hasPassword: false,
      },
    });
    expect(settingsOnly).toEqual({ text: SETTINGS() });
  });

  it("refuses a starting board over the artifact's quota before any R2 put", async () => {
    const a = await agent();
    const files = spy(env.FILES);
    const ctx = serviceCtxFor(agentPrincipal(a), {
      env: { FILES: files.proxy },
      config: {
        data: {
          ...parseConfig().data,
          board: { ...parseConfig().data.board, maxDocsPerArtifact: 3 },
        },
      },
    });
    const { publishArtifact } = await import("../src/services/artifacts.ts");
    await expect(
      publishArtifact(ctx, {
        title: "Big",
        type: "whiteboard",
        content: SEEDED,
        visibility: "allowlist",
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded", details: { limit: "docs" } });
    expect(files.calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it.each([
    [{ ALLOW_SHARED_DATA: "false" }, "disabled"],
    [{ CONTENT_ISOLATION: "opaque" }, "opaque_isolation"],
  ])("refuses to publish a whiteboard with %j", async (vars, reason) => {
    const a = await agent();
    const client = await mcpClient(a.token, vars);
    const r = await tool(client, "publish_artifact", {
      title: "B",
      type: "whiteboard",
      content: '{"v":1}',
    });
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({
      code: "feature_disabled",
      message: "Whiteboards keep their blocks in shared data, which this instance turns off",
      details: { reason },
    });
    // The config says so, too.
    const cfg = await json(await run("http://app.localhost:8787/api/v1/config", {}, vars));
    expect(cfg.artifact_types).toContainEqual({ id: "whiteboard", available: false });
    expect(cfg.artifact_types).toContainEqual({ id: "html", available: true });
  });

  it("refuses assets and start_upload", async () => {
    const a = await agent();
    const { res, body } = await publish(
      a.auth,
      boardBody('{"v":1}', { assets: [{ path: "a.png", content: "x" }] }),
    );
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({
      code: "invalid_input",
      details: { type: "whiteboard", field: "assets" },
    });
    const client = await mcpClient(a.token);
    const up = await tool(client, "start_upload", { title: "B", type: "whiteboard" });
    expect(up.isError).toBe(true);
    expect(up.data.error).toMatchObject({
      code: "invalid_input",
      details: {
        type: "whiteboard",
        next: "Send board JSON inline in publish_artifact or update_artifact",
      },
    });
    const { id } = await board('{"v":1}');
    await grant(id, a.user.email, "editor");
    const up2 = await tool(client, "start_upload", { id, base_version: 1 });
    await client.close();
    expect(up2.isError).toBe(true);
    expect(up2.data.error.code).toBe("invalid_input");
  });
});

describe("updating and restoring a whiteboard", () => {
  it("a settings update changes roomOpen and writers; it writes no shared data", async () => {
    const { owner, id } = await board();
    const before = await usage(id);
    const res = await put(owner.auth, id, { content: '{"v":1,"edit":"editors"}', base_version: 1 });
    expect(res.status).toBe(200);
    expect((await json(res)).board).toBeUndefined();
    const caps = JSON.parse((await versionRow(id, 2))?.capabilities ?? "{}");
    expect(caps).toMatchObject({ roomOpen: [], writers: "editor" });
    expect(await usage(id)).toEqual(before);
  });

  it("refuses blocks on a board that has some, before any version is written", async () => {
    const { owner, id } = await board();
    const res = await put(owner.auth, id, { content: SEEDED, base_version: 1 });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({
      code: "invalid_input",
      message:
        "This board already has blocks in its shared data: add, move or delete them with write_artifact_data",
      details: { reason: "board_not_empty" },
    });
    expect(await versionRow(id, 2)).toBeNull();
  });

  it("an editor's update seeds an emptied board, stamped with the editor's grant", async () => {
    const { id } = await board('{"v":1}');
    const editor = await agent();
    await grant(id, editor.user.email, "editor");
    const res = await put(editor.auth, id, { content: SEEDED, base_version: 1 });
    expect(res.status).toBe(200);
    expect((await json(res)).board).toEqual({ blocks: 3, arrows: 1 });
    for (const r of await docRows(id)) {
      expect(r).toMatchObject({
        created_by_role: "editor",
        created_by_email: editor.user.email,
        created_via: "agent",
      });
    }
  });

  it("a seed that loses a race writes nothing and says board_not_seeded; the version stays", async () => {
    const { owner, id } = await board('{"v":1}');
    const res = await put(owner.auth, id, {
      content: '{"v":1,"background":"grid"}',
      base_version: 1,
    });
    expect(res.status).toBe(200);
    // Someone adds a block between the precheck and the seed statement.
    const s = await browserSession(owner.user.id);
    const { cookie } = await cookieOf(id, s.headers);
    expect((await api(id, "/data/blocks", cookie, "POST", { data: block() })).status).toBe(201);
    const ctx = serviceCtxFor(agentPrincipal(owner));
    const cfg = parseConfig();
    const measured = BLOCKS.map(({ id: docId, ...data }) => ({
      seed: { collection: "blocks" as const, id: docId, data: data as never },
      ...measureDoc(cfg, "blocks", docId, data, "whiteboard"),
    }));
    const base = { id, slug: id, type: "whiteboard", version: 2, warnings: [] } as never;
    const out = await seedBoard(ctx, base, measured);
    expect(out.warnings).toMatchObject([{ code: "board_not_seeded", file: "board.json" }]);
    expect(out.board).toBeUndefined();
    expect(await docRows(id)).toHaveLength(1);
  });

  it("a seed whose writer lost data_write after the commit writes nothing", async () => {
    const { id } = await board('{"v":1}');
    const stranger = await agent();
    const ctx = serviceCtxFor(agentPrincipal(stranger));
    const cfg = parseConfig();
    const measured = [
      {
        seed: { collection: "blocks" as const, id: "goal", data: block() as never },
        ...measureDoc(cfg, "blocks", "goal", block(), "whiteboard"),
      },
    ];
    const out = await seedBoard(ctx, { id, warnings: [] } as never, measured);
    expect(out.warnings).toMatchObject([{ code: "board_not_seeded" }]);
    expect(out.warnings[0]?.message).toMatch(/can no longer change/);
    expect(await docRows(id)).toEqual([]);
  });

  it("a restore brings the old settings and capabilities back and leaves the board's data alone", async () => {
    const { owner, id } = await board(OPEN);
    expect(
      (await put(owner.auth, id, { content: '{"v":1,"edit":"editors"}', base_version: 1 })).status,
    ).toBe(200);
    const before = { rows: await docRows(id), usage: await usage(id) };
    const res = await call(`/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await (await storedFile(id, 3, "board.json"))?.text()).toBe(SETTINGS("commenters"));
    const v3 = await versionRow(id, 3);
    const v1 = await versionRow(id, 1);
    expect(v3?.capabilities).toBe(v1?.capabilities);
    expect(JSON.parse(v3?.capabilities ?? "{}").writers).toBe("commenter");
    expect(await docRows(id)).toEqual(before.rows);
    expect(await usage(id)).toEqual(before.usage);
  });
});

describe("the page's data API on a whiteboard", () => {
  it("a viewer-role grantee reads and sees who they are, but every write is read_only", async () => {
    const { id } = await board();
    const v = await person(id, "viewer");
    const s = await json(await api(id, "/session", v.cookie));
    expect(s).toMatchObject({ available: true, can_write: false });
    expect(s.viewer).toMatchObject({ email: v.user.email, role: "viewer" });
    const list = await api(id, "/data/blocks", v.cookie);
    expect(list.status).toBe(200);
    expect((await json(list)).docs).toHaveLength(3);
    for (const [method, path, body] of [
      ["POST", "/data/blocks", { data: block() }],
      ["PUT", "/data/blocks/goal", { data: block() }],
      ["DELETE", "/data/blocks/goal", undefined],
    ] as const) {
      const res = await api(id, path, v.cookie, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await json(res)).error.details).toMatchObject({ reason: "read_only" });
    }
  });

  it("on a board with the default settings a commenter cannot create, move, retext or delete; an editor can", async () => {
    const { id } = await board();
    const c = await person(id, "commenter");
    const e = await person(id, "editor");
    expect((await json(await api(id, "/session", c.cookie))).can_write).toBe(false);
    expect(c.gate.data).toMatchObject({ can_write: false });
    const goal = () => docRows(id).then((rows) => rows.find((r) => r.doc_id === "goal"));
    const before = await docRows(id);
    const writes = async (cookie: string) => {
      const g = await goal();
      return [
        await api(id, "/data/blocks", cookie, "POST", { data: block() }),
        await api(id, "/data/blocks/goal", cookie, "PUT", {
          data: block({ x: 400 }),
          if_rev: g?.rev,
        }),
        await api(id, "/data/blocks/goal", cookie, "PUT", {
          data: block({ x: 400, text: "Rewritten" }),
          if_rev: (await goal())?.rev,
        }),
        await api(id, "/data/blocks/risk", cookie, "DELETE"),
      ];
    };
    for (const res of await writes(c.cookie)) {
      expect(res.status).toBe(403);
      expect((await json(res)).error.details).toMatchObject({ reason: "read_only" });
    }
    expect(await docRows(id)).toEqual(before);
    const [created, moved, retexted, deleted] = await writes(e.cookie);
    expect(created?.status).toBe(201);
    expect(moved?.status).toBe(200);
    expect(retexted?.status).toBe(200);
    expect(deleted?.status).toBe(204);
  });

  it("a commenter from a category share cannot change a board with the default settings", async () => {
    const o = await categoryOwner();
    const { res, body } = await publish(
      o.auth,
      boardBody(SEEDED, { title: "Retro", category: "Acme" }),
    );
    expect(res.status, JSON.stringify(body)).toBe(201);
    const c = await categoryPerson();
    await shareCategory(o, "Acme", [{ email: c.email, role: "commenter" }]);
    const { cookie, gate } = await cookieOf(body.id, c.session);
    expect(gate.role).toBe("commenter");
    expect(gate.data).toMatchObject({ can_write: false });
    const before = await docRows(body.id);
    const goal = before.find((r) => r.doc_id === "goal");
    for (const [method, path, data] of [
      ["POST", "/data/blocks", { data: block() }],
      ["PUT", "/data/blocks/goal", { data: block({ text: "Gone" }), if_rev: goal?.rev }],
      ["DELETE", "/data/blocks/goal", undefined],
    ] as const) {
      expect((await api(body.id, path, cookie, method, data)).status, `${method} ${path}`).toBe(
        403,
      );
    }
    expect(await docRows(body.id)).toEqual(before);
    // Nor emit on its room: the category grant stops at commenter, below the board's floor.
    expect(await json(await info(body.id, cookie))).toMatchObject({
      available: true,
      can_emit: "none",
      open_topics: [],
    });
  });

  it("an invitee signed in by the gate's code changes a default board as an editor, not as a commenter", async () => {
    const editor = `wb-code-editor-${crypto.randomUUID()}@example.com`;
    const commenter = `wb-code-commenter-${crypto.randomUUID()}@example.com`;
    const { id } = await board(SEEDED, { emails: [editor, commenter] });
    await grant(id, editor, "editor");
    await grant(id, commenter, "commenter");
    const signIn = async (email: string) => {
      const headers = { ...browser(), "Content-Type": "application/json" };
      const send = (path: string, body: unknown) =>
        run(`${APP}/api/v1/view/${id}/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      expect((await send("email", { email })).status).toBe(200);
      const ok = await send("code", { email, code: await codeFor(email) });
      expect(ok.status).toBe(200);
      const session = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      // The code signs them in with an account (#82), and the board treats them by role alone.
      expect(session).toMatch(/^__Host-plinth_session=/);
      return (await cookieOf(id, { Cookie: session })).cookie;
    };
    const e = await signIn(editor);
    const c = await signIn(commenter);
    expect((await json(await api(id, "/session", e))).can_write).toBe(true);
    expect((await json(await api(id, "/session", c))).can_write).toBe(false);
    expect((await api(id, "/data/blocks", e, "POST", { data: block() })).status).toBe(201);
    expect((await api(id, "/data/blocks", c, "POST", { data: block() })).status).toBe(403);
    expect(await json(await info(id, e))).toMatchObject({ can_emit: "all" });
    expect(await json(await info(id, c))).toMatchObject({ can_emit: "none" });
  });

  it("a commenter writes on a commenters board and stops at once when it becomes an editors board", async () => {
    const { owner, id } = await board(OPEN);
    const c = await person(id, "commenter");
    const e = await person(id, "editor");
    expect((await json(await api(id, "/session", c.cookie))).can_write).toBe(true);
    const created = await api(id, "/data/blocks", c.cookie, "POST", { data: block() });
    expect(created.status).toBe(201);
    const doc = await json(created);
    // Shared collections: a commenter moves someone else's block too.
    const goal = (await docRows(id)).find((r) => r.doc_id === "goal");
    const moved = await api(id, "/data/blocks/goal", c.cookie, "PUT", {
      data: block({ x: 400 }),
      if_rev: goal?.rev,
    });
    expect(moved.status).toBe(200);
    expect(
      (await put(owner.auth, id, { content: '{"v":1,"edit":"editors"}', base_version: 1 })).status,
    ).toBe(200);
    const again = await api(id, `/data/blocks/${doc.id}`, c.cookie, "PUT", {
      data: block({ x: 5 }),
    });
    expect(again.status).toBe(403);
    expect((await json(await api(id, "/session", c.cookie))).can_write).toBe(false);
    // An editor always writes.
    expect((await api(id, "/data/blocks", e.cookie, "POST", { data: block() })).status).toBe(201);
  });

  it("fails closed to editors when the stored floor is missing or unknown", async () => {
    const { id } = await board('{"v":1,"edit":"commenters"}');
    const v = await person(id, "viewer");
    const c = await person(id, "commenter");
    const e = await person(id, "editor");
    for (const writers of [undefined, "viewer"]) {
      const caps = {
        data: true,
        viewer: true,
        shared: ["blocks", "arrows"],
        room: true,
        roomOpen: [...BOARD_TOPICS],
        ...(writers ? { writers } : {}),
      };
      await db()
        .update(versions)
        .set({ capabilities: JSON.stringify(caps) })
        .where(and(eq(versions.artifactId, id), eq(versions.number, 1)))
        .run();
      expect((await api(id, "/data/blocks", v.cookie, "POST", { data: block() })).status).toBe(403);
      expect((await api(id, "/data/blocks", c.cookie, "POST", { data: block() })).status).toBe(403);
      expect((await api(id, "/data/blocks", e.cookie, "POST", { data: block() })).status).toBe(201);
    }
  });

  it("keeps HTML as it was: a viewer-role grantee writes on a page that declares data", async () => {
    const owner = await agent();
    const { body } = await publish(owner.auth, {
      html: '<!doctype html><meta name="plinth-capabilities" content="data viewer"><p>x</p>',
      visibility: "allowlist",
    });
    const v = await person(body.id, "viewer");
    expect((await json(await api(body.id, "/session", v.cookie))).can_write).toBe(true);
    expect((await api(body.id, "/data/tasks", v.cookie, "POST", { data: { a: 1 } })).status).toBe(
      201,
    );
    // The board's shapes are checked on a whiteboard only.
    expect(
      (await api(body.id, "/data/blocks", v.cookie, "POST", { data: { kind: "star" } })).status,
    ).toBe(201);
    expect(
      (await api(body.id, "/data/notes/~me", v.cookie, "PUT", { data: { a: 1 } })).status,
    ).toBe(201);
  });

  it("checks every whiteboard write against the board's shapes", async () => {
    const { cookie, id } = await board('{"v":1}');
    const bad = [
      ["/data/blocks", "POST", { data: { ...block(), w: 5 } }, /w must be/],
      ["/data/blocks", "POST", { data: { ...block(), extra: 1 } }, /unknown key/],
      ["/data/notes", "POST", { data: { a: 1 } }, /only blocks and arrows/],
      ["/data/blocks/~me", "PUT", { data: block() }, /no personal documents/],
      ["/data/arrows", "POST", { data: { from: "a", to: "a" } }, /two different blocks/],
    ] as const;
    for (const [path, method, body, why] of bad) {
      const res = await api(id, path, cookie, method, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect((await json(res)).error.message).toMatch(why);
    }
    expect((await api(id, "/data/blocks", cookie, "POST", { data: block() })).status).toBe(201);
  });

  it("checks an agent's write_artifact_data ops one by one; a move at its rev succeeds, a stale one conflicts", async () => {
    const { owner, id } = await board();
    const client = await mcpClient(owner.token);
    const goal = (await docRows(id)).find((r) => r.doc_id === "goal");
    const r = await tool(client, "write_artifact_data", {
      id,
      ops: [
        {
          op: "set",
          collection: "blocks",
          doc_id: "goal",
          data: block({ x: 999 }),
          if_rev: goal?.rev,
        },
        { op: "set", collection: "blocks", data: { kind: "note" }, if_rev: 0 },
        { op: "set", collection: "votes", data: { a: 1 }, if_rev: 0 },
        { op: "set", collection: "blocks", doc_id: "goal", data: block(), if_rev: goal?.rev },
      ],
    });
    await client.close();
    expect(r.isError, r.text).toBe(false);
    const res = r.data.results as { ok: boolean; error?: { code: string; message: string } }[];
    expect(res[0]?.ok).toBe(true);
    expect(res[1]?.error).toMatchObject({ code: "invalid_input" });
    expect(res[2]?.error?.message).toMatch(/only blocks and arrows/);
    expect(res[3]?.error).toMatchObject({ code: "conflict" });
  });

  it("merges an agent's changed fields at a rev, checks the result, and removes a field set to null", async () => {
    const { owner, id } = await board();
    const client = await mcpClient(owner.token);
    const risk = (await docRows(id)).find((r) => r.doc_id === "risk");
    const r = await tool(client, "write_artifact_data", {
      id,
      ops: [
        // Turn the box into a diamond with an outline: nothing else is sent.
        {
          op: "merge",
          collection: "blocks",
          doc_id: "risk",
          data: { kind: "diamond", stroke: "#336699", z: 4 },
          if_rev: risk?.rev,
        },
        // At the rev it was read at, a second merge is a conflict.
        { op: "merge", collection: "blocks", doc_id: "risk", data: { x: 1 }, if_rev: risk?.rev },
        // A merge whose result is not a block is refused, with its reason.
        { op: "merge", collection: "blocks", doc_id: "goal", data: { w: 1 }, if_rev: 1 },
        { op: "merge", collection: "blocks", doc_id: "nope", data: { x: 1 }, if_rev: 1 },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    const res = r.data.results as { ok: boolean; rev?: number; error?: { code: string } }[];
    expect(res[0]).toMatchObject({ op: "merge", ok: true });
    expect(res[1]?.error).toMatchObject({ code: "conflict" });
    expect(res[2]?.ok).toBe(false);
    expect(res[3]?.error).toMatchObject({ code: "not_found" });
    const after = (await docRows(id)).find((row) => row.doc_id === "risk");
    expect(JSON.parse(after?.data as string)).toEqual({
      ...BLOCKS[1],
      id: undefined,
      kind: "diamond",
      stroke: "#336699",
      z: 4,
    });
    const goal = (await docRows(id)).find((row) => row.doc_id === "goal");
    const bad = await tool(client, "write_artifact_data", {
      id,
      ops: [
        { op: "merge", collection: "blocks", doc_id: "goal", data: { w: 1 }, if_rev: goal?.rev },
      ],
    });
    expect((bad.data.results as { error?: { message: string } }[])[0]?.error?.message).toMatch(
      /w must be/,
    );
    // null removes a field: the note loses its colour.
    const cleared = await tool(client, "write_artifact_data", {
      id,
      ops: [
        {
          op: "merge",
          collection: "blocks",
          doc_id: "goal",
          data: { color: null },
          if_rev: goal?.rev,
        },
      ],
    });
    await client.close();
    expect((cleared.data.results as { ok: boolean }[])[0]?.ok).toBe(true);
    const goal2 = (await docRows(id)).find((row) => row.doc_id === "goal");
    expect(JSON.parse(goal2?.data as string)).not.toHaveProperty("color");
  });

  it("holds larger documents than other pages: a table past DATA_MAX_DOC_BYTES fits a board", async () => {
    const { cookie, id } = await board('{"v":1}');
    const cols = { c1: { at: 1 }, c2: { at: 2 } };
    const rows: Record<string, Record<string, string | number>> = {};
    for (let i = 0; i < 40; i++)
      rows[`r${i}`] = { at: i, c1: "x".repeat(500), c2: "y".repeat(500) };
    const table = { kind: "table", x: 0, y: 0, w: 400, h: 400, cols, rows };
    expect(JSON.stringify(table).length).toBeGreaterThan(parseConfig().data.maxDocBytes);
    const res = await api(id, "/data/blocks", cookie, "POST", { data: table });
    expect(res.status, JSON.stringify(await json(res.clone()))).toBe(201);
    // The page is told the board's caps.
    const session = await json(await api(id, "/session", cookie));
    expect(session.limits).toEqual({
      max_doc_bytes: parseConfig().data.board.maxDocBytes,
      max_docs: parseConfig().data.board.maxDocsPerArtifact,
      max_bytes: parseConfig().data.board.maxBytesPerArtifact,
    });
  });
});

describe("the board's live room", () => {
  it("answers /room for a whiteboard and lets each role emit what the policy says", async () => {
    // With the default settings a commenter emits nothing.
    const closed = await board();
    const cc = await person(closed.id, "commenter");
    expect(await json(await info(closed.id, cc.cookie))).toMatchObject({
      available: true,
      can_emit: "none",
      open_topics: [],
    });
    const { id, cookie } = await board(OPEN);
    const c = await person(id, "commenter");
    const v = await person(id, "viewer");
    expect(await json(await info(id, cookie))).toMatchObject({ available: true, can_emit: "all" });
    expect(await json(await info(id, c.cookie))).toMatchObject({
      available: true,
      can_emit: "open",
      open_topics: [...BOARD_TOPICS],
    });
    expect(await json(await info(id, v.cookie))).toMatchObject({
      available: true,
      can_emit: "none",
    });
    // The page kind upgrades; a whiteboard has no doc socket.
    const sock = await connect(id, c.cookie);
    sock.ws.close(1000);
    expect((await upgrade(id, cookie, { kind: "doc" })).status).toBe(404);
  });

  it("a settings version that lets only editors change the board closes sockets with 4410 at once", async () => {
    const { owner, id, cookie } = await board(OPEN);
    const c = await person(id, "commenter");
    const o = await connect(id, cookie);
    const cs = await connect(id, c.cookie);
    // Background only: the same declaration, nothing closes.
    expect(
      (
        await put(owner.auth, id, {
          content: '{"v":1,"edit":"commenters","background":"grid"}',
          base_version: 1,
        })
      ).status,
    ).toBe(200);
    expect(await within(cs.closed, 500)).toBe("timeout");
    // Editors only: both sockets reconnect, well before the 60 s alarm.
    expect(
      (await put(owner.auth, id, { content: '{"v":1,"edit":"editors"}', base_version: 2 })).status,
    ).toBe(200);
    expect(await within(o.closed)).toMatchObject({ code: 4410 });
    expect(await within(cs.closed)).toMatchObject({ code: 4410 });
    // The commenter's reconnect carries no right to emit.
    expect(await json(await info(id, c.cookie))).toMatchObject({
      can_emit: "none",
      open_topics: [],
    });
    const again = await connect(id, c.cookie);
    again.send({ t: "join", room: "main" });
    await again.nextOf("peers");
    again.send({ t: "emit", room: "main", topic: "block.move", data: { id: "goal", x: 1, y: 2 } });
    expect(await again.nextOf("error")).toEqual({ t: "error", code: "forbidden_topic" });
    // It survives the alarm: the declaration it was admitted under is the current one.
    const ns = env.ROOMS;
    if (!ns) throw new Error("no ROOMS");
    await runDurableObjectAlarm(ns.get(ns.idFromName(id)));
    expect(await within(again.closed, 300)).toBe("timeout");
    // A restore to the commenters version reconnects them again.
    const res = await call(`/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect(await within(again.closed)).toMatchObject({ code: 4410 });
  });

  it("a removed grant closes the person's board socket with 4401", async () => {
    const { owner, id } = await board();
    const c = await person(id, "commenter");
    const sock = await connect(id, c.cookie);
    const res = await call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await within(sock.closed)).toMatchObject({ code: 4401 });
  });
});

describe("the viewer gate and the content host", () => {
  it("tells each viewer their email is shown, and whether they can change the board", async () => {
    const { owner, id } = await board(OPEN);
    const v = await person(id, "viewer");
    const c = await person(id, "commenter");
    expect(v.gate.data).toMatchObject({
      can_write: false,
      room_email: v.user.email,
      email: v.user.email,
    });
    expect(c.gate.data).toMatchObject({ can_write: true, room_email: c.user.email });
    expect(
      (await put(owner.auth, id, { content: '{"v":1,"edit":"editors"}', base_version: 1 })).status,
    ).toBe(200);
    const again = await json(await call(`/api/v1/view/${id}`, { headers: c.session.headers }));
    expect(again.data.can_write).toBe(false);
  });

  it("serves the shell with the runtime and the renderer under script-src 'self', and board.json as data", async () => {
    const { id, cookie } = await board();
    const res = await run(`${contentOrigin(id)}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`ws://${id}.`);
    const html = await res.text();
    expect(html).toContain('<script src="/__plinth/runtime.js"></script>');
    expect(html).toContain('<script src="/__plinth/types/whiteboard/whiteboard.js"></script>');
    const payload = JSON.parse(/id="__plinth-content">([^<]*)<\/script>/.exec(html)?.[1] ?? "{}");
    expect(payload).toMatchObject({ type: "whiteboard", path: "board.json", text: SETTINGS() });
    expect(payload).not.toHaveProperty("preview");
    // The settings file itself runs nothing.
    const file = await run(`${contentOrigin(id)}/board.json`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toMatch(/^application\/json/);
    expect(file.headers.get("content-security-policy")).toContain("script-src 'none'");
  });
});

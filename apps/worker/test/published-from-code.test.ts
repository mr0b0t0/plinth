// Published from code (docs/spec.md "Published from code"): a publish or update that carries
// `editing` stores it on the artifact, one that leaves it out keeps it, and owners and editors
// read it back (get_artifact, GET /artifacts/:ref). An upload ticket carries it to its commit, a
// token limited to one artifact (the GitHub Action) may set it, and the view gate tells only the
// people who edit on the page (`from_code`, beside `live`).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import acme from "./fixtures/design-systems/acme.json";
import {
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  fetchWith,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";
import { grant } from "./room-helpers.ts";

const SYSTEM = JSON.stringify(acme, null, 2);

const req = async (method: string, path: string, auth: Record<string, string>, body?: unknown) => {
  const res = await call(`/api/v1${path}`, {
    method,
    headers: { ...auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await json(res) };
};

const editingOf = async (id: string, auth: Record<string, string>) =>
  (await req("GET", `/artifacts/${id}`, auth)).body.editing as string | undefined;

async function designSystem(owner: Awaited<ReturnType<typeof agent>>, extra = {}) {
  const p = await publish(owner.auth, {
    title: "Acme UI",
    html: undefined,
    type: "design_system",
    content: SYSTEM,
    visibility: "allowlist",
    ...extra,
  });
  expect(p.res.status, JSON.stringify(p.body)).toBe(201);
  return p.body.id as string;
}

const update = (id: string, auth: Record<string, string>, base: number, extra = {}) =>
  req("PUT", `/artifacts/${id}`, auth, {
    content: SYSTEM.replace("Acme UI", `Acme UI ${base + 1}`),
    base_version: base,
    ...extra,
  });

describe("editing on publish and update", () => {
  it("is stored by a publish, kept by an update without it, and changed by one with it", async () => {
    const owner = await agent();
    const id = await designSystem(owner, { editing: "code" });
    expect(await editingOf(id, owner.auth)).toBe("code");
    expect((await update(id, owner.auth, 1)).status).toBe(200);
    expect(await editingOf(id, owner.auth)).toBe("code");
    expect((await update(id, owner.auth, 2, { editing: "page" })).status).toBe(200);
    expect(await editingOf(id, owner.auth)).toBe("page");
    // A publish without it is edited on the page.
    expect(await editingOf(await designSystem(owner), owner.auth)).toBe("page");
  });

  it("is refused unless code or page, and a refused update changes nothing", async () => {
    const owner = await agent();
    const id = await designSystem(owner);
    const bad = await update(id, owner.auth, 1, { editing: "repo" });
    expect(bad.status).toBe(400);
    // A stale base is a conflict: neither the version nor where it is edited moves.
    expect((await update(id, owner.auth, 5, { editing: "code" })).status).toBe(409);
    expect(await editingOf(id, owner.auth)).toBe("page");
  });

  it("is read back by owners and editors only", async () => {
    const owner = await agent();
    const id = await designSystem(owner, { editing: "code" });
    const editor = await createUser();
    const viewer = await createUser();
    await grant(id, editor.email, "editor");
    await grant(id, viewer.email, "viewer");
    const asEditor = { Authorization: `Bearer ${(await createToken(editor.id)).token}` };
    const asViewer = { Authorization: `Bearer ${(await createToken(viewer.id)).token}` };
    expect(await editingOf(id, asEditor)).toBe("code");
    const seen = await req("GET", `/artifacts/${id}`, asViewer);
    expect(seen.status).toBe(200);
    expect("editing" in seen.body).toBe(false);
  });

  it("goes through MCP: publish_artifact sets it, get_artifact returns it, update_artifact keeps it", async () => {
    const owner = await agent();
    const c = await mcpClient(owner.token);
    try {
      const p = await tool(c, "publish_artifact", {
        title: "Acme UI",
        type: "design_system",
        content: SYSTEM,
        editing: "code",
      });
      expect(p.isError, p.text).toBe(false);
      const id = p.data.id as string;
      expect((await tool(c, "get_artifact", { id })).data.editing).toBe("code");
      const u = await tool(c, "update_artifact", {
        id,
        content: SYSTEM.replace("Acme UI", "Acme UI 2"),
        base_version: 1,
      });
      expect(u.isError, u.text).toBe(false);
      expect((await tool(c, "get_artifact", { id })).data.editing).toBe("code");
    } finally {
      await c.close();
    }
  });

  it("rides an upload ticket to its commit, for a new artifact and an update", async () => {
    const owner = await agent();
    const send = async (ticket: { upload_url: string; upload_token: string }) => {
      const bundle = new Request(ticket.upload_url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket.upload_token}` },
        body: tar([{ name: "system.json", data: SYSTEM }]),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(bundle, env as never, ctx);
      await waitOnExecutionContext(ctx);
      // 201 for a new artifact, 200 for an update.
      expect([200, 201]).toContain(res.status);
      return json(res);
    };
    const fresh = await req("POST", "/uploads", owner.auth, {
      type: "design_system",
      editing: "code",
    });
    expect(fresh.status).toBe(201);
    const { id } = await send(fresh.body);
    expect(await editingOf(id, owner.auth)).toBe("code");
    const next = await req("POST", "/uploads", owner.auth, {
      id,
      base_version: 1,
      editing: "page",
    });
    expect(next.status).toBe(201);
    await send(next.body);
    expect(await editingOf(id, owner.auth)).toBe("page");
  });

  it("rides an upload ticket together with copy_files, each to its own column", async () => {
    const owner = await agent();
    const logo = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const src = await publish(owner.auth, {
      title: "Source",
      visibility: "unlisted",
      assets: [{ path: "img/logo.svg", content: logo }],
    });
    expect(src.res.status, JSON.stringify(src.body)).toBe(201);
    const ticket = await req("POST", "/uploads", owner.auth, {
      editing: "code",
      copy_files: [{ artifact: src.body.id, path: "img/logo.svg", to: "brand/logo.svg" }],
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const bundle = new Request(ticket.body.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket.body.upload_token}` },
      body: tar([{ name: "index.html", data: "<!doctype html><title>Page</title><h1>Hi</h1>" }]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(bundle, env as never, ctx);
    await waitOnExecutionContext(ctx);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(await editingOf(body.id, owner.auth)).toBe("code");
    expect(body.copied_from).toEqual([
      expect.objectContaining({
        artifact: src.body.id,
        files: [{ path: "brand/logo.svg", from: "img/logo.svg" }],
      }),
    ]);
  });

  it("may be set by a token limited to the artifact (the GitHub Action's)", async () => {
    const owner = await agent();
    const id = await designSystem(owner);
    const bound = await createToken(owner.user.id, { artifactId: id });
    const auth = { Authorization: `Bearer ${bound.token}` };
    expect((await update(id, auth, 1, { editing: "code" })).status).toBe(200);
    expect(await editingOf(id, owner.auth)).toBe("code");
  });
});

describe("the view gate", () => {
  const gate = async (id: string, headers: Record<string, string>, vars?: Record<string, string>) =>
    json(
      vars
        ? await fetchWith(vars, `/api/v1/view/${id}`, { headers })
        : await call(`/api/v1/view/${id}`, { headers }),
    );

  it("says from_code beside live, to the people who edit on the page only", async () => {
    const owner = await agent();
    const id = await designSystem(owner, { editing: "code" });
    const s = await browserSession(owner.user.id);
    const g = await gate(id, s.headers);
    expect(g.live).toBeDefined();
    expect(g.from_code).toBe(true);
    // A viewer has no live, so no from_code.
    const viewer = await createUser();
    await grant(id, viewer.email, "viewer");
    const v = await gate(id, (await browserSession(viewer.id)).headers);
    expect(v.status).toBe("ok");
    expect(v.from_code).toBeUndefined();
    // With editing on the page off on this instance, nobody edits there.
    const off = await gate(id, s.headers, { ALLOW_LIVE_EDITING: "false" });
    expect(off.live).toBeUndefined();
    expect(off.from_code).toBeUndefined();
  });

  it("leaves it out for an artifact edited on the page", async () => {
    const owner = await agent();
    const id = await designSystem(owner);
    const g = await gate(id, (await browserSession(owner.user.id)).headers);
    expect(g.live).toBeDefined();
    expect(g.from_code).toBeUndefined();
  });
});

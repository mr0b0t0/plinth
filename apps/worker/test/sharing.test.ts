import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { newId } from "../src/lib/crypto.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  db,
  fetchWith,
  json,
  mcpClient,
  publish,
  r2Keys,
  tool,
  uniqueEmail,
} from "./helpers.ts";

const putSharing = (headers: Record<string, string>, ref: string, grants: unknown[]) =>
  call(`/api/v1/artifacts/${ref}/sharing`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ grants }),
  });

describe("sharing settings", () => {
  it("owner replaces grants; roles take effect; others cannot read or change them", async () => {
    const owner = await agent();
    const editor = await createUser();
    const stranger = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist" });

    const r = await putSharing(owner.auth, p.id, [
      { email: editor.email, role: "editor" },
      { email: "Viewer@Example.com", role: "viewer" },
      { email: owner.user.email, role: "viewer" },
    ]);
    expect(r.status).toBe(200);
    const s = await json(r);
    expect(s.grants.map((g: { email: string; role: string }) => `${g.email}:${g.role}`)).toEqual([
      `${editor.email}:editor`,
      "viewer@example.com:viewer",
    ]);
    expect(s).toMatchObject({
      visibility: "allowlist",
      has_password: false,
      public_allowed: false,
    });

    const session = await browserSession(editor.id);
    const upd = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>by editor</p>" }),
    });
    expect(upd.status).toBe(200);
    // Editors may edit but not manage sharing.
    expect(
      (await call(`/api/v1/artifacts/${p.id}/sharing`, { headers: session.headers })).status,
    ).toBe(403);
    expect((await putSharing(session.headers, p.id, [])).status).toBe(403);
    // Strangers do not learn the artifact exists.
    expect(
      (await call(`/api/v1/artifacts/${p.id}/sharing`, { headers: stranger.auth })).status,
    ).toBe(404);

    // Removing the grant removes the access.
    expect((await putSharing(owner.auth, p.id, [])).status).toBe(200);
    const after = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>again</p>" }),
    });
    expect(after.status).toBe(404);
  });

  it("rejects duplicates and bad roles", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    expect(
      (
        await putSharing(owner.auth, p.id, [
          { email: "a@x.com", role: "viewer" },
          { email: "A@x.com", role: "editor" },
        ])
      ).status,
    ).toBe(400);
    expect((await putSharing(owner.auth, p.id, [{ email: "a@x.com", role: "owner" }])).status).toBe(
      400,
    );
  });
});

// Categories (docs/spec.md "Categories"): the owner's private organisation. Every summary path
// (list, get, set_visibility, mentions) goes through toSummary, which shows it to the owner only.
describe("category is owner-only metadata", () => {
  const CATEGORY = "Secret Client";
  const setCategory = (id: string, name: string | null) =>
    env.DB.prepare("UPDATE artifacts SET category = ? WHERE id = ?").bind(name, id).run();

  async function sharedArtifact(visibility: "allowlist" | "unlisted" = "allowlist") {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility });
    await setCategory(p.id, CATEGORY);
    const people = {} as Record<
      "editor" | "commenter" | "viewer",
      { auth: Record<string, string> }
    >;
    const grants: { email: string; role: string }[] = [];
    for (const role of ["editor", "commenter", "viewer"] as const) {
      const u = await createUser();
      const t = await createToken(u.id);
      people[role] = { auth: { Authorization: `Bearer ${t.token}` } };
      grants.push({ email: u.email, role });
    }
    expect((await putSharing(owner.auth, p.id, grants)).status).toBe(200);
    return { owner, p, people };
  }

  const listed = async (auth: Record<string, string>, id: string) => {
    const r = await call("/api/v1/artifacts", { headers: auth });
    expect(r.status).toBe(200);
    const { items } = await json<{ items: { id: string; category: string | null }[] }>(r);
    return items.find((i) => i.id === id);
  };

  it("the owner sees it in list and get, and in the set_visibility result", async () => {
    const { owner, p } = await sharedArtifact();
    expect((await listed(owner.auth, p.id))?.category).toBe(CATEGORY);
    const got = await json(await call(`/api/v1/artifacts/${p.id}`, { headers: owner.auth }));
    expect(got.category).toBe(CATEGORY);
    const vis = await call(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "unlisted" }),
    });
    expect(vis.status).toBe(200);
    expect((await json(vis)).category).toBe(CATEGORY);
  });

  it("an uncategorised artifact reads category: null, even for the owner", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    expect(p.category).toBeUndefined();
    expect((await listed(owner.auth, p.id))?.category).toBeNull();
  });

  it("editors, commenters and viewers get category: null from list and get", async () => {
    const { p, people } = await sharedArtifact();
    for (const [role, who] of Object.entries(people)) {
      const item = await listed(who.auth, p.id);
      expect(item, role).toMatchObject({ role, category: null });
      const r = await call(`/api/v1/artifacts/${p.id}`, { headers: who.auth });
      expect(r.status, role).toBe(200);
      const text = await r.text();
      expect(JSON.parse(text).category, role).toBeNull();
      expect(text, role).not.toContain(CATEGORY);
    }
  });

  it("a signed-in editor gets category: null too", async () => {
    const { owner, p } = await sharedArtifact();
    const editor = await createUser();
    expect(
      (await putSharing(owner.auth, p.id, [{ email: editor.email, role: "editor" }])).status,
    ).toBe(200);
    const s = await browserSession(editor.id);
    const r = await call(`/api/v1/artifacts/${p.id}`, { headers: s.headers });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(CATEGORY);
  });

  it("a link viewer gets category: null", async () => {
    const { p } = await sharedArtifact("unlisted");
    const r = await call(`/api/v1/artifacts/${p.id}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text).category).toBeNull();
    expect(text).not.toContain(CATEGORY);
  });

  it("an admin reviewing the artifact gets category: null", async () => {
    const { p } = await sharedArtifact();
    // Admins may look at an artifact only once someone reported it.
    await env.DB.prepare(
      "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?, ?, 'test', 'open', ?)",
    )
      .bind(newId(), p.id, new Date().toISOString())
      .run();
    const email = uniqueEmail("admin");
    const vars = { ADMIN_EMAIL: email };
    const cfg = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
    const admin = await getOrCreateUser(db(), cfg, email, { verified: true });
    expect(admin.isAdmin).toBe(true);
    const s = await browserSession(admin.id);
    const r = await fetchWith(vars, `/api/v1/artifacts/${p.id}`, { headers: s.headers });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text).category).toBeNull();
    expect(text).not.toContain(CATEGORY);
  });

  it("the sharing settings never carry it", async () => {
    const { owner, p } = await sharedArtifact();
    const r = await call(`/api/v1/artifacts/${p.id}/sharing`, { headers: owner.auth });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(CATEGORY);
  });
});

// Only the owner sets a category: an editor's write that carries one is refused before any write,
// upload or rate-limit hit, and a collaborator's list never holds the owner's names.
describe("collaborators and categories", () => {
  const CATEGORY = "Secret Client";

  async function withEditor() {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist", category: CATEGORY });
    expect(p.category).toBe(CATEGORY);
    const editor = await agent();
    expect(
      (await putSharing(owner.auth, p.id, [{ email: editor.user.email, role: "editor" }])).status,
    ).toBe(200);
    return { owner, editor, p };
  }

  const publishRate = async (userId: string) =>
    (
      await env.DB.prepare("SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key = ?")
        .bind(`publish:${userId}`)
        .first<{ n: number }>()
    )?.n ?? 0;
  const stored = async (id: string) =>
    await env.DB.prepare("SELECT category, current_version AS v FROM artifacts WHERE id = ?")
      .bind(id)
      .first<{ category: string | null; v: number }>();

  it("an editor's PUT with a category is 403 owner_only: no version, no rate hit, no R2 write", async () => {
    const { editor, p } = await withEditor();
    const keys = await r2Keys(`artifacts/${p.id}/`);
    const rate = await publishRate(editor.user.id);
    const r = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...editor.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>by editor</p>", base_version: 1, category: "Mine" }),
    });
    expect(r.status).toBe(403);
    const text = await r.text();
    expect(JSON.parse(text).error).toMatchObject({
      code: "forbidden",
      details: { field: "category", reason: "owner_only" },
    });
    expect(text).not.toContain(CATEGORY);
    expect(await stored(p.id)).toEqual({ category: CATEGORY, v: 1 });
    expect(await publishRate(editor.user.id)).toBe(rate);
    expect(await r2Keys(`artifacts/${p.id}/`)).toEqual(keys);
    // Without the category, the same editor's update goes through and keeps the owner's name.
    const ok = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...editor.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>by editor</p>", base_version: 1 }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.text();
    expect(okBody).not.toContain(CATEGORY);
    expect(await stored(p.id)).toEqual({ category: CATEGORY, v: 2 });
  });

  it("an editor's update_artifact over MCP with a category is refused the same way", async () => {
    const { editor, p } = await withEditor();
    const c = await mcpClient(editor.token);
    const r = await tool(c, "update_artifact", {
      id: p.id,
      html: "<p>x</p>",
      base_version: 1,
      category: "Mine",
    });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "forbidden", details: { reason: "owner_only" } });
    expect(r.text).not.toContain(CATEGORY);
    expect(await stored(p.id)).toEqual({ category: CATEGORY, v: 1 });
  });

  it("a collaborator's categories hold only their own names, and the owner's name filters nothing", async () => {
    const { editor, p } = await withEditor();
    await publish(editor.auth, { category: "Editor Stuff" });
    const r = await json(await call("/api/v1/artifacts", { headers: editor.auth }));
    expect(r.categories).toEqual([{ name: "Editor Stuff", count: 1 }]);
    expect(r.items.find((i: { id: string }) => i.id === p.id)).toMatchObject({ category: null });
    const filtered = await call(`/api/v1/artifacts?category=${encodeURIComponent(CATEGORY)}`, {
      headers: editor.auth,
    });
    const text = await filtered.text();
    expect(JSON.parse(text).items).toEqual([]);
    expect(text).not.toContain(CATEGORY);
    // Over MCP too.
    const c = await mcpClient(editor.token);
    const listed = await tool(c, "list_artifacts", { category: CATEGORY });
    expect(listed.data.items).toEqual([]);
    expect(listed.text).not.toContain(CATEGORY);
  });

  const patch = (headers: Record<string, string>, ref: string, body: unknown) =>
    call(`/api/v1/artifacts/${ref}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("an editor's PATCH with a category is 403, by token or by session, and never echoes the name", async () => {
    const { editor, p } = await withEditor();
    const s = await browserSession(editor.user.id);
    for (const headers of [editor.auth, s.headers]) {
      for (const body of [{ category: "Mine" }, { category: null }]) {
        const r = await patch(headers, p.id, body);
        expect(r.status).toBe(403);
        const text = await r.text();
        expect(JSON.parse(text).error.code).toBe("forbidden");
        expect(text).not.toContain(CATEGORY);
      }
    }
    expect(await stored(p.id)).toEqual({ category: CATEGORY, v: 1 });
  });

  it("a stranger's PATCH is 404", async () => {
    const { p } = await withEditor();
    const stranger = await agent();
    const r = await patch(stranger.auth, p.id, { category: "Mine" });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain(CATEGORY);
    expect(await stored(p.id)).toEqual({ category: CATEGORY, v: 1 });
  });

  it("the owner of a taken-down artifact can still change its category", async () => {
    const { owner, p } = await withEditor();
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), p.id)
      .run();
    const r = await patch(owner.auth, p.id, { category: "Archive" });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ taken_down: true, category: "Archive" });
    expect((await patch(owner.auth, p.id, { category: null })).status).toBe(200);
    expect((await stored(p.id))?.category).toBeNull();
  });
});

// The filing safeguard (docs/spec.md "Category sharing and personal categories"): filing an artifact
// under a shared category never shares it, whoever files it and however. It waits as pending until
// the signed-in owner reviews it; until then the category's people cannot open, list or find it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { renameCategory } from "../src/services/categories.ts";
import { createShare, type ReviewItem } from "../src/services/categoryShares.ts";
import {
  categoryRow,
  filed,
  gateStatus,
  outboxFor,
  owner,
  person,
  reviewOf,
  rowsOf,
  run,
  send,
  shareCategory,
  shareDetail,
} from "./category-helpers.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import {
  browserSession,
  call,
  createUser,
  enterContent,
  json,
  mcpClient,
  serviceCtxFor,
  tool,
} from "./helpers.ts";
import { grant } from "./room-helpers.ts";

const html = (t: string) => `<!doctype html><title>${t}</title><p>${t}</p>`;

/** An owner with one artifact under "Acme", shared with a viewer. */
async function sharedAcme(role: "viewer" | "commenter" = "viewer") {
  const o = await owner();
  const first = await filed(o, "Acme", "First");
  const c = await person();
  const made = await shareCategory(o, "Acme", [{ email: c.email, role }]);
  return { o, c, first, shareId: made.share.id };
}

async function listedIds(headers: Record<string, string>): Promise<string[]> {
  const list = await json(await call("/api/v1/artifacts", { headers }));
  return (list.items as { id: string }[]).map((i) => i.id);
}

async function portalIds(shareId: string, headers: Record<string, string>): Promise<string[]> {
  const gate = await json(await call(`/api/v1/portals/${shareId}`, { headers }));
  return gate.status === "ok" ? (gate.items as { id: string }[]).map((i) => i.id) : [];
}

/** Every way a grantee could learn about the artifact says nothing. */
async function invisibleTo(
  c: Awaited<ReturnType<typeof person>>,
  shareId: string,
  a: { id: string; slug: string },
) {
  expect(await gateStatus(a.slug, c.session)).not.toBe("ok");
  expect((await call(`/api/v1/artifacts/${a.id}`, { headers: c.auth })).status).toBe(404);
  expect(await listedIds(c.auth)).not.toContain(a.id);
  expect(await portalIds(shareId, c.session)).not.toContain(a.id);
}

describe("filing never shares", () => {
  it("an agent's publish_artifact into a shared category waits as pending", async () => {
    const { o, c, shareId } = await sharedAcme();
    const mcp = await mcpClient(o.token);
    const { data: r } = await tool(mcp, "publish_artifact", {
      title: "Another client's report",
      html: html("secret"),
      category: "acme",
    });
    await mcp.close();
    expect(r.category).toBe("Acme");
    expect(r.category_share).toEqual({
      state: "pending",
      review_url: `http://app.localhost:8787/dashboard?review=${shareId}`,
    });
    await invisibleTo(c, shareId, r);
    // The allowlist code flow sends a category grantee nothing for it.
    const ask = await run(`/api/v1/view/${r.slug}/email`, {
      method: "POST",
      headers: {
        Cookie: "__Host-plinth_csrf=x",
        "x-plinth-csrf": "x",
        Origin: "http://app.localhost:8787",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: c.email }),
    });
    expect(ask.status).toBe(200);
    expect(await outboxFor(c.email)).toHaveLength(0);
  });

  it("snaps onto an empty share's spelling, and still waits", async () => {
    const o = await owner();
    await filed(o, "Acme Corp");
    const made = await shareCategory(o, "Acme Corp", []);
    // Clearing the category leaves the share empty; its name stays for new filings.
    expect(
      (await send("POST", "/api/v1/categories/rename", o.session, { from: "Acme Corp", to: null }))
        .status,
    ).toBe(200);
    const cats = await json(await call("/api/v1/categories", { headers: o.auth }));
    expect(cats.items).toContainEqual({ name: "Acme Corp", count: 0, shared: true });
    const r = await json(
      await send("POST", "/api/v1/artifacts", o.auth, {
        title: "Weekly",
        html: html("weekly"),
        category: "acme-corp",
      }),
    );
    expect(r.category).toBe("Acme Corp");
    expect(r.category_share?.state).toBe("pending");
    expect(r.category_share?.review_url).toContain(made.share.id);
  });

  it("start_upload and its bundle, and the upload status, report pending for the owner", async () => {
    const { o, c, shareId } = await sharedAcme();
    const mint = await json(
      await send("POST", "/api/v1/uploads", o.auth, { title: "Build", category: "ACME" }),
    );
    expect(mint.category_share?.state).toBe("pending");
    const bundle = await run(mint.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${mint.upload_token}` },
      body: tar([{ name: "index.html", data: html("build") }]),
    });
    expect(bundle.status).toBe(201);
    const result = await json(bundle);
    expect(result.category_share).toMatchObject({ state: "pending" });
    const status = await json(
      await run(mint.upload_url.replace(/\/bundle$/, ""), {
        headers: { Authorization: `Bearer ${mint.upload_token}` },
      }),
    );
    expect(status.category_share).toMatchObject({ state: "pending" });
    await invisibleTo(c, shareId, result);
  });

  it("update_artifact, a bearer PATCH and the owner's own session PATCH all leave it pending", async () => {
    const { o, c, shareId } = await sharedAcme();
    const viaUpdate = await filed(o, "Private", "Moved by update");
    const viaBearer = await filed(o, "Private", "Moved by a token");
    const viaSession = await filed(o, "Private", "Moved by the owner");
    const up = await json(
      await send("PUT", `/api/v1/artifacts/${viaUpdate.id}`, o.auth, {
        html: html("v2"),
        category: "Acme",
      }),
    );
    expect(up.category_share?.state).toBe("pending");
    const bearer = await json(
      await send("PATCH", `/api/v1/artifacts/${viaBearer.id}`, o.auth, { category: "acme" }),
    );
    expect(bearer.category_share).toBe("pending");
    const session = await json(
      await send("PATCH", `/api/v1/artifacts/${viaSession.id}`, o.session, { category: "Acme" }),
    );
    expect(session.category_share).toBe("pending");
    for (const a of [viaUpdate, viaBearer, viaSession]) await invisibleTo(c, shareId, a);
  });

  it("the single-user ADMIN_TOKEN files pending too", async () => {
    const adminEmail = `admin-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await createUser(adminEmail);
    const session = await browserSession(user.id);
    const vars = { SINGLE_USER_MODE: "true", ADMIN_TOKEN: "a".repeat(40), ADMIN_EMAIL: adminEmail };
    const admin = { Authorization: `Bearer ${"a".repeat(40)}` };
    const first = await json(
      await send(
        "POST",
        "/api/v1/artifacts",
        admin,
        { title: "One", html: html("one"), category: "Acme" },
        vars,
      ),
    );
    expect(first.id).toBeTruthy();
    const rows = [{ id: first.id, version: 1, category_rev: 0, decision: "shared" }];
    const made = await send(
      "POST",
      "/api/v1/category-shares",
      session.headers,
      {
        category: "Acme",
        people: [],
        review: rows,
      },
      vars,
    );
    expect(made.status).toBe(201);
    const second = await json(
      await send(
        "POST",
        "/api/v1/artifacts",
        admin,
        { title: "Two", html: html("two"), category: "acme" },
        vars,
      ),
    );
    expect(second.category_share?.state).toBe("pending");
    // And the ADMIN_TOKEN cannot review it in.
    const share = (await json(made)).share.id;
    const review = await send(
      "POST",
      `/api/v1/category-shares/${share}/review`,
      admin,
      {
        items: [{ id: second.id, version: 1, category_rev: 0, decision: "shared" }],
      },
      vars,
    );
    expect(review.status).toBe(403);
  });
});

describe("editors learn nothing about the owner's sharing", () => {
  it("update_artifact, PUT, an update ticket and the reads carry no category_share", async () => {
    for (const state of ["shared", "pending"] as const) {
      const o = await owner();
      const a = await filed(o, "Acme");
      const made = await shareCategory(o, "Acme", [], () => state === "shared");
      const editor = await person();
      await grant(a.id, editor.email, "editor");

      const mcp = await mcpClient(editor.auth.Authorization.slice(7));
      const { data: viaMcp } = await tool(mcp, "update_artifact", { id: a.id, html: html("e1") });
      const { data: got } = await tool(mcp, "get_artifact", { id: a.id });
      const { data: listed } = await tool(mcp, "list_artifacts", {});
      await mcp.close();
      const put = await json(
        await send("PUT", `/api/v1/artifacts/${a.id}`, editor.auth, { html: html("e2") }),
      );
      const mint = await json(
        await send("POST", "/api/v1/uploads", editor.auth, { id: a.id, base_version: 3 }),
      );
      const bundle = await json(
        await run(mint.upload_url, {
          method: "POST",
          headers: { Authorization: `Bearer ${mint.upload_token}` },
          body: tar([{ name: "index.html", data: html("e3") }]),
        }),
      );
      const status = await json(
        await run(mint.upload_url.replace(/\/bundle$/, ""), {
          headers: { Authorization: `Bearer ${mint.upload_token}` },
        }),
      );
      for (const r of [viaMcp, put, mint, bundle, status]) {
        expect(r.category_share, state).toBeUndefined();
        expect(JSON.stringify(r)).not.toContain(made.share.id);
      }
      expect(got.category_share).toBeNull();
      expect(got.category).toBeNull();
      const item = (listed.items as { id: string; category_share: unknown }[]).find(
        (i) => i.id === a.id,
      );
      expect(item?.category_share).toBeNull();
    }
  });
});

describe("after the owner's review", () => {
  it("a viewer views and cannot comment or edit; a commenter comments", async () => {
    const { o, c, first } = await sharedAcme("viewer");
    expect(await gateStatus(first.slug, c.session)).toBe("ok");
    const comment = (h: Record<string, string>) =>
      send("POST", `/api/v1/artifacts/${first.id}/comments`, h, { body: "Looks good" });
    expect((await comment(c.session)).status).toBe(403);
    expect(
      (await send("PUT", `/api/v1/artifacts/${first.id}`, c.auth, { html: html("x") })).status,
    ).toBe(403);
    const made = await json(await send("GET", "/api/v1/category-shares", o.session));
    const shareId = made.items[0].id;
    const rows = (await shareDetail(o, shareId)).artifacts;
    await send("PATCH", `/api/v1/category-shares/${shareId}`, o.session, {
      people: [{ email: c.email, role: "commenter" }],
      review: reviewOf(rows, () => true),
    });
    expect((await comment(c.session)).status).toBe(201);
    expect(
      (await send("PUT", `/api/v1/artifacts/${first.id}`, c.auth, { html: html("x") })).status,
    ).toBe(403);
  });

  it("moving a shared artifact into another shared category: pending there, gone for the first people", async () => {
    const { o, c, first } = await sharedAcme();
    await filed(o, "Beta");
    const b = await person();
    await shareCategory(o, "Beta", [{ email: b.email, role: "viewer" }]);
    const enter = await enterContent(first.slug, { headers: c.session });
    expect(enter.gate.status).toBe("ok");
    const before = await categoryRow(first.id);
    const moved = await json(
      await send("PATCH", `/api/v1/artifacts/${first.id}`, o.session, { category: "Beta" }),
    );
    expect(moved.category_share).toBe("pending");
    const after = await categoryRow(first.id);
    expect(after?.access_epoch).toBe((before?.access_epoch ?? 0) + 1);
    expect(after?.category_rev).toBe((before?.category_rev ?? 0) + 1);
    expect(after?.category_review).toBeNull();
    expect(await gateStatus(first.slug, c.session)).not.toBe("ok");
    expect(await gateStatus(first.slug, b.session)).not.toBe("ok");
    const page = await call(`http://${first.id}.content.localhost:8787/`, {
      headers: { Cookie: enter.cookie ?? "" },
    });
    expect(page.status).not.toBe(200);
  });

  it("respelling within one key keeps it shared, and a category-only PATCH leaves updated_at", async () => {
    const { o, c, first } = await sharedAcme();
    const before = await categoryRow(first.id);
    const r = await json(
      await send("PATCH", `/api/v1/artifacts/${first.id}`, o.session, { category: "ACME" }),
    );
    expect(r.category_share).toBe("shared");
    const after = await categoryRow(first.id);
    expect(after?.category).toBe("Acme");
    expect(after?.category_review).toBe("shared");
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(after?.access_epoch).toBe(before?.access_epoch);
    expect(await gateStatus(first.slug, c.session)).toBe("ok");
  });

  it("a stale review row gives a grantee nothing", async () => {
    const { o, c, first, shareId } = await sharedAcme();
    const other = await filed(o, "Other");
    const otherShare = await shareCategory(o, "Other", []);
    // Bound to the share of another key, then to a share that no longer exists.
    await env.DB.prepare(
      "UPDATE artifacts SET category_review = 'shared', category_review_share = ?1 WHERE id = ?2",
    )
      .bind(otherShare.share.id, first.id)
      .run();
    expect(await gateStatus(first.slug, c.session)).not.toBe("ok");
    await env.DB.prepare(
      "UPDATE artifacts SET category_review = 'shared', category_review_share = 'gone0000000000000000' WHERE id = ?1",
    )
      .bind(first.id)
      .run();
    expect(await gateStatus(first.slug, c.session)).not.toBe("ok");
    expect(await listedIds(c.auth)).not.toContain(first.id);
    expect(await portalIds(shareId, c.session)).toEqual([]);
    expect(other.id).toBeTruthy();
  });
});

describe("renaming and merging around shares", () => {
  it("a shared category cannot merge into an existing one", async () => {
    const { o } = await sharedAcme();
    await filed(o, "Beta");
    const r = await send("POST", "/api/v1/categories/rename", o.session, {
      from: "Acme",
      to: "beta",
    });
    expect(r.status).toBe(409);
    expect((await json(r)).error.details).toMatchObject({ reason: "category_shared" });
  });

  it("an unshared category merged into a shared one arrives pending", async () => {
    const { o, c, shareId } = await sharedAcme();
    const x = await filed(o, "Loose");
    const y = await filed(o, "Loose", "Loose two");
    const r = await json(
      await send("POST", "/api/v1/categories/rename", o.session, { from: "Loose", to: "acme" }),
    );
    expect(r).toEqual({ updated: 2, category: "Acme", pending: 2 });
    for (const a of [x, y]) {
      expect((await categoryRow(a.id))?.category_review).toBeNull();
      await invisibleTo(c, shareId, a);
    }
  });

  it("renaming a shared category to a new name moves the share and keeps its reviews", async () => {
    const { o, c, first, shareId } = await sharedAcme();
    const r = await json(
      await send("POST", "/api/v1/categories/rename", o.session, { from: "Acme", to: "Acme Corp" }),
    );
    expect(r).toEqual({ updated: 1, category: "Acme Corp" });
    const row = await categoryRow(first.id);
    expect(row).toMatchObject({
      category: "Acme Corp",
      category_key: "acme corp",
      category_review: "shared",
    });
    expect(await gateStatus(first.slug, c.session)).toBe("ok");
    const d = await json(await send("GET", `/api/v1/category-shares/${shareId}`, o.session));
    expect(d.category).toBe("Acme Corp");
  });

  it("clearing a shared category ends its people's passes and leaves the share empty", async () => {
    const { o, c, first, shareId } = await sharedAcme();
    const before = (await categoryRow(first.id))?.access_epoch ?? 0;
    const r = await json(
      await send("POST", "/api/v1/categories/rename", o.session, { from: "Acme", to: null }),
    );
    expect(r).toEqual({ updated: 1, category: null });
    expect((await categoryRow(first.id))?.access_epoch).toBe(before + 1);
    expect(await gateStatus(first.slug, c.session)).not.toBe("ok");
    const d = await json(await send("GET", `/api/v1/category-shares/${shareId}`, o.session));
    expect(d.artifacts).toEqual([]);
  });
});

describe("rename and createShare racing on one key", () => {
  /** env.DB whose first batch runs `between` before it goes through. */
  function dbWithPause(between: () => Promise<void>): D1Database {
    let paused = false;
    return new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!paused) {
              paused = true;
              await between();
            }
            return target.batch(stmts);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  const userCtx = (o: Awaited<ReturnType<typeof owner>>, DB?: D1Database) =>
    serviceCtxFor(
      { kind: "user", userId: o.user.id, email: o.user.email, isAdmin: false },
      DB ? { env: { DB } } : {},
    );

  it("a share created after the rename read its decision makes the rename change nothing", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const c = await person();
    const rows = await rowsOf(o, "Acme");
    const DB = dbWithPause(async () => {
      await createShare(userCtx(o), {
        category: "Acme",
        people: [{ email: c.email, role: "viewer" }],
        review: reviewOf(rows, () => true) as ReviewItem[],
      });
    });
    await expect(
      renameCategory(userCtx(o, DB), { from: "Acme", to: "Elsewhere" }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "sharing_changed" },
    });
    expect(await categoryRow(a.id)).toMatchObject({ category: "Acme", category_review: "shared" });
    expect(await gateStatus(a.slug, c.session)).toBe("ok");
  });

  it("a rename that lands between createShare's read and its batch leaves the share empty", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const b = await filed(o, "Acme", "Second");
    const c = await person();
    const rows = await rowsOf(o, "Acme");
    const DB = dbWithPause(async () => {
      await renameCategory(userCtx(o), { from: "Acme", to: "Elsewhere" });
    });
    // The rename moved every artifact away, so the share's key now has none: the review skips all.
    await filed(o, "Acme", "Keeps the name");
    const out = await createShare(userCtx(o, DB), {
      category: "Acme",
      people: [{ email: c.email, role: "viewer" }],
      review: reviewOf(rows, () => true) as ReviewItem[],
    });
    expect(out.review?.shared).toBe(0);
    expect(new Set(out.review?.skipped.map((s) => s.reason))).toEqual(new Set(["moved"]));
    for (const x of [a, b]) expect(await gateStatus(x.slug, c.session)).not.toBe("ok");
    expect(await listedIds(c.auth)).toEqual([]);
  });
});

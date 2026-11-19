// The owner's category share endpoints (docs/spec.md "Category sharing and personal categories"):
// session only, the limits, the review guards, reset-then-apply on create and on a people change,
// and access epochs on every change that takes access away.
import { env } from "cloudflare:workers";
import { LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  categoryRow,
  filed,
  gateStatus,
  owner,
  person,
  reviewOf,
  rowsOf,
  send,
  shareCategory,
  shareDetail,
} from "./category-helpers.ts";
import { call, enterContent, json, publish, uniqueEmail } from "./helpers.ts";

describe("category shares: who may manage them", () => {
  it("a session creates, reads, changes and deletes a share", async () => {
    const o = await owner();
    const a = await filed(o, "Acme", "Q3 report");
    const client = uniqueEmail("client");
    const made = await shareCategory(o, "acme", [{ email: client, role: "viewer" }]);
    expect(made.share).toMatchObject({
      title: "Acme",
      counts: { shared: 1, pending: 0, private: 0 },
    });
    expect(made.share.portal_url).toBe(`http://app.localhost:8787/p/${made.share.id}`);
    expect(made.review).toEqual({ shared: 1, private: 0, skipped: [] });

    const list = await json(await send("GET", "/api/v1/category-shares", o.session));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      category: "Acme",
      people: [{ email: client, role: "viewer" }],
    });

    const d = await shareDetail(o, made.share.id);
    expect(d.artifacts).toEqual([
      expect.objectContaining({ id: a.id, state: "shared", last_author: "Work Claude" }),
    ]);

    const titled = await send("PATCH", `/api/v1/category-shares/${made.share.id}`, o.session, {
      title: "Acme Corp reports",
    });
    expect(titled.status).toBe(200);
    expect((await json(titled)).share.title).toBe("Acme Corp reports");
    // A title-only change touches no review.
    expect((await categoryRow(a.id))?.category_review).toBe("shared");

    const del = await send("DELETE", `/api/v1/category-shares/${made.share.id}`, o.session);
    expect(del.status).toBe(204);
    expect((await categoryRow(a.id))?.category_review).toBeNull();
    expect((await json(await send("GET", "/api/v1/category-shares", o.session))).items).toEqual([]);
  });

  it("bearer tokens, MCP-style callers and anonymous callers get no share endpoint", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const body = { category: "Acme", people: [], review: [] };
    const bearer = await send("POST", "/api/v1/category-shares", o.auth, body);
    expect(bearer.status).toBe(403);
    expect((await json(bearer)).error.details).toMatchObject({ reason: "app_only" });
    expect((await send("GET", "/api/v1/category-shares", o.auth)).status).toBe(403);
    expect((await send("GET", "/api/v1/category-shares", {})).status).toBe(401);
  });

  it("refuses a missing CSRF token and a wrong Origin", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const body = { category: "Acme", people: [], review: [] };
    const { "x-plinth-csrf": _csrf, ...noCsrf } = o.session;
    expect((await send("POST", "/api/v1/category-shares", noCsrf, body)).status).toBe(403);
    const wrongOrigin = { ...o.session, Origin: "https://evil.example" };
    expect((await send("POST", "/api/v1/category-shares", wrongOrigin, body)).status).toBe(403);
  });

  it("is closed with ALLOW_CATEGORY_SHARING off", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const off = { ALLOW_CATEGORY_SHARING: "false" };
    const r = await send(
      "POST",
      "/api/v1/category-shares",
      o.session,
      {
        category: "Acme",
        people: [],
        review: [],
      },
      off,
    );
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe("feature_disabled");
  });
});

describe("GET /category-shares/preview", () => {
  it("lists what a new share would review, and refuses an unknown or already shared category", async () => {
    const o = await owner();
    const a = await filed(o, "Acme", "One");
    const r = await send("GET", "/api/v1/category-shares/preview?category=ACME", o.session);
    expect(r.status).toBe(200);
    const preview = await json(r);
    expect(preview.category).toBe("Acme");
    expect(preview.artifacts).toEqual([
      expect.objectContaining({ id: a.id, current_version: 1, category_rev: 0, state: "pending" }),
    ]);
    expect(
      (await send("GET", "/api/v1/category-shares/preview?category=Nope", o.session)).status,
    ).toBe(404);
    expect(
      (await send("GET", "/api/v1/category-shares/preview?category=Acme", o.auth)).status,
    ).toBe(403);
    await shareCategory(o, "Acme", []);
    expect(
      (await send("GET", "/api/v1/category-shares/preview?category=Acme", o.session)).status,
    ).toBe(409);
  });
});

describe("category shares: input", () => {
  it("404 for a category the owner does not have, 409 when it is already shared", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const missing = await send("POST", "/api/v1/category-shares", o.session, {
      category: "Nope",
      people: [],
      review: [],
    });
    expect(missing.status).toBe(404);
    await shareCategory(o, "Acme", []);
    const again = await send("POST", "/api/v1/category-shares", o.session, {
      category: "ACME",
      people: [],
      review: [],
    });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details).toMatchObject({ reason: "already_shared" });
  });

  it("ignores the owner's own address and refuses duplicates", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const dup = uniqueEmail("dup");
    const twice = await send("POST", "/api/v1/category-shares", o.session, {
      category: "Acme",
      people: [
        { email: dup, role: "viewer" },
        { email: dup, role: "commenter" },
      ],
      review: [],
    });
    expect(twice.status).toBe(400);
    const made = await shareCategory(o, "Acme", [{ email: o.user.email, role: "viewer" }]);
    const d = await shareDetail(o, made.share.id);
    expect(d.people).toEqual([]);
  });

  it("refuses editor roles, too many people and a title over the limit", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const base = { category: "Acme", review: [] };
    const editor = await send("POST", "/api/v1/category-shares", o.session, {
      ...base,
      people: [{ email: uniqueEmail(), role: "editor" }],
    });
    expect(editor.status).toBe(400);
    const many = await send("POST", "/api/v1/category-shares", o.session, {
      ...base,
      people: Array.from({ length: LIMITS.maxAllowlistEmails + 1 }, (_, i) => ({
        email: `p${i}@example.com`,
        role: "viewer",
      })),
    });
    expect(many.status).toBe(400);
    const long = await send("POST", "/api/v1/category-shares", o.session, {
      ...base,
      people: [],
      title: "x".repeat(LIMITS.maxTitleLength + 1),
    });
    expect(long.status).toBe(400);
  });

  it(`stops at ${LIMITS.maxCategorySharesPerOwner} shares`, async () => {
    const o = await owner();
    await filed(o, "One more");
    const now = new Date().toISOString();
    const stmts = Array.from({ length: LIMITS.maxCategorySharesPerOwner }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO category_shares (id, owner_id, category_key, name, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?4)",
      ).bind(`fill${o.user.id.slice(0, 8)}${i}`, o.user.id, `filler ${i}`, now),
    );
    await env.DB.batch(stmts);
    const r = await send("POST", "/api/v1/category-shares", o.session, {
      category: "One more",
      people: [],
      review: [],
    });
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe("quota_exceeded");
  });

  it("caps review items at the owner's artifact limit and refuses an id twice", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    await env.DB.prepare("UPDATE users SET artifact_limit = 1 WHERE id = ?1").bind(o.user.id).run();
    const item = { id: a.id, version: 1, category_rev: 0, decision: "shared" };
    const two = await send("POST", "/api/v1/category-shares", o.session, {
      category: "Acme",
      people: [],
      review: [item, { ...item, id: "a".repeat(20) }],
    });
    expect(two.status).toBe(400);
    await env.DB.prepare("UPDATE users SET artifact_limit = NULL WHERE id = ?1")
      .bind(o.user.id)
      .run();
    const dup = await send("POST", "/api/v1/category-shares", o.session, {
      category: "Acme",
      people: [],
      review: [item, { ...item, decision: "private" }],
    });
    expect(dup.status).toBe(400);
  });

  it("PATCH with people needs a review", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const made = await shareCategory(o, "Acme", []);
    const r = await send("PATCH", `/api/v1/category-shares/${made.share.id}`, o.session, {
      people: [{ email: uniqueEmail(), role: "viewer" }],
    });
    expect(r.status).toBe(400);
    expect((await json(r)).error.details).toMatchObject({ reason: "review_required" });
  });

  it("another owner's share is 404", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const made = await shareCategory(o, "Acme", []);
    const other = await owner();
    expect(
      (await send("GET", `/api/v1/category-shares/${made.share.id}`, other.session)).status,
    ).toBe(404);
    expect(
      (await send("DELETE", `/api/v1/category-shares/${made.share.id}`, other.session)).status,
    ).toBe(404);
  });
});

describe("category shares: the review", () => {
  it("skips items that changed: a new version, a move out and back, a move away, a delete", async () => {
    const o = await owner();
    const v2 = await filed(o, "Acme", "New version");
    const back = await filed(o, "Acme", "Out and back");
    const away = await filed(o, "Acme", "Moved");
    const gone = await filed(o, "Acme", "Deleted");
    const made = await shareCategory(o, "Acme", [], () => false);
    const rows = (await shareDetail(o, made.share.id)).artifacts;
    // Changes made after the owner opened the review:
    await send("PUT", `/api/v1/artifacts/${v2.id}`, o.auth, { html: "<!doctype html><p>v2</p>" });
    await send("PATCH", `/api/v1/artifacts/${back.id}`, o.auth, { category: "Elsewhere" });
    await send("PATCH", `/api/v1/artifacts/${back.id}`, o.auth, { category: "Acme" });
    await send("PATCH", `/api/v1/artifacts/${away.id}`, o.auth, { category: "Other" });
    await send("DELETE", `/api/v1/artifacts/${gone.id}`, o.auth);
    const r = await send("POST", `/api/v1/category-shares/${made.share.id}/review`, o.session, {
      items: reviewOf(rows, () => true),
    });
    expect(r.status).toBe(200);
    const out = await json(r);
    expect(out.shared).toBe(0);
    const reasons = Object.fromEntries(
      (out.skipped as { id: string; reason: string }[]).map((s) => [s.id, s.reason]),
    );
    expect(reasons).toEqual({
      [v2.id]: "changed",
      [back.id]: "changed",
      [away.id]: "moved",
      [gone.id]: "gone",
    });
    // A new version keeps the earlier decision; a move out and back reset it.
    expect((await categoryRow(v2.id))?.category_review).toBe("private");
    expect((await categoryRow(back.id))?.category_review).toBeNull();
  });

  it("a taken-down artifact is skipped as gone", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const made = await shareCategory(o, "Acme", [], () => false);
    const rows = (await shareDetail(o, made.share.id)).artifacts;
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), a.id)
      .run();
    const out = await json(
      await send("POST", `/api/v1/category-shares/${made.share.id}/review`, o.session, {
        items: reviewOf(rows, () => true),
      }),
    );
    expect(out.skipped).toEqual([{ id: a.id, reason: "gone" }]);
  });

  it("reset: a stale review from a deleted share and a filing after the dialog loaded are pending", async () => {
    const o = await owner();
    const old = await filed(o, "Acme", "Shared before");
    const first = await shareCategory(o, "Acme", []);
    await send("DELETE", `/api/v1/category-shares/${first.share.id}`, o.session);
    // A hand-written stale review bound to the deleted share.
    await env.DB.prepare(
      "UPDATE artifacts SET category_review = 'shared', category_review_share = ?1 WHERE id = ?2",
    )
      .bind(first.share.id, old.id)
      .run();
    const rows = await rowsOf(o, "Acme");
    const late = await filed(o, "Acme", "Filed after the dialog loaded");
    const res = await send("POST", "/api/v1/category-shares", o.session, {
      category: "Acme",
      people: [],
      review: reviewOf(rows, () => false),
    });
    expect(res.status).toBe(201);
    const share = (await json(res)).share;
    expect((await categoryRow(old.id))?.category_review).toBe("private");
    expect((await categoryRow(late.id))?.category_review).toBeNull();
    expect(share.counts).toEqual({ shared: 0, pending: 1, private: 1 });
  });

  it("a people change: an artifact left out of the review is pending and its old people lose it", async () => {
    const o = await owner();
    const keep = await filed(o, "Acme", "Kept");
    const drop = await filed(o, "Acme", "Left out");
    const c = await person();
    const made = await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }]);
    const enter = await enterContent(drop.slug, { headers: c.session });
    expect(enter.gate.status).toBe("ok");
    const epoch = (await categoryRow(drop.id))?.access_epoch ?? 0;
    const rows = (await shareDetail(o, made.share.id)).artifacts.filter((r) => r.id === keep.id);
    const res = await send("PATCH", `/api/v1/category-shares/${made.share.id}`, o.session, {
      people: [{ email: c.email, role: "commenter" }],
      review: reviewOf(rows, () => true),
    });
    expect(res.status).toBe(200);
    expect((await categoryRow(drop.id))?.category_review).toBeNull();
    expect((await categoryRow(drop.id))?.access_epoch).toBeGreaterThan(epoch);
    expect(await gateStatus(drop.slug, c.session)).not.toBe("ok");
    // The old content cookie no longer opens it.
    const page = await call(`http://${drop.id}.content.localhost:8787/`, {
      headers: { Cookie: enter.cookie ?? "" },
    });
    expect(page.status).not.toBe(200);
    expect(await gateStatus(keep.slug, c.session)).toBe("ok");
  });

  it("deleting a share and keeping an artifact private both end the people's passes", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const b = await filed(o, "Acme", "Second");
    const c = await person();
    const made = await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }]);
    const before = (await categoryRow(a.id))?.access_epoch ?? 0;
    const rows = (await shareDetail(o, made.share.id)).artifacts.filter((r) => r.id === a.id);
    await send("POST", `/api/v1/category-shares/${made.share.id}/review`, o.session, {
      items: reviewOf(rows, () => false),
    });
    expect((await categoryRow(a.id))?.access_epoch).toBe(before + 1);
    expect(await gateStatus(a.slug, c.session)).not.toBe("ok");
    const bBefore = (await categoryRow(b.id))?.access_epoch ?? 0;
    await send("DELETE", `/api/v1/category-shares/${made.share.id}`, o.session);
    expect((await categoryRow(b.id))?.access_epoch).toBe(bBefore + 1);
    expect(await gateStatus(b.slug, c.session)).not.toBe("ok");
  });

  it("with the switch off, a shared review gives nothing", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const c = await person();
    await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }]);
    const gate = await json(
      await send("GET", `/api/v1/view/${a.slug}`, c.session, undefined, {
        ALLOW_CATEGORY_SHARING: "false",
      }),
    );
    expect(gate.status).not.toBe("ok");
    const list = await json(
      await send("GET", "/api/v1/artifacts", c.auth, undefined, {
        ALLOW_CATEGORY_SHARING: "false",
      }),
    );
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(a.id);
  });

  it("a review needs the artifact in the share's current key", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const other = await publish(o.auth, {
      title: "Other",
      category: "Other",
      visibility: "allowlist",
    });
    const made = await shareCategory(o, "Acme", [], () => false);
    const r = await json(
      await send("POST", `/api/v1/category-shares/${made.share.id}/review`, o.session, {
        items: [
          { id: other.body.id, version: 1, category_rev: 0, decision: "shared" },
          { id: a.id, version: 1, category_rev: 0, decision: "shared" },
        ],
      }),
    );
    expect(r.shared).toBe(1);
    expect(r.skipped).toEqual([{ id: other.body.id, reason: "moved" }]);
  });
});

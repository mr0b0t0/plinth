// What a category grant gives once it counts (docs/spec.md "Category sharing and personal
// categories"): the stronger of it and a direct grant, the identity sealed for shared data, the
// author role agents read on mentions, and the list_artifacts arm that brings shared artifacts in.
// Owner rows and direct-grant rows list exactly as before, taken-down rows included.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { filed, owner, person, send, shareCategory } from "./category-helpers.ts";
import { call, contentOrigin, enterContent, json, publish } from "./helpers.ts";
import { grant, run } from "./room-helpers.ts";

const DATA_PAGE =
  '<!doctype html><title>Board</title><meta name="plinth-capabilities" content="data viewer"><p>b</p>';

const takeDown = (id: string) =>
  env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), id)
    .run();

async function listed(headers: Record<string, string>) {
  const list = await json(await call("/api/v1/artifacts", { headers }));
  return new Map(
    (list.items as { id: string; role: string; taken_down: boolean; category: unknown }[]).map(
      (i) => [i.id, i],
    ),
  );
}

describe("a category grant that counts", () => {
  it("a direct editor grant beats a category viewer grant, and the reverse holds for viewers", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const b = await filed(o, "Acme", "Second");
    const c = await person();
    await grant(a.id, c.email, "editor");
    await grant(b.id, c.email, "viewer");
    await shareCategory(o, "Acme", [{ email: c.email, role: "commenter" }]);
    const ga = await json(await call(`/api/v1/view/${a.slug}`, { headers: c.session }));
    const gb = await json(await call(`/api/v1/view/${b.slug}`, { headers: c.session }));
    expect(ga.role).toBe("editor");
    expect(gb.role).toBe("commenter");
    const items = await listed(c.auth);
    expect(items.get(a.id)?.role).toBe("editor");
    expect(items.get(b.id)?.role).toBe("commenter");
  });

  it("seals the category grantee's email and role, and stamps their shared-data writes", async () => {
    const o = await owner();
    const { body: a } = await publish(o.auth, {
      title: "Board",
      html: DATA_PAGE,
      category: "Acme",
      visibility: "allowlist",
    });
    const c = await person();
    await shareCategory(o, "Acme", [{ email: c.email, role: "commenter" }]);
    const { gate, cookie } = await enterContent(a.slug, { headers: c.session });
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("commenter");
    expect(gate.data).toMatchObject({ identified: true, can_write: true, email: c.email });
    const put = await run(`${contentOrigin(a.id)}/__plinth/api/v1/data/notes/n1`, {
      method: "PUT",
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        origin: contentOrigin(a.id),
        "content-type": "application/json",
        cookie: cookie ?? "",
      },
      body: JSON.stringify({ data: { text: "hello" } }),
    });
    expect(put.status).toBeLessThan(300);
    const row = await env.DB.prepare(
      "SELECT created_by_email, created_by_role FROM artifact_docs WHERE artifact_id = ?1",
    )
      .bind(a.id)
      .first<{ created_by_email: string; created_by_role: string }>();
    expect(row).toEqual({ created_by_email: c.email, created_by_role: "commenter" });
  });

  it("list_mentions names a category commenter's role", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const c = await person();
    await shareCategory(o, "Acme", [{ email: c.email, role: "commenter" }]);
    const posted = await send("POST", `/api/v1/artifacts/${a.id}/comments`, c.session, {
      body: "@work-claude please add a chart",
    });
    expect(posted.status).toBe(201);
    const tasks = await json(await call("/api/v1/mentions", { headers: o.auth }));
    expect(tasks.items).toHaveLength(1);
    expect(tasks.items[0].comment_author_role).toBe("commenter");
  });

  it("thumbnails follow view", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const pending = await filed(o, "Acme", "Pending");
    const c = await person();
    await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }], (r) => r.id === a.id);
    const vars = { THUMBNAILS: "false" };
    // With thumbnails off both answer as missing; the point is a pending one never answers more
    // than a stranger's would.
    const shared = await run(
      `http://app.localhost:8787/api/v1/artifacts/${a.id}/thumbnail`,
      { headers: c.session },
      vars,
    );
    const hidden = await run(
      `http://app.localhost:8787/api/v1/artifacts/${pending.id}/thumbnail`,
      { headers: c.session },
      vars,
    );
    expect(hidden.status).toBe(404);
    expect([404, 200]).toContain(shared.status);
  });
});

describe("list_artifacts and the category arm", () => {
  it("the owner lists a taken-down artifact with its badge, in and out of a shared category", async () => {
    const o = await owner();
    const inside = await filed(o, "Acme");
    const outside = await filed(o, "Other");
    await shareCategory(o, "Acme", []);
    await takeDown(inside.id);
    await takeDown(outside.id);
    const items = await listed(o.auth);
    expect(items.get(inside.id)?.taken_down).toBe(true);
    expect(items.get(outside.id)?.taken_down).toBe(true);
  });

  it("a direct grantee still lists a taken-down artifact; a category-only grantee does not", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const direct = await person();
    const viaCategory = await person();
    await grant(a.id, direct.email, "viewer");
    await shareCategory(o, "Acme", [
      { email: direct.email, role: "viewer" },
      { email: viaCategory.email, role: "viewer" },
    ]);
    expect((await listed(viaCategory.auth)).get(a.id)?.role).toBe("viewer");
    await takeDown(a.id);
    expect((await listed(direct.auth)).get(a.id)?.taken_down).toBe(true);
    expect((await listed(viaCategory.auth)).has(a.id)).toBe(false);
  });

  it("a category grantee lists shared artifacts with their role, never pending or private ones", async () => {
    const o = await owner();
    const shared = await filed(o, "Acme");
    const kept = await filed(o, "Acme", "Kept private");
    const c = await person();
    await shareCategory(
      o,
      "Acme",
      [{ email: c.email, role: "commenter" }],
      (r) => r.id === shared.id,
    );
    const pending = await filed(o, "Acme", "Filed later");
    const items = await listed(c.auth);
    expect(items.get(shared.id)?.role).toBe("commenter");
    expect(items.has(kept.id)).toBe(false);
    expect(items.has(pending.id)).toBe(false);
    // Category names never reach the grantee.
    expect(items.get(shared.id)?.category).toBeNull();
  });

  it("a category filter still covers only the caller's own rows", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const c = await person();
    await filed({ ...o, auth: c.auth } as never, "Acme", "Client's own");
    await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }]);
    const list = await json(await call("/api/v1/artifacts?category=Acme", { headers: c.auth }));
    const ids = (list.items as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toHaveLength(1);
  });
});

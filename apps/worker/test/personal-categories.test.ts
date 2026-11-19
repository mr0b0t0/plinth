// Personal categories (issue #42; docs/spec.md "Category sharing and personal categories"): a
// collaborator files an artifact shared with them under a category of their own, seen by them only
// and set in the app only. The row goes when they lose access or the artifact goes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { filed, owner, person, send, shareCategory } from "./category-helpers.ts";
import { call, json, publish } from "./helpers.ts";
import { grant } from "./room-helpers.ts";

const setMine = (ref: string, headers: Record<string, string>, category: string | null) =>
  send("PUT", `/api/v1/artifacts/${ref}/my-category`, headers, { category });

const rows = (artifactId: string) =>
  env.DB.prepare("SELECT user_id, category FROM personal_categories WHERE artifact_id = ?1")
    .bind(artifactId)
    .all<{ user_id: string; category: string }>()
    .then((r) => r.results);

async function sharedWith(role: "viewer" | "commenter" | "editor" = "viewer") {
  const o = await owner();
  const a = await filed(o, "Owner's own", "Shared deck");
  const c = await person();
  await grant(a.id, c.email, role);
  return { o, a, c };
}

describe("PUT /artifacts/:ref/my-category", () => {
  it("a collaborator files a shared artifact under their own name, seen by them only", async () => {
    const { o, a, c } = await sharedWith();
    const r = await setMine(a.id, c.session, "  Client   work ");
    expect(r.status).toBe(200);
    const summary = await json(r);
    expect(summary.my_category).toBe("Client work");
    // The owner's category stays the owner's, and stays hidden from the collaborator.
    expect(summary.category).toBeNull();

    const mine = await json(await call("/api/v1/artifacts", { headers: c.session }));
    expect(mine.my_categories).toEqual([{ name: "Client work", count: 1 }]);
    expect(mine.items.find((i: { id: string }) => i.id === a.id)?.my_category).toBe("Client work");

    // The owner never sees it.
    const theirs = await json(await call("/api/v1/artifacts", { headers: o.session }));
    expect(theirs.items.find((i: { id: string }) => i.id === a.id)).toMatchObject({
      category: "Owner's own",
      my_category: null,
    });
    expect(JSON.stringify(theirs)).not.toContain("Client work");

    // Agents never see it either, not even the collaborator's own.
    const agentList = await json(await call("/api/v1/artifacts", { headers: c.auth }));
    expect(agentList.my_categories).toBeUndefined();
    expect(agentList.items.find((i: { id: string }) => i.id === a.id)?.my_category).toBeNull();
  });

  it("snaps onto the person's own spelling and clears with null", async () => {
    const { o, a, c } = await sharedWith("commenter");
    const b = await filed(o, "Owner's own", "Second");
    await grant(b.id, c.email, "viewer");
    await setMine(a.id, c.session, "Client Work");
    const snapped = await json(await setMine(b.id, c.session, "client-work"));
    expect(snapped.my_category).toBe("Client Work");
    const cleared = await json(await setMine(b.id, c.session, null));
    expect(cleared.my_category).toBeNull();
    expect(await rows(b.id)).toEqual([]);
  });

  it("is refused for agents, for the owner, and for people without a grant", async () => {
    const { o, a, c } = await sharedWith();
    const bearer = await setMine(a.id, c.auth, "Mine");
    expect(bearer.status).toBe(403);
    expect((await json(bearer)).error.details).toMatchObject({ reason: "app_only" });
    const own = await setMine(a.id, o.session, "Mine");
    expect(own.status).toBe(400);
    expect((await json(own)).error.details).toMatchObject({ reason: "owner" });
    const stranger = await person();
    expect((await setMine(a.id, stranger.session, "Mine")).status).toBe(404);
    // A link viewer of an unlisted artifact holds no grant: nothing to file.
    const { body: open } = await publish(o.auth, { title: "Open", visibility: "unlisted" });
    const link = await setMine(open.id, stranger.session, "Mine");
    expect(link.status).toBe(403);
    expect((await json(link)).error.details).toMatchObject({ reason: "no_grant" });
    expect((await setMine(a.id, c.session, " ")).status).toBe(400);
  });

  it("goes when the person loses access: the sharing list, the allowlist and the artifact itself", async () => {
    const { o, a, c } = await sharedWith();
    await setMine(a.id, c.session, "Mine");
    expect(await rows(a.id)).toHaveLength(1);
    await send("PUT", `/api/v1/artifacts/${a.id}/sharing`, o.session, { grants: [] });
    expect(await rows(a.id)).toEqual([]);

    const b = await filed(o, "x", "Allowlisted");
    await send("PUT", `/api/v1/artifacts/${b.id}/visibility`, o.auth, {
      visibility: "allowlist",
      emails: [c.email],
    });
    await setMine(b.id, c.session, "Mine");
    await send("PUT", `/api/v1/artifacts/${b.id}/visibility`, o.auth, {
      visibility: "allowlist",
      emails: [],
    });
    expect(await rows(b.id)).toEqual([]);

    const d = await filed(o, "x", "Deleted");
    await grant(d.id, c.email, "viewer");
    await setMine(d.id, c.session, "Mine");
    await send("DELETE", `/api/v1/artifacts/${d.id}`, o.auth);
    expect(await rows(d.id)).toEqual([]);
  });

  it("a category grantee files too, and loses it when the share stops, unless a direct grant remains", async () => {
    const o = await owner();
    const a = await filed(o, "Acme");
    const viaCategory = await person();
    const both = await person();
    await grant(a.id, both.email, "viewer");
    const made = await shareCategory(o, "Acme", [
      { email: viaCategory.email, role: "viewer" },
      { email: both.email, role: "viewer" },
    ]);
    expect((await setMine(a.id, viaCategory.session, "Acme work")).status).toBe(200);
    expect((await setMine(a.id, both.session, "Both")).status).toBe(200);
    await send("DELETE", `/api/v1/category-shares/${made.share.id}`, o.session);
    const left = await rows(a.id);
    expect(left).toEqual([{ user_id: both.user.id, category: "Both" }]);
  });
});

describe("renaming personal categories", () => {
  it("renames, merges and clears only the person's own rows", async () => {
    const { o, a, c } = await sharedWith();
    const b = await filed(o, "x", "Second");
    await grant(b.id, c.email, "viewer");
    const other = await person();
    await grant(a.id, other.email, "viewer");
    await setMine(a.id, c.session, "Old");
    await setMine(b.id, c.session, "Kept");
    await setMine(a.id, other.session, "Old");
    const r = await json(
      await send("POST", "/api/v1/categories/rename", c.session, {
        from: "old",
        to: "kept",
        personal: true,
      }),
    );
    expect(r).toEqual({ updated: 1, category: "Kept" });
    expect(await rows(a.id)).toEqual(
      expect.arrayContaining([
        { user_id: c.user.id, category: "Kept" },
        { user_id: other.user.id, category: "Old" },
      ]),
    );
    const cleared = await json(
      await send("POST", "/api/v1/categories/rename", c.session, {
        from: "Kept",
        to: null,
        personal: true,
      }),
    );
    expect(cleared).toEqual({ updated: 2, category: null });
    // Bearer tokens never rename in bulk.
    expect(
      (
        await send("POST", "/api/v1/categories/rename", c.auth, {
          from: "x",
          to: "y",
          personal: true,
        })
      ).status,
    ).toBe(403);
  });
});

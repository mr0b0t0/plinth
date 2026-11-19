// The admin CLI and category sharing: erase-user removes the person's address from other people's
// category shares, and bump-epochs --category-shared ends every pass issued through a share.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  bumpCategorySharedEpochsSql,
  ERASE_USER_STEPS,
  parseArgs,
  UsageError,
} from "../scripts/admin-lib.mjs";
import { categoryRow, filed, owner, person, shareCategory } from "./category-helpers.ts";

describe("erase-user and category grants", () => {
  it("deletes the address from every category share, before the users row", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const c = await person();
    const made = await shareCategory(o, "Acme", [{ email: c.email, role: "viewer" }]);
    const step = ERASE_USER_STEPS.find((s) => s.table === "category_grants");
    expect(step).toBeDefined();
    const tables = ERASE_USER_STEPS.map((s) => s.table);
    expect(tables.indexOf("category_grants")).toBeLessThan(tables.indexOf("users"));
    await env.DB.prepare(step?.sql(c.email) ?? "").run();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM category_grants WHERE share_id = ?1",
    )
      .bind(made.share.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("the owner's own shares and personal categories go with the users row", async () => {
    const o = await owner();
    await filed(o, "Acme");
    const made = await shareCategory(o, "Acme", []);
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(o.user.id).run();
    const share = await env.DB.prepare("SELECT 1 AS one FROM category_shares WHERE id = ?1")
      .bind(made.share.id)
      .first();
    expect(share).toBeNull();
  });
});

describe("bump-epochs --category-shared", () => {
  it("parses only with the flag, and needs a target", () => {
    const p = parseArgs(["bump-epochs", "--category-shared", "--remote", "--env", "staging"]);
    expect(p).toMatchObject({ command: "bump-epochs", target: "remote" });
    if (p.help || p.command !== "bump-epochs") throw new Error("not bump-epochs");
    expect(p.wranglerArgs).toEqual([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      bumpCategorySharedEpochsSql(),
      "--env",
      "staging",
    ]);
    expect(() => parseArgs(["bump-epochs", "--local"])).toThrow(UsageError);
    expect(() => parseArgs(["bump-epochs", "--category-shared"])).toThrow(UsageError);
    expect(() => parseArgs(["set-limit", "a@b.co", "3", "--local", "--category-shared"])).toThrow(
      UsageError,
    );
  });

  it("bumps the epoch of shared artifacts only", async () => {
    const o = await owner();
    const shared = await filed(o, "Acme");
    const kept = await filed(o, "Acme", "Kept");
    await shareCategory(o, "Acme", [], (r) => r.id === shared.id);
    const before = [
      (await categoryRow(shared.id))?.access_epoch,
      (await categoryRow(kept.id))?.access_epoch,
    ];
    await env.DB.prepare(bumpCategorySharedEpochsSql()).run();
    expect((await categoryRow(shared.id))?.access_epoch).toBe((before[0] ?? 0) + 1);
    expect((await categoryRow(kept.id))?.access_epoch).toBe(before[1]);
  });
});

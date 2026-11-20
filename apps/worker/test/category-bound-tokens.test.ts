// Category sharing and tokens limited to one artifact (docs/spec.md "Category sharing and personal
// categories" and "Auth and permissions"): a bound token never sees or manages a category share.
// It gets nothing about the owner's sharing on its artifact, 403 `token_bound` on every share,
// portal and personal-category endpoint (switch on or off, whatever the id), and no role through a
// category grant, so it opens its artifact only with its person's direct rights.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  categoryRow,
  filed,
  type Owner,
  owner,
  person,
  run,
  send,
  shareCategory,
  shareDetail,
} from "./category-helpers.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import { json, mcpClient, tool } from "./helpers.ts";

async function boundToken(session: Record<string, string>, artifact: string) {
  const res = await send("POST", "/api/v1/connections", session, { label: "CI: report", artifact });
  const body = await json(res);
  expect(res.status, JSON.stringify(body)).toBe(201);
  return { token: body.token as string, auth: { Authorization: `Bearer ${body.token}` } };
}

async function req(
  method: string,
  path: string,
  auth: Record<string, string>,
  body?: unknown,
  vars: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await send(method, `/api/v1${path}`, auth, body, vars);
  return { status: res.status, body: res.status === 204 ? null : await json(res) };
}

function tokenBound(r: { status: number; body: any }, what: string) {
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
  expect(r.body.error.code, what).toBe("forbidden");
  expect(r.body.error.details?.reason, what).toBe("token_bound");
}

/** An owner with two artifacts under a category shared with a commenter, both reviewed shared. */
async function sharedSetup(): Promise<{
  o: Owner;
  a: { id: string; slug: string };
  b: { id: string; slug: string };
  share: { id: string };
  client: Awaited<ReturnType<typeof person>>;
}> {
  const o = await owner();
  const a = await filed(o, "Acme", "Coverage report");
  const b = await filed(o, "Acme", "Roadmap");
  const client = await person();
  const { share } = await shareCategory(o, "Acme", [{ email: client.email, role: "commenter" }]);
  return { o, a, b, share, client };
}

describe("a token limited to one artifact and category shares", () => {
  it("sees nothing of the owner's share on its own artifact", async () => {
    const { o, a, share } = await sharedSetup();
    // The owner's account-wide token does see the share state and the shared name.
    const wide = await req("GET", `/artifacts/${a.id}`, o.auth);
    expect(wide.body.category_share).toBe("shared");
    const wideList = await req("GET", "/artifacts", o.auth);
    expect(wideList.body.categories).toEqual([{ name: "Acme", count: 2, shared: true }]);

    const t = await boundToken(o.session, a.id);
    const got = await req("GET", `/artifacts/${a.id}`, t.auth);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ category: null, category_share: null, my_category: null });
    const list = await req("GET", "/artifacts", t.auth);
    expect(list.body.categories).toEqual([]);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ category: null, category_share: null });
    expect((await req("GET", "/categories", t.auth)).body.items).toEqual([]);

    // A new version: no category_share in the result, no review link, no share id anywhere.
    const put = await req("PUT", `/artifacts/${a.id}`, t.auth, {
      html: "<!doctype html><title>Coverage report</title><p>Build 2</p>",
      base_version: got.body.version,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.category_share).toBeUndefined();
    // Through an upload ticket: the mint, the bundle and the status carry none either.
    const ticket = await req("POST", "/uploads", t.auth, { id: a.id, base_version: 2 });
    expect(ticket.status).toBe(201);
    expect(ticket.body.category_share).toBeUndefined();
    const ctx = createExecutionContext();
    const bundled = await worker.fetch(
      new Request(ticket.body.upload_url, {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket.body.upload_token}` },
        body: tar([{ name: "index.html", data: "<!doctype html><title>R</title><p>3</p>" }]),
      }),
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const bundleBody = await json(bundled);
    expect(bundled.status, JSON.stringify(bundleBody)).toBe(200);
    expect(bundleBody.category_share).toBeUndefined();
    const status = await req("GET", `/uploads/${ticket.body.upload_id}`, {
      Authorization: `Bearer ${ticket.body.upload_token}`,
    });
    expect(status.status).toBe(200);
    expect(status.body.category_share).toBeUndefined();

    // Over MCP too.
    const c = await mcpClient(t.token);
    const mcpGot = await tool(c, "get_artifact", { id: a.id });
    expect(mcpGot.data).toMatchObject({ category: null, category_share: null });
    const mcpList = await tool(c, "list_artifacts", { limit: 0 });
    expect(mcpList.data.categories).toEqual([]);
    const updated = await tool(c, "update_artifact", {
      id: a.id,
      html: "<!doctype html><title>R</title><p>4</p>",
      base_version: 3,
    });
    expect(updated.isError, updated.text).toBe(false);
    expect(updated.data.category_share).toBeUndefined();
    for (const body of [got.body, list.body, put.body, ticket.body, bundleBody, status.body]) {
      expect(JSON.stringify(body)).not.toContain(share.id);
    }
    expect(updated.text).not.toContain(share.id);
    // The versions it published keep the owner's review: still shared, never reset by the token.
    expect((await categoryRow(a.id))?.category_review).toBe("shared");
  });

  it("gets token_bound from every share, portal and personal-category endpoint", async () => {
    const { o, a, b, share, client } = await sharedSetup();
    const t = await boundToken(o.session, a.id);
    const review = [{ id: b.id, version: 1, category_rev: 0, decision: "private" }];
    const calls: [string, string, unknown?][] = [
      ["GET", "/category-shares"],
      ["GET", "/category-shares/preview?category=Acme"],
      ["GET", `/category-shares/${share.id}`],
      ["GET", "/category-shares/nosuchshare000000000"],
      ["POST", "/category-shares", { category: "Other", people: [], review: [] }],
      ["PATCH", `/category-shares/${share.id}`, { title: "Renamed by CI" }],
      ["POST", `/category-shares/${share.id}/review`, { items: review }],
      ["DELETE", `/category-shares/${share.id}`],
      ["GET", "/portals"],
      ["GET", `/portals/${share.id}`],
      ["GET", "/portals/nosuchshare000000000"],
      ["PUT", `/artifacts/${a.id}/my-category`, { category: "Mine" }],
    ];
    for (const on of ["true", "false"]) {
      for (const [method, path, body] of calls) {
        const r = await req(method, path, t.auth, body, { ALLOW_CATEGORY_SHARING: on });
        tokenBound(r, `${method} ${path} (sharing ${on})`);
      }
    }
    // Nothing changed: the share, its title, its people and both reviews are as the owner left them.
    const detail = await shareDetail(o, share.id);
    expect(detail.people).toEqual([{ email: client.email, role: "commenter" }]);
    expect(detail.artifacts.map((x) => x.state)).toEqual(["shared", "shared"]);
    const listed = await req("GET", "/category-shares", o.session);
    expect(listed.body.items[0].title).toBe("Acme");
  });

  it("holds no role through a category grant: only its person's direct rights", async () => {
    const { o, a, client } = await sharedSetup();
    // The client edits the artifact directly too, so they may make a token limited to it.
    const grant = await req("PUT", `/artifacts/${a.id}/sharing`, o.session, {
      grants: [{ email: client.email, role: "editor" }],
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    const t = await boundToken(client.session, a.id);
    expect((await req("GET", `/artifacts/${a.id}`, t.auth)).body.role).toBe("editor");
    // The direct grant goes; the category grant (commenter, reviewed shared) stays.
    const removed = await req("PUT", `/artifacts/${a.id}/sharing`, o.session, { grants: [] });
    expect(removed.status).toBe(200);
    // In the app the client still opens it through the category, as a commenter.
    const app = await req("GET", `/artifacts/${a.id}`, client.session);
    expect(app.status).toBe(200);
    expect(app.body.role).toBe("commenter");
    // Their token limited to it does not: it answers as for an artifact its person cannot see.
    const got = await req("GET", `/artifacts/${a.id}`, t.auth);
    expect(got.status).toBe(404);
    expect(got.body.error.code).toBe("not_found");
    expect((await req("GET", "/artifacts", t.auth)).body.items).toEqual([]);
    // The viewer gate answers as for anyone off the allowlist, not token_bound (which it gives
    // only where the token may view).
    const gate = await run(`/api/v1/view/${a.slug}`, { headers: t.auth });
    expect((await json(gate)).status).toBe("email_required");
    const c = await mcpClient(t.token);
    expect((await tool(c, "get_artifact", { id: a.id })).data.error.code).toBe("not_found");
  });
});

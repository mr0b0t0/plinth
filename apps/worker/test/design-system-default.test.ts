// The default design system (docs/spec.md "Design systems", The default design system): the
// signed-in owner marks one of their design systems as the default from the app, only one can be,
// and list_artifacts marks it `default: true` for the owner. Also the design type's reference to a
// design system: the meta in a design's shared section is checked like a page's.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import acme from "./fixtures/design-systems/acme.json";
import {
  agent,
  browserSession,
  call,
  createToken,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";

type Json = Record<string, any>;
type Agent = Awaited<ReturnType<typeof agent>>;

const ACME = JSON.stringify(acme);

const ds = async (a: Agent, title = "Acme UI") => {
  const { res, body } = await publish(a.auth, {
    html: undefined,
    title,
    type: "design_system",
    content: ACME,
    visibility: "allowlist",
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body as Json;
};

const choose = (headers: Record<string, string>, ref: string, on: boolean) =>
  call(`/api/v1/artifacts/${ref}/default-design-system`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ default: on }),
  });

const listed = async (headers: Record<string, string>, type = "design_system") =>
  (await json(await call(`/api/v1/artifacts?type=${type}`, { headers }))).items as Json[];

const defaults = (items: Json[]) => items.filter((i) => i.default === true).map((i) => i.id);

describe("the default design system", () => {
  it("the owner chooses one in the app; list_artifacts marks it, and choosing another replaces it", async () => {
    const a = await agent();
    const one = await ds(a, "One");
    const two = await ds(a, "Two");
    const s = await browserSession(a.user.id);
    expect(defaults(await listed(a.auth))).toEqual([]);
    const r = await choose(s.headers, one.id, true);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ id: one.id, default: true });
    expect(defaults(await listed(a.auth))).toEqual([one.id]);
    expect((await choose(s.headers, two.id, true)).status).toBe(200);
    expect(defaults(await listed(a.auth))).toEqual([two.id]);
    // Turning off one that is not the default changes nothing.
    expect((await choose(s.headers, one.id, false)).status).toBe(200);
    expect(defaults(await listed(a.auth))).toEqual([two.id]);
    const off = await choose(s.headers, two.id, false);
    expect(await json(off)).not.toHaveProperty("default");
    expect(defaults(await listed(a.auth))).toEqual([]);
  });

  it("is marked over MCP for the owner, and in get_artifact", async () => {
    const a = await agent();
    const one = await ds(a);
    const s = await browserSession(a.user.id);
    await choose(s.headers, one.id, true);
    const c = await mcpClient(a.token);
    const l = await tool(c, "list_artifacts", { type: "design_system" });
    const g = await tool(c, "get_artifact", { id: one.id });
    await c.close();
    expect(defaults(l.data.items)).toEqual([one.id]);
    expect(g.data.default).toBe(true);
  });

  it("is never marked for anyone else, nor for a token limited to the design system", async () => {
    const a = await agent();
    const one = await ds(a);
    const s = await browserSession(a.user.id);
    await choose(s.headers, one.id, true);
    const other = await agent();
    const shared = await call(`/api/v1/artifacts/${one.id}/sharing`, {
      method: "PUT",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ email: other.user.email, role: "editor" }] }),
    });
    expect(shared.status).toBe(200);
    const seen = await json(await call(`/api/v1/artifacts/${one.id}`, { headers: other.auth }));
    expect(seen).toMatchObject({ id: one.id, role: "editor" });
    expect(seen.default).toBeUndefined();
    const bound = await createToken(a.user.id, { artifactId: one.id });
    const items = await listed({ Authorization: `Bearer ${bound.token}` });
    expect(items.map((i) => i.id)).toEqual([one.id]);
    expect(defaults(items)).toEqual([]);
  });

  it("only the signed-in owner chooses it, and only a live design system can be it", async () => {
    const a = await agent();
    const one = await ds(a);
    const r = await choose(a.auth, one.id, true);
    expect(r.status).toBe(403);
    expect((await json(r)).error.details.reason).toBe("app_only");
    const page = await publish(a.auth, { title: "Page" });
    const s = await browserSession(a.user.id);
    const notDs = await choose(s.headers, page.body.id, true);
    expect(notDs.status).toBe(400);
    expect((await json(notDs)).error.details.reason).toBe("not_design_system");
    const stranger = await agent();
    const ss = await browserSession(stranger.user.id);
    expect((await choose(ss.headers, one.id, true)).status).toBe(404);
    expect(
      (
        await call(`/api/v1/artifacts/${one.id}/default-design-system`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ default: true }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(401);
  });

  it("is not reported while the design system is taken down", async () => {
    const a = await agent();
    const one = await ds(a);
    const s = await browserSession(a.user.id);
    await choose(s.headers, one.id, true);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?2 WHERE id = ?1")
      .bind(one.id, new Date().toISOString())
      .run();
    expect(defaults(await listed(a.auth))).toEqual([]);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = NULL WHERE id = ?1")
      .bind(one.id)
      .run();
    expect(defaults(await listed(a.auth))).toEqual([one.id]);
  });

  it("a deleted design system is no longer the default", async () => {
    const a = await agent();
    const one = await ds(a);
    const s = await browserSession(a.user.id);
    await choose(s.headers, one.id, true);
    expect(
      (await call(`/api/v1/artifacts/${one.id}`, { method: "DELETE", headers: a.auth })).status,
    ).toBe(204);
    const two = await ds(a, "Two");
    expect(defaults(await listed(a.auth))).toEqual([]);
    expect(two.id).not.toBe(one.id);
  });
});

describe("a design names its design system", () => {
  const design = (shared: string, board = "<div>Home</div>") =>
    `${shared}\n<!-- artboard id="home" name="Home" size="iphone" -->\n${board}\n`;

  it("in its shared section: outdated and unavailable warnings, and get_artifact's field", async () => {
    const a = await agent();
    const sys = await ds(a);
    const v2 = await call(`/api/v1/artifacts/${sys.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: ACME.replace("#ffffff", "#fafafa"), base_version: 1 }),
    });
    expect(v2.status).toBe(200);
    const meta = (ref: string) => `<meta name="plinth-design-system" content="${ref}">`;
    const old = await publish(a.auth, {
      html: undefined,
      type: "design",
      content: design(meta(`${sys.id}@1`)),
    });
    expect(old.res.status, JSON.stringify(old.body)).toBe(201);
    expect(old.body.warnings).toEqual([
      expect.objectContaining({
        code: "design_system_outdated",
        file: "design.html",
        ref: `${sys.id}@1`,
      }),
    ]);
    const got = await json(await call(`/api/v1/artifacts/${old.body.id}`, { headers: a.auth }));
    expect(got.design_system).toEqual({
      id: sys.id,
      title: "Acme UI",
      version: 1,
      current_version: 2,
    });
    const missing = await publish(a.auth, {
      html: undefined,
      type: "design",
      content: design(meta("z".repeat(20))),
    });
    expect(missing.body.warnings).toEqual([
      expect.objectContaining({ code: "design_system_unavailable", file: "design.html" }),
    ]);
  });

  it("ignores a meta inside an artboard's fragment", async () => {
    const a = await agent();
    const sys = await ds(a);
    const r = await publish(a.auth, {
      html: undefined,
      type: "design",
      content: design(
        "<title>D</title>",
        `<meta name="plinth-design-system" content="${sys.id}@1">`,
      ),
    });
    expect(r.res.status).toBe(201);
    const got = await json(await call(`/api/v1/artifacts/${r.body.id}`, { headers: a.auth }));
    expect(got).not.toHaveProperty("design_system");
  });
});

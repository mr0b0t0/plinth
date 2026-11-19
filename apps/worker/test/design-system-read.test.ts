// get_design_system and GET /api/v1/artifacts/:ref/design-system read a design system as the
// caller, through policy.ts: the same decision as get_artifact, with the type checked after it,
// and the same body over MCP and REST. Also the reference an HTML page makes to a design system
// (<meta name="plinth-design-system">): publish warnings and get_artifact's design_system field.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, artifacts } from "../src/db/schema.ts";
import { nowIso } from "../src/lib/time.ts";
import acme from "./fixtures/design-systems/acme.json";
import { agent, call, db, json, mcpClient, publish, tool } from "./helpers.ts";

const ACME = JSON.stringify(acme);
type Json = Record<string, any>;
type Agent = Awaited<ReturnType<typeof agent>>;

/** A design system, private (allowlist) unless the test says otherwise. */
const publishDs = (a: Agent, body: Record<string, unknown> = {}) =>
  publish(a.auth, {
    html: undefined,
    title: "Acme UI",
    type: "design_system",
    content: ACME,
    visibility: "allowlist",
    ...body,
  });

/** The REST query string for the same arguments as the MCP call. */
function queryOf(args: Json): string {
  const q: string[] = [];
  if (args.version !== undefined) q.push(`version=${args.version}`);
  if (args.include) q.push(`include=${args.include.join(",")}`);
  if (args.components) q.push(`components=${args.components.join(",")}`);
  return q.length ? `?${q.join("&")}` : "";
}

const grant = (artifactId: string, email: string, role: "viewer" | "commenter" | "editor") =>
  db().insert(accessGrants).values({ artifactId, email, role, createdAt: nowIso() }).run();

/** Both surfaces: status and body over REST, isError and body over MCP. */
async function readBoth(a: Agent, args: Json) {
  const rest = await call(`/api/v1/artifacts/${args.id}/design-system${queryOf(args)}`, {
    headers: a.auth,
  });
  const c = await mcpClient(a.token);
  const mcp = await tool(c, "get_design_system", args);
  await c.close();
  return { status: rest.status, rest: await json(rest), mcp };
}

/** The same success over REST and MCP. */
async function readOk(a: Agent, args: Json) {
  const r = await readBoth(a, args);
  expect(r.status, JSON.stringify(r.rest)).toBe(200);
  expect(r.mcp.isError).toBe(false);
  expect(r.mcp.data).toEqual(r.rest);
  return r.rest;
}

/** The same refusal over REST and MCP. */
async function readError(a: Agent, args: Json, status: number) {
  const r = await readBoth(a, args);
  expect(r.status).toBe(status);
  expect(r.mcp.isError).toBe(true);
  expect(r.mcp.data).toEqual(r.rest);
  return r.rest.error as Json;
}

describe("get_design_system", () => {
  it("returns the owner the resolved tokens, the CSS, fonts, guidelines and components", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a);
    const ds = await readOk(a, { id: p.id });
    expect(ds).toMatchObject({
      id: p.id,
      slug: p.slug,
      title: "Acme UI",
      version: 1,
      current_version: 1,
      format: "plinth.design-system/1",
      name: "Acme UI",
      prefix: "acme",
      font_links: [acme.fonts[0]?.google],
      fonts: [
        { family: "Inter", source: "google", portable: true },
        { family: "Acme Mono", source: "asset", portable: false },
      ],
      guidelines: acme.guidelines,
      problems: [],
      untrusted: true,
    });
    expect(ds.url).toMatch(new RegExp(`/a/${p.slug}$`));
    expect(ds.css).toMatch(/^:root\{--acme-color-brand-500:#3355ff;/);
    expect(ds.css).toContain(
      ':root[data-theme="dark"]{--acme-color-brand-500:#6b8cff;--acme-color-bg:#0d1117;',
    );
    expect(ds.tokens.find((t: Json) => t.path === "color.accent")).toEqual({
      path: "color.accent",
      css_var: "--acme-color-accent",
      type: "color",
      value: "#3355ff",
      dark: "#6b8cff",
      alias_of: "color.brand.500",
      description: null,
      deprecated: false,
    });
    expect(ds.components.map((c: Json) => c.id)).toEqual(["button", "card"]);
    expect(ds.component_css).toContain("/* shared */");
    expect(ds.component_css).toContain("/* button */");
  });

  it("trims to include and components, and reads a given version", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a);
    const v2 = JSON.parse(ACME);
    v2.tokens.color.bg.$value = "#fafafa";
    const put = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(v2), base_version: 1 }),
    });
    expect(put.status).toBe(200);
    const trimmed = await readOk(a, {
      id: p.id,
      include: ["css", "components"],
      components: ["card"],
    });
    expect(trimmed.tokens).toBeUndefined();
    expect(trimmed.guidelines).toBeUndefined();
    expect(trimmed.components.map((c: Json) => c.id)).toEqual(["card"]);
    expect(trimmed.component_css).not.toContain("/* button */");
    expect(trimmed.css).toContain("--acme-color-bg:#fafafa;");
    const v1 = await readOk(a, { id: p.id, version: 1 });
    expect(v1).toMatchObject({ version: 1, current_version: 2 });
    expect(v1.css).toContain("--acme-color-bg:#ffffff;");
    const missing = await readError(a, { id: p.id, version: 3 }, 404);
    expect(missing.code).toBe("not_found");
    const bad = await call(`/api/v1/artifacts/${p.id}/design-system?include=everything`, {
      headers: a.auth,
    });
    expect(bad.status).toBe(400);
  });

  it("is readable by editors, commenters and viewers with a grant", async () => {
    const owner = await agent();
    const { body: p } = await publishDs(owner);
    for (const role of ["editor", "commenter", "viewer"] as const) {
      const other = await agent();
      await grant(p.id, other.user.email, role);
      expect((await readOk(other, { id: p.id })).name, role).toBe("Acme UI");
    }
  });

  it("is readable by another person's agent with only the link when unlisted or public", async () => {
    const owner = await agent();
    const stranger = await agent();
    const { body: unlisted } = await publishDs(owner, { visibility: "unlisted" });
    expect((await readOk(stranger, { id: unlisted.id })).name).toBe("Acme UI");
    const { body: pub } = await publishDs(owner, { visibility: "unlisted" });
    await db()
      .update(artifacts)
      .set({ visibility: "public" })
      .where(eq(artifacts.id, pub.id))
      .run();
    expect((await readOk(stranger, { id: pub.slug })).name).toBe("Acme UI");
  });

  it("hides a private design system: the same 404 as an id that does not exist", async () => {
    const owner = await agent();
    const stranger = await agent();
    const { body: p } = await publishDs(owner);
    const hidden = await readError(stranger, { id: p.id }, 404);
    const nothing = await readError(stranger, { id: "abcdefghij0123456789" }, 404);
    expect(hidden).toEqual(nothing);
  });

  it("refuses password, taken-down and deleted design systems, and tokens without artifacts:read", async () => {
    const owner = await agent();
    const stranger = await agent();
    const { body: pw } = await publishDs(owner, { visibility: "password", password: "letmein1" });
    const e = await readError(stranger, { id: pw.id }, 403);
    expect(e.details.reason).toBe("password_required");

    const { body: down } = await publishDs(owner, { visibility: "unlisted" });
    await db()
      .update(artifacts)
      .set({ takenDownAt: nowIso() })
      .where(eq(artifacts.id, down.id))
      .run();
    expect((await readError(stranger, { id: down.id }, 403)).details.reason).toBe("taken_down");

    const { body: gone } = await publishDs(owner, { visibility: "unlisted" });
    const del = await call(`/api/v1/artifacts/${gone.id}`, {
      method: "DELETE",
      headers: owner.auth,
    });
    expect(del.status).toBe(204);
    await readError(stranger, { id: gone.id }, 404);

    const writeOnly = await agent({ scopes: "artifacts:write" });
    const { body: own } = await publishDs(writeOnly);
    const scoped = await readError(writeOnly, { id: own.id }, 403);
    expect(scoped.message).toMatch(/scope/);
  });

  it("refuses an artifact of another type after the access decision, so the type never leaks", async () => {
    const owner = await agent();
    const stranger = await agent();
    const { body: page } = await publish(owner.auth, { title: "Page", visibility: "unlisted" });
    const e = await readError(stranger, { id: page.id }, 400);
    expect(e).toMatchObject({ code: "invalid_input", details: { type: "html", field: "id" } });
    expect(e.details.next).toContain("list_artifacts with type design_system");
    const { body: privatePage } = await publish(owner.auth, {
      title: "Private",
      visibility: "allowlist",
    });
    const hidden = await readError(stranger, { id: privatePage.id }, 404);
    expect(JSON.stringify(hidden)).not.toContain("html");
  });

  it("returns problems for a stored version that no longer parses", async () => {
    const a = await agent();
    const { body: p } = await publishDs(a);
    const stored = await db().select().from(artifacts).where(eq(artifacts.id, p.id)).get();
    expect(stored).toBeTruthy();
    // A version written before a rule existed (here: overwritten in storage directly).
    const row = await call(`/api/v1/artifacts/${p.id}`, { headers: a.auth });
    const detail = await json(row);
    const { env } = await import("cloudflare:workers");
    const v = await env.DB.prepare(
      "SELECT r2_prefix FROM versions WHERE artifact_id = ?1 AND number = 1",
    )
      .bind(p.id)
      .first<{ r2_prefix: string }>();
    await env.FILES.put(`${v?.r2_prefix}system.json`, '{"format":"plinth.design-system/1"}');
    const ds = await readOk(a, { id: p.id });
    expect(detail.type).toBe("design_system");
    expect(ds).toMatchObject({ format: "unknown", name: null, untrusted: true });
    expect(ds.problems.map((x: Json) => x.path)).toEqual(
      expect.arrayContaining(["name", "tokens"]),
    );
    expect(ds.css).toBeUndefined();
  });
});

describe("a page's design system reference", () => {
  const page = (ref: string) =>
    `<!doctype html><html><head><title>Built</title><meta name="plinth-design-system" content="${ref}"></head><body><p>x</p></body></html>`;

  it("warns when the page names an older version, and get_artifact names the design system", async () => {
    const a = await agent();
    const { body: ds } = await publishDs(a);
    const v2 = JSON.parse(ACME);
    v2.tokens.color.bg.$value = "#fafafa";
    await call(`/api/v1/artifacts/${ds.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(v2), base_version: 1 }),
    });
    const current = await publish(a.auth, { html: page(`${ds.id}@2`) });
    expect(current.body.warnings).toEqual([]);
    const old = await publish(a.auth, { html: page(`${ds.id}@1`) });
    expect(old.res.status).toBe(201);
    expect(old.body.warnings).toEqual([
      {
        code: "design_system_outdated",
        file: "index.html",
        ref: `${ds.id}@1`,
        message:
          "Built on v1; v2 is current. Read it with get_design_system and update if the person wants the newer tokens.",
      },
    ]);
    const detail = await json(await call(`/api/v1/artifacts/${old.body.id}`, { headers: a.auth }));
    expect(detail.design_system).toEqual({
      id: ds.id,
      title: "Acme UI",
      version: 1,
      current_version: 2,
    });
    const c = await mcpClient(a.token);
    const viaMcp = await tool(c, "get_artifact", { id: old.body.id });
    expect(viaMcp.data.design_system).toEqual(detail.design_system);
  });

  it("counts the reference warning inside the publish's cap of 50", async () => {
    const a = await agent();
    const imgs = Array.from({ length: 50 }, (_, i) => `<img src="m${i}.png">`).join("");
    const html = page("abcdefghij0123456789").replace("<p>x</p>", imgs);
    const r = await publish(a.auth, { html });
    expect(r.res.status).toBe(201);
    expect(r.body.warnings).toHaveLength(50);
    expect(r.body.warnings.at(-1)).toMatchObject({ code: "missing_file", count: 2 });
    expect(r.body.warnings.at(-1).message).toBe("and 2 more");
  });

  it("gives one warning for a private, missing, deleted or non-design-system reference", async () => {
    const owner = await agent();
    const author = await agent();
    const { body: privateDs } = await publishDs(owner);
    const { body: deleted } = await publishDs(author);
    await call(`/api/v1/artifacts/${deleted.id}`, { method: "DELETE", headers: author.auth });
    const { body: notDs } = await publish(author.auth, { title: "Plain" });
    const messages = new Set<string>();
    for (const ref of [privateDs.id, "abcdefghij0123456789", deleted.id, notDs.id]) {
      const r = await publish(author.auth, { html: page(ref) });
      expect(r.res.status).toBe(201);
      expect(
        r.body.warnings.map((w: Json) => w.code),
        ref,
      ).toEqual(["design_system_unavailable"]);
      messages.add(r.body.warnings[0].message);
      const detail = await json(
        await call(`/api/v1/artifacts/${r.body.id}`, { headers: author.auth }),
      );
      expect(detail.design_system, ref).toBeNull();
    }
    expect(messages.size).toBe(1);
  });

  it("drops the field to null once the design system's sharing drops the caller", async () => {
    const owner = await agent();
    const reader = await agent();
    const { body: ds } = await publishDs(owner);
    await grant(ds.id, reader.user.email, "viewer");
    const built = await publish(reader.auth, { html: page(ds.id) });
    expect(built.body.warnings).toEqual([]);
    const before = await json(
      await call(`/api/v1/artifacts/${built.body.id}`, { headers: reader.auth }),
    );
    expect(before.design_system).toEqual({
      id: ds.id,
      title: "Acme UI",
      version: null,
      current_version: 1,
    });
    await db().delete(accessGrants).where(eq(accessGrants.artifactId, ds.id)).run();
    const after = await json(
      await call(`/api/v1/artifacts/${built.body.id}`, { headers: reader.auth }),
    );
    expect(after.design_system).toBeNull();
  });

  it("leaves pages without the meta unchanged: no field, no warning", async () => {
    const a = await agent();
    const r = await publish(a.auth);
    expect(r.body.warnings).toEqual([]);
    const detail = await json(await call(`/api/v1/artifacts/${r.body.id}`, { headers: a.auth }));
    expect("design_system" in detail).toBe(false);
  });
});

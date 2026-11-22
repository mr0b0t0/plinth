// copy_files (docs/spec.md "Copying files from another artifact"): a publish, update or upload
// copies files from other artifacts the caller can view into the version, on the server. Each
// source is read as the caller through policy.ts (`view`), checked once at publish time; the copy
// is the target's own file from then on. A token limited to one artifact cannot copy.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { designSystemCss, parseDesignSystem } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { accessGrants } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { nowIso } from "../src/lib/time.ts";
import { tar } from "./fixtures/bundles/tar.ts";
import acme from "./fixtures/design-systems/acme.json";
import {
  agent,
  browserSession,
  call,
  contentOrigin,
  createToken,
  createUser,
  db,
  fetchWith,
  json,
  manifestOf,
  mcpClient,
  publish,
  r2Keys,
  storedFile,
  tool,
  uniqueEmail,
} from "./helpers.ts";

type Json = Record<string, any>;
type Agent = Awaited<ReturnType<typeof agent>>;

const ACME = JSON.stringify(acme);
const MONO = "wOF2-acme-mono-bytes";
const LOGO = "<svg xmlns='http://www.w3.org/2000/svg'/>";
const PAGE = "<!doctype html><title>Page</title><h1>Hi</h1>";

/** An unlisted page with one stylesheet and one image, owned by `a`. */
async function sourcePage(a: Agent, visibility = "unlisted") {
  const { res, body } = await publish(a.auth, {
    title: "Source",
    visibility,
    assets: [
      { path: "css/brand.css", content: "body{color:#123456}" },
      { path: "img/logo.svg", content: LOGO },
    ],
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body as Json;
}

/** The Acme design system with its font file, private unless the test says otherwise. */
async function designSystem(a: Agent, visibility = "allowlist") {
  const { res, body } = await publish(a.auth, {
    html: undefined,
    title: "Acme UI",
    type: "design_system",
    content: ACME,
    visibility,
    assets: [{ path: "fonts/acme-mono.woff2", content: MONO }],
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body as Json;
}

const post = (a: Agent, body: Json) => publish(a.auth, { title: "Target", html: PAGE, ...body });

const put = async (a: Agent, id: string, body: Json) => {
  const res = await call(`/api/v1/artifacts/${id}`, {
    method: "PUT",
    headers: { ...a.auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: await json(res) };
};

const text = async (id: string, n: number, path: string) =>
  (await storedFile(id, n, path))?.text() ?? null;

describe("copy_files on publish", () => {
  it("copies a file from another artifact into the new version, under the target's own prefix", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const { res, body } = await post(a, {
      copy_files: [{ artifact: src.id, path: "img/logo.svg", to: "brand/logo.svg" }],
    });
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(await text(body.id, 1, "brand/logo.svg")).toBe(LOGO);
    // The bytes live under the target's root: deleting the source keeps the copy.
    const keys = await r2Keys(`artifacts/${body.id}/`);
    expect(keys.some((k) => k.endsWith("/brand/logo.svg"))).toBe(true);
    const m = (await manifestOf(body.id, 1)).find((e) => e.path === "brand/logo.svg");
    expect(m).toMatchObject({
      content_type: "image/svg+xml",
      copied_from: { artifact: src.id, version: 1, path: "img/logo.svg" },
    });
    expect(body.copied_from).toEqual([
      {
        artifact: src.id,
        version: 1,
        copied_at: m?.copied_from?.copied_at,
        files: [{ path: "brand/logo.svg", from: "img/logo.svg" }],
      },
    ]);
    const del = await call(`/api/v1/artifacts/${src.id}`, { method: "DELETE", headers: a.auth });
    expect(del.status).toBe(204);
    expect(await text(body.id, 1, "brand/logo.svg")).toBe(LOGO);
  });

  it("takes an id, a slug or the app link, and `to` defaults to the source path", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    for (const address of [src.slug, src.url, `${src.url}?v=1#top`]) {
      const { res, body } = await post(a, {
        copy_files: [{ artifact: address, path: "css/brand.css" }],
      });
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(await text(body.id, 1, "css/brand.css")).toBe("body{color:#123456}");
    }
    const bad = await post(a, {
      copy_files: [{ artifact: "https://elsewhere.example/a/x", path: "css/brand.css" }],
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("copy_bad_address");
  });

  it("copies from a given version", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const v2 = await put(a, src.id, {
      html: PAGE,
      assets: [{ path: "css/brand.css", content: "body{color:#abcdef}" }],
    });
    expect(v2.res.status).toBe(200);
    const old = await post(a, {
      copy_files: [{ artifact: src.id, path: "css/brand.css", version: 1 }],
    });
    expect(await text(old.body.id, 1, "css/brand.css")).toBe("body{color:#123456}");
    const cur = await post(a, { copy_files: [{ artifact: src.id, path: "css/brand.css" }] });
    expect(await text(cur.body.id, 1, "css/brand.css")).toBe("body{color:#abcdef}");
    const gone = await post(a, {
      copy_files: [{ artifact: src.id, path: "css/brand.css", version: 9 }],
    });
    expect(gone.res.status).toBe(404);
  });

  it("answers a source the caller cannot view exactly like a missing one", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const stranger = await agent();
    const hidden = await post(stranger, {
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    const missing = await post(stranger, {
      copy_files: [{ artifact: "z".repeat(20), path: "img/logo.svg" }],
    });
    expect(hidden.res.status).toBe(404);
    expect(missing.res.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    // A viewer it is shared with may copy.
    await db()
      .insert(accessGrants)
      .values({
        artifactId: src.id,
        email: stranger.user.email,
        role: "viewer",
        createdAt: nowIso(),
      })
      .run();
    const ok = await post(stranger, { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("refuses a token limited to one artifact before any lookup", async () => {
    const a = await agent();
    const target = await sourcePage(a);
    const bound = await createToken(a.user.id, { artifactId: target.id });
    const auth = { Authorization: `Bearer ${bound.token}` };
    for (const artifact of [target.id, "z".repeat(20)]) {
      const r = await put({ ...a, auth } as Agent, target.id, {
        html: PAGE,
        base_version: 1,
        copy_files: [{ artifact, path: "img/logo.svg", to: "x.svg" }],
      });
      expect(r.res.status).toBe(403);
      expect(r.body.error.details).toMatchObject({ reason: "token_bound", field: "copy_files" });
    }
  });

  it("refuses a missing file, a changed type, a file the target type does not take, and repeats", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const cases: [Json[], number, string][] = [
      [[{ artifact: src.id, path: "nope.css" }], 400, "copy_missing_file"],
      [[{ artifact: src.id, path: "img/logo.svg", to: "logo.html" }], 400, "copy_type_mismatch"],
      [
        [
          { artifact: src.id, path: "img/logo.svg", to: "a.svg" },
          { artifact: src.id, path: "img/logo.svg", to: "a.svg" },
        ],
        400,
        "copy_twice",
      ],
    ];
    for (const [copy_files, status, reason] of cases) {
      const r = await post(a, { copy_files });
      expect(r.res.status, JSON.stringify(r.body)).toBe(status);
      expect(r.body.error.details.reason).toBe(reason);
    }
    // A doc takes images only: a stylesheet is refused by the doc's own asset rule.
    const doc = await publish(a.auth, {
      html: undefined,
      type: "doc",
      content: "# Notes",
      copy_files: [{ artifact: src.id, path: "css/brand.css" }],
    });
    expect(doc.res.status).toBe(400);
    expect(doc.body.error.details).toMatchObject({ type: "doc", path: "css/brand.css" });
    // Beside an asset at the same path: the path is listed twice.
    const twice = await post(a, {
      assets: [{ path: "img/logo.svg", content: "<svg/>" }],
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    expect(twice.res.status).toBe(400);
  });

  it("copies from at most four artifact versions in one call", async () => {
    const a = await agent();
    const srcs = [];
    for (let i = 0; i < 5; i++) srcs.push(await sourcePage(a));
    const r = await post(a, {
      copy_files: srcs.map((s, i) => ({ artifact: s.id, path: "img/logo.svg", to: `l${i}.svg` })),
    });
    expect(r.res.status).toBe(400);
    expect(r.body.error.details.reason).toBe("copy_too_many_sources");
  });
});

describe("copy_files on update", () => {
  it("adds to the current files when no assets are sent, replacing one at the same path", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const page = await publish(a.auth, {
      assets: [
        { path: "img/logo.svg", content: "<svg>old</svg>" },
        { path: "app.js", content: "1" },
      ],
    });
    const r = await put(a, page.body.id, {
      html: PAGE,
      base_version: 1,
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(await text(page.body.id, 2, "img/logo.svg")).toBe(LOGO);
    expect(await text(page.body.id, 2, "app.js")).toBe("1");
    // A later update that copies nothing carries the copy and its record.
    const v3 = await put(a, page.body.id, { html: `${PAGE}<p>3</p>`, base_version: 2 });
    expect(v3.res.status).toBe(200);
    const m = (await manifestOf(page.body.id, 3)).find((e) => e.path === "img/logo.svg");
    expect(m?.copied_from).toMatchObject({ artifact: src.id, version: 1, path: "img/logo.svg" });
    const got = await json(await call(`/api/v1/artifacts/${page.body.id}`, { headers: a.auth }));
    expect(got.copied_from).toEqual([
      expect.objectContaining({
        artifact: src.id,
        version: 1,
        title: "Source",
        current_version: 1,
        files: [{ path: "img/logo.svg", from: "img/logo.svg" }],
      }),
    ]);
    expect(JSON.stringify(got)).not.toContain("stored_at");
  });

  it("names the source in get_artifact only to someone who may view it now", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const page = await post(owner, {
      visibility: "unlisted",
      copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
    });
    const stranger = await agent();
    const got = await json(
      await call(`/api/v1/artifacts/${page.body.id}`, { headers: stranger.auth }),
    );
    // No id and no source path: only where the copy is here.
    expect(got.copied_from).toEqual([
      {
        artifact: null,
        version: 1,
        copied_at: expect.any(String),
        files: [{ path: "img/logo.svg" }],
        title: null,
        current_version: null,
      },
    ]);
  });

  it("keeps copied_from on a copied file sent back as {path, sha256}", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const page = await post(a, { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] });
    const m = (await manifestOf(page.body.id, 1)).find((e) => e.path === "img/logo.svg");
    const r = await put(a, page.body.id, {
      html: PAGE,
      base_version: 1,
      assets: [{ path: "img/logo.svg", sha256: m?.sha256 }],
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    const m2 = (await manifestOf(page.body.id, 2)).find((e) => e.path === "img/logo.svg");
    expect(m2?.copied_from).toEqual(m?.copied_from);
  });
});

describe("which sources may be copied", () => {
  it("refuses a password-protected source to an agent, which never passes a password", async () => {
    const owner = await agent();
    const { body: src } = await publish(owner.auth, {
      title: "Locked",
      visibility: "password",
      password: "hunter22",
      assets: [{ path: "img/logo.svg", content: LOGO }],
    });
    const other = await agent();
    const r = await post(other, { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] });
    expect(r.res.status).toBe(403);
    expect(r.body.error.details.reason).toBe("password_required");
  });

  it("refuses a taken-down source, and a deleted one like a missing one", async () => {
    const a = await agent();
    const down = await sourcePage(a);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?2 WHERE id = ?1")
      .bind(down.id, nowIso())
      .run();
    const r1 = await post(a, { copy_files: [{ artifact: down.id, path: "img/logo.svg" }] });
    expect(r1.res.status).toBe(403);
    expect(r1.body.error.details.reason).toBe("taken_down");
    const gone = await sourcePage(a);
    await call(`/api/v1/artifacts/${gone.id}`, { method: "DELETE", headers: a.auth });
    const r2 = await post(a, { copy_files: [{ artifact: gone.id, path: "img/logo.svg" }] });
    const r3 = await post(a, { copy_files: [{ artifact: "z".repeat(20), path: "img/logo.svg" }] });
    expect(r2.res.status).toBe(404);
    expect(r2.body).toEqual(r3.body);
  });

  it("refuses an app link on another origin, the content host's included", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    for (const address of [
      src.url.replace("http://", "https://"),
      src.url.replace("app.localhost", "evil.localhost"),
      `${contentOrigin(src.id)}/a/${src.slug}`,
      `${src.url.replace(`/a/${src.slug}`, "")}/x/a/${src.slug}`,
    ]) {
      const r = await post(a, { copy_files: [{ artifact: address, path: "img/logo.svg" }] });
      expect(r.res.status, address).toBe(400);
      expect(r.body.error.details.reason).toBe("copy_bad_address");
    }
  });

  it("does not count an admin's review access: only what the admin could view anyway", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    await env.DB.prepare(
      "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?1, ?2, 'x', 'open', ?3)",
    )
      .bind(`r${src.id}`, src.id, nowIso())
      .run();
    const email = uniqueEmail("admin");
    const vars = { ADMIN_EMAIL: email };
    const admin = await createUser(email);
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?1").bind(admin.id).run();
    const s = await browserSession(admin.id);
    // The admin may look at it to review the report...
    const look = await fetchWith(vars, `/api/v1/artifacts/${src.id}`, { headers: s.headers });
    expect(look.status).toBe(200);
    // ...but not copy its files into their own.
    const r = await fetchWith(vars, "/api/v1/artifacts", {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Admin's",
        html: PAGE,
        copy_files: [{ artifact: src.id, path: "img/logo.svg" }],
      }),
    });
    expect(r.status).toBe(404);
  });

  it("counts a refused copy toward the publish rate: the rate is checked first", async () => {
    const a = await agent();
    const vars = { MAX_PUBLISHES_PER_HOUR: "1" };
    const send = (body: Json) =>
      fetchWith(vars, "/api/v1/artifacts", {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "T", html: PAGE, ...body }),
      });
    const first = await send({ copy_files: [{ artifact: "z".repeat(20), path: "a.svg" }] });
    expect(first.status).toBe(404);
    const second = await send({ copy_files: [{ artifact: "z".repeat(20), path: "a.svg" }] });
    expect(second.status).toBe(429);
  });
});

describe("folders under ds/", () => {
  it("refuses a second artifact's copies into a folder another one's copies hold", async () => {
    const a = await agent();
    const one = await sourcePage(a);
    const two = await sourcePage(a);
    const page = await post(a, {
      copy_files: [{ artifact: one.id, path: "css/brand.css", to: "ds/brand/tokens.css" }],
    });
    expect(page.res.status).toBe(201);
    const clash = await put(a, page.body.id, {
      html: PAGE,
      base_version: 1,
      copy_files: [{ artifact: two.id, path: "img/logo.svg", to: "ds/brand/logo.svg" }],
    });
    expect(clash.res.status).toBe(400);
    expect(clash.body.error.details).toMatchObject({
      reason: "copy_folder_taken",
      folder: "ds/brand",
    });
    // In one call too.
    const both = await post(a, {
      copy_files: [
        { artifact: one.id, path: "css/brand.css", to: "ds/brand/a.css" },
        { artifact: two.id, path: "css/brand.css", to: "ds/brand/b.css" },
      ],
    });
    expect(both.res.status).toBe(400);
    // The same artifact again (a newer version, say) and another folder are fine.
    const again = await put(a, page.body.id, {
      html: PAGE,
      base_version: 1,
      copy_files: [
        { artifact: one.id, path: "img/logo.svg", to: "ds/brand/logo.svg" },
        { artifact: two.id, path: "img/logo.svg", to: "ds/brand-2/logo.svg" },
      ],
    });
    expect(again.res.status, JSON.stringify(again.body)).toBe(200);
  });
});

describe("installing a design system", () => {
  it("get_design_system lists the files and the copy_files that install them", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system`, { headers: a.auth }),
    );
    expect(read.files).toEqual([
      "system.json",
      "tokens.css",
      "fonts.css",
      "components.css",
      "tokens.json",
      "fonts/acme-mono.woff2",
    ]);
    expect(read.install).toEqual({
      folder: "ds/acme",
      copy_files: [
        "fonts.css",
        "tokens.css",
        "components.css",
        "tokens.json",
        "fonts/acme-mono.woff2",
      ].map((path) => ({ artifact: ds.id, path, to: `ds/acme/${path}`, version: 1 })),
      stylesheets: ["ds/acme/fonts.css", "ds/acme/tokens.css", "ds/acme/components.css"],
      faces: {
        inter: { family: "Inter", href: acme.fonts[0]?.google },
        "acme-mono": {
          family: "Acme Mono",
          src: "ds/acme/fonts/acme-mono.woff2",
          weight: "400",
          style: "normal",
        },
      },
      record: {
        title: "Acme UI",
        namespace: "acme",
        artifact: ds.id,
        version: 1,
        copiedAt: expect.any(String),
      },
    });
    expect(read.fonts.map((f: Json) => f.portable)).toEqual([true, true]);
  });

  it("lists only what the target type takes, and another folder when asked", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system?install_for=design&folder=acme-2`, {
        headers: a.auth,
      }),
    );
    expect(read.install.copy_files.map((c: Json) => c.to)).toEqual([
      "ds/acme-2/tokens.css",
      "ds/acme-2/components.css",
    ]);
    expect(read.install.stylesheets).toEqual(["ds/acme-2/tokens.css", "ds/acme-2/components.css"]);
    expect(Object.keys(read.install.faces)).toEqual(["inter"]);
    expect(read.install.record.namespace).toBe("acme-2");
    // The list works as given on a design.
    const design = await publish(a.auth, {
      html: undefined,
      type: "design",
      content: '<!-- artboard id="home" name="Home" size="iphone" -->\n<div>Home</div>\n',
      copy_files: read.install.copy_files,
    });
    expect(design.res.status, JSON.stringify(design.body)).toBe(201);
  });

  it("install_for slides lists what each deck format takes, and each list publishes as given", async () => {
    const a = await agent();
    const { body: ds } = await publish(a.auth, {
      html: undefined,
      title: "Acme UI",
      type: "design_system",
      content: JSON.stringify({
        ...acme,
        css: `${acme.css} .acme-hero { background: url(img/hero.png) }`,
      }),
      assets: [
        { path: "fonts/acme-mono.woff2", content: MONO },
        { path: "img/hero.png", content: "iVBORw0KGgo=", encoding: "base64" },
      ],
    });
    const read = async (q: string) =>
      json(
        await call(`/api/v1/artifacts/${ds.id}/design-system?install_for=slides${q}`, {
          headers: a.auth,
        }),
      );
    // A Markdown deck (the default): its images only, as before.
    const md = await read("");
    expect(md.install.copy_files.map((c: Json) => c.path)).toEqual(["img/hero.png"]);
    expect(md.install.stylesheets).toEqual([]);
    expect((await read("&deck_format=markdown")).install.copy_files).toEqual(md.install.copy_files);
    const mdDeck = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: "# Talk\n\n![](ds/acme/img/hero.png)\n",
      copy_files: md.install.copy_files,
    });
    expect(mdDeck.res.status, JSON.stringify(mdDeck.body)).toBe(201);
    // An HTML deck: tokens.json, the font files and the images, never the generated CSS.
    const html = await read("&deck_format=html");
    expect(html.install.copy_files.map((c: Json) => c.path).sort()).toEqual([
      "fonts/acme-mono.woff2",
      "img/hero.png",
      "tokens.json",
    ]);
    expect(html.install.faces["acme-mono"]).toMatchObject({ src: "ds/acme/fonts/acme-mono.woff2" });
    const deck = await publish(a.auth, {
      html: undefined,
      type: "slides",
      content: JSON.stringify({
        title: "Deck",
        order: ["a"],
        faces: html.install.faces,
        designSystems: [html.install.record],
      }),
      assets: [
        {
          path: "slides/a.html",
          content: '<section id="a"><img src="ds/acme/img/hero.png" alt=""></section>',
        },
      ],
      copy_files: html.install.copy_files,
    });
    expect(deck.res.status, JSON.stringify(deck.body)).toBe(201);
    // A format the schema does not know is refused.
    const bad = await call(
      `/api/v1/artifacts/${ds.id}/design-system?install_for=slides&deck_format=pdf`,
      {
        headers: a.auth,
      },
    );
    expect(bad.status).toBe(400);
  });

  it("names the folder after the title for a system that kept the default prefix", async () => {
    const a = await agent();
    const plain = { ...acme, prefix: undefined };
    const { body: ds } = await publish(a.auth, {
      html: undefined,
      title: "Brand 2.0",
      type: "design_system",
      content: JSON.stringify(plain),
    });
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system`, { headers: a.auth }),
    );
    expect(read.install.folder).toBe("ds/brand-2-0");
  });

  it("fonts.css declares only the font files the version stores", async () => {
    const a = await agent();
    const { body: ds } = await publish(a.auth, {
      html: undefined,
      title: "No font file",
      type: "design_system",
      content: ACME,
    });
    const page = await post(a, { copy_files: [{ artifact: ds.id, path: "fonts.css" }] });
    const css = await text(page.body.id, 1, "fonts.css");
    expect(css).not.toContain("@font-face");
  });

  it("a page installs it with install.copy_files: generated CSS and JSON, and the font file", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const read = await json(
      await call(`/api/v1/artifacts/${ds.id}/design-system`, { headers: a.auth }),
    );
    const head = read.install.stylesheets.map((h: string) => `<link rel="stylesheet" href="${h}">`);
    const html = `<!doctype html><head><title>App</title><meta name="plinth-design-system" content="${ds.id}@1">${head.join("")}</head><body>x</body>`;
    const { res, body } = await publish(a.auth, { html, copy_files: read.install.copy_files });
    expect(res.status, JSON.stringify(body)).toBe(201);
    // No missing_file warning: every url() in the copied CSS resolves inside ds/acme/.
    expect(body.warnings.filter((w: Json) => w.code === "missing_file")).toEqual([]);
    const parsed = parseDesignSystem(ACME);
    if (!parsed.ok) throw new Error("fixture");
    const css = await text(body.id, 1, "ds/acme/tokens.css");
    expect(css).toBe(
      `/* Plinth design system ${ds.id} v1: tokens. Generated from system.json. */\n${designSystemCss(parsed.value)}\n`,
    );
    expect(await text(body.id, 1, "ds/acme/fonts.css")).toContain(
      'src:url("fonts/acme-mono.woff2") format("woff2")',
    );
    expect(await text(body.id, 1, "ds/acme/fonts/acme-mono.woff2")).toBe(MONO);
    const tokens = JSON.parse((await text(body.id, 1, "ds/acme/tokens.json")) ?? "{}");
    expect(tokens).toMatchObject({
      format: "plinth.design-system-tokens/1",
      design_system: { id: ds.id, version: 1 },
      prefix: "acme",
    });
    expect(tokens.tokens.find((t: Json) => t.path === "color.accent")).toMatchObject({
      css_var: "--acme-color-accent",
      value: "#3355ff",
      dark: "#6b8cff",
    });
    const got = await json(await call(`/api/v1/artifacts/${body.id}`, { headers: a.auth }));
    expect(got.design_system).toEqual({
      id: ds.id,
      title: "Acme UI",
      version: 1,
      current_version: 1,
    });
    expect(got.copied_from).toHaveLength(1);
    expect(got.copied_from[0].files).toHaveLength(5);
  });

  it("works over MCP with the same input", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const c = await mcpClient(a.token);
    const read = await tool(c, "get_design_system", { id: ds.id, include: ["css"] });
    const r = await tool(c, "publish_artifact", {
      title: "From MCP",
      html: PAGE,
      copy_files: read.data.install.copy_files,
    });
    await c.close();
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(await text(r.data.id, 1, "ds/acme/tokens.css")).toMatch(/--acme-color-brand-500/);
  });

  it("a design takes the CSS but refuses the font files, with the design's own rule", async () => {
    const a = await agent();
    const ds = await designSystem(a);
    const content =
      `<meta name="plinth-design-system" content="${ds.id}@1">\n` +
      '<link rel="stylesheet" href="ds/acme/tokens.css">\n' +
      '<!-- artboard id="home" name="Home" size="iphone" -->\n<div>Home</div>\n';
    const ok = await publish(a.auth, {
      html: undefined,
      type: "design",
      content,
      copy_files: [{ artifact: ds.id, path: "tokens.css", to: "ds/acme/tokens.css" }],
    });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(201);
    const font = await publish(a.auth, {
      html: undefined,
      type: "design",
      content,
      copy_files: [{ artifact: ds.id, path: "fonts/acme-mono.woff2", to: "ds/acme/fonts/a.woff2" }],
    });
    expect(font.res.status).toBe(400);
    expect(font.body.error.message).toMatch(/opaque origin/);
  });
});

describe("copy_files on start_upload", () => {
  async function upload(a: Agent, input: Json, files: { name: string; data: string }[]) {
    const start = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const t = await json(start);
    if (start.status !== 201 && start.status !== 200) return { status: start.status, body: t };
    const req = new Request(t.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.upload_token}` },
      body: tar(files),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as never, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await json(res) };
  }

  it("copies beside the bundle's files, which a prefix strip does not move", async () => {
    const a = await agent();
    const src = await sourcePage(a);
    const r = await upload(
      a,
      { copy_files: [{ artifact: src.id, path: "img/logo.svg", to: "brand/logo.svg" }] },
      [
        { name: "dist/index.html", data: PAGE },
        { name: "dist/app.js", data: "1" },
      ],
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.bundle.stripped_prefix).toBe("dist/");
    expect((await manifestOf(r.body.id, 1)).map((e) => e.path).sort()).toEqual([
      "app.js",
      "brand/logo.svg",
      "index.html",
    ]);
    expect(await text(r.body.id, 1, "brand/logo.svg")).toBe(LOGO);
    expect(r.body.copied_from).toEqual([
      expect.objectContaining({
        artifact: src.id,
        files: [{ path: "brand/logo.svg", from: "img/logo.svg" }],
      }),
    ]);
  });

  it("refuses at the commit a source the caller lost access to after start_upload", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const other = await agent();
    await db()
      .insert(accessGrants)
      .values({ artifactId: src.id, email: other.user.email, role: "viewer", createdAt: nowIso() })
      .run();
    const start = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...other.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ copy_files: [{ artifact: src.id, path: "img/logo.svg" }] }),
    });
    expect(start.status).toBe(201);
    const t = await json(start);
    await env.DB.prepare("DELETE FROM access_grants WHERE artifact_id = ?1").bind(src.id).run();
    const req = new Request(t.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.upload_token}` },
      body: tar([{ name: "index.html", data: PAGE }]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(await r2Keys(`artifacts/${t.target.id}/`)).toEqual([]);
  });

  it("refuses a ticket whose source the caller cannot view, before minting", async () => {
    const owner = await agent();
    const src = await sourcePage(owner, "allowlist");
    const stranger = await agent();
    const r = await upload(
      stranger,
      { copy_files: [{ artifact: src.id, path: "img/logo.svg" }] },
      [],
    );
    expect(r.status).toBe(404);
  });
});

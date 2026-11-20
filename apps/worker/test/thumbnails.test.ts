// Thumbnails: the capture after a commit, the dashboard image route, the link-preview tags and
// og.jpg, and who may see which. A fake browser replaces Browser Rendering (setThumbnailShooter);
// a stub BROWSER binding turns the feature on.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentOrigin, getConfig } from "../src/config.ts";
import { contentCookieName } from "../src/content/serve.ts";
import {
  issueEnterUrl,
  signContentCookie,
  verifyContentCookie,
  verifyEnterToken,
} from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { signToken } from "../src/lib/crypto.ts";
import {
  type CaptureCookie,
  type CaptureScope,
  captureFrameCookies,
  captureRequestAllowed,
  captureScope,
  claimThumbnail,
  type GuardedRequest,
  guardCapturePage,
  setThumbnailShooter,
  THUMB,
  thumbnailKey,
  withBudget,
} from "../src/services/thumbnails.ts";
import { APP, agent, createToken, json } from "./helpers.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ON = { BROWSER: {} as Fetcher };
const CSRF = "__Host-plinth_csrf=thumbnails-test";

let shots: string[] = [];
let ip = 0;

async function run(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
  vars: Record<string, unknown> = ON,
): Promise<Response> {
  ip += 1;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(path.startsWith("http") ? path : `${APP}${path}`, {
      redirect: "manual",
      ...init,
      headers: { Cookie: CSRF, "cf-connecting-ip": `198.51.100.${ip % 250}`, ...init.headers },
    }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function publish(
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
  vars: Record<string, unknown> = ON,
) {
  const res = await run(
    "/api/v1/artifacts",
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pricing model", html: "<!doctype html><h1>Hi</h1>", ...body }),
    },
    vars,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

async function state(artifactId: string, n: number) {
  return env.DB.prepare(
    "SELECT thumbnail, thumbnail_at FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(artifactId, n)
    .first<{ thumbnail: string | null; thumbnail_at: string | null }>();
}

const tags = (html: string) =>
  [...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)" \/>/g)].map(
    (m) => [m[1], m[2]],
  );

beforeEach(() => {
  shots = [];
  setThumbnailShooter(async (_browser, url) => {
    shots.push(url);
    return JPEG;
  });
});
afterEach(() => setThumbnailShooter(null));

describe("capture after a commit", () => {
  it("screenshots the exact version as a signed-out viewer and stores it", async () => {
    const a = await agent();
    const p = await publish(a.auth);
    expect(shots).toHaveLength(1);
    const url = new URL(shots[0] as string);
    expect(url.host).toBe(`${p.id}.content.localhost:8787`);
    expect(url.pathname).toBe("/__plinth/enter");
    expect(url.searchParams.get("next")).toBe("/__plinth/v/1/");
    // No identity claim: the page sees an anonymous viewer, never the owner.
    const token = await verifyEnterToken(
      getConfig(env as never),
      url.searchParams.get("t") as string,
    );
    expect(token?.a).toBe(p.id);
    expect(token?.x).toBeUndefined();
    const obj = await env.FILES.get(thumbnailKey(p.id, 1));
    expect(obj?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(JPEG);
    expect((await state(p.id, 1))?.thumbnail).toBe("ok");
  });

  it("captures each new version, and takes none without a BROWSER binding or with THUMBNAILS off", async () => {
    const a = await agent();
    const p = await publish(a.auth);
    const up = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>Two</h1>", base_version: 1 }),
    });
    expect(up.status).toBe(200);
    expect(shots.map((s) => new URL(s).searchParams.get("next"))).toEqual([
      "/__plinth/v/1/",
      "/__plinth/v/2/",
    ]);

    shots = [];
    const off = await publish(a.auth, {}, {});
    const off2 = await publish(a.auth, {}, { ...ON, THUMBNAILS: "false" });
    expect(shots).toEqual([]);
    expect((await state(off.id, 1))?.thumbnail).toBeNull();
    expect((await state(off2.id, 1))?.thumbnail).toBeNull();
  });

  it("records a failure and does not retry it until the retry delay has passed", async () => {
    setThumbnailShooter(async () => {
      throw new Error("navigation timeout");
    });
    const a = await agent();
    const p = await publish(a.auth);
    const s = await state(p.id, 1);
    expect(s?.thumbnail).toBe("failed");
    const row = await env.DB.prepare("SELECT id FROM versions WHERE artifact_id = ?1")
      .bind(p.id)
      .first<{ id: string }>();
    const id = row?.id as string;
    expect(await claimThumbnail(env.DB, id)).toBe(false);
    expect(await claimThumbnail(env.DB, id, Date.now() + THUMB.retryFailedMs + 1000)).toBe(true);
  });

  it("claims a version once, takes a stale claim again, and caps captures running at once", async () => {
    const a = await agent();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await publish(a.auth, {}, {});
      const row = await env.DB.prepare("SELECT id FROM versions WHERE artifact_id = ?1")
        .bind(p.id)
        .first<{ id: string }>();
      ids.push(row?.id as string);
    }
    // Clear claims other tests left running, so the cap below is this test's own.
    await env.DB.prepare("UPDATE versions SET thumbnail = NULL WHERE thumbnail = 'pending'").run();
    const t = Date.now();
    expect(await claimThumbnail(env.DB, ids[0] as string, t)).toBe(true);
    expect(await claimThumbnail(env.DB, ids[0] as string, t)).toBe(false);
    expect(await claimThumbnail(env.DB, ids[1] as string, t)).toBe(true);
    // Two running: the third waits.
    expect(await claimThumbnail(env.DB, ids[2] as string, t)).toBe(false);
    // Once the claims are stale, they no longer count, and a stale claim can be taken again.
    const later = t + THUMB.pendingStaleMs + 1000;
    expect(await claimThumbnail(env.DB, ids[2] as string, later)).toBe(true);
    expect(await claimThumbnail(env.DB, ids[0] as string, later)).toBe(true);
    await env.DB.prepare("UPDATE versions SET thumbnail = NULL WHERE thumbnail = 'pending'").run();
  });

  it("removes what it stored when the artifact was deleted while the browser worked", async () => {
    const a = await agent();
    let target = "";
    setThumbnailShooter(async () => {
      await env.DB.prepare("UPDATE artifacts SET deleted_at = ?1 WHERE id = ?2")
        .bind(new Date().toISOString(), target)
        .run();
      return JPEG;
    });
    // The id is known only after the publish; capture the next artifact this owner creates.
    const before = await publish(a.auth, {}, {});
    target = before.id;
    const res = await run(`/api/v1/artifacts/${before.id}/thumbnail`, { headers: a.auth });
    expect(res.status).toBe(404);
    expect(await env.FILES.head(thumbnailKey(before.id, 1))).toBeNull();
  });
});

describe("the dashboard image", () => {
  it("is listed on summaries and served to people who may view, the same 404 to others", async () => {
    const a = await agent();
    const stranger = await agent();
    const p = await publish(a.auth);
    const list = await json(await run("/api/v1/artifacts", { headers: a.auth }));
    const item = list.items.find((i: { id: string }) => i.id === p.id);
    expect(item.thumbnail_url).toBe(`${APP}/api/v1/artifacts/${p.id}/thumbnail?version=1`);

    const img = await run(`/api/v1/artifacts/${p.id}/thumbnail?version=1`, { headers: a.auth });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    // A version's image never changes; "current" (no version) moves, so it is revalidated.
    expect(img.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    const current = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: a.auth });
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("private, no-cache");

    const denied = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: stranger.auth });
    const missing = await run("/api/v1/artifacts/aaaaaaaaaaaaaaaaaaaa/thumbnail", {
      headers: stranger.auth,
    });
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });

  it("is off on summaries without a BROWSER binding, and gone once taken down", async () => {
    const a = await agent();
    const p = await publish(a.auth);
    const plain = await json(await run("/api/v1/artifacts", { headers: a.auth }, {}));
    expect(plain.items.find((i: { id: string }) => i.id === p.id).thumbnail_url).toBeNull();

    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), p.id)
      .run();
    const res = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: a.auth });
    expect(res.status).not.toBe(200);
  });

  it("starts the capture for a version published before thumbnails, then serves it", async () => {
    const a = await agent();
    const p = await publish(a.auth, {}, {});
    expect(shots).toEqual([]);
    const first = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: a.auth });
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(shots).toHaveLength(1);
    const second = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: a.auth });
    expect(second.status).toBe(200);
  });
});

describe("link previews", () => {
  it("give a link-viewable artifact its title and image", async () => {
    const a = await agent();
    const p = await publish(a.auth, { visibility: "unlisted", title: `Q3 "pricing" <model>` });
    const html = await (await run(`/a/${p.slug}`)).text();
    const t = Object.fromEntries(tags(html));
    expect(t["og:title"]).toBe("Q3 &quot;pricing&quot; &lt;model&gt;");
    expect(t["og:site_name"]).toBe("Plinth");
    expect(t["og:url"]).toBe(`${APP}/a/${p.slug}`);
    expect(t["og:image"]).toBe(`${APP}/a/${p.slug}/og.jpg?version=1`);
    expect(t["og:image:width"]).toBe("1200");
    expect(t["twitter:card"]).toBe("summary_large_image");

    const img = await run(`/a/${p.slug}/og.jpg?version=1`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
  });

  it("give private, password and missing artifacts one generic card and no image", async () => {
    const a = await agent();
    const priv = await publish(a.auth, { title: "Secret acquisition plan" });
    const pass = await publish(a.auth, {
      title: "Board notes",
      visibility: "password",
      password: "hunter22",
    });
    const pages = await Promise.all(
      [priv.slug, pass.slug, "no-such-artifact"].map(async (s) =>
        tags(await (await run(`/a/${s}`)).text()),
      ),
    );
    expect(pages[0]).toEqual(pages[2]);
    expect(pages[1]).toEqual(pages[2]);
    const generic = Object.fromEntries(pages[0] as string[][]);
    expect(generic["og:title"]).toBe("Plinth artifact");
    expect(generic["og:image"]).toBeUndefined();
    expect(JSON.stringify(pages)).not.toContain("Secret");
    expect(JSON.stringify(pages)).not.toContain("Board");

    for (const s of [priv.slug, pass.slug, "no-such-artifact"]) {
      expect((await run(`/a/${s}/og.jpg`)).status, s).toBe(404);
    }
  });

  it("serves no image once an artifact is made private or taken down, or for a bad version", async () => {
    const a = await agent();
    const p = await publish(a.auth, { visibility: "unlisted" });
    expect((await run(`/a/${p.slug}/og.jpg`)).status).toBe(200);
    for (const v of ["0", "2", "x", "1.5"]) {
      expect((await run(`/a/${p.slug}/og.jpg?version=${v}`)).status, v).toBe(404);
    }
    const vis = await run(`/api/v1/artifacts/${p.id}/visibility`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "allowlist" }),
    });
    expect(vis.status).toBe(200);
    expect((await run(`/a/${p.slug}/og.jpg`)).status).toBe(404);

    const q = await publish(a.auth, { visibility: "unlisted" });
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), q.id)
      .run();
    expect((await run(`/a/${q.slug}/og.jpg`)).status).toBe(404);
  });

  it("start a capture for a link-viewable artifact that has none yet, and add the image after", async () => {
    const a = await agent();
    const p = await publish(a.auth, { visibility: "unlisted" }, {});
    const before = Object.fromEntries(tags(await (await run(`/a/${p.slug}`)).text()));
    expect(before["og:image"]).toBeUndefined();
    expect(before["twitter:card"]).toBe("summary");
    expect(shots).toHaveLength(1);
    const after = Object.fromEntries(tags(await (await run(`/a/${p.slug}`)).text()));
    expect(after["og:image"]).toBe(`${APP}/a/${p.slug}/og.jpg?version=1`);
  });

  it("describe the app itself on other pages", async () => {
    const t = Object.fromEntries(tags(await (await run("/dashboard")).text()));
    expect(t["og:title"]).toBe("Plinth");
    expect(t["og:image"]).toBeUndefined();
  });
});

/**
 * Load a URL the way the capture browser does: a top-level page (Sec-Fetch-Dest: document) that
 * keeps the cookies it is given and follows redirects. Returns where it ended up.
 */
async function loadTopLevel(url: string) {
  let cookie = "";
  let current = url;
  for (let i = 0; i < 6; i++) {
    const res = await run(current, {
      headers: { "sec-fetch-dest": "document", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] as string;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { status: res.status, url: current, body: await res.text() };
  }
  throw new Error("too many redirects");
}

describe("what the capture browser loads", () => {
  /** A fake browser that really loads the page, and fails on anything but the artifact. */
  const realLoad = (seen: { url: string; body: string }[]) => async (_b: Fetcher, url: string) => {
    const page = await loadTopLevel(url);
    seen.push(page);
    if (page.status !== 200) throw new Error(`page answered ${page.status}`);
    return JPEG;
  };

  it("reaches the version itself, top-level, for a private artifact too", async () => {
    const seen: { url: string; body: string }[] = [];
    setThumbnailShooter(realLoad(seen));
    const a = await agent();
    const p = await publish(a.auth, { html: "<!doctype html><h1>Private numbers</h1>" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`http://${p.id}.content.localhost:8787/__plinth/v/1/`);
    expect(seen[0]?.body).toContain("<h1>Private numbers</h1>");
    expect((await state(p.id, 1))?.thumbnail).toBe("ok");
  });

  it("is served the captured version on every path, never the current one", async () => {
    // A person's version 1 loads root-relative files (a Vite build with base '/'): a script and a
    // frame. A token limited to the artifact then publishes version 2 with its own files at the
    // same paths. Version 1's later capture (a retry or a reader's backfill) must run version 1's
    // code, not the token's, under its pass that reads the shared data.
    const owner = await agent();
    const v1 = `<!doctype html><script src="/app.js"></script><iframe src="/chart.html"></iframe>`;
    const p = await publish(owner.auth, {
      html: v1,
      assets: [
        { path: "app.js", content: "window.one = 1;" },
        { path: "chart.html", content: "<!doctype html><p>chart one</p>" },
      ],
    });
    const ci = await createToken(owner.user.id, {
      scopes: "artifacts:read artifacts:write",
      artifactId: p.id,
    });
    const up = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ci.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        html: "<!doctype html><h1>Token's page</h1>",
        assets: [
          { path: "app.js", content: "window.two = 2;" },
          { path: "chart.html", content: "<!doctype html><p>chart two</p>" },
        ],
        base_version: 1,
      }),
    });
    expect(up.status, await up.clone().text()).toBe(200);

    const got: Record<string, { status: number; body: string }> = {};
    setThumbnailShooter(async (_b, url) => {
      const enter = await run(url, { headers: { "sec-fetch-dest": "document" } });
      const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const own = new URL(url).origin;
      const load = async (path: string, dest: string) => {
        const res = await run(`${own}${path}`, {
          headers: { Cookie: cookie, "sec-fetch-dest": dest },
        });
        got[`${dest} ${path}`] = { status: res.status, body: await res.text() };
      };
      await load("/__plinth/v/1/", "document");
      await load("/app.js", "script");
      await load("/chart.html", "iframe");
      await load("/", "document");
      await load("/__plinth/v/2/", "document");
      await load("/__plinth/v/2/app.js", "script");
      return JPEG;
    });
    await env.DB.prepare(
      "UPDATE versions SET thumbnail = NULL WHERE artifact_id = ?1 AND number = 1",
    )
      .bind(p.id)
      .run();
    await run(`/api/v1/artifacts/${p.id}/thumbnail?version=1`, { headers: owner.auth });

    expect(got["document /__plinth/v/1/"]?.body).toContain('<script src="/app.js">');
    expect(got["script /app.js"]).toEqual({ status: 200, body: "window.one = 1;" });
    expect(got["iframe /chart.html"]).toEqual({
      status: 200,
      body: "<!doctype html><p>chart one</p>",
    });
    expect(got["document /"]?.status).toBe(200);
    expect(got["document /"]?.body).toContain('<script src="/app.js">');
    expect(got["document /"]?.body).not.toContain("Token's page");
    // Another version, the current one included, is not this capture's to open.
    expect(got["document /__plinth/v/2/"]?.status).toBe(404);
    expect(got["script /__plinth/v/2/app.js"]?.status).toBe(404);
  });

  it("refuses a capture that names no version, at the issuer and on the content host", async () => {
    const config = getConfig(env as never);
    const a = await agent();
    const p = await publish(a.auth, {}, {});
    const art = await env.DB.prepare("SELECT access_epoch FROM artifacts WHERE id = ?1")
      .bind(p.id)
      .first<{ access_epoch: number }>();
    const artifact = { id: p.id, accessEpoch: art?.access_epoch as number };
    await expect(
      issueEnterUrl(config, artifact, "/__plinth/v/1/", undefined, { capture: true }),
    ).rejects.toThrow("A capture names one version");
    await expect(
      issueEnterUrl(config, artifact, "/", undefined, { captureVersion: 1 }),
    ).rejects.toThrow("Only a capture names its captured version");
    await expect(
      signContentCookie(config, p.id, artifact.accessEpoch, undefined, "capture"),
    ).rejects.toThrow("names one version");
    await expect(
      signContentCookie(config, p.id, artifact.accessEpoch, undefined, "view", 1),
    ).rejects.toThrow("names one version");
    // Tokens signed the way an older Worker signed them, with no version: no pass at all.
    const own = `http://${p.id}.content.localhost:8787`;
    const enter = await signToken(config.tokenSigningKey, {
      k: "enter",
      a: p.id,
      e: artifact.accessEpoch,
      n: "unversioned-capture-nonce",
      exp: Date.now() + 60_000,
      c: 1,
    });
    const entered = await run(
      `${own}/__plinth/enter?${new URLSearchParams({ t: enter, next: "/__plinth/v/1/" })}`,
      { headers: { "sec-fetch-dest": "document" } },
    );
    expect(entered.status).toBe(403);
    expect(entered.headers.get("set-cookie")).toBeNull();
    const pass = await signToken(config.tokenSigningKey, {
      k: "content",
      a: p.id,
      e: artifact.accessEpoch,
      exp: Date.now() + 60_000,
      c: 1,
    });
    const name = contentCookieName(config, new URL(own));
    const page = await run(`${own}/__plinth/v/1/`, {
      headers: { Cookie: `${name}=${pass}`, "sec-fetch-dest": "document" },
    });
    expect(page.status).toBe(302);
    expect(new URL(page.headers.get("location") as string).host).toBe("app.localhost:8787");
  });

  it("sends an ordinary viewer's top-level visit to the app page, as before", async () => {
    const a = await agent();
    const p = await publish(a.auth, {}, {});
    const art = await env.DB.prepare("SELECT access_epoch FROM artifacts WHERE id = ?1")
      .bind(p.id)
      .first<{ access_epoch: number }>();
    const enter = await issueEnterUrl(
      getConfig(env as never),
      { id: p.id, accessEpoch: art?.access_epoch as number },
      "/__plinth/v/1/",
    );
    const page = await loadTopLevel(enter);
    expect(new URL(page.url).host).toBe("app.localhost:8787");
  });

  it("records a failure, not a picture of the error page, when access changed before the capture", async () => {
    const seen: { url: string; body: string }[] = [];
    const a = await agent();
    const p = await publish(a.auth, { visibility: "unlisted" }, {});
    setThumbnailShooter(async (b, url) => {
      // Visibility changes between the claim and the browser's visit: the token's epoch is old.
      await env.DB.prepare("UPDATE artifacts SET access_epoch = access_epoch + 1 WHERE id = ?1")
        .bind(p.id)
        .run();
      return realLoad(seen)(b, url);
    });
    const res = await run(`/api/v1/artifacts/${p.id}/thumbnail`, { headers: a.auth });
    expect(res.status).toBe(404);
    expect(seen[0]?.body).toContain("expired");
    expect((await state(p.id, 1))?.thumbnail).toBe("failed");
    expect(await env.FILES.head(thumbnailKey(p.id, 1))).toBeNull();
  });

  it("hands a design's capture a pass for its boards' cookie partition, and nothing to an HTML page", async () => {
    const got: { url: string; scope: CaptureScope; cookies: readonly CaptureCookie[] }[] = [];
    setThumbnailShooter(async (_b, url, scope, cookies) => {
      got.push({ url, scope, cookies });
      return JPEG;
    });
    const a = await agent();
    const page = await publish(a.auth);
    const design = await publish(a.auth, {
      html: undefined,
      type: "design",
      content: '<!-- artboard name="One" size="iphone" -->\n<img src="img/a.png" alt="">',
      assets: [{ path: "img/a.png", content: PNG, encoding: "base64" }],
    });
    expect(got).toHaveLength(2);
    expect(got[0]?.cookies).toEqual([]);
    const cookies = got[1]?.cookies ?? [];
    expect(cookies).toHaveLength(1);
    const c = cookies[0] as CaptureCookie;
    const origin = `http://${design.id}.content.localhost:8787`;
    expect({ ...c, value: "", expires: 0 }).toEqual({
      name: "__Host-plinth_content",
      value: "",
      url: `${origin}/`,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
      expires: 0,
      partitionKey: { topLevelSite: "http://content.localhost", hasCrossSiteAncestor: true },
    });
    const now = Math.floor(Date.now() / 1000);
    expect(c.expires).toBeGreaterThan(now);
    expect(c.expires).toBeLessThanOrEqual(now + 120);
    // A capture pass for this artifact only: no identity, bound to the captured version like the
    // enter's pass, and it opens the boards' files.
    const pass = await verifyContentCookie(getConfig(env as never), c.value);
    expect(pass?.a).toBe(design.id);
    expect(pass?.c).toBe(1);
    expect(pass?.v).toBe(1);
    expect(pass?.d).toBeUndefined();
    expect(pass?.x).toBeUndefined();
    const cookie = `${c.name}=${c.value}`;
    const img = await run(`${origin}/__plinth/v/1/img/a.png`, {
      headers: { Cookie: cookie, "sec-fetch-dest": "image" },
    });
    expect(img.status).toBe(200);
    const other = await run(`http://${page.id}.content.localhost:8787/`, {
      headers: { Cookie: cookie, "sec-fetch-dest": "iframe" },
    });
    expect(other.status).toBe(401);
    // The boards' frames open the board loader as a navigation: the guard lets exactly that page
    // through for a design, and the boards' pass gets it.
    const loader = `${origin}/__plinth/frames/design/board.html`;
    expect(got[1]?.scope.frame).toBe("/__plinth/frames/design/board.html");
    expect(captureRequestAllowed(got[1]?.scope as CaptureScope, loader, true)).toBe(true);
    expect(got[0]?.scope.frame).toBeUndefined();
    const served = await run(loader, { headers: { Cookie: cookie, "sec-fetch-dest": "iframe" } });
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("Plinth board loader");

    // Version 2's capture gets its own pass; version 1's never opens version 2's files.
    const up = await run(`/api/v1/artifacts/${design.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: '<!-- artboard name="Two" size="iphone" -->\n<img src="img/a.png" alt="">',
        assets: [{ path: "img/a.png", content: PNG, encoding: "base64" }],
        base_version: 1,
      }),
    });
    expect(up.status, await up.clone().text()).toBe(200);
    expect(got).toHaveLength(3);
    const c2 = got[2]?.cookies[0] as CaptureCookie;
    expect((await verifyContentCookie(getConfig(env as never), c2.value))?.v).toBe(2);
    const v2 = `${origin}/__plinth/v/2/img/a.png`;
    expect((await run(v2, { headers: { Cookie: cookie, "sec-fetch-dest": "image" } })).status).toBe(
      404,
    );
    expect(
      (await run(v2, { headers: { Cookie: `${c2.name}=${c2.value}`, "sec-fetch-dest": "image" } }))
        .status,
    ).toBe(200);
  });

  it("gives the boards' pass no shared data when the enter's pass has none", async () => {
    const got: { url: string; cookies: readonly CaptureCookie[] }[] = [];
    setThumbnailShooter(async (_b, url, _scope, cookies) => {
      got.push({ url, cookies });
      return JPEG;
    });
    const owner = await agent();
    const design = await publish(owner.auth, {
      html: undefined,
      type: "design",
      content: '<!-- artboard name="One" size="iphone" -->\n<p>One</p>',
    });
    const ci = await createToken(owner.user.id, {
      scopes: "artifacts:read artifacts:write",
      artifactId: design.id,
    });
    const up = await run(`/api/v1/artifacts/${design.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ci.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: '<!-- artboard name="Two" size="iphone" -->\n<p>Two</p>',
        base_version: 1,
      }),
    });
    expect(up.status, await up.clone().text()).toBe(200);
    expect(got).toHaveLength(2);
    const config = getConfig(env as never);
    const passes = await Promise.all(
      got.map(async (g) => ({
        enter: (await verifyEnterToken(config, new URL(g.url).searchParams.get("t") ?? ""))?.d,
        frame: (await verifyContentCookie(config, g.cookies[0]?.value ?? ""))?.d,
      })),
    );
    expect(passes).toEqual([
      { enter: undefined, frame: undefined },
      { enter: 1, frame: 1 },
    ]);
  });

  it("lets a navigation reach a type's framed page only for that type, and only that file", () => {
    const config = getConfig(env as never);
    const id = "aaaaaaaaaaaaaaaaaaaa";
    const own = contentOrigin(config, id);
    const design = captureScope(config, id, 3, "design");
    const page = captureScope(config, id, 3, "html");
    const loader = `${own}/__plinth/frames/design/board.html`;
    expect(captureRequestAllowed(design, loader, true)).toBe(true);
    expect(captureRequestAllowed(page, loader, true)).toBe(false);
    expect(captureRequestAllowed(captureScope(config, id, 3), loader, true)).toBe(false);
    expect(captureRequestAllowed(design, `${own}/__plinth/frames/design/other.html`, true)).toBe(
      false,
    );
    expect(captureRequestAllowed(design, `${own}/__plinth/frames/slides/board.html`, true)).toBe(
      false,
    );
    expect(captureRequestAllowed(design, `${own}/__plinth/frames/design/board.html/x`, true)).toBe(
      false,
    );
    // The rest of the version rule is unchanged for a design.
    expect(captureRequestAllowed(design, `${own}/__plinth/v/4/`, true)).toBe(false);
    expect(captureRequestAllowed(design, `${own}/__plinth/preview`, true)).toBe(false);
  });

  it("makes the boards' pass unpartitioned under opaque isolation, and none without Secure", async () => {
    const config = getConfig(env as never);
    const target = {
      artifactId: "aaaaaaaaaaaaaaaaaaaa",
      accessEpoch: 1,
      number: 1,
      readsData: true,
    };
    const opaque = await captureFrameCookies({ ...config, contentIsolation: "opaque" }, target);
    expect(opaque).toHaveLength(1);
    expect(opaque[0]?.partitionKey).toBeUndefined();
    const plain = await captureFrameCookies(
      { ...config, contentHost: "content.example.test", scheme: "http" },
      target,
    );
    expect(plain).toEqual([]);
  });

  it("never mints a capture pass that carries an identity", async () => {
    await expect(
      issueEnterUrl(
        getConfig(env as never),
        { id: "aaaaaaaaaaaaaaaaaaaa", accessEpoch: 1 },
        "/",
        { email: "ada@example.org", role: "owner" },
        { capture: true },
      ),
    ).rejects.toThrow();
  });

  it("never mints a pass without shared data for anything but a capture", async () => {
    const config = getConfig(env as never);
    const artifact = { id: "aaaaaaaaaaaaaaaaaaaa", accessEpoch: 1 };
    await expect(
      issueEnterUrl(config, artifact, "/", undefined, { noData: true }),
    ).rejects.toThrow();
    await expect(
      signContentCookie(
        config,
        artifact.id,
        1,
        undefined,
        "view",
        undefined,
        false,
        undefined,
        true,
      ),
    ).rejects.toThrow();
    const url = await issueEnterUrl(config, artifact, "/", undefined, {
      capture: true,
      captureVersion: 1,
      noData: true,
    });
    const token = await verifyEnterToken(config, new URL(url).searchParams.get("t") as string);
    expect(token).toMatchObject({ c: 1, d: 1 });
  });

  it("gives up on a capture that outlasts its budget", async () => {
    await expect(withBudget(new Promise(() => undefined), 20)).rejects.toThrow(/longer than/);
    await expect(withBudget(Promise.resolve(7), 20)).resolves.toBe(7);
  });
});

describe("a capture never carries shared data off the page", () => {
  const DATA_PAGE = `<!doctype html><title>Votes</title>
<meta name="plinth-capabilities" content="data"><p>votes</p>`;

  /** A shared-data request the way the runtime makes one, with the capture browser's cookie. */
  const dataApi = (id: string, path: string, cookie: string) =>
    run(`http://${id}.content.localhost:8787/__plinth/api/v1/${path}`, {
      headers: {
        Cookie: cookie,
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });

  type Seen = { version: string; collection: number; body: string; session: unknown };

  /** A fake browser that enters the capture, then reads the page's shared data as its script would. */
  const readingBrowser = (seen: Seen[]) => async (_b: Fetcher, url: string) => {
    const enter = await run(url, { headers: { "sec-fetch-dest": "document" } });
    const cookie = (enter.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const id = new URL(url).host.split(".")[0] as string;
    const votes = await dataApi(id, "data/votes", cookie);
    const session = await json(await dataApi(id, "session", cookie));
    seen.push({
      version: new URL(url).searchParams.get("next") as string,
      collection: votes.status,
      body: await votes.text(),
      session,
    });
    return JPEG;
  };

  const put = (id: string, auth: Record<string, string>, base: number) =>
    run(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        html: DATA_PAGE.replace("votes</p>", `v${base + 1}</p>`),
        base_version: base,
      }),
    });

  /** Forget version n's thumbnail and let a reader start its capture again. */
  async function retake(id: string, n: number, auth: Record<string, string>) {
    await env.DB.prepare(
      "UPDATE versions SET thumbnail = NULL WHERE artifact_id = ?1 AND number = ?2",
    )
      .bind(id, n)
      .run();
    await run(`/api/v1/artifacts/${id}/thumbnail?version=${n}`, { headers: auth });
  }

  it("a version a token limited to the artifact wrote gets no data; a person's version does", async () => {
    const owner = await agent();
    const p = await publish(owner.auth, { html: DATA_PAGE, visibility: "unlisted" }, {});
    const w = await run(`/api/v1/artifacts/${p.id}/data`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "set", collection: "votes", doc_id: "a", data: { secret: 42 }, if_rev: 0 }],
      }),
    });
    expect(w.status).toBe(200);
    const ci = await createToken(owner.user.id, {
      scopes: "artifacts:read artifacts:write",
      artifactId: p.id,
    });
    const seen: Seen[] = [];
    setThumbnailShooter(readingBrowser(seen));

    // The owner's version: the capture reads what a signed-out link viewer reads.
    expect((await put(p.id, owner.auth, 1)).status).toBe(200);
    // The CI token's version: the capture's pass reads nothing, as an in-chat preview's does.
    expect((await put(p.id, { Authorization: `Bearer ${ci.token}` }, 2)).status).toBe(200);
    expect(seen.map((s) => s.version)).toEqual(["/__plinth/v/2/", "/__plinth/v/3/"]);
    expect(seen[0]?.collection).toBe(200);
    expect(seen[0]?.body).toContain("42");
    expect(seen[1]?.collection).toBe(403);
    expect(seen[1]?.body).not.toContain("42");
    expect(JSON.parse(seen[1]?.body as string).error.details.reason).toBe("capture");
    expect(seen[1]?.session).toEqual({ available: false, reason: "capture" });

    // The pass belongs to the version, not to the artifact's current one: a person's newer
    // version does not give the CI version's capture the data.
    expect((await put(p.id, owner.auth, 3)).status).toBe(200);
    expect(seen[2]?.collection).toBe(200);
    await retake(p.id, 3, owner.auth);
    expect(seen.map((s) => s.version)).toEqual([
      "/__plinth/v/2/",
      "/__plinth/v/3/",
      "/__plinth/v/4/",
      "/__plinth/v/3/",
    ]);
    expect(seen[3]?.collection).toBe(403);

    // A version whose writer's account is gone is nobody's to vouch for: no data either.
    await env.DB.prepare(
      `UPDATE versions SET created_by_user = NULL, created_by_connection = NULL
       WHERE artifact_id = ?1 AND number = 2`,
    )
      .bind(p.id)
      .run();
    await retake(p.id, 2, owner.auth);
    expect(seen[4]?.version).toBe("/__plinth/v/2/");
    expect(seen[4]?.collection).toBe(403);
  });
});

describe("where the capture browser may go", () => {
  const scope: CaptureScope = {
    artifact: "https://abc.plinthusercontent.com",
    version: 3,
    hosts: ["cdn.jsdelivr.net", "fonts.googleapis.com"],
  };
  const allowed = (url: string, nav = false) => captureRequestAllowed(scope, url, nav);
  /** The enter URL the capture of version 3 opens first, as issueEnterUrl writes it. */
  const enter = (next: string) =>
    `https://abc.plinthusercontent.com/__plinth/enter?${new URLSearchParams({ t: "x", next })}`;

  it("allows the artifact itself, local schemes and the CSP's hosts for subresources", () => {
    expect(allowed(enter("/__plinth/v/3/"), true)).toBe(true);
    expect(allowed("https://abc.plinthusercontent.com/__plinth/v/3/", true)).toBe(true);
    expect(allowed("https://abc.plinthusercontent.com/__plinth/api/v1/data/votes")).toBe(true);
    expect(allowed("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js")).toBe(true);
    expect(allowed("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
    expect(allowed("data:image/png;base64,AAAA")).toBe(true);
    expect(allowed("blob:https://abc.plinthusercontent.com/2f1c")).toBe(true);
    expect(allowed("about:blank", true)).toBe(true);
  });

  it("aborts every navigation off the artifact and every other host", () => {
    expect(allowed("https://evil.example/?d=secret", true)).toBe(false);
    expect(allowed("https://evil.example/?d=secret")).toBe(false);
    // A sibling artifact, another scheme or port on the artifact's host, credentials in the URL.
    expect(allowed("https://xyz.plinthusercontent.com/", true)).toBe(false);
    expect(allowed("https://xyz.plinthusercontent.com/__plinth/api/v1/data/votes")).toBe(false);
    expect(allowed("http://abc.plinthusercontent.com/", true)).toBe(false);
    expect(allowed("https://abc.plinthusercontent.com:8443/", true)).toBe(false);
    expect(allowed("https://user:pw@abc.plinthusercontent.com/", true)).toBe(false);
    // A CDN is for loading code, never somewhere to go, and only over https on its own port.
    expect(allowed("https://cdn.jsdelivr.net/?d=secret", true)).toBe(false);
    expect(allowed("http://cdn.jsdelivr.net/npm/x@1.0.0/x.js")).toBe(false);
    expect(allowed("https://cdn.jsdelivr.net:8443/npm/x@1.0.0/x.js")).toBe(false);
    expect(allowed("https://cdn.jsdelivr.net.evil.example/x.js")).toBe(false);
    expect(allowed("wss://evil.example/socket")).toBe(false);
    expect(allowed("not a url")).toBe(false);
  });

  it("under the path fallback, only the artifact's own path on the app host", () => {
    const fallback: CaptureScope = {
      artifact: "http://localhost:8787/__content/abc",
      version: 1,
      hosts: [],
    };
    const ok = (url: string, nav = true) => captureRequestAllowed(fallback, url, nav);
    expect(ok("http://localhost:8787/__content/abc/__plinth/v/1/")).toBe(true);
    expect(
      ok("http://localhost:8787/__content/abc/__plinth/enter?t=x&next=%2F__plinth%2Fv%2F1%2F"),
    ).toBe(true);
    expect(ok("http://localhost:8787/__content/abc/app.js", false)).toBe(true);
    expect(ok("http://localhost:8787/__content/abc", false)).toBe(true);
    // Under a capture pass the artifact's other paths serve the captured version: open to a
    // navigation; another version and the helper paths are not.
    expect(ok("http://localhost:8787/__content/abc")).toBe(true);
    expect(ok("http://localhost:8787/__content/abc/")).toBe(true);
    expect(ok("http://localhost:8787/__content/abc/chart.html")).toBe(true);
    expect(ok("http://localhost:8787/__content/abc/__plinth/v/2/")).toBe(false);
    expect(ok("http://localhost:8787/__content/abc/__plinth/runtime.js")).toBe(false);
    // The version path at the app host's root, outside the artifact's own path.
    expect(ok("http://localhost:8787/__plinth/v/1/")).toBe(false);
    expect(ok("http://localhost:8787/__content/abcd/")).toBe(false);
    expect(ok("http://localhost:8787/__content/abcd/", false)).toBe(false);
    expect(ok("http://localhost:8787/api/v1/me")).toBe(false);
  });

  it("the instance's scope is the artifact's content origin and the CSP's hosts", () => {
    const s = captureScope(getConfig(env as never), "aaaaaaaaaaaaaaaaaaaa", 4);
    expect(s.artifact).toBe("http://aaaaaaaaaaaaaaaaaaaa.content.localhost:8787");
    expect(s.version).toBe(4);
    expect(s.hosts).toEqual(expect.arrayContaining(["cdn.jsdelivr.net", "fonts.gstatic.com"]));
  });

  it("the browser page intercepts every request, aborts the ones off scope and closes popups", async () => {
    const handlers: Record<string, (arg: never) => void> = {};
    let intercepting = false;
    const page = {
      setRequestInterception: async (on: boolean) => {
        intercepting = on;
      },
      on: (event: string, handler: (arg: never) => void) => {
        handlers[event] = handler;
        return page;
      },
    };
    await guardCapturePage(page, scope);
    expect(intercepting).toBe(true);
    const outcomes: string[] = [];
    const request = (url: string, nav: boolean, handled = false): GuardedRequest => ({
      url: () => url,
      isNavigationRequest: () => nav,
      isInterceptResolutionHandled: () => handled,
      continue: async () => {
        outcomes.push(`continue ${url}`);
      },
      abort: async (code) => {
        outcomes.push(`abort(${code}) ${url}`);
      },
    });
    const onRequest = handlers.request as (r: GuardedRequest) => void;
    onRequest(request("https://abc.plinthusercontent.com/__plinth/v/3/", true));
    onRequest(request("https://abc.plinthusercontent.com/", true));
    onRequest(request("https://abc.plinthusercontent.com/__plinth/v/4/", true));
    onRequest(request("https://abc.plinthusercontent.com/app.js", false));
    onRequest(request("https://evil.example/?d=secret", true));
    onRequest(request("https://evil.example/pixel.gif", false));
    onRequest(request("https://evil.example/already", true, true));
    await Promise.resolve();
    expect(outcomes).toEqual([
      "continue https://abc.plinthusercontent.com/__plinth/v/3/",
      "continue https://abc.plinthusercontent.com/",
      "abort(blockedbyclient) https://abc.plinthusercontent.com/__plinth/v/4/",
      "continue https://abc.plinthusercontent.com/app.js",
      "abort(blockedbyclient) https://evil.example/?d=secret",
      "abort(blockedbyclient) https://evil.example/pixel.gif",
    ]);
    let closed = false;
    (handlers.popup as (p: { close(): Promise<void> } | null) => void)({
      close: async () => {
        closed = true;
      },
    });
    (handlers.popup as (p: null) => void)(null);
    expect(closed).toBe(true);
  });

  it("every capture hands the browser the artifact's scope", async () => {
    const scopes: CaptureScope[] = [];
    setThumbnailShooter(async (_b, _url, s) => {
      scopes.push(s);
      return JPEG;
    });
    const a = await agent();
    const p = await publish(a.auth);
    expect(scopes).toEqual([captureScope(getConfig(env as never), p.id, 1)]);
    const put = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>Two</h1>", base_version: 1 }),
    });
    expect(put.status).toBe(200);
    expect(scopes[1]).toEqual(captureScope(getConfig(env as never), p.id, 2));
  });

  it("navigations under /__plinth/ stay on the captured version; the page's own paths load", () => {
    const own = "https://abc.plinthusercontent.com";
    // The captured version's own pages, with or without the trailing slash the host adds.
    expect(allowed(`${own}/__plinth/v/3/`, true)).toBe(true);
    expect(allowed(`${own}/__plinth/v/3`, true)).toBe(true);
    expect(allowed(`${own}/__plinth/v/3/about.html?tab=2#top`, true)).toBe(true);
    expect(allowed(`${own}/__plinth/v/3/docs/`, true)).toBe(true);
    // The artifact's other paths, top-level or in a frame: the capture pass is bound to its
    // version, so the content host serves them from it (a frame of /chart.html, a redirect to
    // /docs/, a router's location.replace('/app/')).
    expect(allowed(`${own}/`, true)).toBe(true);
    expect(allowed(own, true)).toBe(true);
    expect(allowed(`${own}/index.html`, true)).toBe(true);
    expect(allowed(`${own}/chart.html`, true)).toBe(true);
    expect(allowed(`${own}/docs/?tab=2`, true)).toBe(true);
    // Another version, or one that only looks like this one.
    expect(allowed(`${own}/__plinth/v/4/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/2/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/30/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/03/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/3%2F..%2F4/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/3/%2e%2e/4/`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/v/3/../4/`, true)).toBe(false);
    // Plinth's other paths are never a page the capture opens.
    expect(allowed(`${own}/__plinth/preview`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/runtime.js`, true)).toBe(false);
    expect(allowed(`${own}/__plinth/api/v1/data/votes`, true)).toBe(false);
    // The enter step only on its way to this version.
    expect(allowed(enter("/"), true)).toBe(false);
    expect(allowed(enter("/__plinth/v/4/"), true)).toBe(false);
    expect(allowed(enter("/__plinth/v/3/about.html"), true)).toBe(false);
    expect(allowed(`${own}/__plinth/enter?t=x`, true)).toBe(false);
    expect(allowed(`${enter("/__plinth/v/3/")}&next=%2F`, true)).toBe(false);
    // Subresources keep the origin-wide rule: the page's files, the runtime, the data API.
    expect(allowed(`${own}/__plinth/v/3/app.js`)).toBe(true);
    expect(allowed(`${own}/app.js`)).toBe(true);
    expect(allowed(`${own}/__plinth/runtime.js`)).toBe(true);
    expect(allowed(`${own}/__plinth/types/doc/doc.js`)).toBe(true);
    expect(allowed(`${own}/__plinth/api/v1/data/votes`)).toBe(true);
    expect(allowed("about:srcdoc", true)).toBe(true);
  });

  it("the capture's own enter URL and the host's redirect from it both pass the guard", async () => {
    const seen: { url: string; scope: CaptureScope; location: string }[] = [];
    setThumbnailShooter(async (_b, url, s) => {
      const res = await run(url, { headers: { "sec-fetch-dest": "document" } });
      seen.push({ url, scope: s, location: res.headers.get("location") ?? "" });
      return JPEG;
    });
    const a = await agent();
    const p = await publish(a.auth);
    const put = await run(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><h1>Two</h1>", base_version: 1 }),
    });
    expect(put.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const [i, s] of seen.entries()) {
      const n = i + 1;
      expect(s.scope.version).toBe(n);
      expect(captureRequestAllowed(s.scope, s.url, true)).toBe(true);
      const next = new URL(s.location, s.url).href;
      expect(next).toBe(`${s.scope.artifact}/__plinth/v/${n}/`);
      expect(captureRequestAllowed(s.scope, next, true)).toBe(true);
      // The same browser may not go on to the other version.
      const other = `${s.scope.artifact}/__plinth/v/${3 - n}/`;
      expect(captureRequestAllowed(s.scope, other, true)).toBe(false);
    }
  });
});

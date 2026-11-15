// Thumbnails: the capture after a commit, the dashboard image route, the link-preview tags and
// og.jpg, and who may see which. A fake browser replaces Browser Rendering (setThumbnailShooter);
// a stub BROWSER binding turns the feature on.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config.ts";
import { issueEnterUrl, verifyEnterToken } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import {
  claimThumbnail,
  setThumbnailShooter,
  THUMB,
  thumbnailKey,
  withBudget,
} from "../src/services/thumbnails.ts";
import { APP, agent, json } from "./helpers.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
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

  it("gives up on a capture that outlasts its budget", async () => {
    await expect(withBudget(new Promise(() => undefined), 20)).rejects.toThrow(/longer than/);
    await expect(withBudget(Promise.resolve(7), 20)).resolves.toBe(7);
  });
});

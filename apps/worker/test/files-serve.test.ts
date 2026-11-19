// The read path of files people add to a page: GET and HEAD /__plinth/files/<id> on the
// artifact's own origin. The headers that keep the bytes inert, the fetch-destination allowlist,
// conditional and range requests, and every case that answers 404.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { appPageFor, contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import {
  cookieFor,
  DATA_ONLY,
  epochOf,
  fileGet,
  filesApi,
  mp4,
  pdf,
  png,
  setup,
  takeDown,
  upload,
} from "./files-helpers.ts";
import { browserSession, call, config, contentOrigin, json, publish } from "./helpers.ts";

const PUBLIC_PAGE = `<!doctype html><title>Wall</title>
<meta name="plinth-capabilities" content="files"><p>wall</p>`;

describe("files read path: headers", () => {
  it("serves the exact proven type, inert: nosniff, script-src 'none', a bare sandbox, CORP same-origin", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(500), "image/png", "café.png");
    const res = await fileGet(id, f.id, { cookie: ownerP.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(contentCsp(config(), { scripts: "none", sandbox: "strict" }));
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp.endsWith("; sandbox")).toBe(true);
    expect(csp).not.toContain("allow-");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBe(`"f-${f.id}"`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="caf_.png"; filename*=UTF-8''caf%C3%A9.png`,
    );
    for (const [k] of res.headers) expect(k.startsWith("access-control-"), k).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(500));
  });

  it("keeps X-Robots-Tag on a public artifact, and sends PDFs, ?download=1 and frames as attachments", async () => {
    const { owner } = await setup();
    const { body } = await publish(owner.auth, { html: PUBLIC_PAGE, visibility: "unlisted" });
    const id = body.id as string;
    await env.DB.prepare("UPDATE artifacts SET visibility = 'public' WHERE id = ?1").bind(id).run();
    const vars = { ALLOW_PUBLIC_VISIBILITY: "true" };
    const s = await browserSession(owner.user.id);
    const cookie = await cookieFor(id, s.headers);
    const me = {
      email: owner.user.email,
      cookie,
      viewerId: "",
      userId: owner.user.id,
      headers: s.headers,
    };
    const doc = await upload(id, me, pdf(400), "application/pdf", "report.pdf");
    const img = await upload(id, me, png(), "image/png", "a.png");
    const r1 = await fileGet(id, doc.id, { cookie, vars });
    expect(r1.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r1.headers.get("content-disposition")).toMatch(/^attachment; filename="report.pdf"/);
    const r2 = await fileGet(id, img.id, { cookie, query: "?download=1" });
    expect(r2.headers.get("content-disposition")).toMatch(/^attachment;/);
    const r3 = await fileGet(id, img.id, { cookie, headers: { "sec-fetch-dest": "iframe" } });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});

describe("files read path: how the file is loaded", () => {
  it("refuses scripts, styles, fonts, workers, objects, embeds and manifests", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    for (const dest of [
      "script",
      "style",
      "font",
      "worker",
      "sharedworker",
      "serviceworker",
      "object",
      "embed",
      "manifest",
      "xslt",
    ]) {
      const res = await fileGet(id, f.id, {
        cookie: ownerP.cookie,
        headers: { "sec-fetch-dest": dest },
      });
      expect(res.status, dest).toBe(403);
    }
    for (const dest of ["image", "video", "audio", "track", "empty"]) {
      const res = await fileGet(id, f.id, {
        cookie: ownerP.cookie,
        headers: { "sec-fetch-dest": dest },
      });
      expect(res.status, dest).toBe(200);
    }
    // Tools that send no fetch metadata are served.
    const bare = await fileGet(id, f.id, {
      cookie: ownerP.cookie,
      headers: { "sec-fetch-dest": null, "sec-fetch-site": null, "sec-fetch-mode": null },
    });
    expect(bare.status).toBe(200);
  });

  it("sends a top-level visit to the artifact's page, not to a frame on the file", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    const res = await fileGet(id, f.id, {
      cookie: ownerP.cookie,
      headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${config().appOrigin}/a/${id}`);
    expect(
      appPageFor(config(), id, `/__plinth/files/${f.id}`, new URL(`${contentOrigin(id)}/x`)),
    ).toBe(`${config().appOrigin}/a/${id}`);
  });
});

describe("files read path: conditional and range requests", () => {
  it("answers a matching If-None-Match with 304 without reading R2", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    const get = vi.fn(env.FILES.get.bind(env.FILES));
    const FILES = new Proxy(env.FILES, {
      get: (t, k) => (k === "get" ? get : (Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k))),
    });
    const res = await fileGet(id, f.id, {
      cookie: ownerP.cookie,
      headers: { "if-none-match": `"f-${f.id}"` },
      vars: { FILES } as unknown as Record<string, string>,
    });
    expect(res.status).toBe(304);
    expect(get).not.toHaveBeenCalled();
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("serves one range as 206, a suffix range, and 416 for several or none that fit", async () => {
    const { id, ownerP } = await setup();
    const bytes = mp4(4000);
    const f = await upload(id, ownerP, bytes, "video/mp4", "clip.mp4");
    const range = (r: string) =>
      fileGet(id, f.id, {
        cookie: ownerP.cookie,
        headers: { range: r, "sec-fetch-dest": "video" },
      });
    const a = await range("bytes=100-199");
    expect(a.status).toBe(206);
    expect(a.headers.get("content-range")).toBe("bytes 100-199/4000");
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(bytes.subarray(100, 200));
    const b = await range("bytes=3990-");
    expect(b.headers.get("content-range")).toBe("bytes 3990-3999/4000");
    const c = await range("bytes=-10");
    expect(c.status).toBe(206);
    expect(new Uint8Array(await c.arrayBuffer())).toEqual(bytes.subarray(3990));
    for (const bad of ["bytes=0-1,5-6", "bytes=5000-", "bytes=9-3", "items=0-1"]) {
      const r = await range(bad);
      expect(r.status, bad).toBe(416);
      expect(r.headers.get("content-range"), bad).toBe("bytes */4000");
    }
    const head = await fileGet(id, f.id, { cookie: ownerP.cookie, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("files read path: 404 and 401", () => {
  it("answers 404 for pending, deleted, unknown and other artifacts' ids", async () => {
    const { id, ownerP } = await setup();
    const other = await setup();
    const f = await upload(other.id, other.ownerP, png(), "image/png");
    expect((await fileGet(id, f.id, { cookie: ownerP.cookie })).status).toBe(404);
    expect((await fileGet(id, "z".repeat(20), { cookie: ownerP.cookie })).status).toBe(404);
    expect((await fileGet(id, "not-an-id", { cookie: ownerP.cookie })).status).toBe(404);
    const pending = await json(
      await filesApi(id, "", {
        cookie: ownerP.cookie,
        body: { name: "a.png", type: "image/png", size: 10 },
      }),
    );
    expect((await fileGet(id, pending.file.id, { cookie: ownerP.cookie })).status).toBe(404);
    const g = await upload(id, ownerP, png(), "image/png");
    await filesApi(id, `/${g.id}`, { method: "DELETE", cookie: ownerP.cookie });
    expect((await fileGet(id, g.id, { cookie: ownerP.cookie })).status).toBe(404);
  });

  it("stops serving when the declaration is dropped or the switch is off, and serves again when it is back", async () => {
    const { owner, id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    expect(
      (await fileGet(id, f.id, { cookie: ownerP.cookie, vars: { ALLOW_FILES: "false" } })).status,
    ).toBe(404);
    const put = (html: string, base: number) =>
      call(`/api/v1/artifacts/${id}`, {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html, base_version: base }),
      });
    expect((await put(DATA_ONLY, 1)).status).toBe(200);
    expect((await fileGet(id, f.id, { cookie: ownerP.cookie })).status).toBe(404);
    // Old version URLs follow the current declaration too.
    expect((await put(PUBLIC_PAGE, 2)).status).toBe(200);
    expect((await fileGet(id, f.id, { cookie: ownerP.cookie })).status).toBe(200);
  });

  it("answers 404 after a takedown, 401 inside a frame without a pass, and 404 to a preview or capture pass", async () => {
    const { id, ownerP } = await setup();
    const f = await upload(id, ownerP, png(), "image/png");
    const noPass = await fileGet(id, f.id, { headers: { "sec-fetch-dest": "iframe" } });
    expect(noPass.status).toBe(401);
    const c = config();
    const name = contentCookieName(c, new URL(contentOrigin(id)));
    const preview = await signContentCookie(c, id, await epochOf(id), undefined, "preview", 1);
    expect((await fileGet(id, f.id, { cookie: `${name}=${preview}` })).status).toBe(404);
    // A thumbnail capture never reads files: a thumbnail and a link preview outlive a deleted file.
    const capture = await signContentCookie(c, id, await epochOf(id), undefined, "capture");
    expect((await fileGet(id, f.id, { cookie: `${name}=${capture}` })).status).toBe(404);
    await takeDown(id);
    expect((await fileGet(id, f.id, { cookie: ownerP.cookie })).status).toBe(404);
  });
});

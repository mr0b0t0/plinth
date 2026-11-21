// Design export: GET /api/v1/artifacts/:ref/export (a PNG of one artboard or a PDF) and
// /export/options (the boards). A fake browser replaces Browser Rendering
// (setDesignExportShooter); a stub BROWSER binding turns the feature on. Checked here: who may
// export (view rights, strangers 404), the type check, the switch and the binding, input
// validation, the pixel cap, the hourly limit, what the browser is asked to open (a thumbnail's
// capture pass bound to the exported version, no identity, no shared data for a version a token
// limited to one artifact wrote, and every request held to the capture's scope), how the browser
// reaches the export layout (print media as the page boots, nothing in the URL), the response
// headers and file names, a failed render, the app config flag and the env vars.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DESIGN_EXPORT,
  DESIGN_EXPORT_LAYOUT_SCRIPT,
  designExportKeepOnlyScript,
  designExportLoadedScript,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, designExportActive, getConfig, parseConfig } from "../src/config.ts";
import { verifyContentCookie, verifyEnterToken } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import { peek } from "../src/lib/ratelimit.ts";
import {
  base64Size,
  browserExport,
  claimExportSlot,
  decodeBase64,
  EXPORT_INSTANCE_KEY,
  EXPORT_RUN,
  type ExportBytes,
  type ExportJob,
  ExportOverPixels,
  ExportTooLarge,
  exportArtifactKey,
  exportFileName,
  exportRateKey,
  redactUrls,
  releaseExportSlot,
  runShooter,
  setDesignExportLauncher,
  setDesignExportShooter,
  stepTimeout,
} from "../src/services/designExport.ts";
import { captureRequestAllowed, captureScope } from "../src/services/thumbnails.ts";
import { APP, agent, browserSession, createToken, createUser, json, publish } from "./helpers.ts";

const ON = { BROWSER: {} as Fetcher };

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/** `n` bytes that do not repeat in any short pattern. */
function bytesOf(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 2463534242;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

const DESIGN = [
  "<title>Launch kit</title>",
  '<!-- artboard id="home" name="Home" size="iphone" section="Mobile" -->',
  "<main><h1>Ship faster</h1></main>",
  '<!-- artboard id="post" name="Launch post" size="instagram-post" -->',
  "<div>Now live</div>",
  '<!-- artboard id="mrec" name="Ad 300x250" width="300" height="250" -->',
  "<a href='https://example.com'>Try it</a>",
].join("\n");
const BIG = [
  '<!-- artboard id="poster" name="Poster" width="4096" height="4096" -->',
  "<div>Big</div>",
].join("\n");

let jobs: ExportJob[] = [];
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
      headers: { "cf-connecting-ip": `203.0.113.${ip % 250}`, ...init.headers },
    }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function publishDesign(
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<{ id: string; slug: string }> {
  const r = await publish(auth, {
    html: undefined,
    type: "design",
    content: DESIGN,
    visibility: undefined,
    ...body,
  });
  expect(r.res.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

const exportUrl = (ref: string, q: string) => `/api/v1/artifacts/${ref}/export?${q}`;

/** A rendered file's bytes, from one array or its pieces. */
function joined(file: ExportBytes): Uint8Array {
  const pieces = file instanceof Uint8Array ? [file] : file;
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** This hour's count on an export counter. */
const counted = (key: string) => peek(env.DB, key, 3600);

beforeEach(async () => {
  // The instance's and the artifacts' hourly counters are shared by every test in this file.
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1 OR key LIKE ?2")
    .bind(EXPORT_INSTANCE_KEY, `${exportArtifactKey("")}%`)
    .run();
  jobs = [];
  setDesignExportShooter(async (_browser, job) => {
    jobs.push(job);
    return job.format === "png" ? PNG_BYTES : PDF_BYTES;
  });
});
afterEach(() => setDesignExportShooter(null));

describe("export options", () => {
  it("lists a version's boards for anyone who may view it, and 404s for anyone else", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const res = await run(`/api/v1/artifacts/${d.id}/export/options`, { headers: a.auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      id: d.id,
      version: 1,
      boards: [
        { id: "home", name: "Home", width: 393, height: 852, auto_height: false },
        { id: "post", name: "Launch post", width: 1080, height: 1080, auto_height: false },
        { id: "mrec", name: "Ad 300x250", width: 300, height: 250, auto_height: false },
      ],
      max_pixels: DESIGN_EXPORT.maxPixels,
    });
    // Without the binding the boards are still listed (the app offers no export there).
    const off = await run(`/api/v1/artifacts/${d.id}/export/options`, { headers: a.auth }, {});
    expect(off.status).toBe(200);
    expect((await json(off)).boards).toHaveLength(3);

    const stranger = await agent();
    const denied = await run(`/api/v1/artifacts/${d.id}/export/options`, {
      headers: stranger.auth,
    });
    expect(denied.status).toBe(404);
    // Signed out, a private design answers as viewing it would: shared with specific people.
    const anonymous = await run(`/api/v1/artifacts/${d.id}/export/options`);
    expect(anonymous.status).toBe(403);
    expect((await json(anonymous)).error.details.reason).toBe("email_required");
  });

  it("reads the version asked for, and answers 404 for another type or a missing version", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const up = await run(
      `/api/v1/artifacts/${d.id}`,
      {
        method: "PUT",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: '<!-- artboard id="only" name="Only" size="og-image" -->\n<p>v2</p>',
          base_version: 1,
        }),
      },
      {},
    );
    expect(up.status, await up.clone().text()).toBe(200);
    const v2 = await json(
      await run(`/api/v1/artifacts/${d.id}/export/options`, { headers: a.auth }),
    );
    expect(v2.version).toBe(2);
    expect(v2.boards.map((b: { id: string }) => b.id)).toEqual(["only"]);
    const v1 = await json(
      await run(`/api/v1/artifacts/${d.id}/export/options?version=1`, { headers: a.auth }),
    );
    expect(v1.boards).toHaveLength(3);
    const missing = await run(`/api/v1/artifacts/${d.id}/export/options?version=9`, {
      headers: a.auth,
    });
    expect(missing.status).toBe(404);

    const page = await publish(a.auth);
    const html = await run(`/api/v1/artifacts/${page.body.id}/export/options`, {
      headers: a.auth,
    });
    expect(html.status).toBe(404);
    expect((await json(html)).error.code).toBe("not_found");
  });
});

describe("export", () => {
  it("renders one board as PNG with a thumbnail's capture pass for the exact version", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const res = await run(exportUrl(d.id, "format=png&board=home&scale=2"), { headers: a.auth });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${d.slug}-home.png"`,
    );
    expect(res.headers.get("Content-Length")).toBe(String(PNG_BYTES.byteLength));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");

    expect(jobs).toHaveLength(1);
    const job = jobs[0] as ExportJob;
    expect(job.format).toBe("png");
    expect(job.board).toBe("home");
    expect(job.boards).toBe(1);
    expect(job.viewport).toEqual({ width: 393, height: 852, deviceScaleFactor: 2 });
    const url = new URL(job.url);
    expect(url.host).toBe(`${d.id}.content.localhost:8787`);
    expect(url.pathname).toBe("/__plinth/enter");
    // The version's own path and nothing else: no query selects the export layout.
    expect(url.searchParams.getAll("next")).toEqual(["/__plinth/v/1/"]);
    // A capture pass: no identity, the page sees a signed-out viewer, never the person exporting.
    // It is bound to the exported version and reads shared data (an unbound token wrote it).
    const config = getConfig(env as never);
    const token = await verifyEnterToken(config, url.searchParams.get("t") as string);
    expect(token?.a).toBe(d.id);
    expect(token?.c).toBe(1);
    expect(token?.v).toBe(1);
    expect(token?.x).toBeUndefined();
    expect(token?.d).toBeUndefined();
    // The boards' cookie partition gets the same capture pass, never in a URL.
    for (const c of job.cookies) {
      expect(c.url).toBe(`http://${d.id}.content.localhost:8787/`);
      expect(job.url).not.toContain(c.value);
      const pass = await verifyContentCookie(config, c.value);
      expect(pass?.c).toBe(1);
      expect(pass?.v).toBe(1);
      expect(pass?.x).toBeUndefined();
    }
    // Every request the page makes is held to the capture's scope for this version.
    expect(job.scope).toEqual(captureScope(config, d.id, 1, "design"));
    expect(job.scope.frame).toBe("/__plinth/frames/design/board.html");
    expect(captureRequestAllowed(job.scope, job.url, true)).toBe(true);
    expect(
      captureRequestAllowed(job.scope, `http://${d.id}.content.localhost:8787/__plinth/v/2/`, true),
    ).toBe(false);
  });

  it("reads no shared data for a version a token limited to this artifact wrote", async () => {
    const owner = await agent();
    const d = await publishDesign(owner.auth);
    const ci = await createToken(owner.user.id, {
      scopes: "artifacts:read artifacts:write",
      artifactId: d.id,
    });
    const up = await run(
      `/api/v1/artifacts/${d.id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${ci.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: DESIGN.replace("Ship faster", "Ship"), base_version: 1 }),
      },
      {},
    );
    expect(up.status, await up.clone().text()).toBe(200);
    const config = getConfig(env as never);
    for (const version of [1, 2]) {
      const res = await run(exportUrl(d.id, `format=pdf&version=${version}`), {
        headers: owner.auth,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const passes = await Promise.all(
      jobs.map(async (job) => {
        const url = new URL(job.url);
        return {
          next: url.searchParams.get("next"),
          enter: (await verifyEnterToken(config, url.searchParams.get("t") ?? ""))?.d,
          frame: (await verifyContentCookie(config, job.cookies[0]?.value ?? ""))?.d,
        };
      }),
    );
    expect(passes).toEqual([
      { next: "/__plinth/v/1/", enter: undefined, frame: undefined },
      { next: "/__plinth/v/2/", enter: 1, frame: 1 },
    ]);
  });

  it("renders every board as one PDF, or only the board named", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const all = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
    expect(all.status, await all.clone().text()).toBe(200);
    expect(all.headers.get("Content-Type")).toBe("application/pdf");
    expect(all.headers.get("Content-Disposition")).toBe(`attachment; filename="${d.slug}.pdf"`);
    expect(new Uint8Array(await all.arrayBuffer())).toEqual(PDF_BYTES);
    const one = await run(exportUrl(d.id, "format=pdf&board=post&version=1"), { headers: a.auth });
    expect(one.status).toBe(200);
    expect(one.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${d.slug}-post.pdf"`,
    );
    const [every, single] = jobs as [ExportJob, ExportJob];
    expect(every.board).toBeNull();
    expect(every.boards).toBe(3);
    expect(every.viewport).toEqual({ width: 1080, height: 1080, deviceScaleFactor: 1 });
    expect(new URL(every.url).searchParams.get("next")).toBe("/__plinth/v/1/");
    expect(single.boards).toBe(1);
    expect(single.board).toBe("post");
    // One board is the export's own choice, made in its browser: the page it opens is the same.
    expect(new URL(single.url).searchParams.get("next")).toBe("/__plinth/v/1/");
  });

  it("is for anyone who may view: a signed-in collaborator, a link viewer; strangers get 404", async () => {
    const a = await agent();
    const linked = await publishDesign(a.auth, { visibility: "unlisted" });
    const anonymous = await run(exportUrl(linked.id, "format=png&board=mrec"));
    expect(anonymous.status, await anonymous.clone().text()).toBe(200);

    const priv = await publishDesign(a.auth);
    const stranger = await createUser();
    const session = await browserSession(stranger.id);
    const denied = await run(exportUrl(priv.id, "format=png&board=mrec"), {
      headers: { Cookie: session.cookie },
    });
    expect(denied.status).toBe(404);
    // The query is checked after access: a bad one still gets the stranger's 404, never a 400.
    for (const q of ["", "format=jpeg&scale=9"]) {
      const res = await run(exportUrl(priv.id, q), { headers: { Cookie: session.cookie } });
      expect(res.status, q).toBe(404);
    }
    const badOptions = await run(`/api/v1/artifacts/${priv.id}/export/options?version=abc`, {
      headers: { Cookie: session.cookie },
    });
    expect(badOptions.status).toBe(404);
    const nobody = await run(exportUrl(priv.id, "format=pdf"));
    expect(nobody.status).toBe(403);
    expect((await json(nobody)).error.details.reason).toBe("email_required");
    // The owner's own session works too (the app's download link).
    const owner = await browserSession(a.user.id);
    const mine = await run(exportUrl(priv.id, "format=pdf"), {
      headers: { Cookie: owner.cookie },
    });
    expect(mine.status).toBe(200);
    expect(jobs).toHaveLength(2);
  });

  it("is off without the BROWSER binding or with DESIGN_EXPORT off, after the access check", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    for (const vars of [{}, { ...ON, DESIGN_EXPORT: "false" }]) {
      const res = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.error.code).toBe("feature_disabled");
      expect(body.error.message).toContain("Print or save as PDF");
    }
    // A stranger still learns nothing.
    const stranger = await agent();
    const res = await run(exportUrl(d.id, "format=pdf"), { headers: stranger.auth }, {});
    expect(res.status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it("refuses an artifact of another type with 404", async () => {
    const a = await agent();
    const page = await publish(a.auth);
    const res = await run(exportUrl(page.body.id, "format=pdf"), { headers: a.auth });
    expect(res.status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it("checks the format, board and scale with fix-it messages", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const cases: [string, string | RegExp][] = [
      ["", /./],
      ["format=jpeg", /./],
      ["format=png", /add board=<id> \(one of home, post, mrec\)/],
      ["format=png&board=nope", /no artboard "nope"; its boards are home, post, mrec/],
      ["format=png&board=Home!", /./],
      ["format=png&board=home&scale=3", /./],
      ["format=png&board=home&scale=two", /./],
      ["format=pdf&scale=2", /scale is for PNG/],
      ["format=pdf&version=0", /./],
    ];
    for (const [q, message] of cases) {
      const res = await run(exportUrl(d.id, q), { headers: a.auth });
      expect(res.status, q).toBe(400);
      const body = await json(res);
      expect(body.error.code, q).toBe("invalid_input");
      expect(body.error.message, q).toMatch(message);
    }
    const missing = await run(exportUrl(d.id, "format=pdf&version=4"), { headers: a.auth });
    expect(missing.status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it("caps a PNG at the pixel limit, so even one that does not compress fits the byte cap", async () => {
    // A PNG is at most about 4 bytes a pixel (RGBA noise), plus a filter byte a row.
    const worst = (px: number, rows: number) => px * 4 + rows + 65_536;
    expect(worst(DESIGN_EXPORT.maxPixels, 8192)).toBeLessThan(DESIGN_EXPORT.maxBytes);
    const a = await agent();
    const d = await publishDesign(a.auth, {
      content: ['<!-- artboard id="hd" name="HD" size="desktop-hd" -->', "<div>HD</div>", BIG].join(
        "\n",
      ),
    });
    // 1920x1080 at 2x is 8,294,400 device pixels: 1x only.
    const twice = await run(exportUrl(d.id, "format=png&board=hd&scale=2"), { headers: a.auth });
    expect(twice.status).toBe(400);
    const body = await json(twice);
    expect(body.error.message).toMatch(/3840x2160 px, over the 4,000,000 pixel limit: use scale=1/);
    expect(body.error.details.max_pixels).toBe(DESIGN_EXPORT.maxPixels);
    const once = await run(exportUrl(d.id, "format=png&board=hd"), { headers: a.auth });
    expect(once.status).toBe(200);
    expect(jobs[0]?.viewport).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    expect(jobs[0]?.maxBytes).toBe(DESIGN_EXPORT.maxBytes);
    // A 4096 px board is over the limit at 1x too: it downloads as a PDF.
    const poster = await run(exportUrl(d.id, "format=png&board=poster"), { headers: a.auth });
    expect(poster.status).toBe(400);
    expect((await json(poster)).error.message).toMatch(
      /4096x4096 px, over the 4,000,000 pixel limit: use format=pdf/,
    );
    const pdf = await run(exportUrl(d.id, "format=pdf&board=poster"), { headers: a.auth });
    expect(pdf.status).toBe(200);
    expect(jobs).toHaveLength(2);
  });

  it("lists a fluid board's least height, and refuses one that rendered past the pixel cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const a = await agent();
      const d = await publishDesign(a.auth, {
        content:
          '<!-- artboard id="site" name="Site" size="desktop" height="auto" -->\n<main>Hi</main>',
      });
      const options = await json(
        await run(`/api/v1/artifacts/${d.id}/export/options`, { headers: a.auth }),
      );
      expect(options.boards).toEqual([
        { id: "site", name: "Site", width: 1440, height: 900, auto_height: true },
      ]);
      // Only the render knows how tall it grew.
      setDesignExportShooter(async (_b, job) => {
        jobs.push(job);
        throw new ExportOverPixels(1440, 3000);
      });
      const png = await run(exportUrl(d.id, "format=png&board=site"), { headers: a.auth });
      expect(png.status).toBe(400);
      const body = await json(png);
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.message).toBe(
        "This board rendered at 1440x3000 px, over the 4,000,000 pixel limit for a PNG: use format=pdf",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a file over the byte cap with 413, and says what to change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const a = await agent();
      const d = await publishDesign(a.auth);
      // The browser's file passed the cap while it was read.
      setDesignExportShooter(async (_b, job) => {
        jobs.push(job);
        throw new ExportTooLarge(job.maxBytes);
      });
      const all = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
      expect(all.status).toBe(413);
      const body = await json(all);
      expect(body.error.code).toBe("payload_too_large");
      expect(body.error.message).toBe(
        "This PDF would be over 24 MB, the largest export: download the boards one at a time (board=<id>)",
      );
      expect(body.error.details.max_bytes).toBe(DESIGN_EXPORT.maxBytes);
      const png = await run(exportUrl(d.id, "format=png&board=home&scale=2"), {
        headers: a.auth,
      });
      expect(png.status).toBe(413);
      expect((await json(png)).error.message).toBe(
        "This PNG would be over 24 MB, the largest export: use scale=1",
      );
      // A shooter that hands back more than the cap is refused as well, never sent.
      setDesignExportShooter(async (_b, job) => new Uint8Array(job.maxBytes + 1));
      const big = await run(exportUrl(d.id, "format=pdf&board=post"), { headers: a.auth });
      expect(big.status).toBe(413);
      expect((await json(big)).error.message).toBe(
        "This PDF would be over 24 MB, the largest export",
      );
      // Every slot was given back.
      setDesignExportShooter(async () => PDF_BYTES);
      const keys: (string | null)[] = [];
      for (let i = 0; i < DESIGN_EXPORT.maxConcurrent; i++)
        keys.push(await claimExportSlot(env.DB));
      expect(keys.every((k) => k !== null)).toBe(true);
      for (const k of keys) if (k) await releaseExportSlot(env.DB, k);
      expect((await run(exportUrl(d.id, "format=pdf"), { headers: a.auth })).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  it("limits exports per person per hour (DESIGN_EXPORTS_PER_HOUR), refused ones not counted", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const vars = { ...ON, DESIGN_EXPORTS_PER_HOUR: "2" };
    // A refused request (bad input) spends nothing.
    const bad = await run(exportUrl(d.id, "format=png"), { headers: a.auth }, vars);
    expect(bad.status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const ok = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
      expect(ok.status).toBe(200);
    }
    const over = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
    expect(over.status).toBe(429);
    const body = await json(over);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("Export limit reached (2 per hour)");
    expect(jobs).toHaveLength(2);
    // Another person has their own budget.
    const b = await agent();
    const theirs = await publishDesign(b.auth);
    const other = await run(exportUrl(theirs.id, "format=pdf"), { headers: b.auth }, vars);
    expect(other.status).toBe(200);
  });

  it("answers 503 when the render fails, and logs no URL or token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setDesignExportShooter(async (_b, job) => {
        throw new Error(`net::ERR_TIMED_OUT at ${job.url}`);
      });
      const a = await agent();
      const d = await publishDesign(a.auth);
      const res = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
      expect(res.status).toBe(503);
      expect((await json(res)).error.code).toBe("unavailable");
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(`design export failed for ${d.id} v1`);
      expect(logged).not.toMatch(/https?:\/\//);
      expect(logged).not.toContain("t=");
      // An empty file is a failure too.
      setDesignExportShooter(async () => new Uint8Array());
      const empty = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
      expect(empty.status).toBe(503);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tokens limited to one artifact", () => {
  it("get 403 token_bound from the export and its options; the owner's own token still exports", async () => {
    const owner = await agent();
    const d = await publishDesign(owner.auth);
    const ci = await createToken(owner.user.id, {
      scopes: "artifacts:read artifacts:write",
      artifactId: d.id,
    });
    const bound = { Authorization: `Bearer ${ci.token}` };
    for (const path of [
      exportUrl(d.id, "format=pdf"),
      exportUrl(d.id, "format=png&board=home"),
      `/api/v1/artifacts/${d.id}/export/options`,
    ]) {
      const res = await run(path, { headers: bound });
      expect(res.status, path).toBe(403);
      const body = await json(res);
      expect(body.error.code, path).toBe("forbidden");
      expect(body.error.details.reason, path).toBe("token_bound");
    }
    // Any other artifact does not exist for it.
    const other = await publishDesign(owner.auth);
    expect((await run(exportUrl(other.id, "format=pdf"), { headers: bound })).status).toBe(404);
    // Nothing rendered and nothing counted.
    expect(jobs).toHaveLength(0);
    expect(await counted(EXPORT_INSTANCE_KEY)).toBe(0);

    const mine = await run(exportUrl(d.id, "format=pdf"), { headers: owner.auth });
    expect(mine.status, await mine.clone().text()).toBe(200);
    const options = await run(`/api/v1/artifacts/${d.id}/export/options`, {
      headers: owner.auth,
    });
    expect(options.status).toBe(200);
    expect(jobs).toHaveLength(1);
  });
});

describe("the instance's and an artifact's hourly limits", () => {
  it("DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR bounds every export on the instance, whoever asks", async () => {
    const vars = { ...ON, DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR: "2" };
    const people = [await agent(), await agent(), await agent()];
    const designs = [];
    for (const p of people) designs.push(await publishDesign(p.auth));
    for (const i of [0, 1]) {
      const ok = await run(
        exportUrl(designs[i]?.id ?? "", "format=pdf"),
        { headers: people[i]?.auth },
        vars,
      );
      expect(ok.status, await ok.clone().text()).toBe(200);
    }
    const over = await run(
      exportUrl(designs[2]?.id ?? "", "format=pdf"),
      { headers: people[2]?.auth },
      vars,
    );
    expect(over.status).toBe(429);
    const body = await json(over);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details.reason).toBe("instance_limit");
    expect(body.error.message).toBe(
      "This instance's export limit is reached (2 per hour); try again later",
    );
    const retry = Number(over.headers.get("Retry-After"));
    expect(retry).toBe(body.error.details.retry_after);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
    // Refused before the browser and before any counter was raised.
    expect(jobs).toHaveLength(2);
    expect(await counted(EXPORT_INSTANCE_KEY)).toBe(2);
    expect(await counted(`design-export:u:${people[2]?.user.id}`)).toBe(0);
  });

  it("DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR bounds one artifact's exports by anyone but its owner and editors", async () => {
    const vars = { ...ON, DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR: "2" };
    const owner = await agent();
    const d = await publishDesign(owner.auth, { visibility: "unlisted" });
    // Signed out, from three networks, each well within its own hourly limit.
    const from = (addr: string) =>
      run(exportUrl(d.id, "format=pdf"), { headers: { "cf-connecting-ip": addr } }, vars);
    expect((await from("198.51.100.1")).status).toBe(200);
    expect((await from("198.51.100.2")).status).toBe(200);
    const over = await from("198.51.100.3");
    expect(over.status).toBe(429);
    const body = await json(over);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details.reason).toBe("artifact_limit");
    expect(body.error.message).toBe(
      "This design's export limit is reached (2 per hour); try again later",
    );
    expect(Number(over.headers.get("Retry-After"))).toBe(body.error.details.retry_after);
    // More refusals spend nothing: not the instance's budget, not the network's.
    for (let i = 0; i < 5; i++) expect((await from(`198.51.100.${10 + i}`)).status).toBe(429);
    expect(await counted(EXPORT_INSTANCE_KEY)).toBe(2);
    expect(await counted(exportArtifactKey(d.id))).toBe(2);
    expect(await counted("design-export:ip:198.51.100.3")).toBe(0);
    // The owner still exports, and does not count toward the artifact's limit.
    const mine = await run(exportUrl(d.id, "format=pdf"), { headers: owner.auth }, vars);
    expect(mine.status, await mine.clone().text()).toBe(200);
    expect(await counted(exportArtifactKey(d.id))).toBe(2);
    expect(await counted(EXPORT_INSTANCE_KEY)).toBe(3);
    // Another artifact has its own limit.
    const other = await publishDesign(owner.auth, { visibility: "unlisted" });
    const theirs = await run(
      exportUrl(other.id, "format=pdf"),
      { headers: { "cf-connecting-ip": "198.51.100.40" } },
      vars,
    );
    expect(theirs.status).toBe(200);
    expect(jobs).toHaveLength(4);
  });

  it("reserves before rendering and gives nothing back when the render fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const vars = { ...ON, DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR: "1" };
      const a = await agent();
      const d = await publishDesign(a.auth);
      let counts: number[] = [];
      setDesignExportShooter(async () => {
        // The browser starts only once every counter holds this export.
        counts = [
          await counted(EXPORT_INSTANCE_KEY),
          await counted(`design-export:u:${a.user.id}`),
        ];
        throw new Error("browser crashed");
      });
      const failed = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
      expect(failed.status).toBe(503);
      expect(counts).toEqual([1, 1]);
      setDesignExportShooter(async () => PDF_BYTES);
      const next = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
      expect(next.status).toBe(429);
      expect((await json(next)).error.details.reason).toBe("instance_limit");
    } finally {
      warn.mockRestore();
    }
  });

  it("parse with their defaults and bounds, and ship in wrangler.jsonc at the defaults", () => {
    const base = {
      ENVIRONMENT: "production",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "plinth-content.example.net",
      PUBLIC_SCHEME: "https",
      EMAIL_PROVIDER: "sendgrid",
      SENDGRID_API_KEY: "SG.x",
      SESSION_SECRET: "s".repeat(40),
      TOKEN_SIGNING_KEY: "t".repeat(40),
    };
    const c = parseConfig(base);
    expect(c.designExportsPerInstancePerHour).toBe(120);
    expect(c.designExportsPerArtifactPerHour).toBe(20);
    const empty = parseConfig({
      ...base,
      DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR: "",
      DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR: "",
    });
    expect(empty.designExportsPerInstancePerHour).toBe(120);
    expect(empty.designExportsPerArtifactPerHour).toBe(20);
    for (const [name, max] of [
      ["DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR", 100_000],
      ["DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR", 10_000],
    ] as const) {
      const field =
        name === "DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR"
          ? "designExportsPerInstancePerHour"
          : "designExportsPerArtifactPerHour";
      for (const v of ["1", String(max)]) {
        expect(parseConfig({ ...base, [name]: v })[field], v).toBe(Number(v));
      }
      for (const v of ["0", String(max + 1), "-1", "1.5", "lots"]) {
        expect(() => parseConfig({ ...base, [name]: v }), `${name}=${v}`).toThrow(
          new RegExp(`${name} must be an integer from 1 to ${max}`),
        );
      }
    }
    const vars = env as unknown as Record<string, unknown>;
    expect(vars.DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR).toBe(
      String(DESIGN_EXPORT.perInstancePerHour),
    );
    expect(vars.DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR).toBe(
      String(DESIGN_EXPORT.perArtifactPerHour),
    );
  });
});

describe("a PDF in pieces", () => {
  it("is sent piece after piece with its exact length, never joined first", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const pieces = [bytesOf(1000), bytesOf(2000), bytesOf(5)];
    setDesignExportShooter(async () => pieces);
    const res = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("3005");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(joined(pieces));
  });

  it("is refused with 413 when the pieces together pass the cap", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    setDesignExportShooter(async (_b, job) => [new Uint8Array(job.maxBytes), new Uint8Array(1)]);
    const res = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("payload_too_large");
  });
});

describe("the signed-out limit", () => {
  it("counts an IPv6 /64 as one client, so new addresses in it get no new budget", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth, { visibility: "unlisted" });
    const vars = { ...ON, DESIGN_EXPORTS_PER_HOUR: "1" };
    const from = (addr: string) =>
      run(exportUrl(d.id, "format=pdf"), { headers: { "cf-connecting-ip": addr } }, vars);
    expect((await from("2001:db8:7:8::1")).status).toBe(200);
    const sibling = await from("2001:db8:7:8:ffff:1:2:3");
    expect(sibling.status).toBe(429);
    expect((await json(sibling)).error.code).toBe("rate_limited");
    // Another /64 is another client; an IPv4-mapped address counts as its IPv4 address.
    expect((await from("2001:db8:7:9::1")).status).toBe(200);
    expect((await from("198.51.100.7")).status).toBe(200);
    expect((await from("::ffff:198.51.100.7")).status).toBe(429);
    expect(jobs).toHaveLength(3);
  });

  it("keys a person by id, a viewer by email, and signed out by network", () => {
    const anon = { kind: "anonymous" } as const;
    expect(exportRateKey({ principal: anon, ip: "2001:db8:1:2:3:4:5:6" })).toBe(
      "design-export:ip:2001:db8:1:2::/64",
    );
    expect(exportRateKey({ principal: anon, ip: "203.0.113.9" })).toBe(
      "design-export:ip:203.0.113.9",
    );
    expect(exportRateKey({ principal: anon, ip: null })).toBe("design-export:ip:unknown");
    expect(exportRateKey({ principal: { kind: "viewer", email: "v@example.com" }, ip: "x" })).toBe(
      "design-export:e:v@example.com",
    );
  });
});

describe("export slots", () => {
  it("renders at most DESIGN_EXPORT.maxConcurrent at once; a busy answer is 503 and not counted", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth);
    const max = DESIGN_EXPORT.maxConcurrent;
    const vars = { ...ON, DESIGN_EXPORTS_PER_HOUR: String(max + 1) };
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    setDesignExportShooter(async (_b, job) => {
      jobs.push(job);
      await gate;
      return PDF_BYTES;
    });
    const exportPdf = () => run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
    const held = Array.from({ length: max }, exportPdf);
    try {
      await vi.waitFor(() => expect(jobs).toHaveLength(max));
      const busy = await exportPdf();
      expect(busy.status).toBe(503);
      expect(busy.headers.get("Retry-After")).toBe(String(EXPORT_RUN.busyRetryAfterS));
      const body = await json(busy);
      expect(body.error.code).toBe("unavailable");
      expect(body.error.message).toMatch(/Other exports are rendering right now/);
      expect(jobs).toHaveLength(max);
    } finally {
      open();
    }
    for (const res of await Promise.all(held)) expect(res.status).toBe(200);
    // The slots are back, and the busy answer spent nothing: one more fits the hour, then 429.
    expect((await exportPdf()).status).toBe(200);
    expect((await exportPdf()).status).toBe(429);
    expect(jobs).toHaveLength(max + 1);
  });

  it("gives the slot back after a failed render and after a refusal over the limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const a = await agent();
      const d = await publishDesign(a.auth);
      const vars = { ...ON, DESIGN_EXPORTS_PER_HOUR: "1" };
      setDesignExportShooter(async () => {
        throw new Error("browser busy");
      });
      expect((await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars)).status).toBe(
        503,
      );
      for (let i = 0; i < 3; i++) {
        const over = await run(exportUrl(d.id, "format=pdf"), { headers: a.auth }, vars);
        expect(over.status).toBe(429);
      }
      const keys = [await claimExportSlot(env.DB), await claimExportSlot(env.DB)];
      try {
        expect(keys.every((k) => k !== null)).toBe(true);
        expect(await claimExportSlot(env.DB)).toBeNull();
      } finally {
        for (const k of keys) if (k) await releaseExportSlot(env.DB, k);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("lets a lease go stale when it was never given back", async () => {
    const now = Date.now();
    const old = [await claimExportSlot(env.DB, now), await claimExportSlot(env.DB, now)];
    const later = now + (EXPORT_RUN.slotStaleS + 1) * 1000;
    let fresh: string | null = null;
    try {
      expect(old.every((k) => k !== null)).toBe(true);
      expect(await claimExportSlot(env.DB, now)).toBeNull();
      fresh = await claimExportSlot(env.DB, later);
      expect(fresh).not.toBeNull();
    } finally {
      for (const k of [...old, fresh]) if (k) await releaseExportSlot(env.DB, k);
    }
  });

  it("aborts a render past its budget, and settles only once the shooter has", async () => {
    let aborted = false;
    let finish: () => void = () => undefined;
    const { result, settled } = runShooter(
      (_b, _job, signal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            finish = () => reject(new Error("browser closed"));
          });
        }),
      ON.BROWSER,
      {} as ExportJob,
      20,
    );
    await expect(result).rejects.toThrow(/longer than 20 ms/);
    expect(aborted).toBe(true);
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    finish();
    await settled;
    expect(done).toBe(true);
  });
});

describe("the browser's steps", () => {
  type Calls = {
    timeouts: Record<string, number>;
    waitUntil?: string;
    closed: number;
    pdf: number;
    /** The printToPDF options, and each IO.read's size; IO.close calls by handle. */
    printOptions?: Record<string, unknown>;
    reads: number[];
    ioClosed: string[];
    /** The screenshot's options. */
    shotOptions?: Record<string, unknown>;
    /** Every page call in order, by name (media types as media:<type>). */
    steps: string[];
    evaluated: string[];
    waitedFor: string[];
    requestHandler?: (req: {
      url(): string;
      isNavigationRequest(): boolean;
      isInterceptResolutionHandled(): boolean;
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => void;
  };

  /**
   * A fake puppeteer browser on a fake clock: launch 3 s, the document 9 s, boards never load.
   * `layout` is whether the page took the export layout; `board` whether the one board is there;
   * `pdf` and `png` the files the browser makes (a PDF is read from a DevTools stream in pieces).
   */
  function fakeBrowser(
    clock: { t: number },
    hangGoto = false,
    page$: { layout?: boolean; board?: boolean; pdf?: Uint8Array; png?: Uint8Array } = {},
  ) {
    const calls: Calls = {
      timeouts: {},
      closed: 0,
      pdf: 0,
      reads: [],
      ioClosed: [],
      steps: [],
      evaluated: [],
      waitedFor: [],
    };
    const pdfFile = page$.pdf ?? PDF_BYTES;
    let pdfAt = 0;
    let rejectGoto: (e: Error) => void = () => undefined;
    const page = {
      setRequestInterception: async (on: boolean) => {
        calls.steps.push(`intercept:${on}`);
      },
      on: (event: string, handler: Calls["requestHandler"]) => {
        calls.steps.push(`on:${event}`);
        if (event === "request") calls.requestHandler = handler;
      },
      createCDPSession: async () => ({
        send: async (method: string, params: Record<string, unknown>) => {
          if (method === "Network.setCookie") {
            calls.steps.push("cookie");
            return {};
          }
          if (method === "Page.printToPDF") {
            calls.steps.push("pdf");
            calls.pdf += 1;
            calls.printOptions = params;
            calls.timeouts.printAt = clock.t;
            return { stream: "pdf-stream" };
          }
          if (method === "IO.read") {
            expect(params.handle).toBe("pdf-stream");
            const size = params.size as number;
            calls.reads.push(size);
            const piece = pdfFile.subarray(pdfAt, pdfAt + size);
            pdfAt += piece.byteLength;
            return { data: toBase64(piece), base64Encoded: true, eof: pdfAt >= pdfFile.byteLength };
          }
          if (method === "IO.close") {
            calls.ioClosed.push(params.handle as string);
            return {};
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
      setViewport: async () => undefined,
      emulateMediaFeatures: async () => undefined,
      emulateMediaType: async (type: string) => {
        calls.steps.push(`media:${type}`);
      },
      goto: async (_url: string, o: { waitUntil?: string; timeout?: number }) => {
        calls.steps.push("goto");
        calls.timeouts.goto = o.timeout ?? -1;
        calls.waitUntil = o.waitUntil;
        if (hangGoto) {
          await new Promise((_r, reject) => {
            rejectGoto = reject;
          });
        }
        clock.t += 9_000;
        return { ok: () => true, status: () => 200, url: () => "" };
      },
      waitForFunction: async (expression: string, o: { timeout?: number }) => {
        calls.waitedFor.push(expression);
        if (expression.includes("data-ready")) {
          calls.timeouts.ready = o.timeout ?? -1;
          return true;
        }
        calls.timeouts.boards = o.timeout ?? -1;
        clock.t += o.timeout ?? 0;
        throw new Error("waiting failed: timeout");
      },
      evaluate: async (expression: string) => {
        calls.evaluated.push(expression);
        if (expression === DESIGN_EXPORT_LAYOUT_SCRIPT) return page$.layout ?? true;
        if (expression.includes("el.remove()")) return page$.board ?? true;
        return "ok";
      },
      $: async () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 250 }) }),
      // Puppeteer's screenshot: base64 when asked for it, else decoded.
      screenshot: async (o: Record<string, unknown>) => {
        calls.steps.push("screenshot");
        calls.shotOptions = o;
        const png = page$.png ?? PNG_BYTES;
        return o.encoding === "base64" ? toBase64(png) : png;
      },
    };
    const browser = {
      newPage: async () => page,
      close: async () => {
        calls.closed += 1;
        rejectGoto(new Error("Target closed"));
      },
    };
    return {
      calls,
      launch: async () => {
        clock.t += 3_000;
        return browser as never;
      },
    };
  }

  const ID = "aaaaaaaaaaaaaaaaaaaa";
  const JOB: ExportJob = {
    format: "pdf",
    url: `http://${ID}.content.localhost:8787/__plinth/enter`,
    cookies: [],
    scope: captureScope(getConfig(env as never), ID, 1, "design"),
    viewport: { width: 300, height: 250, deviceScaleFactor: 1 },
    boards: 3,
    board: null,
    maxBytes: DESIGN_EXPORT.maxBytes,
  };

  afterEach(() => {
    setDesignExportLauncher(null);
    vi.restoreAllMocks();
  });

  it("keep every wait inside the budget, so slow boards still print what loaded", async () => {
    const clock = { t: 1_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    const fake = fakeBrowser(clock);
    setDesignExportLauncher(fake.launch);
    const start = clock.t;
    const bytes = await browserExport(ON.BROWSER, JOB, new AbortController().signal);
    expect(joined(bytes)).toEqual(PDF_BYTES);
    expect(fake.calls.pdf).toBe(1);
    expect(fake.calls.closed).toBe(1);
    // The document, not network idle, so a slow board cannot fail the load.
    expect(fake.calls.waitUntil).toBe("domcontentloaded");
    const printBy = start + EXPORT_RUN.budgetMs - EXPORT_RUN.renderReserveMs;
    expect(fake.calls.timeouts.goto).toBe(EXPORT_RUN.navigationTimeoutMs);
    expect(fake.calls.timeouts.ready).toBe(printBy - (start + 12_000));
    // Launch (3 s) and the document (9 s) took 12 s: the boards get what is left, not 10 s.
    expect(fake.calls.timeouts.boards).toBe(printBy - (start + 12_000));
    expect(fake.calls.timeouts.printAt).toBeLessThanOrEqual(printBy);
  });

  it("close the browser as soon as the render is aborted", async () => {
    const clock = { t: 0 };
    const fake = fakeBrowser(clock, true);
    setDesignExportLauncher(fake.launch);
    const ctrl = new AbortController();
    const shot = browserExport(ON.BROWSER, JOB, ctrl.signal);
    await vi.waitFor(() => expect(fake.calls.timeouts.goto).toBeDefined());
    ctrl.abort();
    await expect(shot).rejects.toThrow(/Target closed/);
    expect(fake.calls.closed).toBeGreaterThanOrEqual(1);
    expect(fake.calls.pdf).toBe(0);
  });

  it("hold every request to the capture's scope and emulate print media before the page opens", async () => {
    const fake = fakeBrowser({ t: 0 });
    setDesignExportLauncher(fake.launch);
    const cookie = { ...(JOB.cookies[0] ?? {}) } as ExportJob["cookies"][number];
    await browserExport(ON.BROWSER, { ...JOB, cookies: [cookie] }, new AbortController().signal);
    const at = (step: string) => fake.calls.steps.indexOf(step);
    expect(at("intercept:true")).toBeGreaterThanOrEqual(0);
    expect(at("intercept:true")).toBeLessThan(at("cookie"));
    expect(at("on:popup")).toBeGreaterThanOrEqual(0);
    expect(at("on:popup")).toBeLessThan(at("goto"));
    expect(at("media:print")).toBeGreaterThanOrEqual(0);
    expect(at("media:print")).toBeLessThan(at("goto"));
    // A PDF prints in print media, every board counted, and nothing removed from the page.
    expect(fake.calls.steps).not.toContain("media:screen");
    expect(fake.calls.evaluated).toContain(DESIGN_EXPORT_LAYOUT_SCRIPT);
    expect(fake.calls.evaluated.some((e) => e.includes("el.remove()"))).toBe(false);
    expect(fake.calls.waitedFor).toContain(designExportLoadedScript(null, 3));
    // The guard the page runs under: its own version and the board loader, nothing else.
    const decide = (url: string, navigation: boolean) => {
      let verdict = "";
      fake.calls.requestHandler?.({
        url: () => url,
        isNavigationRequest: () => navigation,
        isInterceptResolutionHandled: () => false,
        continue: async () => {
          verdict = "continue";
        },
        abort: async () => {
          verdict = "abort";
        },
      });
      return verdict;
    };
    const own = `http://${ID}.content.localhost:8787`;
    expect(decide(`${own}/__plinth/v/1/`, true)).toBe("continue");
    expect(decide(`${own}/__plinth/frames/design/board.html`, true)).toBe("continue");
    expect(decide(`${own}/__plinth/v/2/`, true)).toBe("abort");
    expect(
      decide(`${own}/__plinth/enter?next=%2F__plinth%2Fv%2F1%2F%3Fplinth-print%3D1`, true),
    ).toBe("abort");
    expect(decide("https://evil.example/x.png", false)).toBe("abort");
  });

  it("keep only the one board on the page for it, and take a PNG in screen media", async () => {
    const fake = fakeBrowser({ t: 0 });
    setDesignExportLauncher(fake.launch);
    const bytes = await browserExport(
      ON.BROWSER,
      { ...JOB, format: "png", board: "mrec", boards: 1 },
      new AbortController().signal,
    );
    expect(bytes).toEqual(PNG_BYTES);
    expect(fake.calls.evaluated).toContain(designExportKeepOnlyScript("mrec"));
    expect(fake.calls.waitedFor).toContain(designExportLoadedScript("mrec", 1));
    const at = (step: string) => fake.calls.steps.indexOf(step);
    expect(at("media:print")).toBeGreaterThanOrEqual(0);
    expect(at("media:print")).toBeLessThan(at("goto"));
    expect(at("media:screen")).toBeGreaterThan(at("goto"));
    expect(at("media:screen")).toBeLessThan(at("screenshot"));
  });

  it("refuse a page that did not take the export layout, or lacks the board", async () => {
    for (const [state, message] of [
      [{ layout: false }, /export layout/],
      [{ board: false }, /not on the page/],
    ] as const) {
      const fake = fakeBrowser({ t: 0 }, false, state);
      setDesignExportLauncher(fake.launch);
      await expect(
        browserExport(
          ON.BROWSER,
          { ...JOB, format: "png", board: "mrec", boards: 1 },
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
      expect(fake.calls.steps).not.toContain("screenshot");
      expect(fake.calls.closed).toBe(1);
    }
  });

  it("read a PDF from the browser's stream in 1 MiB pieces, keep them apart, and close the stream", async () => {
    const file = bytesOf(2 * EXPORT_RUN.readChunkBytes + 12_345);
    const fake = fakeBrowser({ t: 0 }, false, { pdf: file });
    setDesignExportLauncher(fake.launch);
    const bytes = await browserExport(ON.BROWSER, JOB, new AbortController().signal);
    expect(joined(bytes)).toEqual(file);
    // The pieces as read, never joined into a second copy of the file.
    expect(Array.isArray(bytes) && bytes.map((p) => p.byteLength)).toEqual([
      EXPORT_RUN.readChunkBytes,
      EXPORT_RUN.readChunkBytes,
      12_345,
    ]);
    expect(fake.calls.reads).toEqual(Array(3).fill(EXPORT_RUN.readChunkBytes));
    expect(fake.calls.ioClosed).toEqual(["pdf-stream"]);
    expect(fake.calls.printOptions).toMatchObject({
      transferMode: "ReturnAsStream",
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0,
      scale: 1,
    });
    expect(fake.calls.closed).toBe(1);
  });

  it("stop reading a PDF as soon as it passes the byte cap, and close the stream", async () => {
    const piece = EXPORT_RUN.readChunkBytes;
    const fake = fakeBrowser({ t: 0 }, false, { pdf: bytesOf(10 * piece) });
    setDesignExportLauncher(fake.launch);
    const shot = browserExport(
      ON.BROWSER,
      { ...JOB, maxBytes: 2 * piece + 1 },
      new AbortController().signal,
    );
    await expect(shot).rejects.toBeInstanceOf(ExportTooLarge);
    // Three pieces passed the cap; the other seven were never read.
    expect(fake.calls.reads).toHaveLength(3);
    expect(fake.calls.ioClosed).toEqual(["pdf-stream"]);
    expect(fake.calls.closed).toBe(1);
  });

  it("check a PNG's size from its base64 before decoding it, and decode it once", async () => {
    const png = bytesOf(1000);
    const board = { ...JOB, format: "png" as const, board: "mrec", boards: 1 };
    const over = fakeBrowser({ t: 0 }, false, { png });
    setDesignExportLauncher(over.launch);
    await expect(
      browserExport(ON.BROWSER, { ...board, maxBytes: 999 }, new AbortController().signal),
    ).rejects.toBeInstanceOf(ExportTooLarge);
    expect(over.calls.shotOptions?.encoding).toBe("base64");
    expect(over.calls.closed).toBe(1);
    const fits = fakeBrowser({ t: 0 }, false, { png });
    setDesignExportLauncher(fits.launch);
    const bytes = await browserExport(
      ON.BROWSER,
      { ...board, maxBytes: 1000 },
      new AbortController().signal,
    );
    expect(bytes).toEqual(png);
  });

  it("size and decode base64, with the runtime's decoder or without it", () => {
    for (const n of [0, 1, 2, 3, 4, 200_001]) {
      const b = bytesOf(n);
      const b64 = toBase64(b);
      expect(base64Size(b64)).toBe(n);
      expect(decodeBase64(b64)).toEqual(b);
    }
    const own = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    try {
      if (own) Reflect.deleteProperty(Uint8Array, "fromBase64");
      for (const n of [0, 1, 2, 65_536 * 3 + 7, 200_001]) {
        const b = bytesOf(n);
        expect(decodeBase64(toBase64(b))).toEqual(b);
      }
    } finally {
      if (own) Object.defineProperty(Uint8Array, "fromBase64", own);
    }
  });

  it("cut a step's timeout to what is left, never below 1 ms", () => {
    expect(stepTimeout(10_000, 20_000, 5_000)).toBe(10_000);
    expect(stepTimeout(10_000, 20_000, 14_000)).toBe(6_000);
    expect(stepTimeout(10_000, 20_000, 25_000)).toBe(1);
  });
});

describe("helpers", () => {
  it("name files from the slug and the board, ASCII letters, digits and - only", () => {
    expect(exportFileName("launch-kit-x1y2", "home", "png")).toBe("launch-kit-x1y2-home.png");
    expect(exportFileName("launch-kit-x1y2", null, "pdf")).toBe("launch-kit-x1y2.pdf");
    expect(exportFileName('a"b/../c', 'x"; y', "png")).toBe("a-b-c-x-y.png");
    expect(exportFileName("", null, "pdf")).toBe("design.pdf");
  });

  it("wait for the one board by its id, or for every board by count", () => {
    expect(designExportLoadedScript("home", 1)).toBe(
      'document.querySelector(".plinth-design__board[data-board=\\"home\\"][data-loaded]") !== null',
    );
    expect(designExportLoadedScript(null, 3)).toBe(
      'Number(document.documentElement.getAttribute("data-boards-loaded") || "0") >= 3',
    );
  });

  it("strip URLs from error messages", () => {
    expect(redactUrls("net::ERR at https://x.example/__plinth/enter?t=abc&next=%2F done")).toBe(
      "net::ERR at <url> done",
    );
  });
});

describe("settings", () => {
  const base = {
    ENVIRONMENT: "production",
    APP_HOST: "plinth.example.com",
    CONTENT_HOST: "plinth-content.example.net",
    PUBLIC_SCHEME: "https",
    EMAIL_PROVIDER: "sendgrid",
    SENDGRID_API_KEY: "SG.x",
    SESSION_SECRET: "s".repeat(40),
    TOKEN_SIGNING_KEY: "t".repeat(40),
  };

  it("default on with 30 exports per hour; empty keeps the defaults", () => {
    const c = parseConfig(base);
    expect(c.designExport).toBe(true);
    expect(c.designExportsPerHour).toBe(30);
    const empty = parseConfig({ ...base, DESIGN_EXPORT: "", DESIGN_EXPORTS_PER_HOUR: "" });
    expect(empty.designExport).toBe(true);
    expect(empty.designExportsPerHour).toBe(30);
  });

  it("read the switch and the limit, and refuse a limit out of bounds", () => {
    for (const off of ["false", "0", "no", "off", "nope"]) {
      expect(parseConfig({ ...base, DESIGN_EXPORT: off }).designExport, off).toBe(false);
    }
    for (const v of ["1", "1000"]) {
      expect(parseConfig({ ...base, DESIGN_EXPORTS_PER_HOUR: v }).designExportsPerHour).toBe(
        Number(v),
      );
    }
    for (const v of ["0", "1001", "-1", "1.5", "lots"]) {
      expect(() => parseConfig({ ...base, DESIGN_EXPORTS_PER_HOUR: v }), v).toThrow(ConfigError);
      expect(() => parseConfig({ ...base, DESIGN_EXPORTS_PER_HOUR: v }), v).toThrow(
        /DESIGN_EXPORTS_PER_HOUR must be an integer from 1 to 1000/,
      );
    }
  });

  it("are active only with the switch and the BROWSER binding", () => {
    expect(designExportActive(parseConfig(base), ON)).toBe(true);
    expect(designExportActive(parseConfig(base), {})).toBe(false);
    expect(designExportActive(parseConfig({ ...base, DESIGN_EXPORT: "false" }), ON)).toBe(false);
  });

  it("reach the web app as design_export in /api/v1/config", async () => {
    expect((await json(await run("/api/v1/config"))).design_export).toBe(true);
    expect((await json(await run("/api/v1/config", {}, {}))).design_export).toBe(false);
    expect(
      (await json(await run("/api/v1/config", {}, { ...ON, DESIGN_EXPORT: "false" })))
        .design_export,
    ).toBe(false);
  });

  it("the shipped wrangler.jsonc lists them with the documented defaults", () => {
    const vars = env as unknown as Record<string, unknown>;
    expect(vars.DESIGN_EXPORT).toBe("true");
    expect(vars.DESIGN_EXPORTS_PER_HOUR).toBe(String(DESIGN_EXPORT.perHour));
  });
});

// Design export: GET /api/v1/artifacts/:ref/export (a PNG of one artboard or a PDF) and
// /export/options (the boards). A fake browser replaces Browser Rendering
// (setDesignExportShooter); a stub BROWSER binding turns the feature on. Checked here: who may
// export (view rights, strangers 404), the type check, the switch and the binding, input
// validation, the pixel cap, the hourly limit, what the browser is asked to open (a capture pass
// at the version's export layout, never an identity), the response headers and file names, a
// failed render, the app config flag and the env vars.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DESIGN_EXPORT } from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, designExportActive, getConfig, parseConfig } from "../src/config.ts";
import { verifyEnterToken } from "../src/content/tokens.ts";
import worker from "../src/index.ts";
import {
  type ExportJob,
  exportFileName,
  exportPath,
  redactUrls,
  setDesignExportShooter,
} from "../src/services/designExport.ts";
import { APP, agent, browserSession, createUser, json, publish } from "./helpers.ts";

const ON = { BROWSER: {} as Fetcher };
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

beforeEach(() => {
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
        { id: "home", name: "Home", width: 393, height: 852 },
        { id: "post", name: "Launch post", width: 1080, height: 1080 },
        { id: "mrec", name: "Ad 300x250", width: 300, height: 250 },
      ],
      formats: ["png", "pdf"],
      scales: [1, 2],
      max_pixels: DESIGN_EXPORT.maxPixels,
      available: true,
    });
    // Without the binding the boards are still listed, and the export says it is unavailable.
    const off = await json(
      await run(`/api/v1/artifacts/${d.id}/export/options`, { headers: a.auth }, {}),
    );
    expect(off.available).toBe(false);

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
  it("renders one board as PNG from the version's export layout with a capture pass", async () => {
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
    expect(url.searchParams.get("next")).toBe("/__plinth/v/1/?plinth-print=1&plinth-board=home");
    // A capture pass: no identity, the page sees a signed-out viewer, never the person exporting.
    const token = await verifyEnterToken(
      getConfig(env as never),
      url.searchParams.get("t") as string,
    );
    expect(token?.a).toBe(d.id);
    expect(token?.c).toBe(1);
    expect(token?.x).toBeUndefined();
    // The boards' cookie partition gets the same capture pass, never in a URL.
    for (const c of job.cookies) {
      expect(c.url).toBe(`http://${d.id}.content.localhost:8787/`);
      expect(job.url).not.toContain(c.value);
    }
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
    expect(new URL(every.url).searchParams.get("next")).toBe("/__plinth/v/1/?plinth-print=1");
    expect(single.boards).toBe(1);
    expect(new URL(single.url).searchParams.get("next")).toBe(
      "/__plinth/v/1/?plinth-print=1&plinth-board=post",
    );
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

  it("caps a PNG at the pixel limit: a 4096 px board at 1x, not at 2x", async () => {
    const a = await agent();
    const d = await publishDesign(a.auth, { content: BIG });
    const twice = await run(exportUrl(d.id, "format=png&board=poster&scale=2"), {
      headers: a.auth,
    });
    expect(twice.status).toBe(400);
    const body = await json(twice);
    expect(body.error.message).toMatch(
      /8192x8192 px, over the 33,554,432 pixel limit: use scale=1/,
    );
    expect(body.error.details.max_pixels).toBe(DESIGN_EXPORT.maxPixels);
    const once = await run(exportUrl(d.id, "format=png&board=poster"), { headers: a.auth });
    expect(once.status).toBe(200);
    expect(jobs[0]?.viewport).toEqual({ width: 4096, height: 4096, deviceScaleFactor: 1 });
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

describe("helpers", () => {
  it("name files from the slug and the board, ASCII letters, digits and - only", () => {
    expect(exportFileName("launch-kit-x1y2", "home", "png")).toBe("launch-kit-x1y2-home.png");
    expect(exportFileName("launch-kit-x1y2", null, "pdf")).toBe("launch-kit-x1y2.pdf");
    expect(exportFileName('a"b/../c', 'x"; y', "png")).toBe("a-b-c-x-y.png");
    expect(exportFileName("", null, "pdf")).toBe("design.pdf");
  });

  it("open the version's export layout, one board or every board", () => {
    expect(exportPath(3, null)).toBe("/__plinth/v/3/?plinth-print=1");
    expect(exportPath(3, "home")).toBe("/__plinth/v/3/?plinth-print=1&plinth-board=home");
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

  it("POST /__dev/export-url is not served unless DEV_SEED is on in development", async () => {
    const res = await run("/__dev/export-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifact_id: "aaaaaaaaaaaaaaaaaaaa", version: 1, board: null }),
    });
    expect(res.status).toBe(404);
  });

  it("the shipped wrangler.jsonc lists them with the documented defaults", () => {
    const vars = env as unknown as Record<string, unknown>;
    expect(vars.DESIGN_EXPORT).toBe("true");
    expect(vars.DESIGN_EXPORTS_PER_HOUR).toBe(String(DESIGN_EXPORT.perHour));
  });
});

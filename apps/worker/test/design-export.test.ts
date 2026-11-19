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
  browserExport,
  claimExportSlot,
  EXPORT_RUN,
  type ExportJob,
  exportFileName,
  exportPath,
  exportRateKey,
  redactUrls,
  releaseExportSlot,
  runShooter,
  setDesignExportLauncher,
  setDesignExportShooter,
  stepTimeout,
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
  };

  /** A fake puppeteer browser on a fake clock: launch 3 s, the document 9 s, boards never load. */
  function fakeBrowser(clock: { t: number }, hangGoto = false) {
    const calls: Calls = { timeouts: {}, closed: 0, pdf: 0 };
    let rejectGoto: (e: Error) => void = () => undefined;
    const page = {
      createCDPSession: async () => ({ send: async () => undefined }),
      setViewport: async () => undefined,
      emulateMediaFeatures: async () => undefined,
      goto: async (_url: string, o: { waitUntil?: string; timeout?: number }) => {
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
        if (expression.includes("data-ready")) {
          calls.timeouts.ready = o.timeout ?? -1;
          return true;
        }
        calls.timeouts.boards = o.timeout ?? -1;
        clock.t += o.timeout ?? 0;
        throw new Error("waiting failed: timeout");
      },
      evaluate: async () => "ok",
      pdf: async () => {
        calls.pdf += 1;
        calls.timeouts.printAt = clock.t;
        return PDF_BYTES;
      },
      $: async () => null,
      screenshot: async () => PNG_BYTES,
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

  const JOB: ExportJob = {
    format: "pdf",
    url: "http://x.content.localhost:8787/__plinth/enter",
    cookies: [],
    viewport: { width: 300, height: 250, deviceScaleFactor: 1 },
    boards: 3,
    board: null,
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
    expect(bytes).toEqual(PDF_BYTES);
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

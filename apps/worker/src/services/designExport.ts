// Server-side design export (docs/spec.md "Designs"): a PNG of one artboard, or a PDF of every
// board or one, rendered by Cloudflare Browser Rendering (the BROWSER binding). Only in effect
// with DESIGN_EXPORT on and the binding (designExportActive); without it people keep the browser's
// own Print or save as PDF.
//
// Who may export: anyone who may view the artifact (requireArtifact "view", the same check as the
// thumbnail; strangers get 404), at most DESIGN_EXPORTS_PER_HOUR per person, or per client network
// signed out (lib/ip.ts: an IPv6 /64 is one client). The type is checked after the access
// decision, so nobody learns whether an artifact they cannot view exists or what type it is.
//
// At most DESIGN_EXPORT.maxConcurrent exports render at once across the instance, beside the
// thumbnails' own cap, because Browser Rendering limits the account's concurrent browsers: a lease
// row in rate_limits (claimExportSlot). A request that finds every slot taken answers 503 at once
// and is not counted. The lease is held until the browser has closed, not until the response: a
// render past its budget is aborted, which closes the browser, and the Worker waits for that
// (waitUntil) before it gives the slot back.
//
// How: the browser opens the version exactly as a thumbnail capture does (captureLoad and
// captureScope in thumbnails.ts): a fresh capture pass with no identity, bound to the exported
// version, reading no shared data when the version's writer may not (policy.captureReadsData), the
// same pass for the boards' cookie partition handed over through the DevTools protocol (never in a
// URL), and every request held to the capture's scope (guardCapturePage). It emulates print media
// before the page loads, which is the one thing that puts the renderer in its export layout: every
// board at 100%, none of the canvas. No URL or message selects that layout, so it is no address
// anyone can open. For one board the browser removes every other board from its own copy of the
// page before they load. It then waits for the boards and takes a PNG of the board's box (in
// screen media again) or prints a PDF with the renderer's named @page per board size. The enter URL
// is minted and used inside the Worker; it is never returned or logged.
import puppeteer from "@cloudflare/puppeteer";
import {
  DESIGN_EXPORT,
  DESIGN_EXPORT_LAYOUT_SCRIPT,
  type DesignBoard,
  type DesignExportInput,
  type DesignExportOptions,
  type DesignExportOptionsInput,
  type DesignSource,
  designExportBoardSelector,
  designExportInput,
  designExportKeepOnlyScript,
  designExportLoadedScript,
  designExportOptionsInput,
  parseDesign,
  TYPE_REGISTRY,
} from "@plinth/shared";
import { designExportActive } from "../config.ts";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { clientNetwork } from "../lib/ip.ts";
import { enforce, peek } from "../lib/ratelimit.ts";
import { requireArtifact, requireVersion } from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { readText } from "./storage.ts";
import {
  type CaptureCookie,
  type CaptureScope,
  captureLoad,
  captureScope,
  captureTarget,
  type GuardedPage,
  guardCapturePage,
  withBudget,
} from "./thumbnails.ts";

const DEF = TYPE_REGISTRY.design;

export const EXPORT_RUN = {
  /** The whole render, browser launch included, as for thumbnails. */
  budgetMs: 25_000,
  /**
   * Kept back from the budget for the print or screenshot and the settle pause: every wait before
   * them ends this long before the budget does, so slow boards still give a file of what loaded.
   */
  renderReserveMs: 7_000,
  /** How long the page's document may take to arrive (the boards go on loading after it). */
  navigationTimeoutMs: 10_000,
  /** How long the renderer may take to say it is ready. */
  readyTimeoutMs: 8_000,
  /** How long to wait for every board to load before rendering what has. */
  boardsTimeoutMs: 10_000,
  /** A pause after the boards load, for fonts, images and animations to settle. */
  settleMs: 500,
  /** A lease not given back this long after it was taken no longer holds a slot. */
  slotStaleS: 60,
  /** Retry-After, in seconds, when every slot is taken. */
  busyRetryAfterS: 10,
} as const;

/**
 * A wait's timeout: its own cap, cut to what is left before `printBy`, and never below 1 ms, so a
 * step that starts late gives up at once.
 */
export function stepTimeout(capMs: number, printBy: number, now: number = Date.now()): number {
  return Math.max(1, Math.min(capMs, printBy - now));
}

/** What the browser renders for one export. */
export interface ExportJob {
  format: "png" | "pdf";
  /** The version's enter URL (a capture pass). Never logged. */
  url: string;
  /** Set in the browser before the page opens (Network.setCookie). */
  cookies: readonly CaptureCookie[];
  /** Where the page may go (captureScope): every request is held to it. */
  scope: CaptureScope;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  /** Boards the export holds: every board of the version, or 1 for one board. */
  boards: number;
  /** The one board exported (always for png), or null for every board. */
  board: string | null;
}

/**
 * Renders an export in a browser and returns the file's bytes. `signal` aborts once the render's
 * budget has passed; the shooter then closes its browser and settles.
 */
export type ExportShooter = (
  browser: Fetcher,
  job: ExportJob,
  signal: AbortSignal,
) => Promise<Uint8Array>;

type Launch = (binding: Fetcher) => ReturnType<typeof puppeteer.launch>;
const puppeteerLaunch: Launch = (binding) => puppeteer.launch(binding);
let launch: Launch = puppeteerLaunch;

/** Tests replace puppeteer's launch with a fake browser; null restores it. */
export function setDesignExportLauncher(l: Launch | null): void {
  launch = l ?? puppeteerLaunch;
}

/** An error message without any URL in it, so no enter token reaches a log. */
export function redactUrls(message: string): string {
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
}

/** The real shooter: Browser Rendering through @cloudflare/puppeteer. */
export async function browserExport(
  binding: Fetcher,
  job: ExportJob,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // One deadline for every wait, launch included, that leaves the print its reserve.
  const printBy = Date.now() + EXPORT_RUN.budgetMs - EXPORT_RUN.renderReserveMs;
  const browser = await launch(binding);
  // Past the budget, close the browser at once: its pending calls reject and the finally runs.
  const close = () => void browser.close().catch(() => undefined);
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  try {
    const page = await browser.newPage();
    // Before anything loads: the page reaches only its own version, the board loader and the
    // CSP's hosts, and any window it opens is closed (as for a thumbnail).
    await guardCapturePage(page as unknown as GuardedPage, job.scope);
    if (job.cookies.length > 0) {
      const cdp = await page.createCDPSession();
      for (const cookie of job.cookies) {
        // Without it boards still render, without their own files (as for thumbnails).
        await cdp.send("Network.setCookie", cookie).catch((e: unknown) => {
          console.warn(
            `export cookie not set: ${redactUrls(e instanceof Error ? e.message : String(e))}`,
          );
        });
      }
    }
    await page.setViewport(job.viewport);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    // Print media as the shell boots, top-level: the renderer's export layout (boot.ts).
    await page.emulateMediaType("print");
    // The document, not network idle: a slow board must not fail the load, only be left out.
    const res = await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: stepTimeout(EXPORT_RUN.navigationTimeoutMs, printBy),
    });
    // Never hand out a picture of an error page ("This link has expired", a 404).
    if (!res?.ok()) throw new Error(`page answered ${res ? res.status() : "nothing"}`);
    // The renderer marks <html> data-ready ("ok" or "error") and counts loaded boards on it.
    await page.waitForFunction('document.documentElement.getAttribute("data-ready") !== null', {
      timeout: stepTimeout(EXPORT_RUN.readyTimeoutMs, printBy),
    });
    const ready = await page.evaluate('document.documentElement.getAttribute("data-ready")');
    if (ready !== "ok") throw new Error("the design did not render");
    // Never hand out a picture of the canvas: only the export layout is exported.
    if ((await page.evaluate(DESIGN_EXPORT_LAYOUT_SCRIPT)) !== true) {
      throw new Error("the design did not take the export layout");
    }
    // One board: the others leave this copy of the page before they load.
    if (
      job.board !== null &&
      (await page.evaluate(designExportKeepOnlyScript(job.board))) !== true
    ) {
      throw new Error("the board is not on the page");
    }
    // Render what has loaded once the cap or the deadline passes, as Print does.
    await page
      .waitForFunction(designExportLoadedScript(job.board, job.boards), {
        timeout: stepTimeout(EXPORT_RUN.boardsTimeoutMs, printBy),
      })
      .catch(() => undefined);
    if (signal.aborted) throw new Error("the render ran out of time");
    // A PNG is the board as people see it on screen; a PDF prints.
    if (job.format === "png") await page.emulateMediaType("screen");
    await new Promise((r) => setTimeout(r, EXPORT_RUN.settleMs));
    if (job.format === "pdf") {
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      return new Uint8Array(pdf);
    }
    if (job.board === null) throw new Error("a PNG is one board");
    const el = await page.$(designExportBoardSelector(job.board));
    const box = el ? await el.boundingBox() : null;
    if (!box) throw new Error("the board is not on the page");
    const shot = await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    return new Uint8Array(shot);
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close().catch(() => undefined);
  }
}

let shooter: ExportShooter = browserExport;

/** Tests replace the browser; null restores it. */
export function setDesignExportShooter(s: ExportShooter | null): void {
  shooter = s ?? browserExport;
}

/**
 * Run a shooter within `budgetMs`. `result` rejects once the budget has passed, and the shooter is
 * then aborted. `settled` resolves when the shooter itself has finished (its browser closed),
 * whatever the outcome, so the caller can hold its slot and the request open until then.
 */
export function runShooter(
  s: ExportShooter,
  binding: Fetcher,
  job: ExportJob,
  budgetMs: number,
): { result: Promise<Uint8Array>; settled: Promise<void> } {
  const ctrl = new AbortController();
  const shot = Promise.resolve().then(() => s(binding, job, ctrl.signal));
  const settled = shot.then(
    () => undefined,
    () => undefined,
  );
  const result = withBudget(shot, budgetMs).catch((e: unknown) => {
    ctrl.abort();
    throw e;
  });
  return { result, settled };
}

/** Lease rows in rate_limits: `design-export:running:<uuid>`, window_start the claim's second. */
const SLOT_PREFIX = "design-export:running:";
/** The first key after every lease key (";" sorts right after ":"), for a primary-key range. */
const SLOT_END = "design-export:running;";

/**
 * Take one of the instance's DESIGN_EXPORT.maxConcurrent export slots: the lease's key, or null
 * when every slot is held. One statement, so two requests cannot both take the last slot. A lease
 * older than EXPORT_RUN.slotStaleS no longer counts, and the rate limiter's pruning removes it.
 */
export async function claimExportSlot(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const key = `${SLOT_PREFIX}${crypto.randomUUID()}`;
  const nowS = Math.floor(nowMs / 1000);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count)
       SELECT ?1, ?2, 1
       WHERE (SELECT count(*) FROM rate_limits
              WHERE key >= ?3 AND key < ?4 AND window_start > ?5) < ?6
       RETURNING key`,
    )
    .bind(
      key,
      nowS,
      SLOT_PREFIX,
      SLOT_END,
      nowS - EXPORT_RUN.slotStaleS,
      DESIGN_EXPORT.maxConcurrent,
    )
    .first<{ key: string }>();
  return row ? key : null;
}

/** Give a slot back. */
export async function releaseExportSlot(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
}

function requireDesign(artifact: ArtifactRow): void {
  if (artifact.type !== DEF.id) {
    throw new ApiError("not_found", "Only a design can be exported as PNG or PDF", {
      type: artifact.type,
    });
  }
}

async function storedDesign(ctx: Ctx, artifact: ArtifactRow, n: number): Promise<DesignSource> {
  const v = await requireVersion(ctx, artifact, n);
  const text = await readText(ctx.env.FILES, `${v.r2Prefix}${DEF.sourcePath}`);
  if (text === null) throw new ApiError("internal", `Stored ${DEF.sourceLabel} is missing`);
  const r = parseDesign(text);
  if (!r.ok) throw new ApiError("internal", "The stored design does not parse");
  return r.design;
}

/** A version's artboards and what they can be downloaded as, for anyone who may view it. */
export async function designExportOptions(
  ctx: Ctx,
  ref: string,
  raw: Record<string, unknown>,
): Promise<DesignExportOptions> {
  const { artifact } = await requireArtifact(ctx, ref, "view");
  requireDesign(artifact);
  const input: DesignExportOptionsInput = parseQuery(designExportOptionsInput, { ...raw, id: ref });
  const version = input.version ?? artifact.currentVersion;
  const design = await storedDesign(ctx, artifact, version);
  return {
    id: artifact.id,
    version,
    boards: design.boards.map((b) => ({
      id: b.id,
      name: b.name,
      width: b.width,
      height: b.height,
    })),
    formats: [...DESIGN_EXPORT.formats],
    scales: [...DESIGN_EXPORT.scales],
    max_pixels: DESIGN_EXPORT.maxPixels,
    available: designExportActive(ctx.config, ctx.env),
  };
}

/**
 * The rate-limit key: the person, a confirmed viewer's email, or signed out the client's network
 * (an IPv6 /64, in which one line or server may pick any address, is one client).
 */
export function exportRateKey(ctx: Pick<Ctx, "principal" | "ip">): string {
  const p = ctx.principal;
  if (p.kind === "user" || p.kind === "agent") return `design-export:u:${p.userId}`;
  if (p.kind === "viewer") return `design-export:e:${p.email}`;
  return `design-export:ip:${ctx.ip === null ? "unknown" : clientNetwork(ctx.ip)}`;
}

/** `<slug>[-<board>].<ext>`, ASCII letters, digits and - only. */
export function exportFileName(slug: string, board: string | null, format: "png" | "pdf"): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const base = [clean(slug) || "design", board ? clean(board) : ""].filter(Boolean).join("-");
  return `${base}.${format}`;
}

export interface DesignExportFile {
  bytes: Uint8Array;
  contentType: "image/png" | "application/pdf";
  filename: string;
}

function invalid(message: string, field: string, details: Record<string, unknown> = {}) {
  return new ApiError("invalid_input", message, { field, ...details });
}

/** Checks the request against the version's boards and returns the board to render, if one. */
function pickBoard(design: DesignSource, input: DesignExportInput): DesignBoard | null {
  const ids = design.boards.map((b) => b.id);
  if (input.format === "png" && !input.board) {
    throw invalid(
      `A PNG is one artboard: add board=<id> (one of ${ids.join(", ")}), or use format=pdf for every board`,
      "board",
      { boards: ids },
    );
  }
  if (input.format === "pdf" && input.scale !== undefined) {
    throw invalid("scale is for PNG; a PDF keeps each board at its size", "scale");
  }
  if (!input.board) return null;
  const board = design.boards.find((b) => b.id === input.board);
  if (!board) {
    throw invalid(
      `This version has no artboard "${input.board}"; its boards are ${ids.join(", ")}`,
      "board",
      { boards: ids },
    );
  }
  if (input.format === "png") {
    const scale = input.scale ?? 1;
    const pixels = board.width * board.height * scale * scale;
    if (pixels > DESIGN_EXPORT.maxPixels) {
      throw invalid(
        `At scale=${scale} this board is ${board.width * scale}x${board.height * scale} px, over the ${DESIGN_EXPORT.maxPixels.toLocaleString("en-US")} pixel limit: use scale=1`,
        "scale",
        { max_pixels: DESIGN_EXPORT.maxPixels },
      );
    }
  }
  return board;
}

/**
 * Validate the query after the access decision, so a caller who may not view the artifact gets
 * its 404 (or 401/403) whatever the query says, never a 400 that answers before policy did.
 */
function parseQuery<T>(
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  raw: unknown,
): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_input", "Invalid input", { issues: r.error.issues });
  return r.data;
}

/**
 * Render a design version as PNG or PDF, as the caller (view rights), within the rate limit and
 * the instance's export slots. `raw` is the request's query, checked against designExportInput
 * once access is decided.
 */
export async function exportDesign(
  ctx: Ctx,
  ref: string,
  raw: Record<string, unknown>,
): Promise<DesignExportFile> {
  const { artifact } = await requireArtifact(ctx, ref, "view");
  requireDesign(artifact);
  const input = parseQuery(designExportInput, { ...raw, id: ref });
  const binding = ctx.env.BROWSER;
  if (!designExportActive(ctx.config, ctx.env) || !binding) {
    throw new ApiError(
      "feature_disabled",
      "This instance does not render design exports; use Print or save as PDF from the artifact menu",
    );
  }
  const version = input.version ?? artifact.currentVersion;
  const design = await storedDesign(ctx, artifact, version);
  const board = pickBoard(design, input);
  // The capture's own view of the version: its writer decides whether the pass reads shared data.
  const target = await captureTarget(ctx.env.DB, artifact.id, version);
  if (!target) throw new ApiError("not_found", "Not found");

  const limit = ctx.config.designExportsPerHour;
  const key = exportRateKey(ctx);
  const limitMessage = `Export limit reached (${limit} per hour)`;
  // Someone already over the limit is refused without taking a slot; the hit itself is counted
  // once a slot is held, so a busy answer costs nobody an export.
  if ((await peek(ctx.env.DB, key, 3600)) >= limit) {
    await enforce(ctx.env.DB, key, limit, 3600, limitMessage);
  }
  const slot = await claimExportSlot(ctx.env.DB);
  if (!slot) {
    throw new ApiError(
      "unavailable",
      "Other exports are rendering right now; try again in a few seconds",
      { retry_after: EXPORT_RUN.busyRetryAfterS },
    );
  }

  const boards = board ? [board] : design.boards;
  const scale = input.format === "png" ? (input.scale ?? 1) : 1;
  let job: ExportJob;
  try {
    await enforce(ctx.env.DB, key, limit, 3600, limitMessage);
    const { url, cookies } = await captureLoad(ctx.config, target);
    job = {
      format: input.format,
      url,
      cookies,
      scope: captureScope(ctx.config, target.artifactId, target.number, target.type),
      viewport: {
        width: Math.max(...boards.map((b) => b.width)),
        height: Math.max(...boards.map((b) => b.height)),
        deviceScaleFactor: scale,
      },
      boards: boards.length,
      board: board?.id ?? null,
    };
  } catch (e) {
    await releaseExportSlot(ctx.env.DB, slot).catch(() => undefined);
    throw e;
  }

  const { result, settled } = runShooter(shooter, binding, job, EXPORT_RUN.budgetMs);
  // The slot is given back once the browser has closed, even after a timed-out response.
  ctx.waitUntil(settled.then(() => releaseExportSlot(ctx.env.DB, slot)).catch(() => undefined));
  let bytes: Uint8Array;
  try {
    bytes = await result;
    if (bytes.byteLength === 0) throw new Error("empty file");
  } catch (e) {
    console.warn(
      `design export failed for ${artifact.id} v${version}: ${redactUrls(e instanceof Error ? e.message : String(e))}`,
    );
    throw new ApiError(
      "unavailable",
      "The export could not be rendered right now; try again in a minute",
    );
  }
  return {
    bytes,
    contentType: input.format === "png" ? "image/png" : "application/pdf",
    filename: exportFileName(artifact.slug, board?.id ?? null, input.format),
  };
}

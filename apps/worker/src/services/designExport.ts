// Server-side design export (docs/spec.md "Designs"): a PNG of one artboard, or a PDF of every
// board or one, rendered by Cloudflare Browser Rendering (the BROWSER binding). Only in effect
// with DESIGN_EXPORT on and the binding (designExportActive); without it people keep the browser's
// own Print or save as PDF.
//
// Who may export: anyone who may view the artifact (requireArtifact "view", the same check as the
// thumbnail; strangers get 404), at most DESIGN_EXPORTS_PER_HOUR per person, or per address
// signed out. The type is checked after the access decision, so nobody learns whether an artifact
// they cannot view exists or what type it is.
//
// How: the browser opens the exact version on its own content origin with a fresh capture pass,
// as a thumbnail does (no identity, top-level, the pass for the boards' cookie partition handed to
// the browser through the DevTools protocol, never in a URL), at ?plinth-print=1, where the
// renderer lays the boards out at 100% and mounts every one (with ?plinth-board=<id>, one). It
// waits until the renderer reports every board loaded, then takes a PNG of the board's box or
// prints a PDF with the renderer's named @page per board size. The enter URL is minted and used
// inside the Worker; it is never returned or logged.
import puppeteer from "@cloudflare/puppeteer";
import {
  CONTENT_RESERVED_PREFIX,
  DESIGN_BOARD_PARAM,
  DESIGN_EXPORT,
  DESIGN_PRINT_PARAM,
  type DesignBoard,
  type DesignExportInput,
  type DesignExportOptions,
  type DesignExportOptionsInput,
  type DesignSource,
  designExportInput,
  designExportOptionsInput,
  parseDesign,
  TYPE_REGISTRY,
} from "@plinth/shared";
import { type Config, designExportActive } from "../config.ts";
import { issueEnterUrl } from "../content/tokens.ts";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { requireArtifact, requireVersion } from "./artifacts.ts";
import type { Ctx } from "./context.ts";
import { readText } from "./storage.ts";
import { type CaptureCookie, captureFrameCookies, withBudget } from "./thumbnails.ts";

const DEF = TYPE_REGISTRY.design;

export const EXPORT_RUN = {
  /** The whole render, browser launch included, as for thumbnails. */
  budgetMs: 25_000,
  /** How long the page may take to load. */
  navigationTimeoutMs: 12_000,
  /** How long the renderer may take to say it is ready. */
  readyTimeoutMs: 8_000,
  /** How long to wait for every board to load before rendering what has. */
  boardsTimeoutMs: 10_000,
  /** A pause after the boards load, for fonts, images and animations to settle. */
  settleMs: 500,
} as const;

/** What the browser renders for one export. */
export interface ExportJob {
  format: "png" | "pdf";
  /** The version's enter URL (a capture pass). Never logged. */
  url: string;
  /** Set in the browser before the page opens (Network.setCookie). */
  cookies: readonly CaptureCookie[];
  viewport: { width: number; height: number; deviceScaleFactor: number };
  /** Boards the page lays out, which the renderer counts as they load. */
  boards: number;
  /** For png: the board whose box is the picture. */
  board: string | null;
}

/** Renders an export in a browser and returns the file's bytes. */
export type ExportShooter = (browser: Fetcher, job: ExportJob) => Promise<Uint8Array>;

/** An error message without any URL in it, so no enter token reaches a log. */
export function redactUrls(message: string): string {
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
}

async function browserExport(binding: Fetcher, job: ExportJob): Promise<Uint8Array> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
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
    const res = await page.goto(job.url, {
      waitUntil: "networkidle0",
      timeout: EXPORT_RUN.navigationTimeoutMs,
    });
    // Never hand out a picture of an error page ("This link has expired", a 404).
    if (!res?.ok()) throw new Error(`page answered ${res ? res.status() : "nothing"}`);
    // The renderer marks <html> data-ready ("ok" or "error") and counts loaded boards on it.
    await page.waitForFunction('document.documentElement.getAttribute("data-ready") !== null', {
      timeout: EXPORT_RUN.readyTimeoutMs,
    });
    const ready = await page.evaluate('document.documentElement.getAttribute("data-ready")');
    if (ready !== "ok") throw new Error("the design did not render");
    // Render what has loaded once the cap passes, as Print does.
    await page
      .waitForFunction(
        `Number(document.documentElement.getAttribute("data-boards-loaded") || "0") >= ${Math.trunc(job.boards)}`,
        { timeout: EXPORT_RUN.boardsTimeoutMs },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, EXPORT_RUN.settleMs));
    if (job.format === "pdf") {
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      return new Uint8Array(pdf);
    }
    const el = await page.$(`.plinth-design__board[data-board="${job.board ?? ""}"]`);
    const box = el ? await el.boundingBox() : null;
    if (!box) throw new Error("the board is not on the page");
    const shot = await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    return new Uint8Array(shot);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

let shooter: ExportShooter = browserExport;

/** Tests replace the browser; null restores it. */
export function setDesignExportShooter(s: ExportShooter | null): void {
  shooter = s ?? browserExport;
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

/** The rate-limit key: the person, a confirmed viewer's email, or the address signed out. */
function rateKey(ctx: Ctx): string {
  const p = ctx.principal;
  if (p.kind === "user" || p.kind === "agent") return `design-export:u:${p.userId}`;
  if (p.kind === "viewer") return `design-export:e:${p.email}`;
  return `design-export:ip:${ctx.ip ?? "unknown"}`;
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

/** The page the browser opens: the version's export layout, one board or every board. */
export function exportPath(n: number, board: string | null): string {
  const q = new URLSearchParams({ [DESIGN_PRINT_PARAM]: "1" });
  if (board) q.set(DESIGN_BOARD_PARAM, board);
  return `${CONTENT_RESERVED_PREFIX}v/${n}/?${q}`;
}

/**
 * What the export's browser opens for version `n` (one board, or every board when `board` is
 * null), and the cookies it holds first: a capture pass, top-level, and the same pass for the
 * boards' cookie partition (captureFrameCookies), as for a design's thumbnail.
 */
export async function exportLoad(
  config: Config,
  target: { artifactId: string; accessEpoch: number },
  n: number,
  board: string | null,
): Promise<{ url: string; cookies: CaptureCookie[] }> {
  const url = await issueEnterUrl(
    config,
    { id: target.artifactId, accessEpoch: target.accessEpoch },
    exportPath(n, board),
    undefined,
    { capture: true },
  );
  return { url, cookies: await captureFrameCookies(config, target) };
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
 * Render a design version as PNG or PDF, as the caller (view rights), within the rate limit.
 * `raw` is the request's query, checked against designExportInput once access is decided.
 */
export async function exportDesign(
  ctx: Ctx,
  ref: string,
  raw: Record<string, unknown>,
): Promise<DesignExportFile> {
  const { artifact } = await requireArtifact(ctx, ref, "view");
  requireDesign(artifact);
  const input = parseQuery(designExportInput, { ...raw, id: ref });
  if (!designExportActive(ctx.config, ctx.env) || !ctx.env.BROWSER) {
    throw new ApiError(
      "feature_disabled",
      "This instance does not render design exports; use Print or save as PDF from the artifact menu",
    );
  }
  const version = input.version ?? artifact.currentVersion;
  const design = await storedDesign(ctx, artifact, version);
  const board = pickBoard(design, input);
  await enforce(
    ctx.env.DB,
    rateKey(ctx),
    ctx.config.designExportsPerHour,
    3600,
    `Export limit reached (${ctx.config.designExportsPerHour} per hour)`,
  );
  const boards = board ? [board] : design.boards;
  const scale = input.format === "png" ? (input.scale ?? 1) : 1;
  const { url, cookies } = await exportLoad(
    ctx.config,
    { artifactId: artifact.id, accessEpoch: artifact.accessEpoch },
    version,
    board?.id ?? null,
  );
  const job: ExportJob = {
    format: input.format,
    url,
    cookies,
    viewport: {
      width: Math.max(...boards.map((b) => b.width)),
      height: Math.max(...boards.map((b) => b.height)),
      deviceScaleFactor: scale,
    },
    boards: boards.length,
    board: board?.id ?? null,
  };
  let bytes: Uint8Array;
  try {
    bytes = await withBudget(shooter(ctx.env.BROWSER, job), EXPORT_RUN.budgetMs);
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

// Thumbnails (docs/spec.md "Thumbnails and link previews"). After a version commits, the Worker asks
// Cloudflare Browser Rendering (the BROWSER binding) to open that version on its own content origin
// with a fresh one-time enter token, takes a 1200x630 JPEG and stores it at
// artifacts/<id>/thumbs/v<n>.jpg. The dashboard shows it on the artifact's card, and link previews
// use it as og:image for artifacts a signed-out visitor could open.
//
// The capture never runs on the request's critical path: commitVersion and the readers hand it to
// waitUntil. versions.thumbnail coordinates it (migrations/0008_thumbnails.sql): one guarded UPDATE
// claims a version, at most THUMB.maxConcurrent captures run at once across the instance, a claim
// that never finished is taken again after THUMB.pendingStaleMs, and a failed capture is retried
// after THUMB.retryFailedMs. A reader that finds no thumbnail starts one (the backfill for
// versions published before thumbnails existed) and answers 404 until it lands.
//
// The browser sees the page as a signed-out link viewer would: the enter token carries no identity
// claim, so a page with shared data shows it read-only and never learns who is viewing.
import puppeteer from "@cloudflare/puppeteer";
import { CONTENT_RESERVED_PREFIX, typeDef } from "@plinth/shared";
import {
  type Bindings,
  type Config,
  contentOrigin,
  registrableDomain,
  thumbnailsActive,
} from "../config.ts";
import { contentCookieName } from "../content/serve.ts";
import { issueEnterUrl, passMaxAgeS, signContentCookie } from "../content/tokens.ts";
import { secureFlag } from "../lib/cookies.ts";
import { artifactRoot } from "./storage.ts";

export const THUMB = {
  width: 1200,
  height: 630,
  quality: 80,
  /** How long the page may take to load before the capture gives up. */
  navigationTimeoutMs: 12_000,
  /**
   * The whole capture, browser launch included. Below waitUntil's 30 s after the response, so a
   * slow capture records its failure instead of being cut off while still claimed.
   */
  budgetMs: 25_000,
  /** A pause after load for fonts, charts and animations to settle. */
  settleMs: 750,
  /** A capture claimed this long ago without finishing is taken again. */
  pendingStaleMs: 2 * 60 * 1000,
  /** A failed capture is tried again after this long. */
  retryFailedMs: 24 * 60 * 60 * 1000,
  /** Captures running at once across the instance (Browser Rendering limits concurrent browsers). */
  maxConcurrent: 2,
} as const;

/** The R2 key of version n's thumbnail. Under the artifact's root, so a delete removes it. */
export function thumbnailKey(artifactId: string, n: number): string {
  return `${artifactRoot(artifactId)}thumbs/v${n}.jpg`;
}

/**
 * A cookie the browser holds before it opens the page: the parameters of the DevTools protocol's
 * Network.setCookie, partition key included.
 */
export interface CaptureCookie {
  name: string;
  value: string;
  url: string;
  path: string;
  secure: true;
  httpOnly: true;
  sameSite: "None";
  /** Seconds since the epoch. */
  expires: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: true };
}

/**
 * Opens `url` in a browser and returns a JPEG of the first screen. `cookies` are set before the
 * page opens.
 */
export type Shooter = (
  browser: Fetcher,
  url: string,
  cookies: readonly CaptureCookie[],
) => Promise<Uint8Array>;

/**
 * A second capture pass for the cookie partition of documents that have a cross-site ancestor,
 * for a type that renders its author HTML in opaque frames (a design's artboards).
 *
 * The capture loads the version top-level, so the enter sets its cookie in the partition of a
 * top-level, same-site document. A board's document is opaque (CSP and iframe `sandbox`), so
 * Chromium keys the board's own requests (its images, styles and scripts) to the same top-level
 * site with the cross-site ancestor bit set, a partition the enter's cookie is not in: without
 * this cookie they would go to the app's gate and the thumbnail would show boards without them.
 * In the app the shell is already a cross-site frame, so viewing needs nothing of this. Under
 * CONTENT_ISOLATION=opaque the shell is itself opaque at the top, where Chromium keys no
 * partition at all, so there the cookie is unpartitioned: it lives only in this capture's own
 * browser, which loads this one artifact and is closed afterwards.
 *
 * The cookie is the same kind of pass the enter sets (a capture: no identity, two minutes, this
 * artifact at this epoch only), handed to Plinth's own browser and never put in a URL. Empty where
 * a Secure cookie cannot be set (a plain-http instance on a name other than localhost).
 */
export async function captureFrameCookies(
  config: Config,
  target: { artifactId: string; accessEpoch: number },
  nowMs = Date.now(),
): Promise<CaptureCookie[]> {
  const origin = new URL(contentOrigin(config, target.artifactId));
  if (!secureFlag(config.scheme, origin.host)) return [];
  // In the staging path fallback every artifact lives on the app host under its own path.
  const path = config.contentPathFallback ? `${origin.pathname}/` : "/";
  return [
    {
      name: contentCookieName(config, origin),
      value: await signContentCookie(
        config,
        target.artifactId,
        target.accessEpoch,
        undefined,
        "capture",
      ),
      url: `${origin.origin}${path}`,
      path,
      secure: true,
      httpOnly: true,
      sameSite: "None",
      expires: Math.floor(nowMs / 1000) + passMaxAgeS("capture"),
      ...(config.contentIsolation === "opaque"
        ? {}
        : {
            partitionKey: {
              topLevelSite: `${origin.protocol}//${registrableDomain(origin.host)}`,
              hasCrossSiteAncestor: true as const,
            },
          }),
    },
  ];
}

/**
 * What the capture's browser opens for version `number`, and the cookies it holds first. The
 * exact version, even if a newer one lands while the browser loads, entered with a capture pass:
 * no identity, and the one pass the content host serves top-level. A type whose author HTML
 * renders in opaque frames gets the pass in their partition too (captureFrameCookies).
 */
export async function captureLoad(
  config: Config,
  target: { artifactId: string; accessEpoch: number; type: string; number: number },
): Promise<{ url: string; cookies: CaptureCookie[] }> {
  const url = await issueEnterUrl(
    config,
    { id: target.artifactId, accessEpoch: target.accessEpoch },
    `${CONTENT_RESERVED_PREFIX}v/${target.number}/`,
    undefined,
    { capture: true },
  );
  const cookies = typeDef(target.type)?.opaqueFrames
    ? await captureFrameCookies(config, target)
    : [];
  return { url, cookies };
}

async function browserShot(
  binding: Fetcher,
  url: string,
  cookies: readonly CaptureCookie[],
): Promise<Uint8Array> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    if (cookies.length > 0) {
      const cdp = await page.createCDPSession();
      for (const cookie of cookies) {
        // Without it the capture still runs, as before: boards without their own files.
        await cdp.send("Network.setCookie", cookie).catch((e: unknown) => {
          console.warn(`capture cookie not set: ${e instanceof Error ? e.message : e}`);
        });
      }
    }
    await page.setViewport({ width: THUMB.width, height: THUMB.height, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    const res = await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: THUMB.navigationTimeoutMs,
    });
    // Never keep a picture of an error page ("This link has expired", a 404) as the thumbnail.
    if (!res?.ok()) throw new Error(`page answered ${res ? res.status() : "nothing"}`);
    await new Promise((r) => setTimeout(r, THUMB.settleMs));
    const shot = await page.screenshot({ type: "jpeg", quality: THUMB.quality });
    return new Uint8Array(shot);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

let shooter: Shooter = browserShot;

/** Tests replace the browser; null restores it. */
export function setThumbnailShooter(s: Shooter | null): void {
  shooter = s ?? browserShot;
}

interface CaptureTarget {
  artifactId: string;
  accessEpoch: number;
  type: string;
  versionId: string;
  number: number;
}

/**
 * Claim version `versionId` for a capture. True when this caller should capture: the version has
 * no thumbnail yet (or its claim went stale, or its last failure is old enough to retry) and fewer
 * than THUMB.maxConcurrent captures are running.
 */
export async function claimThumbnail(
  db: D1Database,
  versionId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const now = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - THUMB.pendingStaleMs).toISOString();
  const retryBefore = new Date(nowMs - THUMB.retryFailedMs).toISOString();
  const row = await db
    .prepare(
      `UPDATE versions SET thumbnail = 'pending', thumbnail_at = ?1
       WHERE id = ?2
         AND (thumbnail IS NULL
              OR (thumbnail = 'pending' AND thumbnail_at < ?3)
              OR (thumbnail = 'failed' AND thumbnail_at < ?4))
         AND (SELECT count(*) FROM versions
              WHERE thumbnail = 'pending' AND thumbnail_at >= ?3) < ?5
       RETURNING id`,
    )
    .bind(now, versionId, staleBefore, retryBefore, THUMB.maxConcurrent)
    .first();
  return row !== null;
}

async function setState(db: D1Database, versionId: string, state: "ok" | "failed") {
  await db
    .prepare("UPDATE versions SET thumbnail = ?1, thumbnail_at = ?2 WHERE id = ?3")
    .bind(state, new Date().toISOString(), versionId)
    .run();
}

/** The live (not deleted, not taken down) artifact and its version n, or null. */
async function captureTarget(
  db: D1Database,
  artifactId: string,
  n: number,
): Promise<CaptureTarget | null> {
  const row = await db
    .prepare(
      `SELECT a.id AS artifact_id, a.access_epoch, a.type, v.id AS version_id, v.number
       FROM artifacts a JOIN versions v ON v.artifact_id = a.id
       WHERE a.id = ?1 AND v.number = ?2 AND a.deleted_at IS NULL AND a.taken_down_at IS NULL`,
    )
    .bind(artifactId, n)
    .first<{
      artifact_id: string;
      access_epoch: number;
      type: string;
      version_id: string;
      number: number;
    }>();
  return row
    ? {
        artifactId: row.artifact_id,
        accessEpoch: row.access_epoch,
        type: row.type,
        versionId: row.version_id,
        number: row.number,
      }
    : null;
}

/**
 * Capture version n of an artifact, if thumbnails are on and nobody else is capturing it. Never
 * throws: a failure is recorded on the version and retried later.
 */
export async function captureThumbnail(
  env: Bindings,
  config: Config,
  artifactId: string,
  n: number,
): Promise<"ok" | "failed" | "skipped"> {
  if (!thumbnailsActive(config, env) || !env.BROWSER) return "skipped";
  const target = await captureTarget(env.DB, artifactId, n).catch(() => null);
  if (!target) return "skipped";
  if (!(await claimThumbnail(env.DB, target.versionId).catch(() => false))) return "skipped";
  try {
    const { url, cookies } = await captureLoad(config, target);
    const jpeg = await withBudget(shooter(env.BROWSER, url, cookies), THUMB.budgetMs);
    if (jpeg.byteLength === 0) throw new Error("empty screenshot");
    const key = thumbnailKey(target.artifactId, target.number);
    await env.FILES.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
    // A delete that ran while the browser worked has already removed the artifact's root: remove
    // what this capture just put there too, so nothing outlives the artifact.
    if (!(await captureTarget(env.DB, artifactId, n))) {
      await env.FILES.delete(key);
      return "skipped";
    }
    await setState(env.DB, target.versionId, "ok");
    return "ok";
  } catch (e) {
    console.warn(
      `thumbnail capture failed for ${artifactId} v${n}: ${e instanceof Error ? e.message : e}`,
    );
    await setState(env.DB, target.versionId, "failed").catch(() => undefined);
    return "failed";
  }
}

/** `p`, or a rejection once `ms` have passed. */
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: number | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capture took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Start a capture after the response (waitUntil). A no-op when thumbnails are off. */
export function scheduleThumbnail(
  ctx: { env: Bindings; config: Config; waitUntil: (p: Promise<unknown>) => void },
  artifactId: string,
  n: number,
): void {
  if (!thumbnailsActive(ctx.config, ctx.env)) return;
  ctx.waitUntil(captureThumbnail(ctx.env, ctx.config, artifactId, n));
}

/** Version n's thumbnail state, or null when the version does not exist. */
export async function thumbnailState(
  db: D1Database,
  artifactId: string,
  n: number,
): Promise<"pending" | "ok" | "failed" | "none" | null> {
  const row = await db
    .prepare("SELECT thumbnail FROM versions WHERE artifact_id = ?1 AND number = ?2")
    .bind(artifactId, n)
    .first<{ thumbnail: "pending" | "ok" | "failed" | null }>();
  if (!row) return null;
  return row.thumbnail ?? "none";
}

/** The JPEG response for version n's thumbnail, or null when there is none (yet). */
export async function thumbnailResponse(
  bucket: R2Bucket,
  artifactId: string,
  n: number,
  headers: Headers,
): Promise<Response | null> {
  const obj = await bucket.get(thumbnailKey(artifactId, n));
  if (!obj) return null;
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

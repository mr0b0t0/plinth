// REST mirror of the artifact MCP tools. Same services, same policy, same validation.
import {
  API,
  getArtifactInput,
  listArtifactsInput,
  publishArtifactInput,
  renameArtifactInput,
  restoreVersionInput,
  setVisibilityInput,
  updateArtifactInput,
} from "@plinth/shared";
import { Hono } from "hono";
import { applyAppHeaders } from "../app/headers.ts";
import { thumbnailsActive } from "../config.ts";
import { getArtifactWithData } from "../services/artifactData.ts";
import {
  deleteArtifact,
  getVersionRow,
  listArtifacts,
  listVersions,
  publishArtifact,
  requireArtifact,
  restoreVersion,
  setVisibility,
  updateArtifact,
} from "../services/artifacts.ts";
import { patchArtifact } from "../services/categories.ts";
import { designExportOptions, exportDesign } from "../services/designExport.ts";
import { scheduleThumbnail, thumbnailResponse } from "../services/thumbnails.ts";
import { type AppEnv, parseBody, parseInput, serviceCtx } from "./context.ts";

export const artifactsApi = new Hono<AppEnv>();

artifactsApi.get("/artifacts", async (c) => {
  const limit = c.req.query("limit");
  const input = parseInput(listArtifactsInput, {
    query: c.req.query("query") ?? c.req.query("q"),
    category: c.req.query("category"),
    // A query string is text: a non-number fails the schema's integer check (400).
    limit: limit === undefined || limit === "" ? undefined : Number(limit),
    type: c.req.query("type") || undefined,
  });
  return c.json(await listArtifacts(serviceCtx(c), input));
});

artifactsApi.post("/artifacts", async (c) => {
  const input = await parseBody(c, publishArtifactInput);
  return c.json(await publishArtifact(serviceCtx(c), input), 201);
});

artifactsApi.get("/artifacts/:ref", async (c) => {
  const v = c.req.query("version");
  const input = parseInput(getArtifactInput, {
    id: c.req.param("ref"),
    version: v ? Number(v) : undefined,
  });
  return c.json(await getArtifactWithData(serviceCtx(c), input.id, input.version));
});

artifactsApi.put("/artifacts/:ref", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(updateArtifactInput, { ...(body ?? {}), id: c.req.param("ref") });
  return c.json(await updateArtifact(serviceCtx(c), input));
});

artifactsApi.patch("/artifacts/:ref", async (c) => {
  const input = await parseBody(c, renameArtifactInput);
  return c.json(await patchArtifact(serviceCtx(c), c.req.param("ref"), input));
});

artifactsApi.delete("/artifacts/:ref", async (c) => {
  await deleteArtifact(serviceCtx(c), c.req.param("ref"));
  return c.body(null, 204);
});

artifactsApi.get("/artifacts/:ref/versions", async (c) => {
  return c.json({ items: await listVersions(serviceCtx(c), c.req.param("ref")) });
});

artifactsApi.get("/artifacts/:ref/versions/:n", async (c) => {
  const input = parseInput(getArtifactInput, {
    id: c.req.param("ref"),
    version: Number(c.req.param("n")),
  });
  return c.json(await getArtifactWithData(serviceCtx(c), input.id, input.version));
});

artifactsApi.post("/artifacts/:ref/versions/:n/restore", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseInput(restoreVersionInput, {
    ...body,
    id: c.req.param("ref"),
    version: Number(c.req.param("n")),
  });
  return c.json(
    await restoreVersion(serviceCtx(c), input.id, input.version, input.base_version),
    201,
  );
});

artifactsApi.put("/artifacts/:ref/visibility", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(setVisibilityInput, { ...(body ?? {}), id: c.req.param("ref") });
  return c.json(await setVisibility(serviceCtx(c), input));
});

/**
 * A version's thumbnail (the current version without ?version), for anyone who may view the
 * artifact: the same access check as reading it. 404 until the capture lands; a missing one starts
 * a capture, which is how versions published before thumbnails existed get theirs.
 */
artifactsApi.get("/artifacts/:ref/thumbnail", async (c) => {
  const ctx = serviceCtx(c);
  const { artifact } = await requireArtifact(ctx, c.req.param("ref"), "view");
  const q = c.req.query("version");
  const n = q === undefined ? artifact.currentVersion : Number(q);
  const headers = new Headers();
  applyAppHeaders(ctx.config, headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  const missing = () => {
    headers.set("Cache-Control", "no-store");
    return c.json({ error: { code: "not_found", message: "No thumbnail yet", details: {} } }, 404, {
      ...Object.fromEntries(headers),
    });
  };
  if (!Number.isInteger(n) || n < 1 || n > artifact.currentVersion) return missing();
  if (!thumbnailsActive(ctx.config, ctx.env)) return missing();
  const v = await getVersionRow(ctx, artifact.id, n);
  if (!v) return missing();
  if (v.thumbnail === "ok") {
    // A version's image never changes; a revoked viewer keeps only what their browser cached.
    // Without ?version the URL means "current", which moves, so it is revalidated every time.
    headers.set("Cache-Control", q === undefined ? "private, no-cache" : "private, max-age=86400");
    const res = await thumbnailResponse(ctx.env.FILES, artifact.id, n, headers);
    if (res) return res;
  }
  scheduleThumbnail(ctx, artifact.id, n);
  return missing();
});

/** A query parameter, or undefined when absent or empty. */
const queryOf = (c: { req: { query: (k: string) => string | undefined } }, k: string) => {
  const v = c.req.query(k);
  return v === undefined || v === "" ? undefined : v;
};
/** A query string is text: a non-number fails the schema's integer check (400). */
const numberOf = (v: string | undefined) => (v === undefined ? undefined : Number(v));

/**
 * A design version's artboards and the formats it downloads as, for anyone who may view it (the
 * app's export dialog). 404 for an artifact of another type. The service checks the query after
 * the access decision.
 */
artifactsApi.get(API.designExportOptions, async (c) => {
  return c.json(
    await designExportOptions(serviceCtx(c), c.req.param("ref"), {
      version: numberOf(queryOf(c, "version")),
    }),
  );
});

/**
 * A design version as a PNG of one artboard or a PDF (every board, or one), rendered by Browser
 * Rendering, for anyone who may view it. A download, never a page: an attachment with its own
 * CSP that runs nothing.
 */
artifactsApi.get(API.designExport, async (c) => {
  const ctx = serviceCtx(c);
  const file = await exportDesign(ctx, c.req.param("ref"), {
    format: queryOf(c, "format"),
    version: numberOf(queryOf(c, "version")),
    board: queryOf(c, "board"),
    scale: numberOf(queryOf(c, "scale")),
  });
  const headers = new Headers();
  applyAppHeaders(ctx.config, headers);
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  headers.set("Content-Type", file.contentType);
  headers.set("Content-Disposition", `attachment; filename="${file.filename}"`);
  headers.set("Content-Length", String(file.bytes.byteLength));
  headers.set("Cache-Control", "private, no-store");
  return new Response(file.bytes, { status: 200, headers });
});

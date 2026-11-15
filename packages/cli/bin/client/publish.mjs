// `plinth publish <dir>` and `plinth upload <dir> --to <upload_url>`.
//
// publish, new artifact: POST /uploads, then one gzipped tar to the upload_url it returns.
// publish --id: GET the artifact for its version and file hashes; when the changed bytes are small,
// PUT them inline with every unchanged file as {path, sha256}; otherwise POST /uploads {id,
// base_version} and send a bundle. A conflict is never retried (exit 3). Afterwards the artifact is
// read back and every file's hash compared.
// upload: the agent's variant of the bundle step, with a ticket from start_upload; the token comes
// from PLINTH_UPLOAD_TOKEN only, never from the command line.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  badPaths,
  checkLimits,
  defaultLimits,
  hashFiles,
  SOURCE_FILES,
  sha256,
  walk,
} from "./files.mjs";
import {
  ApiError,
  apiClient,
  CliError,
  describeApiError,
  EXIT,
  formatBytes,
  guardedFetch,
  printable,
  readJson,
} from "./http.mjs";
import { gzipTarStream } from "./tar.mjs";
import { UPLOAD_TOKEN_PREFIX } from "./vendor/constants.mjs";
import { isLoopbackHost } from "./vendor/plinth-oauth.mjs";

/** Updates whose source plus changed files stay under this go inline (base64 in one JSON body). */
export const INLINE_UPDATE_MAX_BYTES = 24 * 1024 * 1024;
const BUNDLE_PATH_RE = /^\/api\/v1\/uploads\/[a-z0-9]{20}\/bundle$/;

/**
 * An upload URL the CLI will send a bundle (and its token) to: https (http only on a loopback
 * host), exactly /api/v1/uploads/<id>/bundle, no credentials, query or fragment, and, when given,
 * on the expected origin.
 */
export function checkUploadUrl(raw, { expectedOrigin, exitCode = EXIT.usage } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new CliError(`Not an upload URL: ${raw}`, exitCode);
  }
  const why =
    u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))
      ? "it must be https (http only on localhost)"
      : u.username || u.password || u.search || u.hash
        ? "it must not carry credentials, a query or a fragment"
        : !BUNDLE_PATH_RE.test(u.pathname)
          ? "its path must be /api/v1/uploads/<upload_id>/bundle (the upload_url from start_upload)"
          : expectedOrigin && u.origin !== expectedOrigin
            ? `it is not on ${expectedOrigin}`
            : null;
  if (why) throw new CliError(`Refusing the upload URL ${u.origin}${u.pathname}: ${why}`, exitCode);
  return u.toString();
}

function checkDir(dir) {
  if (!dir) throw new CliError("Name the build folder: plinth publish <dir>", EXIT.usage);
  const abs = path.resolve(dir);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new CliError(`No such folder: ${dir}`, EXIT.usage);
  }
  if (!st.isDirectory()) throw new CliError(`Not a folder: ${dir}`, EXIT.usage);
  return abs;
}

/** Walk and check the folder: links refused, paths valid, not empty. */
export function collect(dir, { includeMaps }) {
  const { files, skipped, refused } = walk(dir, { includeMaps });
  if (refused.length) {
    throw new CliError(
      [
        "The folder has files plinth will not send:",
        ...refused.map((r) => `  ${r.path} ${r.reason}`),
        "Copy the specific files the page needs into the build folder; plinth never follows links.",
      ].join("\n"),
    );
  }
  const bad = badPaths(files);
  if (bad.length) {
    throw new CliError(
      [
        "Rename these files (and what refers to them) first:",
        ...bad
          .slice(0, 20)
          .map(
            (b) => `  ${b.path} ${b.reason}${b.suggestion ? `; for example ${b.suggestion}` : ""}`,
          ),
        ...(bad.length > 20 ? [`  and ${bad.length - 20} more`] : []),
      ].join("\n"),
    );
  }
  if (!files.length) throw new CliError(`${dir} has no files to publish`);
  return { files, skipped };
}

function typeOfFolder(files) {
  const has = new Set(files.map((f) => f.path));
  if (has.has(SOURCE_FILES.html)) return "html";
  if (has.has(SOURCE_FILES.doc)) return "doc";
  throw new CliError(
    "No index.html (or content.md for a document) at the top of the folder. Publish the build folder itself, the one with index.html in it.",
  );
}

/** Source first (so the server meets it early), then the rest in path order. */
const sendOrder = (files, sourcePath) => [
  ...files.filter((f) => f.path === sourcePath),
  ...files.filter((f) => f.path !== sourcePath),
];

async function instanceLimits(origin, ctx) {
  const anon = apiClient({ origin, userAgent: ctx.userAgent, fetch: ctx.fetch });
  try {
    const cfg = await anon.get("/config");
    return {
      limits: { ...defaultLimits(), ...(cfg.limits ?? {}) },
      isolation: cfg.content_isolation,
    };
  } catch (e) {
    if (e instanceof ApiError) return { limits: defaultLimits(), isolation: undefined };
    throw e;
  }
}

/** POST one gzipped tar to the upload URL with the upload token. */
export async function sendBundle({ uploadUrl, uploadToken, files, ctx }) {
  const body = gzipTarStream(files);
  let streamError = null;
  body.on("error", (e) => {
    streamError = e;
  });
  let res;
  try {
    res = await guardedFetch(ctx.fetch)(uploadUrl, {
      method: "POST",
      headers: {
        "User-Agent": ctx.userAgent,
        Accept: "application/json",
        "Content-Type": "application/gzip",
        Authorization: `Bearer ${uploadToken}`,
      },
      body,
      duplex: "half",
    });
  } catch (e) {
    if (streamError) throw new CliError(streamError.message);
    throw e;
  }
  return readJson(res, "POST bundle");
}

/**
 * A version conflict: someone published past the base. The bundle route sends it with
 * `reason: "conflict"`; the inline routes send no reason. The upload_* reasons (used, dead,
 * running) are states of the ticket, not conflicts.
 */
export function isVersionConflict(e) {
  if (!(e instanceof ApiError) || e.code !== "conflict") return false;
  const reason = e.details?.reason;
  return !reason || reason === "conflict";
}

/** A conflict as the CLI reports it (exit 3), or null when `e` is not one. */
function conflict(e, message) {
  if (!isVersionConflict(e)) return null;
  return new CliError(message(e.details?.current_version), EXIT.conflict);
}

const staleBase = (ref, base) => (now) =>
  `${ref} changed since v${base}${now ? ` (now v${now})` : ""}. Check what changed, then publish again with --base-version ${now ?? "<current>"}.`;

function apiFailure(e) {
  if (!(e instanceof ApiError)) return e;
  const d = e.details ?? {};
  let msg = describeApiError(e);
  if (d.reason === "upload_used" && d.url) msg += `\nIt was already published: ${d.url}`;
  return new CliError(msg);
}

/**
 * The hash the source is compared by: of its text, not its bytes. The API returns the source as a
 * decoded string (R2's text(), which drops a leading BOM and replaces bytes that are not UTF-8), so
 * the local file is decoded the same way, and a leading BOM is ignored on both sides.
 */
const sourceTextHash = (text) => sha256(Buffer.from(text.replace(/^\uFEFF/, ""), "utf8"));

/** Read the version back and compare every file's hash with the folder's. */
async function verify(api, result, files) {
  let d;
  try {
    d = await api.get(`/artifacts/${encodeURIComponent(result.id)}`, {
      query: { version: String(result.version) },
    });
  } catch (e) {
    return { verified: false, note: `Could not read it back to verify: ${e.message}` };
  }
  const remote = new Map((d.assets ?? []).map((a) => [a.path, a.sha256]));
  const source = d.html ?? d.content;
  const local = new Map(files.map((f) => [f.path, f.sha256]));
  if (typeof source === "string") {
    remote.set(d.source_path, sourceTextHash(source));
    const file = files.find((f) => f.path === d.source_path);
    if (file)
      local.set(file.path, sourceTextHash(new TextDecoder().decode(readFileSync(file.abs))));
  }
  const differ = files.filter(
    (f) =>
      remote.has(f.path) && remote.get(f.path) !== null && remote.get(f.path) !== local.get(f.path),
  );
  const missing = files.filter((f) => !remote.has(f.path)).map((f) => f.path);
  const extra = [...remote.keys()].filter((p) => !local.has(p));
  const unknown = files.filter((f) => remote.get(f.path) === null).map((f) => f.path);
  if (differ.length || missing.length || extra.length) {
    const lines = ["Verification failed: the published version does not match the folder."];
    for (const f of differ.slice(0, 20)) lines.push(`  differs: ${f.path}`);
    for (const p of missing.slice(0, 20)) lines.push(`  missing: ${p}`);
    for (const p of extra.slice(0, 20)) lines.push(printable(`  not in the folder: ${p}`));
    return { verified: false, failed: true, note: lines.join("\n") };
  }
  if (unknown.length) {
    return {
      verified: false,
      note: `Could not verify ${unknown.length} files stored without a hash`,
    };
  }
  return { verified: true, note: `Verified ${files.length} files.` };
}

function report(result, check, opts, out) {
  if (opts.json) {
    const { id, slug, version, url, content_url, stored, warnings } = result;
    out.stdout(
      JSON.stringify(
        {
          id,
          slug,
          version,
          url,
          content_url,
          stored,
          warnings: warnings ?? [],
          verified: check.verified,
        },
        null,
        2,
      ),
    );
    if (check.note && !check.verified) out.stderr(check.note);
    return;
  }
  out.stdout(`Published v${result.version}: ${result.url}`);
  const s = result.stored;
  if (s) {
    out.stdout(
      `Stored ${s.files} files: ${s.written} written (${formatBytes(s.bytes_written)}), ${s.reused} reused; ${formatBytes(s.bytes)} in all.`,
    );
  }
  if (check.note) out.stdout(check.note);
  const { fix, notes } = splitWarnings(result.warnings);
  if (fix.length) {
    out.stdout(`Warnings (${fix.length}); fix them, then publish again:`);
    // Warnings echo text from the published files: print it without control characters.
    for (const x of fix) out.stdout(printable(`  ${x.code} ${x.file}: ${x.message}`));
  }
  for (const x of notes) out.stdout(printable(`Note (no action needed): ${x.message}`));
}

/**
 * Warnings to fix, and notes that need no action: `not_scanned` only says the reference check did
 * not read some files (past its budget, or sent unchanged as {path, sha256}); nothing in the
 * folder can or should change for it.
 */
export function splitWarnings(warnings) {
  const all = warnings ?? [];
  return {
    fix: all.filter((w) => w.code !== "not_scanned"),
    notes: all.filter((w) => w.code === "not_scanned"),
  };
}

/** The source as text for an inline update; a leading BOM is kept, so the stored bytes match the file. */
function utf8Text(f, bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError(`${f.path} is not valid UTF-8 text`);
  }
}

/** plinth publish <dir> */
export async function publish(dir, opts, ctx) {
  const folder = checkDir(dir);
  if (opts.id === undefined) {
    if (opts.note !== undefined)
      throw new CliError("--note applies to an update (--id)", EXIT.usage);
    if (opts["base-version"] !== undefined)
      throw new CliError("--base-version applies to an update (--id)", EXIT.usage);
  } else if (opts.title !== undefined) {
    throw new CliError("--title applies to a new artifact only", EXIT.usage);
  }
  let base;
  if (opts["base-version"] !== undefined) {
    base = Number(opts["base-version"]);
    if (!Number.isInteger(base) || base < 1)
      throw new CliError("--base-version must be a version number", EXIT.usage);
  }

  const { files, skipped } = collect(folder, { includeMaps: opts["include-maps"] === true });
  if (skipped.length)
    ctx.stderr(
      `Left out ${skipped.length} dotfiles and source maps (${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""}).`,
    );
  const { limits } = await instanceLimits(ctx.origin, ctx);
  const api = ctx.api();
  let result;

  if (opts.id === undefined) {
    const type = typeOfFolder(files);
    const sourcePath = SOURCE_FILES[type];
    const { total } = checkLimits(files, sourcePath, type, limits);
    hashFiles(files);
    if (opts["dry-run"]) {
      ctx.stdout(
        `Would publish ${files.length} files (${formatBytes(total)}) to ${ctx.origin} as a new ${type === "doc" ? "document" : "page"}, in one bundle.`,
      );
      return EXIT.ok;
    }
    await ctx.requireAuth();
    let ticket;
    try {
      ticket = await api.post("/uploads", { type, ...(opts.title ? { title: opts.title } : {}) });
    } catch (e) {
      throw apiFailure(e);
    }
    const uploadUrl = checkUploadUrl(ticket.upload_url, {
      expectedOrigin: ctx.origin,
      exitCode: EXIT.error,
    });
    try {
      result = await sendBundle({
        uploadUrl,
        uploadToken: ticket.upload_token,
        files: sendOrder(files, sourcePath),
        ctx,
      });
    } catch (e) {
      throw apiFailure(e);
    }
  } else {
    await ctx.requireAuth();
    const ref = opts.id;
    let detail;
    try {
      detail = await api.get(`/artifacts/${encodeURIComponent(ref)}`);
    } catch (e) {
      throw apiFailure(e);
    }
    const type = detail.type;
    const sourcePath = detail.source_path ?? SOURCE_FILES[type] ?? "index.html";
    if (!files.some((f) => f.path === sourcePath)) {
      throw new CliError(
        `${ref} is a ${type === "doc" ? "document" : "page"}; the folder needs ${sourcePath} at its top`,
      );
    }
    base ??= detail.version;
    if (base !== detail.version) {
      throw new CliError(staleBase(ref, base)(detail.version), EXIT.conflict);
    }
    const { total } = checkLimits(files, sourcePath, type, limits);
    hashFiles(files);
    const current = new Map((detail.assets ?? []).map((a) => [a.path, a.sha256]));
    const source = files.find((f) => f.path === sourcePath);
    const assets = files.filter((f) => f.path !== sourcePath);
    const changed = assets.filter((f) => !current.get(f.path) || current.get(f.path) !== f.sha256);
    const inlineBytes = source.size + changed.reduce((n, f) => n + f.size, 0);
    const inline = inlineBytes <= INLINE_UPDATE_MAX_BYTES;
    if (opts["dry-run"]) {
      ctx.stdout(
        `Would update ${ref} from v${base} to v${base + 1} on ${ctx.origin}: ${files.length} files (${formatBytes(total)}), ${changed.length} changed asset files, ${assets.length - changed.length} reused, ${inline ? "in one request" : "in one bundle"}.`,
      );
      return EXIT.ok;
    }
    const note = opts.note !== undefined ? { note: opts.note } : {};
    try {
      if (inline) {
        const sourceText = utf8Text(source, readFileSync(source.abs));
        const withContent = new Set(changed.map((f) => f.path));
        const body = () => ({
          [type === "doc" ? "content" : "html"]: sourceText,
          assets: assets.map((f) =>
            withContent.has(f.path)
              ? {
                  path: f.path,
                  content: readFileSync(f.abs).toString("base64"),
                  encoding: "base64",
                  sha256: f.sha256,
                }
              : { path: f.path, sha256: f.sha256 },
          ),
          base_version: base,
          ...note,
        });
        try {
          result = await api.put(`/artifacts/${encodeURIComponent(detail.id)}`, body());
        } catch (e) {
          const missing =
            e instanceof ApiError && e.code === "invalid_input" ? e.details?.missing_paths : null;
          if (!Array.isArray(missing) || missing.length === 0) throw e;
          // The server no longer has those bytes: send them once with content.
          for (const m of missing) withContent.add(typeof m === "string" ? m : m?.path);
          result = await api.put(`/artifacts/${encodeURIComponent(detail.id)}`, body());
        }
      } else {
        const ticket = await api.post("/uploads", { id: detail.id, base_version: base, ...note });
        const uploadUrl = checkUploadUrl(ticket.upload_url, {
          expectedOrigin: ctx.origin,
          exitCode: EXIT.error,
        });
        result = await sendBundle({
          uploadUrl,
          uploadToken: ticket.upload_token,
          files: sendOrder(files, sourcePath),
          ctx,
        });
      }
    } catch (e) {
      throw conflict(e, staleBase(ref, base)) ?? apiFailure(e);
    }
  }

  const check = await verify(api, result, files);
  report(result, check, opts, ctx);
  return check.failed ? EXIT.error : EXIT.ok;
}

/** plinth upload <dir> --to <upload_url> */
export async function upload(dir, opts, ctx) {
  const folder = checkDir(dir);
  if (opts.to === undefined)
    throw new CliError(
      "--to <upload_url> is required (the upload_url from start_upload)",
      EXIT.usage,
    );
  const uploadUrl = checkUploadUrl(opts.to);
  const token = ctx.env.PLINTH_UPLOAD_TOKEN?.trim();
  if (!token)
    throw new CliError(
      "Set PLINTH_UPLOAD_TOKEN to the upload_token from start_upload (never pass it as an argument)",
      EXIT.usage,
    );
  if (!token.startsWith(UPLOAD_TOKEN_PREFIX))
    throw new CliError(`PLINTH_UPLOAD_TOKEN must start with ${UPLOAD_TOKEN_PREFIX}`, EXIT.usage);
  const origin = new URL(uploadUrl).origin;
  ctx.stderr(`plinth: sending to ${origin}`);

  const { files, skipped } = collect(folder, { includeMaps: opts["include-maps"] === true });
  if (skipped.length) ctx.stderr(`Left out ${skipped.length} dotfiles and source maps.`);
  const type = typeOfFolder(files);
  const sourcePath = SOURCE_FILES[type];
  const { limits } = await instanceLimits(origin, ctx);
  checkLimits(files, sourcePath, type, limits);
  let result;
  try {
    result = await sendBundle({
      uploadUrl,
      uploadToken: token,
      files: sendOrder(files, sourcePath),
      ctx,
    });
  } catch (e) {
    throw (
      conflict(
        e,
        (now) =>
          `The artifact changed since start_upload${now ? ` (now v${now})` : ""}. Read it again (get_artifact), then call start_upload with the new base_version.`,
      ) ?? apiFailure(e)
    );
  }
  ctx.stdout(JSON.stringify(result, null, 2));
  ctx.stderr(`Published v${result.version}: ${result.url}`);
  const { fix, notes } = splitWarnings(result.warnings);
  if (fix.length) ctx.stderr(`${fix.length} warnings: fix them, then call start_upload again.`);
  for (const x of notes) ctx.stderr(printable(`Note (no action needed): ${x.message}`));
  return EXIT.ok;
}

// `plinth publish <dir|file.html|file.md|file.csv|file.xlsx>` and `plinth upload <dir> --to <upload_url>`.

//
// One .html (or .htm) file is published as index.html, one .md file as a doc's content.md, and one
// .csv or .xlsx file is imported as a sheet (the server converts it to sheet.jsonl: POST or PUT
// /artifacts inline with content_format); anything else is a build folder. With PLINTH_TOKEN limited to one artifact (docs/ci.md) and no --id, the
// token's artifact is the one updated.
//
// publish, new artifact: POST /uploads, then one gzipped tar to the upload_url it returns.
// publish --id: GET the artifact for its version and file hashes; when the changed bytes are small,
// PUT them inline with every unchanged file as {path, sha256}; otherwise POST /uploads {id,
// base_version} and send a bundle. A conflict is never retried (exit 3). Afterwards the artifact is
// read back and every file's hash compared.
// upload: the agent's variant of the bundle step, with a ticket from start_upload; the token comes
// from PLINTH_UPLOAD_TOKEN only, never from the command line.
// A lost answer (the connection dropped, a proxy timeout) is never resent blindly: once the whole
// body was sent the request may have committed, so the command asks first (the upload's status, or
// the artifact for an inline update) and reports what it finds.
import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  badPaths,
  canonicalSheet,
  checkLimits,
  defaultLimits,
  hashFiles,
  IMPORT_FORMATS,
  SOURCE_FILES,
  sha256,
  sourceField,
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
  LostResponse,
  printable,
  readJson,
} from "./http.mjs";
import { gzipTarStream } from "./tar.mjs";
import { LIMITS, UPLOAD_TOKEN_PREFIX } from "./vendor/constants.mjs";
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

/** Control and format (bidi, zero-width) characters: the server refuses them. Line breaks are whitespace. */
const REFUSED_CATEGORY_CHARS = /[\p{Cc}\p{Cf}]/u;

/**
 * --category as the server stores it (NFC, whitespace runs collapsed, trimmed), or a usage error
 * for a name it would refuse. The server stays the authority: it also snaps the name onto the
 * owner's existing spelling and echoes the one it stored.
 */
export function checkCategory(raw) {
  const name = String(raw).normalize("NFC").replace(/\s+/gu, " ").trim();
  const why = !name
    ? "needs at least one character"
    : name.length > LIMITS.maxCategoryLength
      ? `is at most ${LIMITS.maxCategoryLength} characters`
      : REFUSED_CATEGORY_CHARS.test(name)
        ? "cannot contain control or invisible characters"
        : !/[^\s\-_]/u.test(name.normalize("NFKC"))
          ? "needs a character other than spaces, '-' and '_'"
          : null;
  if (why) throw new CliError(`--category ${why} (a short project or repo name)`, EXIT.usage);
  return name;
}

/** The name a single published file takes, by extension; null for one that cannot be published. */
export function singleFileName(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html" || ext === ".htm") return SOURCE_FILES.html;
  if (ext === ".md") return SOURCE_FILES.doc;
  return null;
}

/** The content_format a single file is imported with (.csv or .xlsx), or null. */
export function importFormat(p) {
  return IMPORT_FORMATS[path.extname(p).toLowerCase()] ?? null;
}

/**
 * What `plinth publish` was given: `{ kind: "dir", abs }`, `{ kind: "file", abs, as }` for one
 * .html, .htm or .md file (sent as index.html or content.md), or `{ kind: "import", abs, format }`
 * for one .csv or .xlsx file (imported as a sheet). A link to a file is refused, as in a folder;
 * anything else is a usage error.
 */
export function checkSource(p) {
  if (!p)
    throw new CliError(
      "Name the build folder or file: plinth publish <dir|file.html|file.md|file.csv|file.xlsx>",
      EXIT.usage,
    );
  const abs = path.resolve(p);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new CliError(`No such folder or file: ${p}`, EXIT.usage);
  }
  if (st.isSymbolicLink()) {
    // A folder given through a link is followed, as before; a file through a link never is.
    let target;
    try {
      target = statSync(abs);
    } catch {
      throw new CliError(`No such folder or file: ${p}`, EXIT.usage);
    }
    if (target.isDirectory()) return { kind: "dir", abs };
    throw new CliError(
      `${p} is a symbolic link; plinth never follows links. Publish the file itself.`,
      EXIT.usage,
    );
  }
  if (st.isDirectory()) return { kind: "dir", abs };
  const format = st.isFile() ? importFormat(abs) : null;
  if (format) return { kind: "import", abs, format, size: st.size };
  const as = st.isFile() ? singleFileName(abs) : null;
  if (!as)
    throw new CliError(
      `${p}: publish takes a build folder, or one .html, .md, .csv or .xlsx file`,
      EXIT.usage,
    );
  return { kind: "file", abs, as, size: st.size };
}

/** The files to send for a source from checkSource: the folder's, or the one file under its name. */
function collectSource(source, opts) {
  if (source.kind === "dir") return collect(source.abs, opts);
  return { files: [{ path: source.as, abs: source.abs, size: source.size }], skipped: [] };
}

/**
 * The artifact PLINTH_TOKEN is limited to (GET /me: `connection.bound`), as `{ id, slug, title }`,
 * or null for a token without that limit (and for a server older than the limit). A bound token
 * whose artifact the person can no longer open is an error.
 */
export async function boundArtifact(api) {
  let me;
  try {
    me = await api.get("/me");
  } catch (e) {
    throw apiFailure(e);
  }
  return bindingOf(me);
}

/** The binding a GET /me answer describes (see boundArtifact). */
export function bindingOf(me) {
  const c = me?.connection;
  if (c?.bound !== true) return null;
  const a = c.artifact;
  if (!a || typeof a.id !== "string")
    throw new CliError("This token's artifact was deleted or is no longer shared with you.");
  return { id: a.id, slug: String(a.slug ?? a.id), title: String(a.title ?? "") };
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

/** What each artifact type is called in messages. */
const TYPE_NOUNS = { html: "page", doc: "document", slides: "deck", design: "design", sheet: "sheet" };
const nounOf = (type) => TYPE_NOUNS[type] ?? "page";

function typeOfFolder(files) {
  const has = new Set(files.map((f) => f.path));
  for (const [type, source] of Object.entries(SOURCE_FILES)) if (has.has(source)) return type;
  throw new CliError(
    "No index.html (or content.md for a document, slides.md for a deck, design.html for a design, sheet.jsonl for a sheet) at the top of the folder. Publish the build folder itself, the one with index.html in it.",
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

/**
 * POST one gzipped tar to the upload URL with the upload token. A LostResponse from it means the
 * whole body went out and no answer came back; a connection lost before that is a plain failure,
 * since an incomplete tar never commits.
 */
export async function sendBundle({ uploadUrl, uploadToken, files, ctx }) {
  const body = gzipTarStream(files);
  let streamError = null;
  let sent = false;
  body.on("error", (e) => {
    streamError = e;
  });
  body.on("end", () => {
    sent = true;
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
    if (e instanceof LostResponse && !sent) {
      throw new CliError(
        `${e.message}\nThe bundle did not arrive in full, so nothing was published (an incomplete upload never commits). Run the same command again.`,
      );
    }
    throw e;
  }
  return readJson(res, "POST bundle");
}

/** How long a lost bundle's status is watched while a request still holds its upload. */
const STATUS_WAIT_MS = 30_000;
const STATUS_POLL_MS = 2_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET /api/v1/uploads/<id>: the upload's state, with the upload token only, on its own origin. */
async function uploadStatus({ uploadUrl, uploadToken, ctx }) {
  const res = await guardedFetch(ctx.fetch)(uploadUrl.replace(/\/bundle$/, ""), {
    headers: {
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
      Authorization: `Bearer ${uploadToken}`,
    },
  });
  return readJson(res, "GET upload status");
}

/** Waits before each new try of a status read that failed (often the same network blip). */
const STATUS_RETRY_MS = [500, 1500, 3000];

/** uploadStatus, tried again after a lost answer or a 5xx; a 4xx from Plinth is final. */
async function readUploadStatus(args) {
  for (let i = 0; ; i++) {
    try {
      return await uploadStatus(args);
    } catch (e) {
      const transient = e instanceof LostResponse || (e instanceof ApiError && e.status >= 500);
      if (!transient || i >= STATUS_RETRY_MS.length) throw e;
      await sleep(STATUS_RETRY_MS[i]);
    }
  }
}

/** The upload id in an upload URL (…/uploads/<id>/bundle). */
const uploadIdOf = (uploadUrl) => /\/uploads\/([^/]+)\/bundle$/.exec(uploadUrl)?.[1] ?? null;

/**
 * The safe rerun of an update whose outcome is unknown: with the base stated, it exits 0 without
 * sending when the update landed after all, and 3 when someone else published first.
 */
const rerunWithBase = (base) =>
  `Run the same command again with --base-version ${base}: it sends nothing and exits 0 if this update landed after all (v${base + 1} matches the folder), publishes it if nothing landed, and exits 3 if someone else published first.`;

/** A CliError for an outcome the command could not learn; --json prints `unknown` on stdout. */
function unknownError(message, { id, uploadId, base }) {
  const err = new CliError(message);
  err.unknown = {
    published: "unknown",
    id: id ?? null,
    ...(uploadId !== undefined ? { upload_id: uploadId } : {}),
    ...(base !== undefined ? { base_version: base } : {}),
  };
  return err;
}

/**
 * The whole bundle was sent but its answer was lost, so it may have committed. Ask the upload
 * (waiting while a request still holds it) instead of sending it again. Returns `{ id, version,
 * url, recovered }` when it committed; otherwise throws: exit 3 when a conflict ended it. When the
 * status cannot be read, or still says a request is working on it, the error names the artifact
 * to check (`targetId`: the update's artifact, or the id a publish ticket reserved), and for an
 * update (`base`) the rerun that cannot publish twice, and carries `unknown` for --json.
 */
async function afterLostBundle(
  lost,
  { uploadUrl, uploadToken, ctx, conflictMessage, retry, targetId, base },
) {
  const uploadId = uploadIdOf(uploadUrl);
  const deadline = Date.now() + STATUS_WAIT_MS;
  let s;
  for (;;) {
    try {
      s = await readUploadStatus({ uploadUrl, uploadToken, ctx });
    } catch (e) {
      throw unknownError(
        `${lost.message}\nThe whole bundle was sent, so it may have been published, but the status of upload ${uploadId ?? uploadUrl} could not be read (${e.message}).` +
          (base !== undefined
            ? ` ${rerunWithBase(base)}`
            : targetId
              ? ` Check artifact ${targetId} before sending it again (GET ${ctx.origin}/api/v1/artifacts/${targetId}, or get_artifact): if it has the new version, this upload published it; if it is not found or still at the old version, nothing was published.`
              : " Check the artifact before sending it again.") +
          " An upload commits at most once.",
        { id: targetId, uploadId, base },
      );
    }
    if (s.state !== "receiving" || Date.now() >= deadline) break;
    await sleep(STATUS_POLL_MS);
  }
  if (s.state === "used") return { id: s.id, version: s.version, url: s.url, recovered: true };
  if (s.state === "dead") throw new CliError(conflictMessage(), EXIT.conflict);
  if (s.state === "taken_down") {
    throw new CliError(
      `${lost.message}\nThe artifact${s.id ? ` ${s.id}` : ""} was taken down, so nothing was published, and it takes no new versions.`,
    );
  }
  if (s.state === "receiving") {
    throw unknownError(
      `${lost.message}\nThe server is still working on the bundle. ` +
        (base !== undefined
          ? `Wait a minute, then: ${rerunWithBase(base)}`
          : `Check ${s.id} in a minute before sending it again; an upload commits at most once.`),
      { id: s.id ?? targetId, uploadId, base },
    );
  }
  throw new CliError(
    `${lost.message}\nThe answer was lost, and nothing was published with this upload (${s.state}). ${s.state === "open" ? retry.open : retry.ended}`,
  );
}

/** How long a lost inline update is given to land (a PUT the server was still running) before a second read. */
const LATE_PUT_MS = 1500;

/**
 * An inline update whose answer was lost: read the artifact. Still at the base, and again after a
 * moment (the server may still have been running the PUT when the connection broke): nothing was
 * published as far as can be told, and the rerun it suggests states the base, so a commit that
 * lands even later stops it (exit 3) instead of publishing twice. One version past it and matching
 * the folder: that is this update. Anything else is a conflict (exit 3).
 */
async function afterLostPut(lost, { api, ref, detail, base, files, ctx }) {
  const read = async () => {
    try {
      return await api.get(`/artifacts/${encodeURIComponent(detail.id)}`);
    } catch (e) {
      throw unknownError(
        `${lost.message}\nIt may have been published, but ${ref} could not be read to check (${e.message}). ${rerunWithBase(base)}`,
        { id: detail.id, base },
      );
    }
  };
  let now = await read();
  if (now.version === base) {
    await sleep(LATE_PUT_MS);
    now = await read();
  }
  if (now.version === base) {
    throw new CliError(
      `${lost.message}\nThe answer was lost, and nothing was published: ${ref} is still v${base}. Run the same command again with --base-version ${base}: if this update still lands first, that stops with a conflict (exit 3) instead of publishing it twice.`,
    );
  }
  const mine = await verify(api, { id: detail.id, version: base + 1 }, files);
  if (mine.verified) {
    return {
      id: detail.id,
      slug: now.slug,
      version: base + 1,
      url: now.url ?? `${ctx.origin}/a/${now.slug}`,
      recovered: true,
    };
  }
  if (mine.failed) throw conflictError(staleBase(ref, base)(now.version), now.version);
  throw unknownError(
    `${lost.message}\n${ref} is now v${now.version}, but it could not be compared with the folder (${mine.note}). ${rerunWithBase(base)}`,
    { id: detail.id, base },
  );
}

const LOST_NOTE =
  "The server's answer was lost after it published; nothing was sent twice. Warnings, if there were any, were in that answer.";

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

/** A CliError for a version conflict (exit 3); `current_version` goes into --json's failure object. */
function conflictError(message, current) {
  const err = new CliError(message, EXIT.conflict);
  if (Number.isInteger(current)) err.details = { current_version: current };
  return err;
}

/** A conflict as the CLI reports it (exit 3), or null when `e` is not one. */
function conflict(e, message) {
  if (!isVersionConflict(e)) return null;
  return conflictError(message(e.details?.current_version), e.details?.current_version);
}

const staleBase = (ref, base) => (now) =>
  `${ref} changed since v${base}${now ? ` (now v${now})` : ""}. Check what changed, then publish again with --base-version ${now ?? "<current>"}.`;

function apiFailure(e) {
  if (!(e instanceof ApiError)) return e;
  const d = e.details ?? {};
  if (e.code === "forbidden" && d.reason === "owner_only") {
    return new CliError(
      "Only the owner sets an artifact's category. Nothing was published; run it again without --category.",
    );
  }
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
  // A sheet's JSON lines are stored in their canonical spelling, which can differ from the file
  // byte for byte (key order, spaces, a final newline): both sides are compared in that spelling.
  const canonical = d.type === "sheet" && typeof source === "string";
  if (typeof source === "string") {
    const spell = canonical ? (text) => canonicalSheet(text) ?? text : (text) => text;
    remote.set(d.source_path, sourceTextHash(spell(source)));
    const file = files.find((f) => f.path === d.source_path);
    if (file)
      local.set(file.path, sourceTextHash(spell(new TextDecoder().decode(readFileSync(file.abs)))));
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
  const title = typeof d.title === "string" ? { title: d.title } : {};
  if (unknown.length) {
    return {
      verified: false,
      note: `Could not verify ${unknown.length} files stored without a hash`,
      ...title,
    };
  }
  return {
    verified: true,
    note: `Verified ${files.length} files.${canonical ? ` ${d.source_path} is stored in its canonical form.` : ""}`,
    ...title,
  };
}

/** The title a new sheet takes from its file's name: "q4-budget.csv" is "q4-budget". */
const titleOfFile = (abs) =>
  path
    .basename(abs)
    .replace(/\.[^.]+$/, "")
    .slice(0, LIMITS.maxTitleLength) || "Sheet";

/**
 * `plinth publish <file.csv|file.xlsx>`: the file goes inline (CSV as text, .xlsx as base64) with
 * content_format, and the server imports it as a sheet. A new artifact is POST /artifacts; --id is
 * PUT /artifacts/:id with base_version. The answer is read back to confirm the version is a sheet.
 */
async function publishImport(source, opts, ctx, { base, category }) {
  const name = path.basename(source.abs);
  if (source.size > LIMITS.maxSheetImportBytes) {
    throw new CliError(
      `${name} is ${formatBytes(source.size)}; a file to import is at most ${formatBytes(LIMITS.maxSheetImportBytes)}.`,
    );
  }
  const bytes = readFileSync(source.abs);
  const content =
    source.format === "xlsx" ? bytes.toString("base64") : utf8Text({ path: name }, bytes);
  const api = ctx.api();
  const note = opts.note !== undefined ? { note: opts.note } : {};
  let result;
  if (opts.id === undefined) {
    if (opts["dry-run"]) {
      ctx.stdout(
        printable(
          `Would import ${name} (${formatBytes(source.size)}) to ${ctx.origin} as a new sheet${category.category !== undefined ? ` under ${category.category}` : ""}.`,
        ),
      );
      return EXIT.ok;
    }
    await ctx.requireAuth();
    const title = opts.title ?? titleOfFile(source.abs);
    try {
      result = await api.post("/artifacts", {
        type: "sheet",
        title,
        content,
        content_format: source.format,
        ...category,
      });
    } catch (e) {
      if (e instanceof LostResponse) {
        throw unknownOutcome(
          unknownError(
            `${e.message}
The answer was lost, so the sheet may have been published. Check your artifacts for "${title}" before running it again, or it will publish a second sheet.`,
            {},
          ),
          opts,
          ctx,
        );
      }
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
    if (detail.type !== "sheet") {
      throw new CliError(
        `${ref} is a ${nounOf(detail.type)}; a .csv or .xlsx file updates a sheet only`,
      );
    }
    const from = base ?? detail.version;
    if (from !== detail.version) {
      throw conflictError(staleBase(ref, from)(detail.version), detail.version);
    }
    if (opts["dry-run"]) {
      ctx.stdout(
        `Would import ${name} as v${from + 1} of ${ref} on ${ctx.origin}, in one request.`,
      );
      return EXIT.ok;
    }
    try {
      result = await api.put(`/artifacts/${encodeURIComponent(detail.id)}`, {
        content,
        content_format: source.format,
        base_version: from,
        ...note,
        ...category,
      });
    } catch (e) {
      if (e instanceof LostResponse) {
        throw unknownOutcome(
          unknownError(
            `${e.message}
It may have been published. ${rerunWithBase(from)}`,
            {
              id: detail.id,
              base: from,
            },
          ),
          opts,
          ctx,
        );
      }
      throw conflict(e, staleBase(ref, from)) ?? apiFailure(e);
    }
  }
  let check;
  try {
    const d = await api.get(`/artifacts/${encodeURIComponent(result.id)}`, {
      query: { version: String(result.version) },
    });
    check =
      d.type === "sheet" && d.source_path === "sheet.jsonl"
        ? { verified: true, note: `Imported ${name}: v${result.version} holds it as sheet.jsonl.` }
        : { verified: false, failed: true, note: `v${result.version} is not a sheet.` };
  } catch (e) {
    check = { verified: false, note: `Could not read it back to verify: ${e.message}` };
  }
  report(result, check, opts, ctx);
  return check.failed ? EXIT.error : EXIT.ok;
}

function report(result, check, opts, out) {
  if (opts.json) {
    const { id, slug, version, url, content_url, stored, warnings, recovered, category } = result;
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
          // The artifact's title as the read-back returned it: text its editors wrote.
          ...(typeof check.title === "string" ? { title: check.title } : {}),
          ...(typeof category === "string" ? { category } : {}),
          ...(recovered ? { recovered: true } : {}),
        },
        null,
        2,
      ),
    );
    if (recovered) out.stderr(LOST_NOTE);
    if (check.note && !check.verified) out.stderr(check.note);
    return;
  }
  // The category is the name the server stored (it may have snapped onto an existing spelling).
  const under = typeof result.category === "string" ? ` under ${result.category}` : "";
  out.stdout(printable(`Published v${result.version}${under}: ${result.url}`));
  if (result.recovered) out.stdout(LOST_NOTE);
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
 * Warning codes that need no action: `not_scanned` only says the reference check did not read
 * some files (past its budget, or sent unchanged as {path, sha256}), and `live_draft` only says
 * people have unsaved edits on a doc's page (nothing was overwritten). Nothing in the folder can
 * or should change for either.
 */
const NOTE_CODES = new Set(["not_scanned", "live_draft"]);

/** Warnings to fix, and notes that need no action (NOTE_CODES). */
export function splitWarnings(warnings) {
  const all = warnings ?? [];
  return {
    fix: all.filter((w) => !NOTE_CODES.has(w?.code)),
    notes: all.filter((w) => NOTE_CODES.has(w?.code)),
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

/**
 * --json --dry-run's one object: what would be sent (nothing was). `files` and `bytes` count the
 * whole version; on an update `changed` and `reused` count its asset files (the source is always
 * sent), and `send` says how it would go: `inline` (one request) or `bundle`.
 */
function printDryRun(said, fields, opts, ctx) {
  if (!opts.json) {
    ctx.stdout(said);
    return;
  }
  ctx.stderr(said);
  ctx.stdout(JSON.stringify({ outcome: "dry_run", dry_run: true, ...fields }, null, 2));
}

/** Rethrow `err`; one whose outcome is unknown also prints the ids to check, as JSON, with --json. */
function unknownOutcome(err, opts, ctx) {
  if (opts.json && err?.unknown) ctx.stdout(JSON.stringify(err.unknown, null, 2));
  throw err;
}

const RETRY_PUBLISH = { open: "Run the same command again.", ended: "Run the same command again." };
const RETRY_UPLOAD = {
  open: "Run the same command again (the upload keeps its remaining attempts).",
  ended: "Call start_upload again for a new upload.",
};

/** plinth publish <dir|file.html|file.md|file.csv|file.xlsx> */
export async function publish(dir, givenOpts, ctx) {
  const source = checkSource(dir);
  // The checks that need no request come first: a bad --category or --base-version sends nothing.
  if (givenOpts.id !== undefined && givenOpts.title !== undefined)
    throw new CliError("--title applies to a new artifact only", EXIT.usage);
  if (givenOpts.category !== undefined) checkCategory(givenOpts.category);
  let base;
  if (givenOpts["base-version"] !== undefined) {
    base = Number(givenOpts["base-version"]);
    if (!Number.isInteger(base) || base < 1)
      throw new CliError("--base-version must be a version number", EXIT.usage);
  }
  let opts = givenOpts;
  // A PLINTH_TOKEN limited to one artifact publishes that artifact's next version (docs/ci.md).
  if (opts.id === undefined && ctx.envToken) {
    const bound = await boundArtifact(ctx.api());
    if (bound) {
      ctx.stderr(
        printable(`PLINTH_TOKEN is limited to ${bound.slug}: publishing its next version.`),
      );
      if (opts.title !== undefined)
        ctx.stderr("--title is ignored: it names a new artifact, and this token updates one.");
      if (opts.category !== undefined)
        ctx.stderr(
          "--category is ignored: set the category on the artifact's Settings page; this token cannot.",
        );
      const { title: _t, category: _c, ...rest } = opts;
      opts = { ...rest, id: bound.id };
    }
  }
  if (opts.id === undefined) {
    if (opts.note !== undefined)
      throw new CliError("--note applies to an update (--id)", EXIT.usage);
    if (opts["base-version"] !== undefined)
      throw new CliError("--base-version applies to an update (--id)", EXIT.usage);
  }
  const category = opts.category !== undefined ? { category: checkCategory(opts.category) } : {};
  if (source.kind === "import") return publishImport(source, opts, ctx, { base, category });

  const { files, skipped } = collectSource(source, {
    includeMaps: opts["include-maps"] === true,
  });
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
      printDryRun(
        printable(
          `Would publish ${files.length} files (${formatBytes(total)}) to ${ctx.origin} as a new ${nounOf(type)}${category.category !== undefined ? ` under ${category.category}` : ""}, in one bundle.`,
        ),
        { type, files: files.length, bytes: total, send: "bundle" },
        opts,
        ctx,
      );
      return EXIT.ok;
    }
    await ctx.requireAuth();
    let ticket;
    try {
      ticket = await api.post("/uploads", {
        type,
        ...(opts.title ? { title: opts.title } : {}),
        ...category,
      });
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
      if (!(e instanceof LostResponse)) throw apiFailure(e);
      result = await afterLostBundle(e, {
        uploadUrl,
        uploadToken: ticket.upload_token,
        ctx,
        conflictMessage: () => "This upload was ended by a conflict. Run the same command again.",
        retry: RETRY_PUBLISH,
        targetId: ticket.target?.id,
      }).catch((err) => unknownOutcome(err, opts, ctx));
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
      // One file can stand in for a page's index.html or a document's content.md, not for the
      // source of a deck or a design.
      const fileExt = { html: ".html", doc: ".md" }[type];
      throw new CliError(
        source.kind !== "file"
          ? `${ref} is a ${nounOf(type)}; the folder needs ${sourcePath} at its top`
          : fileExt
            ? `${ref} is a ${nounOf(type)}; publish a ${fileExt} file (or a folder with ${sourcePath} at its top)`
            : `${ref} is a ${nounOf(type)}; publish a folder with ${sourcePath} at its top`,
      );
    }
    const stated = base !== undefined;
    base ??= detail.version;
    const { total } = checkLimits(files, sourcePath, type, limits);
    hashFiles(files);
    if (stated) {
      // With --base-version N it exits 0 without sending in exactly two cases: the current
      // version is N+1 and equals the folder (an earlier run whose answer was lost committed it),
      // or it is N and equals the folder (nothing to publish). N+1 with other files, N+2 or later
      // (not ours, whatever its files), or a base past the current version is a conflict (exit 3);
      // N with other files publishes as usual.
      const current = detail.version;
      if (current !== base && current !== base + 1) {
        throw conflictError(staleBase(ref, base)(current), current);
      }
      const same = await verify(api, detail, files);
      if (same.verified) {
        const landed = current === base + 1;
        ctx.stderr(
          landed
            ? `${ref} is already published as v${current}, which matches this folder: an earlier run whose answer was lost published it. Nothing was sent.`
            : `${ref} v${current} already matches this folder: nothing to publish. Nothing was sent.`,
        );
        if (category.category !== undefined)
          ctx.stderr(
            "--category was not applied, since nothing was sent; set it on the artifact's Settings page.",
          );
        const url = detail.url ?? `${ctx.origin}/a/${detail.slug}`;
        if (opts.json) {
          ctx.stdout(
            JSON.stringify(
              {
                id: detail.id,
                slug: detail.slug,
                version: current,
                url,
                verified: true,
                unchanged: true,
                outcome: landed ? "already_published" : "nothing_to_publish",
              },
              null,
              2,
            ),
          );
        } else ctx.stdout(url);
        return EXIT.ok;
      }
      if (current !== base) throw conflictError(staleBase(ref, base)(current), current);
    }
    const current = new Map((detail.assets ?? []).map((a) => [a.path, a.sha256]));
    const sourceFile = files.find((f) => f.path === sourcePath);
    const assets = files.filter((f) => f.path !== sourcePath);
    const changed = assets.filter((f) => !current.get(f.path) || current.get(f.path) !== f.sha256);
    const inlineBytes = sourceFile.size + changed.reduce((n, f) => n + f.size, 0);
    const inline = inlineBytes <= INLINE_UPDATE_MAX_BYTES;
    if (opts["dry-run"]) {
      printDryRun(
        printable(
          `Would update ${ref} from v${base} to v${base + 1} on ${ctx.origin}: ${files.length} files (${formatBytes(total)}), ${changed.length} changed asset files, ${assets.length - changed.length} reused, ${inline ? "in one request" : "in one bundle"}.`,
        ),
        {
          id: detail.id,
          slug: detail.slug,
          type,
          base_version: base,
          next_version: base + 1,
          files: files.length,
          bytes: total,
          changed: changed.length,
          reused: assets.length - changed.length,
          send: inline ? "inline" : "bundle",
        },
        opts,
        ctx,
      );
      return EXIT.ok;
    }
    const note = opts.note !== undefined ? { note: opts.note } : {};
    try {
      if (inline) {
        const sourceText = utf8Text(sourceFile, readFileSync(sourceFile.abs));
        const withContent = new Set(changed.map((f) => f.path));
        const body = () => ({
          [sourceField(type)]: sourceText,
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
          ...category,
        });
        try {
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
        } catch (e) {
          if (!(e instanceof LostResponse)) throw e;
          result = await afterLostPut(e, { api, ref, detail, base, files, ctx }).catch((err) =>
            unknownOutcome(err, opts, ctx),
          );
        }
      } else {
        const ticket = await api.post("/uploads", {
          id: detail.id,
          base_version: base,
          ...note,
          ...category,
        });
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
          if (!(e instanceof LostResponse)) throw e;
          result = await afterLostBundle(e, {
            uploadUrl,
            uploadToken: ticket.upload_token,
            ctx,
            conflictMessage: () => staleBase(ref, base)(undefined),
            retry: { open: rerunWithBase(base), ended: rerunWithBase(base) },
            targetId: detail.id,
            base,
          }).catch((err) => unknownOutcome(err, opts, ctx));
        }
      }
    } catch (e) {
      throw conflict(e, staleBase(ref, base)) ?? apiFailure(e);
    }
  }

  // A recovered answer (upload status, or the artifact read after a lost PUT) has no category: read
  // the name the server stored back from the artifact, so --json still carries it.
  if (result.recovered && category.category !== undefined && typeof result.category !== "string") {
    result = { ...result, ...(await storedCategory(api, result.id)) };
  }
  const check = await verify(api, result, files);
  report(result, check, opts, ctx);
  return check.failed ? EXIT.error : EXIT.ok;
}

/** `{ category }` as the artifact holds it now (the owner's read), or `{}` when it cannot be read. */
async function storedCategory(api, id) {
  try {
    const a = await api.get(`/artifacts/${encodeURIComponent(id)}`);
    return typeof a.category === "string" ? { category: a.category } : {};
  } catch {
    return {};
  }
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
  const changed = (now) =>
    `The artifact changed since start_upload${now ? ` (now v${now})` : ""}. Read it again (get_artifact), then call start_upload with the new base_version.`;
  let result;
  try {
    result = await sendBundle({
      uploadUrl,
      uploadToken: token,
      files: sendOrder(files, sourcePath),
      ctx,
    });
  } catch (e) {
    if (!(e instanceof LostResponse)) throw conflict(e, changed) ?? apiFailure(e);
    const found = await afterLostBundle(e, {
      uploadUrl,
      uploadToken: token,
      ctx,
      conflictMessage: () => changed(undefined),
      retry: RETRY_UPLOAD,
    }).catch((err) => unknownOutcome(err, { json: true }, ctx));
    ctx.stdout(JSON.stringify(found, null, 2));
    ctx.stderr(
      `Published v${found.version}: ${found.url}\nThe server's answer was lost after it published; nothing was sent twice.`,
    );
    return EXIT.ok;
  }
  ctx.stdout(JSON.stringify(result, null, 2));
  ctx.stderr(`Published v${result.version}: ${result.url}`);
  const { fix, notes } = splitWarnings(result.warnings);
  if (fix.length) ctx.stderr(`${fix.length} warnings: fix them, then call start_upload again.`);
  for (const x of notes) ctx.stderr(printable(`Note (no action needed): ${x.message}`));
  return EXIT.ok;
}

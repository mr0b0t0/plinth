// The read path of the files people add to a page (docs/spec.md "Files people add to a page"):
// GET and HEAD /__plinth/files/<id> on the artifact's own content origin. A plain subresource
// read, outside /__plinth/api/, because <img>, <video> and <audio> cannot send x-plinth-data: it
// has no side effects and the same exposure as the version's own files, behind the same content
// pass. It is a `pass` row of content/serve.ts RESERVED_PATHS, so before it runs the content host
// has already refused other methods and service workers, sent top-level visits to the app's
// artifact page, loaded the live artifact and checked the pass (a 401 inside a frame, otherwise
// the gate redirect). Then, in order:
//   1. the id (FILE_ID_RE);
//   2. Sec-Fetch-Dest, when sent: image, video, audio, track, empty, or iframe (answered as an
//      attachment); never script, style, font, worker, manifest, object or embed;
//   3. availability (ALLOW_FILES with origin isolation), never for an in-chat preview pass;
//   4. the current version declares `files`;
//   5. a ready row of this artifact.
// Every answer carries the content headers; a file's answer adds `script-src 'none'` and a bare
// `sandbox` (no flags) to its CSP, the exact server-proven Content-Type, nosniff and CORP
// same-origin, so the bytes can never run as a document or a script on the artifact's origin.
import { contentDisposition, FILE_ID_RE } from "@plinth/shared";
import { type Bindings, type Config, filesActive } from "../config.ts";
import { versionCapabilities } from "../services/artifacts.ts";
import { fileObjectKey, getReadyFile } from "../services/files.ts";
import { applyContentHeaders, type ContentCspOptions } from "./csp.ts";
import type { PassGate } from "./serve.ts";

export const FILES_PREFIX = "/__plinth/files/";

/** Fetch destinations a file may be loaded as. Everything else (scripts, styles, fonts...) is 403. */
const ALLOWED_DESTS = new Set(["image", "video", "audio", "track", "empty", "iframe"]);

function plain(config: Config, status: number, body: string, opts: ContentCspOptions): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyContentHeaders(config, headers, opts);
  return new Response(body, { status, headers });
}

/** One `Range: bytes=` value: a single range, or "bad" (several, or none that fits). */
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | "bad" | null {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "bad";
  const [, a, b] = m;
  if (a === "" && b === "") return "bad";
  if (a === "") {
    const n = Number(b);
    if (!(n > 0)) return "bad";
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start) || start >= size) return "bad";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return "bad";
  return { offset: start, length: end - start + 1 };
}

/** The `pass` row's handler: a file's bytes for a page that may read them. */
export async function serveFile(
  request: Request,
  env: Bindings,
  config: Config,
  path: string,
  gate: PassGate,
): Promise<Response> {
  const framing = gate.pass.preview ? "any" : "app";
  const fail = (status: number, body: string) => plain(config, status, body, { framing });
  // 1. The id.
  const id = path.slice(FILES_PREFIX.length);
  if (!FILE_ID_RE.test(id)) return fail(404, "Not found");
  // 2. How the file is being loaded.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null && !ALLOWED_DESTS.has(dest)) return fail(403, "Not allowed");
  // 3. Availability. An in-chat preview never reads files.
  if (!filesActive(config) || gate.pass.preview) return fail(404, "Not found");
  // 4. The current version's declaration governs, for old version URLs too.
  const { artifact } = gate;
  const version = await env.DB.prepare(
    "SELECT capabilities FROM versions WHERE artifact_id = ?1 AND number = ?2",
  )
    .bind(artifact.id, artifact.currentVersion)
    .first<{ capabilities: string | null }>();
  if (versionCapabilities(version)?.files !== true) return fail(404, "Not found");
  // 5. A ready file of this artifact.
  const row = await getReadyFile(env.DB, artifact.id, id);
  if (!row) return fail(404, "Not found");

  const url = new URL(request.url);
  const attachment =
    row.content_type === "application/pdf" ||
    dest === "iframe" ||
    url.searchParams.get("download") === "1";
  const headers = new Headers({
    "Content-Type": row.content_type,
    "Content-Disposition": contentDisposition(attachment ? "attachment" : "inline", row.name),
    "Accept-Ranges": "bytes",
    ETag: `"f-${row.id}"`,
  });
  applyContentHeaders(config, headers, { scripts: "none", framing: "app", sandbox: "strict" });
  // Not immutable: a file the owner deletes stops showing at the next revalidation.
  headers.set("Cache-Control", "private, no-cache");
  // A file id's bytes never change, so its tag is strong and a match needs no R2 read.
  const inm = request.headers.get("if-none-match");
  if (inm?.split(",").some((t) => t.trim() === `"f-${row.id}"` || t.trim() === "*")) {
    return new Response(null, { status: 304, headers });
  }
  const key = fileObjectKey(artifact.id, row.id);
  const range = parseRange(request.headers.get("range"), row.size_bytes);
  if (range === "bad") {
    headers.set("Content-Range", `bytes */${row.size_bytes}`);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.delete("Content-Disposition");
    return new Response("Range not satisfiable", { status: 416, headers });
  }
  if (request.method === "HEAD") {
    const head = await env.FILES.head(key);
    if (!head) return fail(404, "Not found");
    headers.set("Content-Length", String(row.size_bytes));
    return new Response(null, { status: 200, headers });
  }
  const obj = await env.FILES.get(key, range ? { range } : undefined);
  if (!obj) return fail(404, "Not found");
  if (range) {
    const end = range.offset + range.length - 1;
    headers.set("Content-Range", `bytes ${range.offset}-${end}/${row.size_bytes}`);
    headers.set("Content-Length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(row.size_bytes));
  return new Response(obj.body, { status: 200, headers });
}

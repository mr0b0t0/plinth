// The files routes of the shared-data API (docs/spec.md "Files people add to a page"), under
// /__plinth/api/v1/files. They are rows of DATA_API_ROUTES (content/data-api.ts) with their own
// steps, as the live room's is: the dispatcher runs checks 1 to 4 (method, x-plinth-data, fetch
// metadata, exact Origin on writes) and the JSON type of check 6 before any handler here, so no
// file route can skip them. Then, in this order, keeping the data API's numbering:
//   5. availability: ALLOW_FILES with origin isolation (filesActive);
//   7. the artifact, with its current version's declaration;
//   8. the content pass for it at its current epoch: a JSON 401, never the gate redirect;
//   9. the declaration (`files`), for a view pass only: never an in-chat preview or a thumbnail
//      capture;
//   6. only now the body, through the route's own reader (JSON only, size-capped while reading),
//      and for a part only an uploader's, within the part rate limits: an instance with files off
//      or a caller without a pass never costs a part's read and decode;
//  10. policy (policy.ts pageFileAccess, canSendFilePart, canDeleteFile, through
//      services/files.ts), rate limits, quotas and the guarded write.
// While files are unavailable (off, opaque isolation, not declared, a preview), the session
// answers 200 `{ available: false, reason }` and every other files route 404 with the reason.
//
// Bytes travel as base64 inside JSON part bodies, `{"data":"<base64>"}`, so the JSON-body rule
// covers uploads too. readBase64PartBody is a streaming strict parser of exactly that shape: it
// decodes into one buffer of at most FILE_LIMITS.partBytes as the body arrives, so a part never
// costs more memory than its own bytes. Bodies and bytes are never logged.
import {
  createFileInput,
  FILE_ID_RE,
  FILE_LIMITS,
  type FilesUnavailableReason,
  maxPartBodyBytes,
  type PageFile,
} from "@plinth/shared";
import { filesActive } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { type PageClaim, pageFileAccess } from "../policy.ts";
import {
  createUpload,
  deleteFile,
  type FilesTarget,
  fileChanges,
  filesSession,
  filesUnavailableReason,
  getReadyFile,
  limitParts,
  listFiles,
  maybeSweepFiles,
  putPart,
  requireUploader,
  toPageFile,
} from "../services/files.ts";
import {
  afterResponse,
  loadTarget,
  type OwnRouteCtx,
  parseBody,
  readJsonBody,
  respond,
} from "./data-api.ts";
import { passKindOf } from "./files.ts";
import { readContentPass } from "./serve.ts";

// ---------- route matching ----------

export function matchFilesSession(seg: string[]): Record<string, string> | null {
  return seg.length === 2 && seg[0] === "files" && seg[1] === "session" ? {} : null;
}

export function matchFilesChanges(seg: string[]): Record<string, string> | null {
  return seg.length === 2 && seg[0] === "files" && seg[1] === "changes" ? {} : null;
}

export function matchFiles(seg: string[]): Record<string, string> | null {
  return seg.length === 1 && seg[0] === "files" ? {} : null;
}

export function matchFile(seg: string[]): Record<string, string> | null {
  return seg.length === 2 && seg[0] === "files" && FILE_ID_RE.test(seg[1] ?? "")
    ? { id: seg[1] as string }
    : null;
}

export function matchFilePart(seg: string[]): Record<string, string> | null {
  return seg.length === 4 &&
    seg[0] === "files" &&
    FILE_ID_RE.test(seg[1] ?? "") &&
    seg[2] === "parts" &&
    /^[1-9]\d{0,3}$/.test(seg[3] ?? "")
    ? { id: seg[1] as string, n: seg[3] as string }
    : null;
}

// ---------- bodies (check 6) ----------

/** A create body: small JSON, refused past FILE_LIMITS.createBodyBytes. */
export function readCreateBody(request: Request): Promise<unknown> {
  return readJsonBody(request, FILE_LIMITS.createBodyBytes);
}

const B64 = new Int16Array(256).fill(-1);
for (const [i, c] of [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
].entries())
  B64[c.charCodeAt(0)] = i;
const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const PREFIX = [0x22, 0x64, 0x61, 0x74, 0x61, 0x22]; // "data"

/**
 * A part body, exactly `{"data":"<base64>"}` with optional JSON whitespace between the tokens: a
 * strict subset of JSON (base64 needs no escapes), so any other key, shape, escape or trailing
 * text is refused, as a strict schema would. Decoded while the body streams in, into one buffer;
 * refused past `cap` bytes on the wire (whether or not a length was sent) or past
 * FILE_LIMITS.partBytes decoded. The handler then checks the exact length of the part.
 */
export async function readBase64PartBody(
  request: Request,
  cap: number = maxPartBodyBytes(),
): Promise<Uint8Array> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError("invalid_input", "Send a JSON body with Content-Type: application/json");
  }
  const tooLarge = () => new ApiError("payload_too_large", "The request body is too large");
  const shape = () =>
    new ApiError("invalid_input", 'A part body is {"data":"<base64>"} and nothing else');
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > cap)) {
    throw tooLarge();
  }
  const max = FILE_LIMITS.partBytes;
  let out = new Uint8Array(
    declared === null ? 64 * 1024 : Math.min(max, Math.ceil((Number(declared) * 3) / 4) + 3),
  );
  let len = 0;
  const push = (b: number) => {
    if (len >= out.length) {
      if (out.length >= max) throw tooLarge();
      const next = new Uint8Array(Math.min(max, out.length * 2));
      next.set(out);
      out = next;
    }
    out[len++] = b;
  };
  // 0 before "{", 1 before the key, 2 in the key, 3 before ":", 4 before the value, 5 in the value,
  // 6 before "}", 7 after "}".
  let stage = 0;
  let keyAt = 0;
  let quad = 0;
  let quadLen = 0;
  let pad = 0;
  let total = 0;
  const step = (b: number) => {
    switch (stage) {
      case 0:
        if (isWs(b)) return;
        if (b !== 0x7b) throw shape();
        stage = 1;
        return;
      case 1:
        if (isWs(b)) return;
        if (b !== PREFIX[0]) throw shape();
        stage = 2;
        keyAt = 1;
        return;
      case 2:
        if (b !== PREFIX[keyAt]) throw shape();
        keyAt++;
        if (keyAt === PREFIX.length) stage = 3;
        return;
      case 3:
        if (isWs(b)) return;
        if (b !== 0x3a) throw shape();
        stage = 4;
        return;
      case 4:
        if (isWs(b)) return;
        if (b !== 0x22) throw shape();
        stage = 5;
        return;
      case 5: {
        if (b === 0x22) {
          if (quadLen !== 0) throw shape();
          stage = 6;
          return;
        }
        if (b === 0x3d) {
          // "=" only as padding, at the end of the last quartet.
          if (quadLen < 2) throw shape();
          pad++;
          quadLen++;
        } else {
          const v = B64[b] ?? -1;
          if (v < 0 || pad > 0) throw shape();
          quad = (quad << 6) | v;
          quadLen++;
        }
        if (quadLen === 4) {
          const bits = quad << (6 * pad);
          push((bits >> 16) & 0xff);
          if (pad < 2) push((bits >> 8) & 0xff);
          if (pad < 1) push(bits & 0xff);
          quad = 0;
          quadLen = 0;
          if (pad > 0) stage = 51;
        }
        return;
      }
      case 51:
        // After padding, only the closing quote.
        if (b !== 0x22) throw shape();
        stage = 6;
        return;
      case 6:
        if (isWs(b)) return;
        if (b !== 0x7d) throw shape();
        stage = 7;
        return;
      default:
        if (!isWs(b)) throw shape();
    }
  };
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) throw tooLarge();
        for (let i = 0; i < value.length; i++) step(value[i] as number);
      }
    } catch (e) {
      await reader.cancel().catch(() => undefined);
      throw e;
    }
  }
  if (stage !== 7) throw shape();
  return out.subarray(0, len);
}

// ---------- steps 5 and 7 to 10 ----------

const unavailable = (reason: string) =>
  new ApiError("not_found", "Files are not available on this page", { reason });

interface Caller {
  target: FilesTarget;
  claim: PageClaim | null;
  access: ReturnType<typeof pageFileAccess>;
  /** The uploader, or null for a read-only caller. */
  writer: PageClaim | null;
}

/** Steps 5 and 7 to 10 for a files route: the caller, or why files are unavailable. */
async function filesCaller(c: OwnRouteCtx): Promise<Caller | FilesUnavailableReason> {
  const off = filesUnavailableReason(c.config, null, { assumeDeclared: true });
  if (off) return off;
  const loaded = await loadTarget(c.env, c.artifactId);
  if (!loaded) throw new ApiError("not_found", "Not found");
  const pass = await readContentPass(c.request, c.config, loaded);
  if (!pass) {
    throw new ApiError("unauthorized", "Your access expired. Reload the page.", {
      reason: "expired",
    });
  }
  const { target } = loaded;
  // An in-chat preview and Plinth's thumbnail capture never use files (policy.ts pageFileAccess):
  // both read as a preview to the page.
  const kind = passKindOf(pass);
  const reason = kind !== "view" ? "preview" : filesUnavailableReason(c.config, target.caps);
  if (reason) return reason;
  const { claim } = pass;
  const access = pageFileAccess(claim, target.caps, filesActive(c.config), kind);
  if (!access.read) return "not_declared";
  return { target, claim, access, writer: access.upload ? claim : null };
}

/** Run a files route: refuse while unavailable (the session says why), else the handler. */
async function withCaller(
  c: OwnRouteCtx,
  handler: (k: Caller) => Promise<Response>,
  session = false,
): Promise<Response> {
  const k = await filesCaller(c);
  if (typeof k === "string") {
    if (session) return respond(c.config, 200, { available: false, reason: k });
    throw unavailable(k);
  }
  return handler(k);
}

function intParam(v: string | null, name: string, min: number, max: number): number | undefined {
  if (v === null) return undefined;
  const n = /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= min && n <= max)) throw new ApiError("invalid_input", `${name}: ${min} to ${max}`);
  return n;
}

// ---------- handlers ----------

export async function filesSessionRoute(c: OwnRouteCtx): Promise<Response> {
  return withCaller(
    c,
    async (k) => respond(c.config, 200, await filesSession(c.env.DB, c.config, k.target, k.claim)),
    true,
  );
}

export async function filesChangesRoute(c: OwnRouteCtx): Promise<Response> {
  return withCaller(c, async (k) =>
    respond(c.config, 200, await fileChanges(c.env.DB, k.target.id)),
  );
}

export async function filesRoute(c: OwnRouteCtx): Promise<Response> {
  return withCaller(c, async (k) => {
    if (c.request.method === "POST") {
      const input = parseBody(createFileInput, await c.readBody());
      const { created } = await createUpload(c.env, c.config, k.target, k.writer, input);
      maybeSweepFiles(c.env, afterResponse);
      return respond(c.config, 201, created);
    }
    const url = new URL(c.request.url);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor.length > 400) throw new ApiError("invalid_input", "Bad cursor");
    const mine = url.searchParams.get("mine") === "1";
    if (mine && !k.claim) return respond(c.config, 200, { files: [], next_cursor: null });
    const page = await listFiles(c.env.DB, k.target.id, {
      limit: intParam(url.searchParams.get("limit"), "limit", 1, FILE_LIMITS.maxListLimit) ?? 50,
      cursor,
      ...(mine && k.claim ? { mineEmail: k.claim.email } : {}),
    });
    const files: PageFile[] = page.rows.map((r) => toPageFile(r, k.claim, k.access.seeIdentity));
    return respond(c.config, 200, { files, next_cursor: page.next_cursor });
  });
}

export async function fileRoute(c: OwnRouteCtx): Promise<Response> {
  return withCaller(c, async (k) => {
    const id = c.params.id as string;
    if (c.request.method === "DELETE") {
      await deleteFile(c.env, k.target, k.writer, id, afterResponse);
      return respond(c.config, 204, null);
    }
    const row = await getReadyFile(c.env.DB, k.target.id, id);
    if (!row) throw new ApiError("not_found", "File not found");
    return respond(c.config, 200, toPageFile(row, k.claim, k.access.seeIdentity));
  });
}

export async function filePartRoute(c: OwnRouteCtx): Promise<Response> {
  return withCaller(c, async (k) => {
    // Only an uploader's part is read, and within its own part rate limits.
    const w = requireUploader(k.writer);
    await limitParts(c.env.DB, c.config, k.target.id, w.email);
    const bytes = (await c.readBody()) as Uint8Array;
    const r = await putPart(
      c.env,
      k.target,
      k.writer,
      c.params.id as string,
      Number(c.params.n),
      bytes,
      k.access.seeIdentity,
    );
    return respond(c.config, 200, r);
  });
}

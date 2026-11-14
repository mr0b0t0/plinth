// Shared data and viewer identity (docs/spec.md "Shared data and viewer identity"): the capability
// declaration a page makes, the validation rules for collections, document ids and documents, the
// agent tool inputs, and the wire types. Pure code, used by the Worker and the web app.
import { z } from "zod";
import { DATA_CAPABILITIES, type DataCapability, type EffectiveRole, LIMITS } from "./constants.ts";
import { artifactRefSchema } from "./schemas.ts";

// ---------- capabilities ----------

/** What a version's index.html declares. Stored as JSON in versions.capabilities. */
export interface Capabilities {
  /** The shared document store. */
  data: boolean;
  /** The page may learn the viewer's email and role, and see who wrote each document. */
  viewer: boolean;
  /** Collections any writer may edit, not only each document's creator. */
  shared: string[];
}

export const CAPABILITIES_META = "plinth-capabilities";
export const DATA_SHARED_META = "plinth-data-shared";

/** A <meta> tag, attribute values may hold ">" when quoted. Linear: the alternatives are disjoint. */
const META_TAG_RE = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
/** One attribute: name, then an optional double-quoted, single-quoted or unquoted value. */
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

function metaAttributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(ATTR_RE)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function tokens(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Read a page's declaration from its HTML: the first <meta name="plinth-capabilities"> and the
 * first <meta name="plinth-data-shared">, in any attribute order and quote style, names compared
 * case-insensitively, tags inside HTML comments ignored. Unknown tokens are ignored, and so are
 * shared names that break the collection rule; at most LIMITS.maxDataShared are kept. Returns null
 * unless `data` is declared: the viewer is learned through the data API, so `viewer` alone declares
 * nothing, and neither does a shared list alone.
 */
export function parseCapabilities(html: string): Capabilities | null {
  if (!/plinth-/i.test(html)) return null;
  const text = html.replace(COMMENT_RE, "");
  let declared: string[] | null = null;
  let sharedNames: string[] | null = null;
  for (const m of text.matchAll(META_TAG_RE)) {
    const attrs = metaAttributes(m[1] ?? "");
    const name = attrs.get("name")?.trim().toLowerCase();
    if (name === CAPABILITIES_META && declared === null) {
      declared = tokens(attrs.get("content") ?? "");
    } else if (name === DATA_SHARED_META && sharedNames === null) {
      sharedNames = tokens(attrs.get("content") ?? "");
    }
    if (declared !== null && sharedNames !== null) break;
  }
  const known = new Set<DataCapability>(
    (declared ?? []).filter((t): t is DataCapability =>
      (DATA_CAPABILITIES as readonly string[]).includes(t),
    ),
  );
  if (!known.has("data")) return null;
  const shared: string[] = [];
  for (const n of sharedNames ?? []) {
    if (shared.length >= LIMITS.maxDataShared) break;
    if (DATA_COLLECTION_RE.test(n) && !shared.includes(n)) shared.push(n);
  }
  return { data: true, viewer: known.has("viewer"), shared };
}

/** The declared capabilities as a list, in a fixed order. */
export function capabilityList(c: Capabilities | null): DataCapability[] {
  if (!c) return [];
  return DATA_CAPABILITIES.filter((k) => c[k]);
}

// ---------- validation ----------

export const DATA_COLLECTION_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const DATA_DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Alias for the caller's own personal document (its id is the caller's viewer id). */
export const ME_DOC_ID = "~me";
/** Personal documents: `u_` plus 24 hex characters of the person's per-artifact viewer id. */
export const PERSONAL_DOC_PREFIX = "u_";

export function isPersonalDocId(id: string): boolean {
  return id.startsWith(PERSONAL_DOC_PREFIX);
}

export const dataCollectionSchema = z
  .string()
  .regex(DATA_COLLECTION_RE, "Collection: lowercase letter, then up to 39 of a-z 0-9 _ -")
  .describe("Collection name");

export const dataDocIdSchema = z
  .string()
  .refine(
    (s) => s === ME_DOC_ID || DATA_DOC_ID_RE.test(s),
    "Document id: a letter or digit, then up to 63 of A-Z a-z 0-9 _ -, or ~me",
  )
  .describe("Document id, or ~me for your own personal document");

/** UTF-8 length of a string, without TextEncoder (this package targets plain ES2023). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** UTF-8 bytes of a document's JSON, as stored. */
export function dataByteSize(data: unknown): number {
  return utf8Length(JSON.stringify(data));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Why a value is not a JSON document of at most `maxDepth` levels (objects and arrays each count
 * one), or null when it is. Iterative, and it stops at the first level past the limit, so deep
 * input cannot exhaust the stack.
 */
export function dataShapeError(value: unknown, maxDepth = LIMITS.maxDataDepth): string | null {
  if (!isPlainObject(value)) return "Data must be a JSON object";
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 1 }];
  while (stack.length > 0) {
    const { v, depth } = stack.pop() as { v: unknown; depth: number };
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "Numbers must be finite";
      continue;
    }
    const children = Array.isArray(v) ? v : isPlainObject(v) ? Object.values(v) : null;
    if (children === null) return "Data must contain only JSON values";
    if (depth > maxDepth) return `Data nests more than ${maxDepth} levels`;
    for (const c of children) stack.push({ v: c, depth: depth + 1 });
  }
  return null;
}

/** A plain JSON object nesting at most LIMITS.maxDataDepth levels. No size check. */
export const dataObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((v, ctx) => {
    const err = dataShapeError(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  })
  .describe("A JSON object");

/** dataObjectSchema plus a size cap in UTF-8 bytes of its JSON (DATA_MAX_DOC_BYTES). */
export function dataObjectWithin(maxBytes: number) {
  return dataObjectSchema.superRefine((v, ctx) => {
    if (dataShapeError(v) !== null) return;
    if (dataByteSize(v) > maxBytes) {
      ctx.addIssue({ code: "custom", message: `Data is over ${maxBytes} bytes` });
    }
  });
}

// ---------- agent tool inputs (list_artifact_data, write_artifact_data) ----------

export const listArtifactDataInput = z
  .object({
    id: artifactRefSchema,
    collection: dataCollectionSchema.optional(),
    doc_id: dataDocIdSchema.optional(),
    limit: z.number().int().min(1).max(LIMITS.maxDataListLimit).default(50),
    cursor: z.string().max(400).optional().describe("next_cursor from the previous page"),
  })
  .refine((v) => v.doc_id === undefined || v.collection !== undefined, {
    message: "doc_id needs a collection",
    path: ["doc_id"],
  });

const setOpSchema = z.object({
  op: z.literal("set"),
  collection: dataCollectionSchema,
  doc_id: dataDocIdSchema.optional().describe("Omit to create a document with a server id"),
  data: dataObjectSchema,
  if_rev: z
    .number()
    .int()
    .min(0)
    .describe("0 creates (fails if the document exists); n replaces only at rev n"),
});

const deleteOpSchema = z.object({
  op: z.literal("delete"),
  collection: dataCollectionSchema,
  doc_id: dataDocIdSchema,
  if_rev: z.number().int().min(1).describe("Deletes only when the current rev is this"),
});

export const dataOpSchema = z.discriminatedUnion("op", [setOpSchema, deleteOpSchema]);
export type DataOp = z.infer<typeof dataOpSchema>;

export const writeArtifactDataInput = z.object({
  id: artifactRefSchema,
  ops: z.array(dataOpSchema).min(1).max(LIMITS.maxDataOps),
});

// ---------- wire types ----------

/** How a document was written: from the page (content cookie), by an agent, or from the app. */
export type DataVia = "page" | "agent" | "app";

/** Why shared data is unavailable to a page. */
export type DataUnavailableReason = "opaque_isolation" | "disabled" | "not_declared";

/** Server-derived author of a write, as a page sees it (only with `viewer` and when identified). */
export interface PageDocAuthor {
  email: string | null;
  role: EffectiveRole | null;
  via: DataVia;
}

/** A document as the content-host API returns it. */
export interface PageDoc {
  id: string;
  data: Record<string, unknown>;
  rev: number;
  /** The reader created it (false for anonymous readers). */
  mine: boolean;
  /** A `u_` document that belongs to one person. */
  personal: boolean;
  created_at: string;
  updated_at: string;
  created_by?: PageDocAuthor;
  updated_by?: PageDocAuthor;
}

/** Server-derived author of a write, as owners' and editors' agents see it. */
export interface AgentDocAuthor {
  email: string | null;
  role: EffectiveRole | null;
  via: DataVia;
  connection_label: string | null;
  viewer_id: string | null;
}

/** A document as list_artifact_data and the REST mirror return it. Untrusted input for agents. */
export interface AgentDoc {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  rev: number;
  personal: boolean;
  created_at: string;
  updated_at: string;
  created_by: AgentDocAuthor;
  updated_by: AgentDocAuthor;
}

/** GET /__plinth/api/v1/session. Always 200; `available: false` says why. */
export type DataSession =
  | { available: false; reason: DataUnavailableReason }
  | {
      available: true;
      /** null for anonymous link viewers. `email` only when the page declares `viewer`. */
      viewer: { id: string; email: string | null; role: EffectiveRole } | null;
      can_write: boolean;
      capabilities: DataCapability[];
      shared: string[];
      limits: { max_doc_bytes: number; max_docs: number; max_bytes: number };
      usage: { docs: number; bytes: number };
      seq: number;
    };

/** What get_artifact adds to an artifact's detail (owners' and editors' agents see the usage). */
export interface ArtifactDataInfo {
  /** What the returned version declares; empty when nothing. */
  capabilities: DataCapability[];
  /** Totals of the artifact's shared data; null when there is none or the caller cannot read it. */
  data_usage: { docs: number; bytes: number } | null;
}

/** Limits as list_artifact_data and the page session report them. */
export interface DataLimits {
  max_doc_bytes: number;
  max_docs: number;
  max_bytes: number;
}

/** list_artifact_data without a collection. Untrusted input for agents. */
export interface DataSummary {
  capabilities: DataCapability[];
  /** Pages can use shared data right now (on, origin isolation, declared). */
  available: boolean;
  usage: { docs: number; bytes: number };
  limits: DataLimits;
  collections: { name: string; docs: number; bytes: number; updated_at: string }[];
  untrusted: string;
}

/** list_artifact_data with a collection. */
export interface DataPage {
  docs: AgentDoc[];
  next_cursor: string | null;
  untrusted: string;
}

/** list_artifact_data with a collection and doc_id. */
export interface DataDocResult {
  doc: AgentDoc;
  untrusted: string;
}

/** One write_artifact_data op's outcome; ops succeed or fail on their own. */
export interface DataOpResult {
  op: "set" | "delete";
  collection: string;
  doc_id: string | null;
  ok: boolean;
  rev?: number;
  error?: { code: string; message: string; details?: unknown };
}

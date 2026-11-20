// Shared data and viewer identity (docs/spec.md "Shared data and viewer identity"): the capability
// declaration a page makes, the validation rules for collections, document ids and documents, the
// agent tool inputs, and the wire types. Pure code, used by the Worker and the web app.
import { z } from "zod";
import {
  CAPABILITY_TOKENS,
  DATA_CAPABILITIES,
  type DataCapability,
  type EffectiveRole,
  LIMITS,
} from "./constants.ts";
import { ROOM_LIMITS, ROOM_OPEN_ALL, ROOM_OPEN_META, ROOM_TOPIC_RE } from "./room.ts";
import { artifactRefSchema } from "./schemas.ts";
import { utf8Length } from "./utf8.ts";

// ---------- capabilities ----------

/** What a version's index.html declares. Stored as JSON in versions.capabilities. */
export interface Capabilities {
  /** The shared document store. */
  data: boolean;
  /** The page may learn the viewer's email and role, and see who wrote each document. */
  viewer: boolean;
  /** Collections any writer may edit, not only each document's creator. */
  shared: string[];
  /** The live room (presence and broadcast, `plinth.room`). Not shared data. */
  room: boolean;
  /** Topics commenters may emit too (plinth-room-open); `*` opens all. Viewers never emit. */
  roomOpen: string[];
  /** The page may open the comment composer with its own anchors (`plinth.comments`). */
  comments: boolean;
  /**
   * The owner and editors may list everyone with access from the page (/__plinth/api/v1/people).
   * Counts only with `data` and `viewer`.
   */
  people: boolean;
  /**
   * Set by the server for a type whose capabilities are fixed (a whiteboard's, from its settings),
   * never read from HTML: the lowest role that may write shared data and emit open topics from the
   * page. Policy (policy.ts pageWriteFloor) treats a missing or unknown value on such a type as
   * "editor", never as "any viewer". Absent on every HTML declaration.
   */
  writers?: PageWriters;
  /**
   * While the viewer is using the page (focus inside its frame), a newer version waits behind an
   * Update button instead of replacing it (docs/spec.md "Live views"). Not shared data, no API.
   */
  hold: boolean;
}

/** The roles a server-set write floor may name (Capabilities.writers). */
export const PAGE_WRITERS = ["commenter", "editor"] as const;
export type PageWriters = (typeof PAGE_WRITERS)[number];

export const CAPABILITIES_META = "plinth-capabilities";
export const DATA_SHARED_META = "plinth-data-shared";

type TokenKey = {
  [K in keyof Capabilities]-?: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];
type ListKey = {
  [K in keyof Capabilities]-?: Capabilities[K] extends string[] ? K : never;
}[keyof Capabilities];
type ServerKey = Exclude<keyof Capabilities, TokenKey | ListKey>;

/** A capability token (constants.ts CAPABILITY_TOKENS) at its place in the stored JSON. */
interface TokenField {
  kind: "token";
  key: TokenKey & DataCapability;
}

/**
 * An auxiliary meta: a list that refines one token's declaration. It counts only when `needs` is
 * declared. `stored`: `always`, or only when that token is declared. `checkOnRead`: entries of a
 * stored row are checked against `accept` again when read.
 */
interface ListField {
  kind: "list";
  key: ListKey;
  meta: string;
  needs: DataCapability;
  stored: "always" | DataCapability;
  max: number;
  accept: (entry: string) => boolean;
  checkOnRead: boolean;
}

/**
 * A field the server sets for a type with fixed capabilities (artifactTypes.ts pageData "fixed"),
 * never parsed from a page: stored only when set, and read back only when `accept` takes the
 * stored value (anything else is dropped, and policy applies its fail-closed default).
 */
interface ServerField {
  kind: "server";
  key: ServerKey;
  accept: (value: unknown) => boolean;
}

export type DeclarationField = TokenField | ListField | ServerField;

/**
 * The declaration registry: every field of Capabilities, one per line, in the order the stored
 * JSON (versions.capabilities) writes them. Tokens come from CAPABILITY_TOKENS; lists are read from
 * their own <meta>. A feature adds its token there and its line here; parseCapabilities,
 * serializeCapabilities and readStoredCapabilities follow.
 */
export const DECLARATION_FIELDS: readonly DeclarationField[] = [
  { kind: "token", key: "data" },
  { kind: "token", key: "viewer" },
  {
    kind: "list",
    key: "shared",
    meta: DATA_SHARED_META,
    needs: "data",
    stored: "always",
    max: LIMITS.maxDataShared,
    accept: (n) => DATA_COLLECTION_RE.test(n),
    checkOnRead: false,
  },
  { kind: "token", key: "room" },
  {
    kind: "list",
    key: "roomOpen",
    meta: ROOM_OPEN_META,
    needs: "room",
    stored: "room",
    max: ROOM_LIMITS.maxOpenTopics,
    accept: (t) => t === ROOM_OPEN_ALL || ROOM_TOPIC_RE.test(t),
    checkOnRead: true,
  },
  { kind: "token", key: "comments" },
  { kind: "token", key: "people" },
  {
    kind: "server",
    key: "writers",
    accept: (v) => (PAGE_WRITERS as readonly unknown[]).includes(v),
  },
  { kind: "token", key: "hold" },
];

const TOKEN_INFO = new Map<string, (typeof CAPABILITY_TOKENS)[number]>(
  CAPABILITY_TOKENS.map((t) => [t.token, t]),
);

function tokenInfo(token: DataCapability): (typeof CAPABILITY_TOKENS)[number] {
  return TOKEN_INFO.get(token) as (typeof CAPABILITY_TOKENS)[number];
}

/** Whether a field is in the stored JSON of this declaration. */
function isStored(f: DeclarationField, c: Capabilities): boolean {
  if (f.kind === "server") return c[f.key] !== undefined;
  if (f.kind === "token") return tokenInfo(f.key).stored === "always" || c[f.key] === true;
  return f.stored === "always" || c[f.stored] === true;
}

/** The tokens that count: declared, with every token they need counting too. */
function countedTokens(declared: ReadonlySet<string>): Set<DataCapability> {
  const out = new Set<DataCapability>();
  const counts = (t: DataCapability, seen: ReadonlySet<string>): boolean =>
    declared.has(t) &&
    !seen.has(t) &&
    (tokenInfo(t).needs as readonly DataCapability[]).every((n) =>
      counts(n, new Set([...seen, t])),
    );
  for (const t of DATA_CAPABILITIES) if (counts(t, new Set())) out.add(t);
  return out;
}

/** A declaration counts only when a token that declares on its own is there. */
function declaresSomething(counted: ReadonlySet<DataCapability>): boolean {
  return CAPABILITY_TOKENS.some((t) => t.declares && counted.has(t.token));
}

/** A meta tag, attribute values may hold ">" when quoted. Linear: the alternatives are disjoint. */
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
 * first of each registered list meta (plinth-data-shared, plinth-room-open), in any attribute
 * order and quote style, names compared case-insensitively, tags inside HTML comments ignored.
 * Every meta tag is read, so a registered meta after the others is never missed. Unknown tokens
 * are ignored, and so are list entries that break their rule; at most each list's `max` are kept
 * (LIMITS.maxDataShared, ROOM_LIMITS.maxOpenTopics). Returns null unless `data`, `room`,
 * `comments` or `hold` is declared: the viewer is learned through the data API or the room, so
 * `viewer` alone declares nothing, and neither does a list alone. Shared names count only with
 * `data`, open topics only with `room`. A page that declares only `comments` or `hold` has no store
 * and no room.
 */
export function parseCapabilities(html: string): Capabilities | null {
  if (!/plinth-/i.test(html)) return null;
  const text = html.replace(COMMENT_RE, "");
  const wanted = new Set<string>([CAPABILITIES_META]);
  for (const f of DECLARATION_FIELDS) if (f.kind === "list") wanted.add(f.meta);
  const found = new Map<string, string[]>();
  for (const m of text.matchAll(META_TAG_RE)) {
    const attrs = metaAttributes(m[1] ?? "");
    const name = attrs.get("name")?.trim().toLowerCase();
    if (name !== undefined && wanted.has(name) && !found.has(name)) {
      found.set(name, tokens(attrs.get("content") ?? ""));
    }
  }
  const counted = countedTokens(new Set(found.get(CAPABILITIES_META) ?? []));
  if (!declaresSomething(counted)) return null;
  const out: Record<string, boolean | string[]> = {};
  for (const f of DECLARATION_FIELDS) {
    // A server-set field is never read from a page.
    if (f.kind === "server") continue;
    if (f.kind === "token") {
      out[f.key] = counted.has(f.key);
      continue;
    }
    const list: string[] = [];
    for (const e of counted.has(f.needs) ? (found.get(f.meta) ?? []) : []) {
      if (list.length >= f.max) break;
      if (f.accept(e) && !list.includes(e)) list.push(e);
    }
    out[f.key] = list;
  }
  return out as unknown as Capabilities;
}

/**
 * The JSON stored in versions.capabilities, keys in registry order. A key whose field is stored
 * only with its token is written only when that token is declared, so a declaration without it is
 * stored exactly as before the token existed (the room fields: a stored row without them reads as
 * room: false, roomOpen: []).
 */
export function serializeCapabilities(c: Capabilities): string {
  const out: Record<string, unknown> = {};
  for (const f of DECLARATION_FIELDS) if (isStored(f, c)) out[f.key] = c[f.key];
  return JSON.stringify(out);
}

/**
 * A stored declaration (versions.capabilities) read back, with the registry's defaults for the
 * fields it does not hold (false, or an empty list). Null when nothing is declared, or when the
 * value is malformed: an `always` token that is not a boolean. A token stored only when declared
 * counts only when it is `true`; a list stored with a token is read only when that token counts.
 */
export function readStoredCapabilities(json: string): Capabilities | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const row = v as Record<string, unknown>;
  const declared = new Set<string>();
  for (const t of CAPABILITY_TOKENS) {
    const value = row[t.token];
    if (t.stored === "always" && typeof value !== "boolean") return null;
    if (value === true) declared.add(t.token);
  }
  const counted = countedTokens(declared);
  if (!declaresSomething(counted)) return null;
  const out: Record<string, boolean | string | string[]> = {};
  for (const f of DECLARATION_FIELDS) {
    if (f.kind === "server") {
      const value = row[f.key];
      if (f.accept(value)) out[f.key] = value as string;
      continue;
    }
    if (f.kind === "token") {
      out[f.key] = counted.has(f.key);
      continue;
    }
    const value = row[f.key];
    const readable = f.stored === "always" || counted.has(f.stored);
    out[f.key] =
      readable && Array.isArray(value)
        ? value.filter((e): e is string => typeof e === "string" && (!f.checkOnRead || f.accept(e)))
        : [];
  }
  return out as unknown as Capabilities;
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

export { utf8Length };

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

/**
 * Why shared data is unavailable to a page. `preview`: the page is shown in an agent's thread
 * (an MCP App), through a read-only pass that carries no identity. `capture`: Plinth's thumbnail
 * browser is taking a picture of a version whose writer may not read the data (a token limited to
 * one artifact wrote it).
 */
export type DataUnavailableReason =
  | "opaque_isolation"
  | "disabled"
  | "not_declared"
  | "preview"
  | "capture";

/** Server-derived author of a write, as a page sees it (only with `viewer` and when identified). */
export interface PageDocAuthor {
  email: string | null;
  /** The writer's display name, read live (displayName.ts pageDisplayName); null without one. */
  name: string | null;
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
  /** Display text chosen by the writer: untrusted, never proof of role. */
  name: string | null;
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
      /**
       * null for anonymous link viewers. `email` and `name` only when the page declares `viewer`;
       * `name` is null without an account name.
       */
      viewer: { id: string; email: string | null; name: string | null; role: EffectiveRole } | null;
      can_write: boolean;
      /** The reader may list the page's people (owner or editor, the page declares `people`). */
      can_list_people: boolean;
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
  /**
   * Everyone with access (the owner, then grants by email). Present only when the current version
   * declares `data viewer people` and shared data is on: the same people a page's owner and
   * editors can list, under the same notice to viewers.
   */
  people?: AgentPerson[];
  untrusted: string;
}

// ---------- people (docs/spec.md "Who is viewing: names and the people list") ----------

/** One person with access to an artifact, as an owner's or editor's page sees them. */
export interface PagePerson {
  /** The per-artifact `u_` viewer id: what a personal document of theirs is called. */
  id: string;
  email: string;
  /** Display text chosen by the person, or null. Never authority. */
  name: string | null;
  role: EffectiveRole;
  /** This is the reader. */
  you: boolean;
}

/** GET /__plinth/api/v1/people */
export interface PagePeopleList {
  people: PagePerson[];
  /** How many matched before `limit`. */
  total: number;
}

/** One person with access, as owners' and editors' agents see them. Untrusted input for agents. */
export interface AgentPerson {
  viewer_id: string;
  email: string;
  name: string | null;
  role: EffectiveRole;
}

/** GET /api/v1/artifacts/:ref/people */
export interface PeopleResult {
  people: AgentPerson[];
  /** How many matched `q` in all, before `limit`. */
  total: number;
  untrusted: string;
}

/**
 * The most people one list returns: the owner and every direct grant (LIMITS.maxAllowlistEmails).
 * With a shared category's people the list can be longer; `total` counts them all.
 */
export const MAX_PEOPLE_LISTED = LIMITS.maxAllowlistEmails + 1;

/** A people search: every whitespace-separated term must match a name or an email. */
export const peopleQuerySchema = z
  .string()
  .trim()
  .max(LIMITS.maxPeopleQueryLength)
  .describe("Search terms, matched against names and emails");

/** GET /api/v1/artifacts/:ref/people */
export const listArtifactPeopleInput = z.object({
  id: artifactRefSchema,
  q: peopleQuerySchema.optional(),
  limit: z.number().int().min(1).max(MAX_PEOPLE_LISTED).optional(),
});

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

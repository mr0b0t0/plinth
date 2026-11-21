// Shared data: one fixed JSON document store per artifact (docs/spec.md "Shared data and viewer
// identity"). One implementation for the page API on the content host, REST and MCP. Every
// decision goes through policy.ts (pageDataAccess, canModifyDoc); the ownership condition is
// repeated in the SQL of each guarded write, so a delete-and-recreate race cannot slip past it.
//
// Exact totals live in artifact_data_usage, kept by triggers (migrations/0005_shared_state.sql).
// D1's meta.changes counts the rows those triggers touch, so writes learn what happened from
// RETURNING, never from a change count.
import {
  type AgentDoc,
  type AgentDocAuthor,
  type AgentPerson,
  boardDocError,
  type Capabilities,
  capabilityList,
  DATA_COLLECTION_RE,
  DATA_DOC_ID_RE,
  type DataOp,
  type DataOpResult,
  type DataSession,
  type DataSummary,
  type DataUnavailableReason,
  type DataVia,
  dataShapeError,
  type EffectiveRole,
  isPersonalDocId,
  LIMITS,
  ME_DOC_ID,
  mergeDocData,
  type PageDoc,
  type PageDocAuthor,
  staleBoardWrite,
  utf8Length,
} from "@plinth/shared";
import { type Config, dataLimitsFor, sharedDataActive } from "../config.ts";
import { base64url, fromBase64url, newId, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import {
  canModifyDoc,
  type PageClaim,
  pageDataAccess,
  pagePeopleAccess,
  peopleListOffered,
  type VersionWriter,
} from "../policy.ts";
import { type Person, peopleWithAccess } from "./people.ts";
import { nameByEmail, namesByEmail } from "./users.ts";

/** Who is writing, as the server knows it. Stamps come only from here, never from the request. */
export interface DataWriter {
  email: string;
  role: EffectiveRole;
  /** The writer's per-artifact viewer id (crypto.ts viewerIdFor); what "~me" resolves to. */
  viewerId: string;
  via: DataVia;
  /** Agent connection label at write time. */
  label?: string | null;
}

/** The artifact whose data is used, with its current version's declaration. */
export interface DataTarget {
  id: string;
  ownerId: string;
  caps: Capabilities | null;
  /**
   * Who wrote the versions the content host serves (policy.ts peopleListOffered), loaded only on a
   * page that declares `people`. Absent or null offers no people list, so a caller that does not
   * load it never opens the list.
   */
  writers?: readonly VersionWriter[] | null;
  /**
   * The artifact's stored type (artifacts.type): policy's write floor depends on it, and a
   * whiteboard's documents are checked against the board's shapes.
   */
  type: string;
}

/** A row of artifact_docs as D1 returns it. */
export interface StoredDoc {
  artifact_id: string;
  collection: string;
  doc_id: string;
  data: string;
  size_bytes: number;
  rev: number;
  created_by_email: string | null;
  created_by_role: EffectiveRole | null;
  created_via: DataVia;
  created_by_label: string | null;
  created_at: string;
  updated_by_email: string | null;
  updated_by_role: EffectiveRole | null;
  updated_via: DataVia;
  updated_by_label: string | null;
  updated_at: string;
}

export type QuotaLimit = "docs" | "bytes" | "user_bytes" | "collections";

const HOUR_S = 3600;
/** A plain set (no if_rev) tries once and retries up to three times on a race. */
const PLAIN_SET_ATTEMPTS = 4;

// ---------- errors ----------

const invalid = (message: string) => new ApiError("invalid_input", message);
const quota = (limit: QuotaLimit) =>
  new ApiError("quota_exceeded", `This artifact's shared data is full (${limit})`, { limit });
/** quota_exceeded with the limit that stopped a write. */
export const quotaExceeded = quota;
const conflict = (currentRev: number) =>
  new ApiError("conflict", "The document changed since you read it", { current_rev: currentRev });
const docNotFound = () => new ApiError("not_found", "Document not found");
const denied = (reason: "read_only" | "forbidden") =>
  reason === "read_only"
    ? new ApiError("forbidden", "Only people this artifact is shared with can write here", {
        reason: "read_only",
      })
    : new ApiError("forbidden", "You cannot change this document");

// ---------- availability and reads ----------

/**
 * Why the page API is unavailable for this artifact, or null when it is available. Only `data`
 * counts as a declaration: a page that declares `room` alone has no shared data. With
 * `assumeDeclared`, only the instance-wide reasons are checked (before the artifact is loaded).
 */
export function unavailableReason(
  config: Pick<Config, "allowSharedData" | "contentIsolation">,
  caps: Capabilities | null,
  opts: { assumeDeclared?: boolean } = {},
): DataUnavailableReason | null {
  if (config.contentIsolation === "opaque") return "opaque_isolation";
  if (!config.allowSharedData) return "disabled";
  if (opts.assumeDeclared !== true && caps?.data !== true) return "not_declared";
  return null;
}

async function usageOf(
  d1: D1Database,
  artifactId: string,
): Promise<{ docs: number; bytes: number; seq: number }> {
  const row = await d1
    .prepare("SELECT docs, bytes, seq FROM artifact_data_usage WHERE artifact_id = ?1")
    .bind(artifactId)
    .first<{ docs: number; bytes: number; seq: number }>();
  return row ?? { docs: 0, bytes: 0, seq: 0 };
}

/** The caps a page and an agent are told: a whiteboard's own, or the instance's (dataLimitsFor). */
function limitsOf(config: Config, type: string) {
  const l = dataLimitsFor(config, type);
  return {
    max_doc_bytes: l.maxDocBytes,
    max_docs: l.maxDocsPerArtifact,
    max_bytes: l.maxBytesPerArtifact,
  };
}

/** GET /__plinth/api/v1/session for a reader with a content pass. */
export async function session(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  claim: PageClaim | null,
): Promise<DataSession> {
  const reason = unavailableReason(config, target.caps);
  if (reason) return { available: false, reason };
  const active = sharedDataActive(config);
  const access = pageDataAccess(claim, target.caps, active, target.type);
  const usage = await usageOf(d1, target.id);
  // The name is read only when the page may see who this is (a link viewer triggers no read).
  const name = claim && access.seeIdentity ? await nameByEmail(d1, claim.email) : null;
  return {
    available: true,
    viewer: claim
      ? {
          id: claim.viewerId,
          email: access.seeIdentity ? claim.email : null,
          name,
          role: claim.role,
        }
      : null,
    can_write: access.write,
    can_list_people: pagePeopleAccess(claim, target.caps, active, target.writers ?? null).list,
    capabilities: capabilityList(target.caps),
    shared: target.caps?.shared ?? [],
    limits: limitsOf(config, target.type),
    usage: { docs: usage.docs, bytes: usage.bytes },
    seq: usage.seq,
  };
}

/** The change counter the runtime polls: one row. */
export async function changes(d1: D1Database, artifactId: string): Promise<{ seq: number }> {
  return { seq: (await usageOf(d1, artifactId)).seq };
}

/**
 * What an agent sees first: declaration, usage, limits and one line per collection, plus `people`
 * (everyone with access) only when the page offers its people list (policy.ts peopleListOffered),
 * read by `readerEmail` so the caller's own row carries their name.
 */
export async function summary(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  readerEmail: string | null,
): Promise<Omit<DataSummary, "untrusted">> {
  const usage = await usageOf(d1, target.id);
  const { results } = await d1
    .prepare(
      `SELECT collection AS name, count(*) AS docs, sum(size_bytes) AS bytes, max(updated_at) AS updated_at
         FROM artifact_docs WHERE artifact_id = ?1 GROUP BY collection ORDER BY collection`,
    )
    .bind(target.id)
    .all<{ name: string; docs: number; bytes: number; updated_at: string }>();
  const people = peopleListOffered(target.caps, sharedDataActive(config), target.writers ?? null)
    ? await peopleWithAccess(
        d1,
        config.tokenSigningKey,
        target.id,
        readerEmail,
        config.allowCategorySharing,
      )
    : null;
  return {
    capabilities: capabilityList(target.caps),
    available: unavailableReason(config, target.caps) === null,
    usage: { docs: usage.docs, bytes: usage.bytes },
    limits: limitsOf(config, target.type),
    collections: results,
    ...(people ? { people: people.map(toAgentPerson) } : {}),
  };
}

/** A person with access as owners' and editors' agents see them. */
export function toAgentPerson(p: Person): AgentPerson {
  return { viewer_id: p.id, email: p.email, name: p.name, role: p.role };
}

function checkCollection(collection: string): void {
  if (!DATA_COLLECTION_RE.test(collection)) {
    throw invalid("Collection: a lowercase letter, then up to 39 of a-z 0-9 _ -");
  }
}

function checkDocId(docId: string): void {
  if (!DATA_DOC_ID_RE.test(docId)) {
    throw invalid("Document id: a letter or digit, then up to 63 of A-Z a-z 0-9 _ -");
  }
}

/** "~me" is the caller's own personal document. Null when the caller has none (anonymous). */
export function resolveDocId(docId: string, viewerId: string | null): string | null {
  return docId === ME_DOC_ID ? viewerId : docId;
}

function encodeCursor(createdAt: string, docId: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify([createdAt, docId])));
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64url(cursor)),
    );
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      typeof v[1] === "string"
    ) {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw invalid("Bad cursor");
}

/** One page of a collection, in creation order. The cursor is base64url of [created_at, doc_id]. */
export async function listDocs(
  d1: D1Database,
  artifactId: string,
  collection: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<{ docs: StoredDoc[]; next_cursor: string | null }> {
  checkCollection(collection);
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxDataListLimit) {
    throw invalid(`limit must be 1 to ${LIMITS.maxDataListLimit}`);
  }
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const stmt = after
    ? d1
        .prepare(
          `SELECT * FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2
             AND (created_at, doc_id) > (?3, ?4) ORDER BY created_at, doc_id LIMIT ?5`,
        )
        .bind(artifactId, collection, after[0], after[1], limit + 1)
    : d1
        .prepare(
          `SELECT * FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2
             ORDER BY created_at, doc_id LIMIT ?3`,
        )
        .bind(artifactId, collection, limit + 1);
  const { results } = await stmt.all<StoredDoc>();
  const docs = results.slice(0, limit);
  const last = docs[docs.length - 1];
  return {
    docs,
    next_cursor: results.length > limit && last ? encodeCursor(last.created_at, last.doc_id) : null,
  };
}

export async function getDoc(
  d1: D1Database,
  artifactId: string,
  collection: string,
  docId: string,
): Promise<StoredDoc | null> {
  checkCollection(collection);
  checkDocId(docId);
  return d1
    .prepare(
      "SELECT * FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3",
    )
    .bind(artifactId, collection, docId)
    .first<StoredDoc>();
}

// ---------- views ----------

function parseData(row: StoredDoc): Record<string, unknown> {
  return JSON.parse(row.data) as Record<string, unknown>;
}

/** Display names by email, from namesByEmail. A missing email reads as no name. */
export type NameMap = ReadonlyMap<string, string | null>;

const nameIn = (names: NameMap, email: string | null) =>
  email ? (names.get(email) ?? null) : null;

const pageAuthor = (
  email: string | null,
  role: EffectiveRole | null,
  via: DataVia,
  names: NameMap,
) => ({ email, name: nameIn(names, email), role, via }) satisfies PageDocAuthor;

/** The distinct writer emails of these documents (created and updated). */
export function authorEmails(rows: readonly StoredDoc[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.created_by_email) out.add(r.created_by_email);
    if (r.updated_by_email) out.add(r.updated_by_email);
  }
  return out;
}

/**
 * The names a page reader may see on these documents: read only when it sees authors at all
 * (`seeIdentity`), so anonymous readers and pages without `viewer` never cause a users read.
 */
export async function pageNames(
  d1: D1Database,
  rows: readonly StoredDoc[],
  seeIdentity: boolean,
): Promise<NameMap> {
  if (!seeIdentity || rows.length === 0) return new Map();
  return namesByEmail(d1, authorEmails(rows));
}

/**
 * A document as the page sees it. `mine` is the reader's own (false for anonymous readers);
 * authors only when `seeIdentity` (pageDataAccess: identified reader, page declares `viewer`),
 * with their display names from `names` (pageNames).
 */
export function toPageDoc(
  row: StoredDoc,
  reader: PageClaim | null,
  seeIdentity: boolean,
  names: NameMap = new Map(),
): PageDoc {
  const doc: PageDoc = {
    id: row.doc_id,
    data: parseData(row),
    rev: row.rev,
    mine: reader !== null && row.created_by_email === reader.email,
    personal: isPersonalDocId(row.doc_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (seeIdentity && reader) {
    doc.created_by = pageAuthor(row.created_by_email, row.created_by_role, row.created_via, names);
    doc.updated_by = pageAuthor(row.updated_by_email, row.updated_by_role, row.updated_via, names);
  }
  return doc;
}

/**
 * A document as owners' and editors' agents see it, with authors' emails and per-artifact viewer
 * ids and display names (`names`, from namesByEmail). Untrusted input for agents. `cache` memoizes
 * viewer ids across a page of documents.
 */
export async function toAgentDoc(
  secret: string,
  row: StoredDoc,
  cache: Map<string, string> = new Map(),
  names: NameMap = new Map(),
): Promise<AgentDoc> {
  const idOf = async (email: string | null) => {
    if (!email) return null;
    let id = cache.get(email);
    if (!id) {
      id = await viewerIdFor(secret, row.artifact_id, email);
      cache.set(email, id);
    }
    return id;
  };
  const author = async (
    email: string | null,
    role: EffectiveRole | null,
    via: DataVia,
    label: string | null,
  ): Promise<AgentDocAuthor> => ({
    email,
    name: nameIn(names, email),
    role,
    via,
    connection_label: label,
    viewer_id: await idOf(email),
  });
  return {
    collection: row.collection,
    id: row.doc_id,
    data: parseData(row),
    rev: row.rev,
    personal: isPersonalDocId(row.doc_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: await author(
      row.created_by_email,
      row.created_by_role,
      row.created_via,
      row.created_by_label,
    ),
    updated_by: await author(
      row.updated_by_email,
      row.updated_by_role,
      row.updated_via,
      row.updated_by_label,
    ),
  };
}

// ---------- writes ----------

/**
 * Validate a document and measure it: UTF-8 bytes of collection + doc id + data JSON. `json` is
 * exactly the text stored in artifact_docs.data, and `size` what counts toward the quotas. Every
 * write measures through this, a whiteboard's starting board included (services/board.ts), against
 * the cap for the artifact's `type` (dataLimitsFor).
 */
export function measureDoc(
  config: Config,
  collection: string,
  docId: string,
  data: unknown,
  type: string,
): { json: string; size: number } {
  checkCollection(collection);
  checkDocId(docId);
  const shape = dataShapeError(data);
  if (shape) throw invalid(shape);
  const json = JSON.stringify(data);
  const dataBytes = utf8Length(json);
  const max = dataLimitsFor(config, type).maxDocBytes;
  if (dataBytes > max) {
    throw new ApiError("payload_too_large", `Data is over ${max} bytes`, {
      max_doc_bytes: max,
    });
  }
  return { json, size: utf8Length(collection) + utf8Length(docId) + dataBytes };
}

/**
 * measureDoc, plus the board's shapes on a whiteboard: only the `blocks` and `arrows` collections,
 * no personal documents, and each document a valid block or arrow (whiteboard.ts boardDocError).
 * Validation, not authorization: the same for the page, agents and the app, and who may write is
 * policy's (pageDataAccess, decide data_write).
 */
function prepareDoc(
  config: Config,
  target: DataTarget,
  collection: string,
  docId: string,
  data: unknown,
) {
  const measured = measureDoc(config, collection, docId, data, target.type);
  if (target.type === "whiteboard") {
    if (isPersonalDocId(docId)) throw invalid("A whiteboard has no personal documents");
    const problem = boardDocError(collection, data);
    if (problem) throw invalid(problem);
  }
  return measured;
}

/**
 * A page loaded before the wider whiteboard format writes back whole blocks read through its older
 * reader, which would turn a table or a diamond into an empty note (whiteboard.ts
 * staleBoardWrite). Refused as invalid, which such a page reports and never retries; agents may
 * still replace a block whole.
 */
function refuseStaleBoardWrite(collection: string, existing: StoredDoc, data: unknown): void {
  const why = staleBoardWrite(collection, parseData(existing), data);
  if (why) {
    throw new ApiError(
      "invalid_input",
      `This board changed since the page was loaded (${why}): reload the page to change it`,
      { reason: "stale_page" },
    );
  }
}

/** A writer the page rules refuse outright (anonymous) never reaches the rate limits. */
function requireWriter(writer: DataWriter | null, docId: string): DataWriter {
  if (writer) return writer;
  const d = canModifyDoc(null, { docId, creatorEmail: null }, "create", false);
  throw denied(d.allow ? "read_only" : d.reason);
}

export async function limitWrites(
  d1: D1Database,
  config: Config,
  artifactId: string,
  email: string,
) {
  for (const [key, limit] of [
    [`data:w:${artifactId}:${email}`, config.data.writesPerViewerPerHour],
    [`data:w:${artifactId}:all`, config.data.writesPerArtifactPerHour],
  ] as const) {
    const r = await hit(d1, key, limit, HOUR_S);
    if (!r.allowed) {
      throw new ApiError("rate_limited", "Too many changes, try again later", {
        retry_after: r.retryAfter,
      });
    }
  }
}

function authorize(
  writer: DataWriter,
  target: DataTarget,
  collection: string,
  doc: { docId: string; creatorEmail: string | null },
  op: "create" | "update" | "delete",
): void {
  const d = canModifyDoc(writer, doc, op, isShared(target, collection));
  if (!d.allow) throw denied(d.reason);
}

function isShared(target: DataTarget, collection: string): boolean {
  return target.caps?.shared.includes(collection) ?? false;
}

/**
 * True when the policy lets this writer change the document whoever created it, so the guarded
 * SQL need not compare creators; otherwise it must find the writer's email as the creator.
 */
function anyCreator(
  writer: DataWriter,
  target: DataTarget,
  collection: string,
  docId: string,
  op: "update" | "delete",
) {
  return canModifyDoc(writer, { docId, creatorEmail: null }, op, isShared(target, collection))
    .allow;
}

export const USER_BYTES_SQL = `SELECT coalesce(sum(u.bytes), 0) AS total FROM artifact_data_usage u
  JOIN artifacts a ON a.id = u.artifact_id WHERE a.owner_id = ?1 AND a.deleted_at IS NULL`;

async function readState(d1: D1Database, target: DataTarget, collection: string, docId: string) {
  const [doc, user] = await d1.batch<Record<string, unknown>>([
    d1
      .prepare(
        "SELECT * FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3",
      )
      .bind(target.id, collection, docId),
    d1.prepare(USER_BYTES_SQL).bind(target.ownerId),
  ]);
  return {
    existing: (doc?.results[0] as StoredDoc | undefined) ?? null,
    userBytes: Number((user?.results[0] as { total?: number } | undefined)?.total ?? 0),
  };
}

/** The per-owner cap is soft (checked here, not in the write); a shrinking write always passes. */
function checkUserBytes(config: Config, userBytes: number, delta: number): void {
  if (delta > 0 && userBytes + delta > config.data.maxBytesPerUser) throw quota("user_bytes");
}

/**
 * A document's next rev: one past the artifact's change counter, so revs only ever grow across the
 * whole artifact. A document deleted and created again (or cleared and recreated) never repeats a
 * rev an earlier reader saw, so if_rev n can only match the content that reader read.
 */
const NEXT_REV_SQL =
  "coalesce((SELECT seq FROM artifact_data_usage WHERE artifact_id = ?1), 0) + 1";

/**
 * Checked inside every guarded insert and update: the artifact still exists and is not taken down.
 * Callers check the artifact once before their ops, so a write already in flight when the artifact
 * is deleted or taken down (and its data wiped) must not bring data back.
 */
export const ARTIFACT_LIVE_SQL = `EXISTS (SELECT 1 FROM artifacts WHERE id = ?1
  AND deleted_at IS NULL AND taken_down_at IS NULL)`;

const artifactGone = () => new ApiError("not_found", "Artifact not found");

/** The columns every insert into artifact_docs writes, in the order its values follow. */
export const DOC_INSERT_COLUMNS = `artifact_id, collection, doc_id, data, size_bytes, rev,
         created_by_email, created_by_role, created_via, created_by_label, created_at,
         updated_by_email, updated_by_role, updated_via, updated_by_label, updated_at`;

async function insertGuarded(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter,
  collection: string,
  docId: string,
  json: string,
  size: number,
): Promise<StoredDoc | null> {
  const now = nowIso();
  // The SELECT needs its WHERE for SQLite to parse ON CONFLICT after INSERT ... SELECT.
  return d1
    .prepare(
      `INSERT INTO artifact_docs (${DOC_INSERT_COLUMNS})
       SELECT ?1, ?2, ?3, ?4, ?5, ${NEXT_REV_SQL}, ?6, ?7, ?8, ?9, ?10, ?6, ?7, ?8, ?9, ?10
        WHERE ${ARTIFACT_LIVE_SQL}
          AND coalesce((SELECT docs FROM artifact_data_usage WHERE artifact_id = ?1), 0) < ?11
          AND coalesce((SELECT bytes FROM artifact_data_usage WHERE artifact_id = ?1), 0) + ?5 <= ?12
          AND (EXISTS (SELECT 1 FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2)
               OR (SELECT count(DISTINCT collection) FROM artifact_docs WHERE artifact_id = ?1) < ?13)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    )
    .bind(
      target.id,
      collection,
      docId,
      json,
      size,
      writer.email,
      writer.role,
      writer.via,
      writer.label ?? null,
      now,
      dataLimitsFor(config, target.type).maxDocsPerArtifact,
      dataLimitsFor(config, target.type).maxBytesPerArtifact,
      LIMITS.maxDataCollections,
    )
    .first<StoredDoc>();
}

/** Why a guarded insert changed nothing: the id is taken, or which quota stopped it. */
async function whyNotInserted(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  collection: string,
  docId: string,
  size: number,
): Promise<{ taken: number } | { quota: QuotaLimit } | { retry: true }> {
  const r = await d1
    .prepare(
      `SELECT (SELECT rev FROM artifact_docs
                WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3) AS rev,
              coalesce((SELECT docs FROM artifact_data_usage WHERE artifact_id = ?1), 0) AS docs,
              coalesce((SELECT bytes FROM artifact_data_usage WHERE artifact_id = ?1), 0) AS bytes,
              EXISTS (SELECT 1 FROM artifact_docs WHERE artifact_id = ?1 AND collection = ?2) AS has,
              (SELECT count(DISTINCT collection) FROM artifact_docs WHERE artifact_id = ?1) AS colls,
              ${ARTIFACT_LIVE_SQL} AS live`,
    )
    .bind(target.id, collection, docId)
    .first<{
      rev: number | null;
      docs: number;
      bytes: number;
      has: number;
      colls: number;
      live: number;
    }>();
  if (!r) return { retry: true };
  if (!r.live) throw artifactGone();
  if (r.rev !== null) return { taken: r.rev };
  const limits = dataLimitsFor(config, target.type);
  if (r.docs >= limits.maxDocsPerArtifact) return { quota: "docs" };
  if (r.bytes + size > limits.maxBytesPerArtifact) return { quota: "bytes" };
  if (!r.has && r.colls >= LIMITS.maxDataCollections) return { quota: "collections" };
  return { retry: true };
}

async function updateGuarded(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter,
  collection: string,
  docId: string,
  json: string,
  size: number,
  readRev: number,
  any: boolean,
): Promise<StoredDoc | null> {
  return d1
    .prepare(
      `UPDATE artifact_docs SET data = ?4, size_bytes = ?5, rev = ${NEXT_REV_SQL},
         updated_by_email = ?6, updated_by_role = ?7, updated_via = ?8, updated_by_label = ?9,
         updated_at = ?10
       WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3 AND rev = ?11
         AND (?12 = 1 OR created_by_email = ?6)
         AND ${ARTIFACT_LIVE_SQL}
         AND (?5 <= size_bytes OR coalesce((SELECT bytes FROM artifact_data_usage
               WHERE artifact_id = ?1), 0) - size_bytes + ?5 <= ?13)
       RETURNING *`,
    )
    .bind(
      target.id,
      collection,
      docId,
      json,
      size,
      writer.email,
      writer.role,
      writer.via,
      writer.label ?? null,
      nowIso(),
      readRev,
      any ? 1 : 0,
      dataLimitsFor(config, target.type).maxBytesPerArtifact,
    )
    .first<StoredDoc>();
}

/** Why a guarded update or delete changed nothing. */
async function whyNotChanged(
  d1: D1Database,
  target: DataTarget,
  collection: string,
  docId: string,
  readRev: number,
  writerEmail: string,
  any: boolean,
): Promise<{ gone: true } | { moved: number } | { forbidden: true } | { quota: QuotaLimit }> {
  const r = await d1
    .prepare(
      `SELECT d.rev, d.created_by_email, ${ARTIFACT_LIVE_SQL} AS live
         FROM (SELECT 1) LEFT JOIN artifact_docs d
           ON d.artifact_id = ?1 AND d.collection = ?2 AND d.doc_id = ?3`,
    )
    .bind(target.id, collection, docId)
    .first<{ rev: number | null; created_by_email: string | null; live: number }>();
  if (r && !r.live) throw artifactGone();
  if (!r || r.rev === null) return { gone: true };
  if (r.rev !== readRev) return { moved: r.rev };
  if (!any && r.created_by_email !== writerEmail) return { forbidden: true };
  return { quota: "bytes" };
}

/** POST: a new document with a server id. */
export async function createDoc(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter | null,
  collection: string,
  data: unknown,
): Promise<StoredDoc> {
  let docId = newId();
  const w = requireWriter(writer, docId);
  let { json, size } = prepareDoc(config, target, collection, docId, data);
  await limitWrites(d1, config, target.id, w.email);
  for (let attempt = 0; attempt < PLAIN_SET_ATTEMPTS; attempt++) {
    authorize(w, target, collection, { docId, creatorEmail: null }, "create");
    const { userBytes } = await readState(d1, target, collection, docId);
    checkUserBytes(config, userBytes, size);
    const row = await insertGuarded(d1, config, target, w, collection, docId, json, size);
    if (row) return row;
    const why = await whyNotInserted(d1, config, target, collection, docId, size);
    if ("quota" in why) throw quota(why.quota);
    docId = newId();
    ({ json, size } = prepareDoc(config, target, collection, docId, data));
  }
  throw new ApiError("conflict", "Could not create the document, try again");
}

/**
 * PUT: create or replace. `ifRev` 0 creates only; n replaces only at rev n (409 with current_rev
 * otherwise, 0 meaning absent). Without `ifRev` the last writer wins, retrying on a race.
 */
export async function putDoc(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter | null,
  collection: string,
  docIdIn: string,
  data: unknown,
  ifRev?: number,
): Promise<{ doc: StoredDoc; created: boolean }> {
  const w = requireWriter(writer, docIdIn);
  const docId = resolveDocId(docIdIn, w.viewerId) as string;
  const { json, size } = prepareDoc(config, target, collection, docId, data);
  if (ifRev !== undefined && (!Number.isInteger(ifRev) || ifRev < 0)) {
    throw invalid("if_rev must be a whole number, 0 or more");
  }
  await limitWrites(d1, config, target.id, w.email);
  const plain = ifRev === undefined;
  let lastRev = 0;
  for (let attempt = 0; attempt < (plain ? PLAIN_SET_ATTEMPTS : 1); attempt++) {
    const { existing, userBytes } = await readState(d1, target, collection, docId);
    lastRev = existing?.rev ?? 0;
    if (!plain && lastRev !== ifRev) throw conflict(lastRev);
    if (!existing) {
      authorize(w, target, collection, { docId, creatorEmail: null }, "create");
      checkUserBytes(config, userBytes, size);
      const row = await insertGuarded(d1, config, target, w, collection, docId, json, size);
      if (row) return { doc: row, created: true };
      const why = await whyNotInserted(d1, config, target, collection, docId, size);
      if ("quota" in why) throw quota(why.quota);
      if ("taken" in why) lastRev = why.taken;
      if (!plain) throw conflict(lastRev);
      continue;
    }
    authorize(w, target, collection, { docId, creatorEmail: existing.created_by_email }, "update");
    if (target.type === "whiteboard" && w.via === "page")
      refuseStaleBoardWrite(collection, existing, data);
    checkUserBytes(config, userBytes, size - existing.size_bytes);
    const any = anyCreator(w, target, collection, docId, "update");
    const row = await updateGuarded(
      d1,
      config,
      target,
      w,
      collection,
      docId,
      json,
      size,
      existing.rev,
      any,
    );
    if (row) return { doc: row, created: false };
    const why = await whyNotChanged(d1, target, collection, docId, existing.rev, w.email, any);
    if ("forbidden" in why) throw denied("forbidden");
    if ("quota" in why) throw quota(why.quota);
    lastRev = "moved" in why ? why.moved : 0;
    if (!plain) throw conflict(lastRev);
  }
  throw conflict(lastRev);
}

/** DELETE: only at `ifRev` when given; otherwise the current rev, retrying on a race. */
export async function deleteDoc(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter | null,
  collection: string,
  docIdIn: string,
  ifRev?: number,
): Promise<void> {
  const w = requireWriter(writer, docIdIn);
  const docId = resolveDocId(docIdIn, w.viewerId) as string;
  checkCollection(collection);
  checkDocId(docId);
  if (ifRev !== undefined && (!Number.isInteger(ifRev) || ifRev < 1)) {
    throw invalid("if_rev must be a whole number, 1 or more");
  }
  await limitWrites(d1, config, target.id, w.email);
  const plain = ifRev === undefined;
  let lastRev = 0;
  for (let attempt = 0; attempt < (plain ? PLAIN_SET_ATTEMPTS : 1); attempt++) {
    const existing = await getDoc(d1, target.id, collection, docId);
    if (!existing) throw docNotFound();
    lastRev = existing.rev;
    if (!plain && existing.rev !== ifRev) throw conflict(existing.rev);
    authorize(w, target, collection, { docId, creatorEmail: existing.created_by_email }, "delete");
    const any = anyCreator(w, target, collection, docId, "delete");
    const gone = await d1
      .prepare(
        `DELETE FROM artifact_docs
          WHERE artifact_id = ?1 AND collection = ?2 AND doc_id = ?3 AND rev = ?4
            AND (?5 = 1 OR created_by_email = ?6)
          RETURNING rev`,
      )
      .bind(target.id, collection, docId, existing.rev, any ? 1 : 0, w.email)
      .first<{ rev: number }>();
    if (gone) return;
    const why = await whyNotChanged(d1, target, collection, docId, existing.rev, w.email, any);
    if ("gone" in why) throw docNotFound();
    if ("forbidden" in why) throw denied("forbidden");
    if ("moved" in why) lastRev = why.moved;
    if (!plain) throw conflict(lastRev);
  }
  throw conflict(lastRev);
}

export type OpResult = DataOpResult;

/**
 * A merge op: the stored document at `if_rev` with the op's fields put in place (null removes
 * one), written as a whole at that rev, so a write that raced it is a conflict, never lost. The
 * result is checked like any write (a whiteboard's block or arrow shape included).
 */
async function mergeDoc(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter,
  op: Extract<DataOp, { op: "merge" }>,
): Promise<StoredDoc> {
  const docId = resolveDocId(op.doc_id, writer.viewerId) as string;
  const existing = await getDoc(d1, target.id, op.collection, docId);
  if (!existing) throw docNotFound();
  if (existing.rev !== op.if_rev) throw conflict(existing.rev);
  const data = mergeDocData(parseData(existing), op.data);
  const { doc } = await putDoc(d1, config, target, writer, op.collection, docId, data, op.if_rev);
  return doc;
}

/**
 * write_artifact_data: ops apply in order and each succeeds or fails on its own. Every op names
 * its if_rev: 0 creates (a server id when doc_id is omitted), n changes only at rev n.
 */
export async function applyOps(
  d1: D1Database,
  config: Config,
  target: DataTarget,
  writer: DataWriter,
  ops: DataOp[],
): Promise<{ results: OpResult[] }> {
  const results: OpResult[] = [];
  for (const op of ops) {
    const base = { op: op.op, collection: op.collection, doc_id: op.doc_id ?? null };
    try {
      if (op.op === "merge") {
        const doc = await mergeDoc(d1, config, target, writer, op);
        results.push({ ...base, doc_id: doc.doc_id, ok: true, rev: doc.rev });
      } else if (op.op === "set") {
        let doc: StoredDoc;
        if (op.doc_id === undefined) {
          if (op.if_rev !== 0) throw invalid("Without doc_id, if_rev must be 0 (create)");
          doc = await createDoc(d1, config, target, writer, op.collection, op.data);
        } else {
          ({ doc } = await putDoc(
            d1,
            config,
            target,
            writer,
            op.collection,
            op.doc_id,
            op.data,
            op.if_rev,
          ));
        }
        results.push({ ...base, doc_id: doc.doc_id, ok: true, rev: doc.rev });
      } else {
        await deleteDoc(d1, config, target, writer, op.collection, op.doc_id, op.if_rev);
        results.push({ ...base, doc_id: resolveDocId(op.doc_id, writer.viewerId), ok: true });
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const error = {
        code: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
      };
      results.push({ ...base, ok: false, error });
    }
  }
  return { results };
}

/**
 * Delete every document of an artifact (the owner's "Delete all shared data"). The usage row
 * stays, so its seq keeps growing and open pages see the change.
 */
export async function clearData(d1: D1Database, artifactId: string): Promise<{ docs: number }> {
  const before = await usageOf(d1, artifactId);
  await d1.prepare("DELETE FROM artifact_docs WHERE artifact_id = ?1").bind(artifactId).run();
  return { docs: before.docs };
}

/**
 * Statements that remove all of an artifact's data and its usage row, for batching with the
 * artifact's deletion or takedown.
 */
export function wipeArtifactData(d1: D1Database, artifactId: string): D1PreparedStatement[] {
  return [
    d1.prepare("DELETE FROM artifact_docs WHERE artifact_id = ?1").bind(artifactId),
    d1.prepare("DELETE FROM artifact_data_usage WHERE artifact_id = ?1").bind(artifactId),
  ];
}

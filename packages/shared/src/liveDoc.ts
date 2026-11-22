// On-page doc editing (#36): the doc socket protocol between Plinth's doc renderer and the
// artifact's room, the REST inputs of checkpoints, and the pure line and lease helpers both sides
// use. Never used by page code: only Plinth's renderer runs on a doc origin.
//
// The model: the draft is an array of lines (the text split on "\n", so joining them gives the
// text back exactly). A lease is an exclusive line range [start, end) held by one socket, where
// start === end is an insert point. An edit replaces the whole leased range with new text, so
// only the holder ever changes those lines and no transform is needed. The room applies edits in
// arrival order, shifts the other leases, bumps `rev` and broadcasts each op to every doc socket
// (the sender's copy is its ack). `gen` is random per in-memory load of the room, so a client
// never mistakes a reload for a continuation.
//
// A sheet (the other live-editable type) uses the same channel: a row is a line, a lease on a row
// is a lease on its line, and each line an edit puts in is checked by the type's rules
// (liveTypes.ts). Rows and columns are inserted and deleted with one more frame, `struct`, that
// both sides apply with the same pure function (applySheetStruct), so no text is resent. A deck
// does too (slides-text): a lease is a block of one slide part, or the whole notes part, and its
// notes and settings change with `struct` (applySlidesStruct), whose ops name the ranges they
// touch, so a person can change one slide while others type on another.
import { z } from "zod";
import { FILE_SUMMARY_LIMITS } from "./changes/files.ts";
import { LIMITS } from "./constants.ts";
import { DS_TOKEN_TYPES, dsJsonDepthWithin } from "./designSystem.ts";
import { sheetColumnInputSchema } from "./schemas.ts";
import { MAX_DECK_FOOTER } from "./slides.ts";
import { FOOTER_UNSAFE_RE } from "./slidesStruct.ts";

// The line and lease helpers live in liveLines.ts, the per-type rules in liveTypes.ts (neither
// with zod), so the renderers can use them without carrying the schemas below.
export * from "./liveLines.ts";
export * from "./liveTypes.ts";
export * from "./slidesSerialize.ts";
export * from "./slidesStruct.ts";

/** Fixed live-editing rules, not env vars (the env-var ones are LIVE_DEFAULTS). */
export const LIVE_DOC = {
  /** Largest `text` frame when the room sends the draft (a 1 MB doc is a few frames). */
  textChunkBytes: 256 * 1024,
  /** The renderer sends a block's text at most this often while typing. */
  editDebounceMs: 250,
  /** A checkpoint snapshot holds the draft this long at most. */
  checkpointLockS: 30,
  /** Checkpoint snapshots a room keeps for recognizing their versions (the oldest goes first). */
  maxPendingCheckpoints: 8,
  /** A diff with more edits than this is a conflict rather than a merge. */
  maxMergeEdits: 5000,
  /** Co-editors a status lists. */
  maxEditorsListed: 50,
} as const;

/** Env-var defaults for live editing (ALLOW_LIVE_EDITING and LIVE_* env vars). */
export const LIVE_DEFAULTS = {
  /** LIVE_CHECKPOINT_IDLE_S: quiet time before an autosave; 0 means explicit saves only. */
  checkpointIdleS: 120,
  /** LIVE_AUTO_CHECKPOINT_MIN_S: least time between autosaves (at least the idle time). */
  autoCheckpointMinS: 600,
  /** LIVE_DRAFT_FLUSH_S: how often the room writes the draft to D1 at most. */
  draftFlushS: 5,
  /** LIVE_DRAFT_RETENTION_DAYS: how long an untouched unsaved draft is kept. */
  draftRetentionDays: 30,
} as const;

export const LIVE_BOUNDS = {
  /** 0, or from the first to the second value. */
  checkpointIdleS: [30, 3600],
  autoCheckpointMinS: [0, 86400],
  draftFlushS: [2, 60],
  draftRetentionDays: [1, 365],
} as const;

/** How an owner or editor edits a doc on its page: with the room, or alone (Save only). */
export type LiveMode = "room" | "solo";

// ---------- lines and leases ----------

/**
 * The draft text cut into pieces of at most `maxBytes` UTF-8 bytes, never inside a character, for
 * the `text` frames that follow `welcome`, `reset` and `rebased`. Always at least one piece.
 */
export function chunkText(text: string, maxBytes: number = LIVE_DOC.textChunkBytes): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must be at least 4");
  const out: string[] = [];
  let from = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length;
    const d = pair ? text.charCodeAt(i + 1) : 0;
    const surrogate = pair && d >= 0xdc00 && d <= 0xdfff;
    const n = surrogate ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    const w = surrogate ? 2 : 1;
    if (bytes + n > maxBytes) {
      out.push(text.slice(from, i));
      from = i;
      bytes = 0;
    }
    bytes += n;
    i += w;
  }
  out.push(text.slice(from));
  return out;
}

// ---------- doc socket frames ----------

export const LEASE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const leaseId = z.string().regex(LEASE_ID_RE);
const count = z.number().int().min(0);
// A design system's projection may run past a doc's line limit (LIMITS.maxLiveProjectionLines).
const line = z
  .number()
  .int()
  .min(0)
  .max(Math.max(LIMITS.maxLiveDocLines, LIMITS.maxLiveProjectionLines));
const version = z.number().int().min(1);
const email = z.string().max(254);
const gen = z.string().min(1).max(64);

const columnLetters = z.string().regex(/^[A-Z]{1,3}$/);
const rowCount = z.number().int().min(1).max(LIMITS.maxSheetRows);
const sheetRow = z
  .number()
  .int()
  .min(2)
  .max(LIMITS.maxSheetRows + 2);

/** A sheet's structural change (SheetStructOp), as a struct frame carries it. */
export const sheetStructOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert_rows"), before: sheetRow, count: rowCount }).strict(),
  z.object({ op: z.literal("delete_rows"), from: sheetRow, count: rowCount }).strict(),
  z
    .object({
      op: z.literal("insert_columns"),
      before: columnLetters,
      columns: z.array(sheetColumnInputSchema).min(1).max(LIMITS.maxSheetColumns),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete_columns"),
      from: columnLetters,
      count: z.number().int().min(1).max(LIMITS.maxSheetColumns),
    })
    .strict(),
  z.object({ op: z.literal("move_rows"), from: sheetRow, count: rowCount, to: sheetRow }).strict(),
]);

const dsTokenPath = z
  .string()
  .max(16 * 65)
  .regex(/^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}$/);
const dsText = z.string().max(LIMITS.liveDocFrameBytes);
const rawSlide = z.number().int().min(1).max(LIMITS.maxSlides);

/** A deck's structural change (SlidesStructOp, slidesStruct.ts), as a struct frame carries it. */
export const slidesStructOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_notes"), n: rawSlide }).strict(),
  z.object({ op: z.literal("remove_notes"), n: rawSlide }).strict(),
  z
    .object({
      op: z.literal("set_deck"),
      aspect: z.enum(["16:9", "4:3"]),
      theme: z.enum(["auto", "light", "dark"]),
      paginate: z.boolean(),
      footer: z
        .string()
        .max(MAX_DECK_FOOTER)
        .refine((f) => !FOOTER_UNSAFE_RE.test(f), { message: "plain text on one line" }),
    })
    .strict(),
  z.object({ op: z.literal("trim_start") }).strict(),
]);

/**
 * A token's value: any JSON (the room checks it with the publish rules; the frame bounds its size)
 * nested no deeper than a design system may be, so nothing has to write out a deeper one.
 */
const dsValue = z
  .unknown()
  .refine((v) => v !== undefined, { message: "required" })
  .refine((v) => dsJsonDepthWithin(v), { message: "nests too deep" });

/** A design system's structural change (DsStructOp, designSystemStruct.ts), as a struct frame carries it. */
export const designSystemStructOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_dark"), token: dsTokenPath, value: dsValue }).strict(),
  z.object({ op: z.literal("clear_dark"), token: dsTokenPath }).strict(),
  z.object({ op: z.literal("set_text"), path: z.string().max(1200), value: dsText }).strict(),
  z.object({ op: z.literal("clear_text"), path: z.string().max(1200) }).strict(),
  z
    .object({
      op: z.literal("add_token"),
      group: z.union([z.literal(""), dsTokenPath]),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      value: dsValue,
      type: z.enum(DS_TOKEN_TYPES).optional(),
    })
    .strict(),
  z.object({ op: z.literal("remove_token"), path: dsTokenPath }).strict(),
]);

/**
 * Every live type's structural op, as a struct frame carries it (a sheet's, a design system's or a
 * deck's). The room checks the op's kind against the artifact's type (LiveTypeRules.struct.kinds)
 * before it applies it.
 */
export const liveStructOpSchema = z.discriminatedUnion("op", [
  ...sheetStructOpSchema.options,
  ...designSystemStructOpSchema.options,
  ...slidesStructOpSchema.options,
]);

/**
 * A client frame's own number (docs/spec.md "Editing", the room protocol): the room puts it back as
 * `re` on its direct answer to that frame, so the client matches answers by number, never by order.
 * Optional: a tab opened before the room knew it sends none, and gets answers with no `re`.
 */
const frameId = count.optional();
/** The `id` of the client frame a server frame directly answers (absent: not an answer). */
const re = count.optional();

/** What the renderer sends. The raw frame is checked against LIMITS.liveDocFrameBytes first. */
export const liveDocClientFrameSchema = z.discriminatedUnion("t", [
  z
    .object({ t: z.literal("lease"), rev: count, start: line, end: line, id: frameId })
    .refine((v) => v.end >= v.start, { message: "end before start", path: ["end"] }),
  z.object({
    t: z.literal("edit"),
    lease: leaseId,
    seq: count,
    text: z.string().max(LIMITS.liveDocFrameBytes),
    id: frameId,
  }),
  z.object({ t: z.literal("release"), lease: leaseId, id: frameId }),
  z.object({ t: z.literal("takeover"), lease: leaseId, id: frameId }),
  /**
   * The holder still has typing in the block it cannot send yet (a doc block whose text cannot be
   * written as typed): the lease counts as in use, as an edit would make it, so it is not taken
   * over as idle. Sent by a connected tab only, every LIMITS.liveLeaseKeepS.
   */
  z.object({ t: z.literal("keep"), lease: leaseId, id: frameId }),
  z.object({ t: z.literal("sync"), id: frameId }),
  /**
   * A sheet's rows or columns (while nobody else holds a lease), or a design system's keys (while
   * no lease overlaps what the op changes), at the draft's current rev.
   */
  z.object({ t: z.literal("struct"), rev: count, op: liveStructOpSchema, id: frameId }),
]);
export type LiveDocClientFrame = z.infer<typeof liveDocClientFrameSchema>;

export const LIVE_DOC_ERROR_CODES = [
  "invalid",
  "too_large",
  "rate_limited",
  "not_held",
  "draft_limit",
  "unavailable",
] as const;
export type LiveDocErrorCode = (typeof LIVE_DOC_ERROR_CODES)[number];

const leaseView = z.object({ id: leaseId, start: line, end: line, by: email });

const fileChange = z.object({
  path: z.string().max(FILE_SUMMARY_LIMITS.maxPathChars * 2),
  kind: z.enum(["added", "removed", "replaced", "same"]),
  before: count.optional(),
  after: count.optional(),
});

/**
 * The files a version published meanwhile changed since the draft's base (summarizeFileChanges):
 * what the review lists under "Files". At most FILE_SUMMARY_LIMITS.maxPaths of each kind.
 */
export const liveFilesSchema = z.object({
  added: z.array(fileChange).max(FILE_SUMMARY_LIMITS.maxPaths),
  removed: z.array(fileChange).max(FILE_SUMMARY_LIMITS.maxPaths),
  replaced: z.array(fileChange).max(FILE_SUMMARY_LIMITS.maxPaths),
  more: count,
  same: count,
});

/** What the room sends on a doc socket. The renderer validates every frame. */
export const liveDocServerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    v: z.literal(1),
    you: z.object({ id: z.string().max(64), email, right: z.enum(["watch", "write"]) }),
    gen,
    rev: count,
    base_version: version,
    flushed_rev: count,
    conflict_version: version.nullable(),
    last_by_you: z.boolean(),
    leases: z.array(leaseView).max(1000),
    peers: z
      .array(z.object({ id: z.string().max(64), email, lease: leaseId.nullable() }))
      .max(1000),
    /** While the draft is frozen: the files conflict_version changed since base_version. */
    files: liveFilesSchema.optional(),
    /** Answering this socket's `sync`. */
    re,
  }),
  z.object({
    t: z.literal("text"),
    gen,
    part: count,
    of: z.number().int().min(1),
    chunk: z.string(),
  }),
  /**
   * Sent to every doc socket: `holder` is the socket that holds it, `by` its email. The holder's
   * copy has `re` when it answers that socket's lease or takeover.
   */
  z.object({
    t: z.literal("leased"),
    lease: leaseId,
    start: line,
    end: line,
    holder: z.string().max(64),
    by: email,
    re,
  }),
  /** A lease or takeover refused, or an edit (`watch`, `frozen`): `re` says which frame. */
  z.object({
    t: z.literal("lease_denied"),
    reason: z.enum(["held", "stale", "frozen", "watch"]),
    by: email.optional(),
    re,
  }),
  z.object({
    t: z.literal("op"),
    gen,
    rev: z.number().int().min(1),
    lease: leaseId,
    start: line,
    del: count,
    ins: z.string(),
    /** The sending socket's id, so a client recognizes its own ack. */
    by: z.string().max(64),
    seq: count.optional(),
    /** The sender's copy: its edit frame's id. */
    re,
  }),
  /**
   * A structural change, applied: every socket applies `op` with the type's own function
   * (applySheetStruct, applyDesignSystemStruct, applySlidesStruct).
   */
  z.object({
    t: z.literal("struct"),
    gen,
    rev: z.number().int().min(1),
    op: liveStructOpSchema,
    by: z.string().max(64),
    /** The sender's copy: its struct frame's id. */
    re,
  }),
  /** Sent only to the socket whose struct frame was refused. */
  z.object({
    t: z.literal("struct_denied"),
    reason: z.enum(["held", "stale", "frozen", "watch"]),
    by: email.optional(),
    re,
  }),
  /**
   * A lease ended. `re` only on the copy answering this socket's own `release`; one a takeover, a
   * struct or a closed socket caused is no answer.
   */
  z.object({ t: z.literal("released"), lease: leaseId, re }),
  /** The answer to a `keep` for a lease the socket holds (an older room answers `invalid`). */
  z.object({ t: z.literal("kept"), lease: leaseId, re }),
  z.object({
    t: z.literal("lease_lost"),
    lease: leaseId,
    reason: z.enum(["takeover", "rebased", "closed"]),
  }),
  z.object({ t: z.literal("flushed"), rev: count }),
  z.object({ t: z.literal("saved"), version, rev: count }),
  /**
   * The draft was replaced by `version`. `why` when an editor's choice in the review (or the
   * strip's discard) did it: "published" (the page changes became `version`) or "discarded".
   */
  z.object({
    t: z.literal("reset"),
    version,
    gen,
    rev: count,
    why: z.enum(["published", "discarded"]).optional(),
  }),
  z.object({ t: z.literal("rebased"), version, gen, rev: count }),
  /** The draft is frozen against `version`, which changed `files` since the draft's base. */
  z.object({ t: z.literal("conflict"), version, files: liveFilesSchema.optional() }),
  z.object({
    t: z.literal("status"),
    dirty: z.boolean(),
    editors: z.array(email).max(LIVE_DOC.maxEditorsListed),
    last_edit_at: z.string().max(40).nullable(),
    last_by_you: z.boolean(),
  }),
  /**
   * `re` when it answers that frame of this socket (refused, over the rate, not held); none when
   * it answers nothing (`draft_limit` after a flush, a frame that does not parse).
   */
  z.object({
    t: z.literal("error"),
    code: z.enum(LIVE_DOC_ERROR_CODES),
    re,
  }),
]);
export type LiveDocServerFrame = z.infer<typeof liveDocServerFrameSchema>;

// ---------- REST inputs (app host, /api/v1/artifacts/:ref/live...) ----------

/** POST /api/v1/artifacts/:ref/live/checkpoint */
export const liveCheckpointInput = z
  .object({
    base_version: version.describe("The version the draft is based on, as the page last saw it"),
    rev: count.describe("The draft revision the page last saw"),
    note: z.string().max(LIMITS.maxNoteLength).optional(),
    reason: z.enum(["save", "done", "idle"]),
    conflict_version: version
      .optional()
      .describe(
        "Publish your changes: the version the frozen draft was reviewed against. The room's own frozen draft is published over it, with the files of the draft's base version. 409 live_resolved when the draft is no longer frozen, live_conflict when a newer version froze it, live_moved when rev is not current",
      ),
  })
  // No draft text comes from the app (the room publishes its own), so an unknown field is refused.
  .strict();
export type LiveCheckpointInput = z.infer<typeof liveCheckpointInput>;

/** DELETE /api/v1/artifacts/:ref/live/draft?rev=n */
export const liveDiscardQuery = z.object({
  rev: z.coerce.number().int().min(0).describe("The draft revision the editor chose to discard"),
  conflict_version: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Discard your changes: the version the frozen draft was reviewed against. 409 live_resolved when the draft is no longer frozen, live_conflict when a newer version froze it",
    ),
});
export type LiveDiscardQuery = z.infer<typeof liveDiscardQuery>;

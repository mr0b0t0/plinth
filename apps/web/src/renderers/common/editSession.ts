// The editing side of the renderer protocol that every renderer which edits on the page shares
// (the doc and the sheet): reading the app's editing messages, posting with the frame key, and the
// whole-draft review session, which opens the review (review.ts) on the room's frozen draft or on
// the solo copy, posts the person's choice to the app, and closes the review with what happened.
// A solo `review` may carry `text`: the copy the app's tab kept from before a reload, which this
// frame never held. The review then shows and publishes that copy instead of the frame's own.
import {
  type FileChangeSummary,
  LIMITS,
  type LiveTypeRules,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  versionRange,
} from "@plinth/shared";
import type { LiveDocClient } from "./live.ts";
import type { DraftReview, ReviewOutcome } from "./review.ts";

export type ReviewResult = "busy" | "resolved" | "conflict" | "failed" | "done";

export type EditAppMessage =
  | { type: "edit"; on: boolean; base?: number }
  | { type: "collect"; nonce: string }
  | {
      type: "review";
      nonce: string;
      n?: number;
      base?: number;
      files?: FileChangeSummary;
      /** Solo only: the copy the app kept from before a reload, reviewed instead of the frame's. */
      text?: string;
    }
  | { type: "reviewed"; nonce: string; result: ReviewResult };

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The longest kept copy a `review` may carry, in UTF-16 units; the type's rules check it exactly. */
const MAX_REVIEW_TEXT = Math.max(LIMITS.maxDocBytes, LIMITS.maxSheetBytes);
const RESULTS = new Set(["busy", "resolved", "conflict", "failed", "done"]);
const FILE_KINDS = new Set(["added", "removed", "replaced", "same"]);
const isVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v < 2 ** 31;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 31;

/** A files summary from the app (solo review), checked field by field, or null. */
function readFiles(v: unknown): FileChangeSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  if (!isCount(f.more) || !isCount(f.same)) return null;
  const out: FileChangeSummary = {
    added: [],
    removed: [],
    replaced: [],
    more: f.more,
    same: f.same,
  };
  for (const k of ["added", "removed", "replaced"] as const) {
    const list = f[k];
    if (!Array.isArray(list) || list.length > 50) return null;
    for (const c of list) {
      if (typeof c !== "object" || c === null) return null;
      const e = c as Record<string, unknown>;
      if (typeof e.path !== "string" || e.path.length > 512) return null;
      if (!FILE_KINDS.has(e.kind as string)) return null;
      if (e.before !== undefined && !isCount(e.before)) return null;
      if (e.after !== undefined && !isCount(e.after)) return null;
      out[k].push({
        path: e.path,
        kind: e.kind as FileChangeSummary["added"][number]["kind"],
        ...(e.before !== undefined ? { before: e.before as number } : {}),
        ...(e.after !== undefined ? { after: e.after as number } : {}),
      });
    }
  }
  return out;
}

/** An editing message from the app page, validated, or null. The caller checks source and origin. */
export function readEditMessage(data: unknown): EditAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "edit" && typeof m.on === "boolean") {
    if (m.base !== undefined && !isVersion(m.base)) return null;
    return { type: "edit", on: m.on, ...(isVersion(m.base) ? { base: m.base } : {}) };
  }
  if (typeof m.nonce !== "string" || !NONCE_RE.test(m.nonce)) return null;
  if (m.type === "collect") return { type: "collect", nonce: m.nonce };
  if (m.type === "review") {
    const solo =
      m.n !== undefined || m.base !== undefined || m.files !== undefined || m.text !== undefined;
    if (!solo) return { type: "review", nonce: m.nonce };
    const files = readFiles(m.files);
    if (!isVersion(m.n) || !isVersion(m.base) || m.base >= m.n || !files) return null;
    if (m.text !== undefined && (typeof m.text !== "string" || m.text.length > MAX_REVIEW_TEXT)) {
      return null;
    }
    return {
      type: "review",
      nonce: m.nonce,
      n: m.n,
      base: m.base,
      files,
      ...(typeof m.text === "string" ? { text: m.text } : {}),
    };
  }
  if (m.type === "reviewed" && RESULTS.has(m.result as string)) {
    return { type: "reviewed", nonce: m.nonce, result: m.result as ReviewResult };
  }
  return null;
}

/** A poster to the app page at its exact origin, with the frame key on every message. */
export function appPoster(win: Window, appOrigin: string, key: string | null) {
  let stopped = false;
  const post = (msg: Record<string, unknown>) => {
    if (appOrigin === "" || stopped) return;
    try {
      win.parent.postMessage(
        {
          source: RENDERER_MESSAGE_SOURCE,
          v: RENDERER_PROTOCOL_VERSION,
          ...msg,
          ...(key ? { key } : {}),
        },
        appOrigin,
      );
    } catch {
      // The app page is gone or navigated away: nobody to tell.
    }
  };
  return {
    post,
    stop: () => {
      stopped = true;
    },
  };
}

export interface ReviewSessionHost {
  post(msg: Record<string, unknown>): void;
  rules: LiveTypeRules;
  /** The room's client, while the frame edits with the room (not solo). */
  room(): LiveDocClient | null;
  /** The solo copy's text, while the frame edits alone. */
  soloText(): string | null;
}

/** The whole-draft review of one frame: the app's `review`, the person's choice, what closed it. */
export class ReviewSession {
  private nonce: string | null = null;
  /** Solo: the kept copy the app sent with `review`, reviewed instead of the frame's own. */
  private kept: string | null = null;

  constructor(
    private readonly review: DraftReview,
    private readonly host: ReviewSessionHost,
  ) {}

  get isOpen(): boolean {
    return this.review.isOpen;
  }

  /** The person's choice in the review, for the app (from DraftReview's `choose`). */
  choose(outcome: ReviewOutcome, note?: string): void {
    const nonce = this.nonce;
    if (!nonce) return;
    if (outcome === "cancelled") {
      this.nonce = null;
      this.host.post({ type: "resolved", nonce, outcome });
      return;
    }
    const c = this.host.room();
    const range = this.review.range;
    if (c && range) {
      // Room mode: the frozen version and the revision reviewed; the room publishes its own draft.
      this.host.post({
        type: "resolved",
        nonce,
        outcome,
        version: range.to,
        rev: c.rev,
        ...(outcome === "publish" && note ? { note } : {}),
      });
      return;
    }
    const text = this.kept ?? this.host.soloText();
    if (outcome === "publish" && text !== null) {
      this.host.post({ type: "resolved", nonce, outcome, text, ...(note ? { note } : {}) });
    } else if (outcome === "discard") {
      this.host.post({ type: "resolved", nonce, outcome });
    }
  }

  /** The app's `review`: open on the room's frozen draft, or (solo) on the version it names. */
  async open(m: Extract<EditAppMessage, { type: "review" }>): Promise<void> {
    this.kept = null;
    const c = m.text === undefined ? this.host.room() : null;
    if (c) {
      if (c.conflictVersion === null || !c.ready) {
        this.host.post({ type: "resolved", nonce: m.nonce, outcome: "cancelled" });
        this.review.announce("Nothing to review: your changes are not waiting on a version.");
        return;
      }
      this.nonce = m.nonce;
      await this.review.open({
        mode: "room",
        base: c.baseVersion,
        n: c.conflictVersion,
        files: c.conflictFiles,
        draft: c.text,
        editors: c.editors.filter((e) => e !== c.you?.email),
      });
      return;
    }
    // A kept copy is checked as the room checks a whole draft: one the type cannot hold is not
    // reviewed (the app keeps it, and can still drop it).
    const kept =
      m.text !== undefined && !this.host.rules.tooLarge(m.text) && this.host.rules.valid(m.text)
        ? m.text
        : null;
    const text = m.text !== undefined ? kept : this.host.soloText();
    if (text === null || m.n === undefined || m.base === undefined) {
      this.host.post({ type: "resolved", nonce: m.nonce, outcome: "cancelled" });
      return;
    }
    this.kept = kept;
    this.nonce = m.nonce;
    await this.review.open({
      mode: "solo",
      base: m.base,
      n: m.n,
      files: m.files ?? null,
      draft: text,
      editors: [],
    });
  }

  /** The app's answer to the choice. */
  answer(m: Extract<EditAppMessage, { type: "reviewed" }>): void {
    if (m.nonce !== this.nonce) return;
    this.review.answer(m.result);
    if (!this.review.isOpen) this.nonce = null;
  }

  /** What the room did to the draft while the review is open: it may close or move the review. */
  version(
    kind: "saved" | "reset" | "rebased" | "conflict",
    n: number,
    info: { why?: "published" | "discarded"; was: number | null },
  ): void {
    if (!this.review.isOpen) return;
    const c = this.host.room();
    if (kind === "conflict" && c && c.conflictVersion === n) {
      // A newer version froze the draft: the review opens again on the whole range.
      void this.review.open({
        mode: "room",
        base: c.baseVersion,
        n,
        files: c.conflictFiles,
        draft: c.text,
        editors: c.editors.filter((e) => e !== c.you?.email),
      });
      return;
    }
    if (kind !== "reset" && kind !== "rebased") return;
    const mine = this.review.chosen;
    let message: string;
    if (info.why === "published") {
      message =
        mine === "publish"
          ? `Your changes were published as v${n}.`
          : `Another editor published these changes as v${n}.`;
    } else if (info.why === "discarded") {
      message =
        mine === "discard"
          ? `Your changes were discarded. The page shows v${n}.`
          : "Another editor discarded these changes.";
    } else if (kind === "rebased") {
      const was = info.was;
      message =
        this.host.rules.merge === "lines"
          ? `v${n} was published, and your changes were kept on top of it.`
          : `v${n} undid the changes of ${was !== null && this.review.range ? versionRange(this.review.range.from, was) : "the version you reviewed"}. Your changes are kept.`;
    } else {
      message = `v${n} is the same as your changes, so nothing is left to publish.`;
    }
    const nonce = this.nonce;
    this.nonce = null;
    this.review.close(message);
    // The app's review state ends with it.
    if (nonce) this.host.post({ type: "resolved", nonce, outcome: "cancelled" });
  }
}

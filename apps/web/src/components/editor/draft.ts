// Unsaved drafts in sessionStorage, keyed by artifact id and the version the draft is based on, so
// a reload (or a crash) does not lose work. Storage can be blocked or full: every access is wrapped,
// and the editor works without it.

import {
  MAX_RESCUE_ITEMS,
  MAX_RESCUE_TOTAL,
  type RescueItem,
  readRescueItems,
} from "../viewer/rendererProtocol.ts";

const PREFIX = "plinth-draft:";

export interface Draft {
  html: string;
  note: string;
  /** The version the draft was started from. Saving it uses this as base_version. */
  base: number;
  saved_at: string;
}

export function draftKey(artifactId: string, base: number): string {
  return `${PREFIX}${artifactId}:v${base}`;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null, base: number): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.html !== "string") return null;
    return {
      html: d.html,
      note: typeof d.note === "string" ? d.note : "",
      base,
      saved_at: typeof d.saved_at === "string" ? d.saved_at : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(artifactId: string, base: number, html: string, note: string): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const draft: Draft = { html, note, base, saved_at: new Date().toISOString() };
    s.setItem(draftKey(artifactId, base), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(artifactId: string, base: number): Draft | null {
  const s = storage();
  if (!s) return null;
  try {
    return parse(s.getItem(draftKey(artifactId, base)), base);
  } catch {
    return null;
  }
}

/** Every draft kept for this artifact, newest base first. */
export function listDrafts(artifactId: string): Draft[] {
  const s = storage();
  if (!s) return [];
  const out: Draft[] = [];
  try {
    const prefix = `${PREFIX}${artifactId}:v`;
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key?.startsWith(prefix)) continue;
      const base = Number(key.slice(prefix.length));
      if (!Number.isInteger(base) || base < 1) continue;
      const d = parse(s.getItem(key), base);
      if (d) out.push(d);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.base - a.base);
}

export function clearDraft(artifactId: string, base: number): void {
  try {
    storage()?.removeItem(draftKey(artifactId, base));
  } catch {
    // storage blocked: nothing was kept
  }
}

/** Remove every draft of this artifact (after a successful save or an explicit discard). */
export function clearAllDrafts(artifactId: string): void {
  for (const d of listDrafts(artifactId)) clearDraft(artifactId, d.base);
}

// ---------- page edits (#36, solo mode: a doc edited on its page without a room) ----------
// One per artifact, in its own namespace so the source editor's drafts never see it. It holds the
// text the doc frame last reported, for "Restore unsaved page edits" after a reload.

const PAGE_PREFIX = "plinth-draft:page-edit:";

export interface PageDraft {
  text: string;
  /** The version the page edits started from. */
  base: number;
  saved_at: string;
}

export function pageDraftKey(artifactId: string): string {
  return `${PAGE_PREFIX}${artifactId}`;
}

export function savePageDraft(artifactId: string, base: number, text: string): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const d: PageDraft = { text, base, saved_at: new Date().toISOString() };
    s.setItem(pageDraftKey(artifactId), JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function loadPageDraft(artifactId: string): PageDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(pageDraftKey(artifactId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PageDraft>;
    if (typeof d.text !== "string" || !Number.isInteger(d.base) || (d.base as number) < 1) {
      return null;
    }
    return {
      text: d.text,
      base: d.base as number,
      saved_at: typeof d.saved_at === "string" ? d.saved_at : "",
    };
  } catch {
    return null;
  }
}

export function clearPageDraft(artifactId: string): void {
  try {
    storage()?.removeItem(pageDraftKey(artifactId));
  } catch {
    // storage blocked: nothing was kept
  }
}

// ---------- the doc frame's rescue store ----------
// Text typed in a doc block on the page that the room's draft does not hold yet (the frame's
// rescue store, renderers/doc/edit.ts): one list per artifact's live draft, in this app origin's
// session storage beside the kept copy, never in the content origin's. Storage can be blocked or
// full, so a copy stays in memory too; the frame is offered the items again after a reload.

const RESCUE_PREFIX = "plinth-draft:page-rescue:";
const rescueMemory = new Map<string, unknown>();

/**
 * One per person and artifact: after an account switch in the tab, the next person is never
 * offered (or writes) the last one's text, which waits under its own key.
 */
export function rescueKey(userId: string, artifactId: string): string {
  return `${RESCUE_PREFIX}${userId}:${artifactId}`;
}

/**
 * Drops every account's rescue store in this tab: only on an explicit sign-out here. A store is
 * never dropped because someone else (or no one yet) is signed in: it is ignored then.
 */
export function clearRescueStores(): void {
  rescueMemory.clear();
  try {
    const s = storage();
    if (!s) return;
    const gone: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(RESCUE_PREFIX)) gone.push(k);
    }
    for (const k of gone) s.removeItem(k);
  } catch {
    // storage blocked: nothing kept there
  }
}

/** Writes a store as the merge below computed it; empty removes it. */
function writeRescue(key: string, items: RescueItem[]): void {
  // Memory holds a store only while storage cannot (blocked or full).
  rescueMemory.delete(key);
  try {
    const s = storage();
    if (!s) throw new Error("no storage");
    if (items.length === 0) s.removeItem(key);
    else s.setItem(key, JSON.stringify(items));
  } catch {
    if (items.length > 0) rescueMemory.set(key, items);
  }
}

/**
 * Merges a frame's report into this person's store for the artifact, which only ever grows by
 * it: each upserted item is added or updated by id while the store stays within
 * MAX_RESCUE_ITEMS and MAX_RESCUE_TOTAL (newest first; one that does not fit leaves what is there
 * as it was), then the ids in `remove` (written or gone, named one by one) leave it. Nothing else
 * takes an item out but clearRescue (a discard) and clearRescueStores (a sign-out). Returns the
 * ids the store holds as upserted: an update refused over the caps keeps the item's older text,
 * so its id is left out, and the frame still offers Copy for it.
 */
export function mergeRescue(
  userId: string,
  artifactId: string,
  upsert: readonly RescueItem[],
  remove: readonly string[],
): string[] {
  const key = rescueKey(userId, artifactId);
  const byId = new Map(
    (readRescueItems(loadRescue(userId, artifactId)) ?? []).map((i) => [i.id, i]),
  );
  const fits = (m: Map<string, RescueItem>) => {
    let total = 0;
    // A deck item's ref counts too, as readRescueItems counts it.
    for (const i of m.values()) total += i.text.length + (i.ref?.length ?? 0);
    return m.size <= MAX_RESCUE_ITEMS && total <= MAX_RESCUE_TOTAL;
  };
  const refused = new Set<string>();
  for (const it of [...upsert].reverse()) {
    const next = new Map(byId);
    next.set(it.id, it);
    if (fits(next)) byId.set(it.id, it);
    else refused.add(it.id);
  }
  for (const id of remove) byId.delete(id);
  writeRescue(key, [...byId.values()]);
  return [...byId.keys()].filter((id) => !refused.has(id));
}

/** Drops this person's store for the artifact: its unpublished changes were discarded. */
export function clearRescue(userId: string, artifactId: string): void {
  writeRescue(rescueKey(userId, artifactId), []);
}

/**
 * How many items the store for the artifact holds in this tab, for the warning before leaving:
 * `userId`'s store once the session is known (none when no one is signed in), so another
 * account's store never warns the person here now; while the session is unknown or could not be
 * read (`undefined`), any account's, as what this tab kept may be theirs.
 */
export function countRescue(artifactId: string, userId?: string | null): number {
  if (userId === null) return 0;
  const suffix = `:${artifactId}`;
  const keys = new Set<string>();
  const mine = userId === undefined ? null : rescueKey(userId, artifactId);
  const wanted = (k: string) => (mine ? k === mine : k.endsWith(suffix));
  for (const k of rescueMemory.keys()) if (wanted(k)) keys.add(k);
  try {
    const s = storage();
    for (let i = 0; s && i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(RESCUE_PREFIX) && wanted(k)) keys.add(k);
    }
  } catch {
    // storage blocked: memory only
  }
  let n = 0;
  for (const k of keys) {
    let v: unknown = rescueMemory.get(k) ?? null;
    if (v === null) {
      try {
        const raw = storage()?.getItem(k);
        if (raw) v = JSON.parse(raw);
      } catch {
        // unreadable: nothing counted
      }
    }
    n += readRescueItems(v)?.length ?? 0;
  }
  return n;
}

/** The kept rescue items, unchecked (the caller reads them field by field), or null. */
export function loadRescue(userId: string, artifactId: string): unknown {
  const key = rescueKey(userId, artifactId);
  if (rescueMemory.has(key)) return rescueMemory.get(key);
  try {
    const raw = storage()?.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    // storage blocked or the copy unreadable
  }
  return null;
}

// Unsaved drafts in sessionStorage, keyed by artifact id and the version the draft is based on, so
// a reload (or a crash) does not lose work. Storage can be blocked or full: every access is wrapped,
// and the editor works without it.

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

export function rescueKey(artifactId: string): string {
  return `${RESCUE_PREFIX}${artifactId}`;
}

/** Keeps the frame's rescue items (`[]` clears them). */
export function saveRescue(artifactId: string, items: unknown[]): void {
  const key = rescueKey(artifactId);
  if (items.length === 0) rescueMemory.delete(key);
  else rescueMemory.set(key, items);
  try {
    const s = storage();
    if (items.length === 0) s?.removeItem(key);
    else s?.setItem(key, JSON.stringify(items));
  } catch {
    // storage blocked or full: the copy in memory stays
  }
}

/** The kept rescue items, unchecked (the caller reads them field by field), or null. */
export function loadRescue(artifactId: string): unknown {
  const key = rescueKey(artifactId);
  try {
    const raw = storage()?.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    // storage blocked or the copy unreadable: the one in memory
  }
  return rescueMemory.get(key) ?? null;
}

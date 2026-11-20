// File changes between two versions (moved from the web app's history/diff.ts, where it was
// diffAssets), and a bounded summary of them that fits in one socket frame.

/** What a change list needs of a version file. AssetInfo has these fields. */
export interface FileEntry {
  path: string;
  size_bytes: number;
  /** Lowercase hex SHA-256 of the bytes, or null for files stored before hashes were kept. */
  sha256: string | null;
}

export type FileChangeKind = "added" | "removed" | "replaced" | "same";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  /** Size in the old version (absent when added). */
  before?: number;
  /** Size in the new version (absent when removed). */
  after?: number;
}

/**
 * File changes between two versions, by path. When both sides list a sha256 they decide: the same
 * hash is "same", another is "replaced", whatever the size. Otherwise only sizes are known, so a
 * file with the same path and size counts as "same" (it may still differ byte for byte). Sorted:
 * added, removed, replaced, same, then by path.
 */
export function fileChanges(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
): FileChange[] {
  const old = new Map(before.map((a) => [a.path, a]));
  const next = new Map(after.map((a) => [a.path, a]));
  const out: FileChange[] = [];
  for (const [path, now] of next) {
    const was = old.get(path);
    if (was === undefined) {
      out.push({ path, kind: "added", after: now.size_bytes });
      continue;
    }
    const same =
      was.sha256 && now.sha256 ? was.sha256 === now.sha256 : was.size_bytes === now.size_bytes;
    out.push({
      path,
      kind: same ? "same" : "replaced",
      before: was.size_bytes,
      after: now.size_bytes,
    });
  }
  for (const [path, was] of old) {
    if (!next.has(path)) out.push({ path, kind: "removed", before: was.size_bytes });
  }
  const order: Record<FileChangeKind, number> = { added: 0, removed: 1, replaced: 2, same: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.path.localeCompare(y.path));
}

export const FILE_SUMMARY_LIMITS = {
  /** Paths listed per kind. */
  maxPaths: 50,
  /** Longest path listed as is; a longer one keeps its start and its end around "…". */
  maxPathChars: 256,
  /**
   * UTF-8 bytes the summary may take as JSON, whatever the paths hold: a frame or a page that
   * carries it stays small even when every path is long and every character takes four bytes.
   */
  maxBytes: 12 * 1024,
} as const;

/** The changed files of a version, at most FILE_SUMMARY_LIMITS of them, for a list or a frame. */
export interface FileChangeSummary {
  added: FileChange[];
  removed: FileChange[];
  replaced: FileChange[];
  /** Changed files not listed, to keep the summary within its limits. */
  more: number;
  /** Files with the same path and content (or size) on both sides. */
  same: number;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function shortPath(path: string, max: number): string {
  const chars = Array.from(path);
  if (chars.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}

/**
 * The changed files of `changes`, listed by kind in their sorted order until a kind has
 * `maxPaths` or the whole summary would pass `maxBytes` as JSON; `more` counts the rest.
 */
export function summarizeFileChanges(
  changes: readonly FileChange[],
  limits: Partial<Record<keyof typeof FILE_SUMMARY_LIMITS, number>> = {},
): FileChangeSummary {
  const { maxPaths, maxPathChars, maxBytes } = { ...FILE_SUMMARY_LIMITS, ...limits };
  const out: FileChangeSummary = { added: [], removed: [], replaced: [], more: 0, same: 0 };
  // The empty summary's own JSON, with room for the largest counts.
  let bytes = utf8Length(JSON.stringify({ ...out, more: 1e9, same: 1e9 }));
  for (const c of changes) {
    if (c.kind === "same") {
      out.same++;
      continue;
    }
    const list = out[c.kind];
    const entry: FileChange = { ...c, path: shortPath(c.path, maxPathChars) };
    const size = utf8Length(JSON.stringify(entry)) + 1;
    if (list.length >= maxPaths || bytes + size > maxBytes) {
      out.more++;
      continue;
    }
    bytes += size;
    list.push(entry);
  }
  return out;
}

// The plain-language list of what changed between two versions: the describers' items (from
// @plinth/shared changes/*), then the files that changed, as rows of the same list. Every string
// is rendered as a text node; the list shows what a person sees on the page, never the artifact's
// source.
import type {
  ChangeItem,
  ChangeList as Changes,
  FileChange,
  FileChangeSummary,
} from "@plinth/shared";
import { useId } from "react";
import { SkeletonText } from "../ui/index.ts";
import { formatBytes } from "./format.ts";
import "./changes.css";

/** Values short enough to read on one line as "before → after", or as one chip. */
const INLINE_MAX = 48;

function Values({ item }: { item: ChangeItem }) {
  const { before, after } = item;
  if (before === undefined && after === undefined) return null;
  // One side only (added, removed, filled in, cleared): its text alone, red or green. The item's
  // words already say which.
  if (before === undefined || after === undefined) {
    const removed = before !== undefined;
    const text = (before ?? after) as string;
    return text.length <= INLINE_MAX ? (
      <p className="hx-change__values">
        <span className={`hx-change__value${removed ? " hx-change__value--before" : ""}`}>
          {text}
        </span>
      </p>
    ) : (
      <p className={`hx-change__excerpt${removed ? " hx-change__excerpt--before" : ""}`}>{text}</p>
    );
  }
  if (before.length + after.length <= INLINE_MAX) {
    return (
      <p className="hx-change__values">
        <span className="visually-hidden">Before: </span>
        <span className="hx-change__value hx-change__value--before">{before}</span>
        <span aria-hidden="true"> → </span>
        <span className="visually-hidden">, after: </span>
        <span className="hx-change__value">{after}</span>
      </p>
    );
  }
  return (
    <dl className="hx-change__pair">
      <div className="hx-change__excerpt hx-change__excerpt--before">
        <dt>Before</dt>
        <dd>{before}</dd>
      </div>
      <div className="hx-change__excerpt">
        <dt>After</dt>
        <dd>{after}</dd>
      </div>
    </dl>
  );
}

function fileSize(c: FileChange): string {
  if (c.kind === "added") return formatBytes(c.after ?? 0);
  if (c.kind === "removed") return formatBytes(c.before ?? 0);
  return c.before === c.after
    ? formatBytes(c.after ?? 0)
    : `${formatBytes(c.before ?? 0)} → ${formatBytes(c.after ?? 0)}`;
}

/** A changed file as a row of the list: "File “img/map.png” added", its size as the place. */
function fileItem(c: FileChange): ChangeItem {
  const kind = c.kind === "added" || c.kind === "removed" ? c.kind : "changed";
  return { kind, where: fileSize(c), what: `File “${c.path}” ${c.kind}` };
}

export interface ChangeListProps {
  /** The describers' list, or null while it is being worked out. */
  changes: Changes | null;
  /** The files part, or null to leave it out. Changed files are listed after the content. */
  files: FileChangeSummary | null;
}

export function ChangeList({ changes, files }: ChangeListProps) {
  const id = useId();
  const fileItems = files
    ? [...files.added, ...files.removed, ...files.replaced].map(fileItem)
    : [];
  const moreFiles = files?.more ?? 0;
  const items = changes ? [...changes.items, ...fileItems] : [];
  return (
    <section className="hx-changes" aria-labelledby={id} aria-busy={changes === null || undefined}>
      {/* The pickers above say which versions; the heading only names the region. */}
      <h2 id={id} className="visually-hidden">
        Changes
      </h2>
      {changes === null ? (
        <div className="hx-changes__loading">
          <span className="visually-hidden">Working out what changed…</span>
          <SkeletonText lines={4} />
        </div>
      ) : (
        <>
          {items.length === 0 && moreFiles === 0 ? (
            <p className="hx-changes__none">Nothing changed in the content.</p>
          ) : (
            <ul className="hx-changes__list">
              {items.map((item, k) => (
                // The list is replaced as a whole, never reordered: the index is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={k} className={`hx-change hx-change--${item.kind}`}>
                  <p className="hx-change__what">
                    {item.what}
                    {item.where !== "" && <span className="hx-change__where">{item.where}</span>}
                  </p>
                  <Values item={item} />
                </li>
              ))}
            </ul>
          )}
          {changes.truncated && (
            <p className="hx-changes__more type-small">More changed than this list shows.</p>
          )}
          {moreFiles > 0 && (
            <p className="hx-changes__more type-small">
              {`And ${moreFiles === 1 ? "1 more file" : `${moreFiles.toLocaleString("en")} more files`}.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

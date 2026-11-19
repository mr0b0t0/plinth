// The plain-language list of what changed between two versions: the describers' items (from
// @plinth/shared changes/*), then the files part. Every string is rendered as a text node; the
// list shows what a person sees on the page, never the artifact's source.
import type {
  ChangeItem,
  ChangeKind,
  ChangeList as Changes,
  FileChange,
  FileChangeSummary,
} from "@plinth/shared";
import { useId } from "react";
import { Badge, SkeletonText } from "../ui/index.ts";
import { formatBytes } from "./format.ts";
import "./changes.css";

const MARK: Record<ChangeKind, string> = { added: "+", removed: "−", changed: "~", moved: "↕" };

/** Values short enough to read on one line as "before → after". */
const INLINE_MAX = 48;

function Values({ item }: { item: ChangeItem }) {
  const { before, after } = item;
  if (before === undefined && after === undefined) return null;
  if (before !== undefined && after !== undefined && before.length + after.length <= INLINE_MAX) {
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
    <dl className="hx-change__excerpts">
      {before !== undefined && (
        <div className="hx-change__excerpt hx-change__excerpt--before">
          <dt>Before</dt>
          <dd>{before}</dd>
        </div>
      )}
      {after !== undefined && (
        <div className="hx-change__excerpt">
          <dt>After</dt>
          <dd>{after}</dd>
        </div>
      )}
    </dl>
  );
}

const FILE_LABEL: Record<Exclude<FileChange["kind"], "same">, string> = {
  added: "Added",
  removed: "Removed",
  replaced: "Replaced",
};
const FILE_TONE = { added: "success", removed: "danger", replaced: "warning" } as const;

function fileSize(c: FileChange): string {
  if (c.kind === "added") return formatBytes(c.after ?? 0);
  if (c.kind === "removed") return formatBytes(c.before ?? 0);
  return c.before === c.after
    ? formatBytes(c.after ?? 0)
    : `${formatBytes(c.before ?? 0)} → ${formatBytes(c.after ?? 0)}`;
}

/** The files part: added, removed and replaced files with their sizes, then a count of the rest. */
export function FileChanges({
  files,
  headingLevel = 3,
}: {
  files: FileChangeSummary;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const listed = [...files.added, ...files.removed, ...files.replaced];
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="hx-files" aria-labelledby={id}>
      <H id={id} className="hx-files__title">
        Files
      </H>
      {listed.length === 0 && files.more === 0 ? (
        <p className="type-small text-muted">
          No files changed
          {files.same > 0
            ? ` (${files.same === 1 ? "1 file is" : `${files.same} files are`} the same in both).`
            : "."}
        </p>
      ) : (
        <>
          <ul className="hx-files__list">
            {listed.map((c) => (
              <li key={`${c.kind}:${c.path}`} className="hx-file">
                <Badge tone={FILE_TONE[c.kind as keyof typeof FILE_TONE]}>
                  {FILE_LABEL[c.kind as keyof typeof FILE_LABEL]}
                </Badge>
                <span className="hx-file__path type-mono">{c.path}</span>
                <span className="hx-file__size type-small text-muted">{fileSize(c)}</span>
              </li>
            ))}
          </ul>
          {(files.more > 0 || files.same > 0) && (
            <p className="type-small text-muted">
              {files.more > 0 &&
                `And ${files.more === 1 ? "1 more file" : `${files.more.toLocaleString("en")} more files`}. `}
              {files.same > 0 &&
                `${files.same === 1 ? "1 file is" : `${files.same.toLocaleString("en")} files are`} the same in both.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export interface ChangeListProps {
  /** "What changed from v4 to v5". */
  heading: string;
  /** The describers' list, or null while it is being worked out. */
  changes: Changes | null;
  /** The files part, or null to leave it out. */
  files: FileChangeSummary | null;
}

export function ChangeList({ heading, changes, files }: ChangeListProps) {
  const id = useId();
  return (
    <section className="hx-changes" aria-labelledby={id} aria-busy={changes === null || undefined}>
      <h2 id={id} className="hx-changes__title">
        {heading}
      </h2>
      {changes === null ? (
        <div className="hx-changes__loading">
          <span className="visually-hidden">Working out what changed…</span>
          <SkeletonText lines={4} />
        </div>
      ) : (
        <>
          {changes.items.length === 0 ? (
            <p className="hx-changes__none">Nothing changed in the content.</p>
          ) : (
            <ul className="hx-changes__list">
              {changes.items.map((item, k) => (
                // The list is replaced as a whole, never reordered: the index is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={k} className={`hx-change hx-change--${item.kind}`}>
                  <span className="hx-change__mark" aria-hidden="true">
                    {MARK[item.kind]}
                  </span>
                  <div className="hx-change__body">
                    <p className="hx-change__what">
                      {item.what}
                      {item.where !== "" && <span className="hx-change__where">{item.where}</span>}
                    </p>
                    <Values item={item} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {changes.truncated && (
            <p className="hx-changes__more type-small">
              These versions differ in more places than the list shows. The two versions below show
              everything.
            </p>
          )}
        </>
      )}
      {files && <FileChanges files={files} />}
    </section>
  );
}

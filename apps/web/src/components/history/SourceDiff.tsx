// Source diff of two versions' source file (index.html, or a doc's content.md): unified by default,
// side by side on wide screens.
// Long unchanged runs fold behind an expander; very long diffs render in pages of rows so the
// page stays responsive. Asset changes are listed under the diff.
import { ColumnsIcon, RowsIcon } from "@phosphor-icons/react";
import type { AssetInfo } from "@plinth/shared";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, SegmentedControl } from "../ui/index.ts";
import {
  type AssetChange,
  type DiffLine,
  diffAssets,
  diffTextLines,
  foldUnchanged,
  type SplitRow,
  splitRows,
  type UnifiedRow,
  unifiedRows,
} from "./diff.ts";
import { formatBytes } from "./format.ts";

/** Rows rendered at once; "Show more" adds another page. */
export const ROW_PAGE = 1500;
const WIDE_QUERY = "(min-width: 64rem)";

function useWide(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia?.(WIDE_QUERY);
      mq?.addEventListener("change", l);
      return () => mq?.removeEventListener("change", l);
    },
    () => window.matchMedia?.(WIDE_QUERY).matches ?? false,
    () => false,
  );
}

export interface SourceDiffProps {
  from: number;
  to: number;
  oldHtml: string;
  newHtml: string;
  oldAssets: AssetInfo[];
  newAssets: AssetInfo[];
  /** The version file being compared (the artifact's source_path). */
  fileName?: string;
  /** What the source is called ("HTML", "Markdown"). */
  sourceLabel?: string;
}

export function SourceDiff({
  from,
  to,
  oldHtml,
  newHtml,
  oldAssets,
  newAssets,
  fileName = "index.html",
  sourceLabel = "HTML",
}: SourceDiffProps) {
  const diff = useMemo(() => diffTextLines(oldHtml, newHtml), [oldHtml, newHtml]);
  const blocks = useMemo(() => foldUnchanged(diff.lines), [diff]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(ROW_PAGE);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const wide = useWide();
  const split = mode === "split" && wide;

  const rows = useMemo(() => unifiedRows(blocks, expanded), [blocks, expanded]);
  const all = useMemo(() => (split ? splitRows(rows) : rows), [rows, split]);
  const shown = all.slice(0, limit);
  const total = all.length;
  const expand = (id: string) => setExpanded((s) => new Set(s).add(id));
  const assets = useMemo(() => diffAssets(oldAssets, newAssets), [oldAssets, newAssets]);

  return (
    <div className="hx-source">
      <div className="hx-source__bar">
        <p className="hx-source__stats" aria-live="polite">
          <span className="hx-file type-mono">{fileName}</span>
          {diff.identical ? (
            <span className="text-muted">No changes</span>
          ) : (
            <>
              <span className="hx-stat hx-stat--added">
                +{diff.added.toLocaleString("en")}
                <span className="visually-hidden"> lines added,</span>
              </span>
              <span className="hx-stat hx-stat--removed">
                −{diff.removed.toLocaleString("en")}
                <span className="visually-hidden"> lines removed</span>
              </span>
            </>
          )}
        </p>
        {wide && !diff.identical && (
          <SegmentedControl
            label="Diff layout"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "unified", label: "Unified", icon: RowsIcon },
              { value: "split", label: "Side by side", icon: ColumnsIcon },
            ]}
          />
        )}
      </div>

      {!diff.exact && (
        <p className="hx-note type-small">
          These versions differ too much to line up line by line quickly, so the changed part is
          shown as removed and then added.
        </p>
      )}

      {diff.identical ? (
        <p className="hx-same">
          The {sourceLabel} of <span className="type-mono">v{from}</span> and{" "}
          <span className="type-mono">v{to}</span> is identical.
        </p>
      ) : (
        <div className="hx-diff">
          {split ? (
            <SplitTable
              from={from}
              to={to}
              fileName={fileName}
              rows={shown as SplitRow[]}
              onExpand={expand}
            />
          ) : (
            <UnifiedTable
              from={from}
              to={to}
              fileName={fileName}
              rows={shown as UnifiedRow[]}
              onExpand={expand}
            />
          )}
          {total > limit && (
            <div className="hx-more">
              <Button size="sm" onClick={() => setLimit((l) => l + ROW_PAGE)}>
                Show {Math.min(ROW_PAGE, total - limit).toLocaleString("en")} more lines
              </Button>
              <span className="type-small text-muted">
                {(total - limit).toLocaleString("en")} not shown yet
              </span>
            </div>
          )}
        </div>
      )}

      <AssetChanges changes={assets} fileName={fileName} />
    </div>
  );
}

function Marker({ kind }: { kind: DiffLine["kind"] }) {
  if (kind === "context") return null;
  return (
    <>
      <span aria-hidden="true">{kind === "added" ? "+" : "−"}</span>
      <span className="visually-hidden">{kind === "added" ? "Added" : "Removed"}</span>
    </>
  );
}

function FoldRow({
  row,
  colSpan,
  onExpand,
}: {
  row: Extract<UnifiedRow, { type: "fold" }>;
  colSpan: number;
  onExpand: (id: string) => void;
}) {
  const last = row.firstNew + row.count - 1;
  return (
    <tr className="hx-fold">
      <td colSpan={colSpan}>
        <button type="button" className="hx-fold__button" onClick={() => onExpand(row.id)}>
          Show {row.count.toLocaleString("en")} unchanged lines
          <span className="hx-fold__range">
            {" "}
            ({row.firstNew}–{last})
          </span>
        </button>
      </td>
    </tr>
  );
}

function UnifiedTable({
  from,
  to,
  fileName,
  rows,
  onExpand,
}: {
  from: number;
  to: number;
  fileName: string;
  rows: UnifiedRow[];
  onExpand: (id: string) => void;
}) {
  return (
    <table className="hx-table hx-table--unified">
      <caption className="visually-hidden">
        Changes to {fileName} from v{from} to v{to}
      </caption>
      <colgroup>
        <col className="hx-col-no" />
        <col className="hx-col-no" />
        <col className="hx-col-mark" />
        <col />
      </colgroup>
      <thead className="visually-hidden">
        <tr>
          <th scope="col">v{from} line</th>
          <th scope="col">v{to} line</th>
          <th scope="col">Change</th>
          <th scope="col">Content</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) =>
          r.type === "fold" ? (
            <FoldRow key={r.id} row={r} colSpan={4} onExpand={onExpand} />
          ) : (
            <tr
              key={`${r.line.oldNo ?? ""}:${r.line.newNo ?? ""}`}
              className={`hx-line hx-line--${r.line.kind}`}
            >
              <td className="hx-no">{r.line.oldNo ?? ""}</td>
              <td className="hx-no">{r.line.newNo ?? ""}</td>
              <td className="hx-mark">
                <Marker kind={r.line.kind} />
              </td>
              <td className="hx-code">{r.line.text}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function SplitTable({
  from,
  to,
  fileName,
  rows,
  onExpand,
}: {
  from: number;
  to: number;
  fileName: string;
  rows: SplitRow[];
  onExpand: (id: string) => void;
}) {
  const side = (line: DiffLine | null, which: "old" | "new") => {
    const kind = line ? (line.kind === "context" ? "context" : line.kind) : "empty";
    const no = line ? (which === "old" ? line.oldNo : line.newNo) : null;
    return [
      <td key={`${which}-no`} className={`hx-no hx-cell--${kind}`}>
        {no ?? ""}
      </td>,
      <td key={`${which}-code`} className={`hx-code hx-cell--${kind}`}>
        {line && line.kind !== "context" && (
          <span className="hx-mark hx-mark--inline">
            <Marker kind={line.kind} />
          </span>
        )}
        {line?.text ?? ""}
      </td>,
    ];
  };
  return (
    <table className="hx-table hx-table--split">
      <caption className="visually-hidden">
        Changes to {fileName}, v{from} on the left and v{to} on the right
      </caption>
      <colgroup>
        <col className="hx-col-no" />
        <col />
        <col className="hx-col-no" />
        <col />
      </colgroup>
      <thead className="visually-hidden">
        <tr>
          <th scope="col">v{from} line</th>
          <th scope="col">v{from}</th>
          <th scope="col">v{to} line</th>
          <th scope="col">v{to}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) =>
          r.type === "fold" ? (
            <FoldRow key={r.id} row={r} colSpan={4} onExpand={onExpand} />
          ) : (
            <tr
              key={`${r.left?.oldNo ?? ""}:${r.right?.newNo ?? ""}:${r.left?.newNo ?? ""}`}
              className="hx-line"
            >
              {side(r.left, "old")}
              {side(r.right, "new")}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

const ASSET_LABEL: Record<Exclude<AssetChange["kind"], "same">, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};
const ASSET_TONE = { added: "success", removed: "danger", changed: "warning" } as const;

function AssetChanges({ changes, fileName }: { changes: AssetChange[]; fileName: string }) {
  const listed = changes.filter((c) => c.kind !== "same");
  const same = changes.length - listed.length;
  return (
    <section className="hx-assets" aria-labelledby="hx-assets-title">
      <h2 id="hx-assets-title" className="hx-assets__title">
        Other files
      </h2>
      {changes.length === 0 ? (
        <p className="type-small text-muted">Neither version has files besides {fileName}.</p>
      ) : (
        <>
          {listed.length > 0 && (
            <ul className="hx-assets__list">
              {listed.map((c) => (
                <li key={c.path} className="hx-asset">
                  <Badge tone={ASSET_TONE[c.kind as keyof typeof ASSET_TONE]}>
                    {ASSET_LABEL[c.kind as keyof typeof ASSET_LABEL]}
                  </Badge>
                  <span className="hx-asset__path type-mono">{c.path}</span>
                  <span className="hx-asset__size type-small text-muted">
                    {c.kind === "added" && formatBytes(c.after ?? 0)}
                    {c.kind === "removed" && formatBytes(c.before ?? 0)}
                    {c.kind === "changed" &&
                      `${formatBytes(c.before ?? 0)} → ${formatBytes(c.after ?? 0)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="type-small text-muted">
            {listed.length === 0 ? "No files were added, removed or resized. " : ""}
            {same > 0 &&
              `${same === 1 ? "1 file has" : `${same} files have`} the same path and size in both versions.`}
          </p>
        </>
      )}
    </section>
  );
}

// The review of a sheet's page edits when a version was published while they were unsaved (#36),
// in a dialog on the artifact page. A sheet's draft is never merged with that version (rows and
// formulas refer to each other by position, and a line merge cannot tell an edit from a move), so
// the editors see both sheets side by side (one at a time at phone width), every row, in the first
// column and the columns either side changed, with the changed cells marked, and choose one:
// - "Publish mine": the page edits become the next version, on top of the one published meanwhile,
//   which stays in the history ("Edited on the page. Replaces the changes in v6.");
// - "Discard mine": the button turns into "Discard for everyone" (or "Confirm discard" for this
//   tab's own edits), and a second press returns the page to the version published meanwhile.
// Changes a grid cannot show (a row removed, a column's settings) are named under it. Closing the
// dialog keeps the draft frozen. It is its own lazy chunk. Cells are text nodes, never HTML: sheet
// text is untrusted.
import { FloppyDiskIcon, TrashIcon } from "@phosphor-icons/react";
import { type RefObject, type UIEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMediaQuery } from "../editor/useMediaQuery.ts";
import { Button, Dialog, SegmentedControl } from "../ui/index.ts";
import {
  type ChangeList,
  changedColumns,
  offGridChanges,
  onlyColumns,
  type ReviewGrid,
  reviewGrid,
  summarize,
} from "./sheetReview.ts";
import type { LiveConflict } from "./useLiveEdit.ts";
import "./liveSheetReview.css";

export interface LiveSheetReviewProps {
  conflict: LiveConflict;
  saving: boolean;
  /** "room": the shared draft of everyone editing; "solo": this tab's own edits. */
  mode: "room" | "solo";
  onClose: () => void;
  onPublishMine: () => void;
  onDiscardMine: () => void;
}

type Side = "mine" | "theirs";
/** One side at a time, with the switch (liveSheetReview.css). */
const NARROW = "(max-width: 40rem)";

/** The changes the grid above cannot show, in one muted line. */
function OffGrid({ list }: { list: ChangeList | null }) {
  if (!list || list.items.length === 0) return null;
  return <p className="pl-sheetreview__offgrid">{summarize(list)}</p>;
}

function Grid({
  grid,
  label,
  active,
  onScroll,
  scrollRef,
}: {
  grid: ReviewGrid | null;
  label: string;
  /** Shown (at phone width one side at a time): it scrolls to its first change once shown. */
  active: boolean;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  // The first changed cell in view, past the sticky row numbers, first column and column names
  // (once the dialog has its size).
  useLayoutEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      const box = scrollRef.current;
      const cell = box?.querySelector<HTMLElement>("td[data-changed]");
      if (!box || !cell) return;
      const first = box.querySelector<HTMLElement>("tbody td");
      const pinned = first ? first.offsetLeft + first.offsetWidth : 0;
      const colHead = box.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0;
      if (cell.offsetLeft + cell.offsetWidth > box.scrollLeft + box.clientWidth) {
        box.scrollLeft = Math.max(0, cell.offsetLeft - pinned);
      }
      if (cell.offsetTop + cell.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, cell.offsetTop - colHead);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [scrollRef, active]);
  if (!grid) return <p className="pl-sheetreview__none">This sheet could not be read.</p>;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling region is reachable by keyboard
    <div className="pl-sheetreview__grid" ref={scrollRef} onScroll={onScroll} tabIndex={0}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Row</span>
            </th>
            {grid.columns.map((c, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                key={i}
                scope="col"
                data-changed={grid.columnsChanged[i] ? "true" : undefined}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((r) => (
            <tr key={r.n} data-changed={r.changed ? "true" : undefined}>
              <th scope="row">{r.n}</th>
              {r.cells.map((c, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={i}
                  title={c.title}
                  data-number={c.number ? "true" : undefined}
                  data-changed={c.changed ? "true" : undefined}
                >
                  {c.text}
                  {c.changed && <span className="visually-hidden"> (changed)</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {grid.more > 0 && (
        <p className="pl-sheetreview__more">
          and {grid.more} more {grid.more === 1 ? "row" : "rows"}
        </p>
      )}
    </div>
  );
}

export default function LiveSheetReview({
  conflict,
  saving,
  mode,
  onClose,
  onPublishMine,
  onDiscardMine,
}: LiveSheetReviewProps) {
  const { current, draft, currentText } = conflict;
  const baseText = conflict.baseText ?? null;
  const [show, setShow] = useState<Side>("mine");
  const narrow = useMediaQuery(NARROW);
  // "Discard mine" asks once more in place: the button turns into the confirmation.
  const [armed, setArmed] = useState(false);
  // Both sides show the same columns: the first, and those either side changed.
  const [mine, theirs] = useMemo(() => {
    const a = reviewGrid(draft, baseText);
    const b = reviewGrid(currentText, baseText);
    const keep = changedColumns(a, b);
    return [onlyColumns(a, keep), onlyColumns(b, keep)];
  }, [draft, currentText, baseText]);
  const mineOff = useMemo(
    () => (baseText === null ? null : offGridChanges(baseText, draft)),
    [baseText, draft],
  );
  const theirOff = useMemo(
    () => (baseText === null ? null : offGridChanges(baseText, currentText)),
    [baseText, currentText],
  );
  // The two grids scroll together, row by row.
  const mineRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const follow = (other: RefObject<HTMLDivElement | null>) => (e: UIEvent<HTMLDivElement>) => {
    const o = other.current;
    if (o && o.scrollTop !== e.currentTarget.scrollTop) o.scrollTop = e.currentTarget.scrollTop;
  };
  const confirmLabel = mode === "room" ? "Discard for everyone" : "Confirm discard";
  return (
    <Dialog
      open
      onClose={onClose}
      title={`v${current} published while you edited`}
      size="lg"
      footer={
        <>
          <span className="visually-hidden" aria-live="polite">
            {armed ? `Press ${confirmLabel} to drop your changes.` : ""}
          </span>
          <Button
            variant={armed ? "danger" : "secondary"}
            icon={TrashIcon}
            onClick={() => (armed ? onDiscardMine() : setArmed(true))}
            disabled={saving}
          >
            {armed ? confirmLabel : "Discard mine"}
          </Button>
          <Button variant="primary" icon={FloppyDiskIcon} onClick={onPublishMine} loading={saving}>
            Publish mine
          </Button>
        </>
      }
    >
      <div className="pl-sheetreview" data-show={show}>
        <SegmentedControl<Side>
          label="Show"
          className="pl-sheetreview__switch"
          size="sm"
          value={show}
          onChange={setShow}
          options={[
            { value: "mine", label: "Mine" },
            { value: "theirs", label: `v${current}` },
          ]}
        />
        <div className="pl-sheetreview__panes">
          <section className="pl-sheetreview__pane" data-side="mine" aria-label="Mine">
            <h3 className="pl-sheetreview__label">Mine</h3>
            <Grid
              grid={mine}
              label="Mine"
              active={show === "mine" || !narrow}
              scrollRef={mineRef}
              onScroll={follow(theirsRef)}
            />
            <OffGrid list={mineOff} />
          </section>
          <section className="pl-sheetreview__pane" data-side="theirs" aria-label={`v${current}`}>
            <h3 className="pl-sheetreview__label">v{current}</h3>
            <Grid
              grid={theirs}
              label={`v${current}`}
              active={show === "theirs" || !narrow}
              scrollRef={theirsRef}
              onScroll={follow(mineRef)}
            />
            <OffGrid list={theirOff} />
          </section>
        </div>
      </div>
    </Dialog>
  );
}

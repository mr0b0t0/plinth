// The review of a sheet's page edits when a version was published while they were unsaved (#36),
// in a dialog on the artifact page. A sheet's draft is never merged with that version (rows and
// formulas refer to each other by position, and a line merge cannot tell an edit from a move), so
// the editors see both sheets whole, side by side (one at a time at phone width), with what each
// side changed since the draft's base, and choose exactly one:
// - "Publish mine": the page edits become the next version, on top of the one published meanwhile,
//   which stays in the history ("Edited on the page. Replaces the changes in v6.");
// - "Discard mine": after a confirmation that names what will be lost, the page goes back to the
//   version published meanwhile.
// Cancel closes the review and keeps the draft frozen. It is its own lazy chunk. Cells are text
// nodes, never HTML: sheet text is untrusted.
import { FloppyDiskIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { type RefObject, type UIEvent, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, Dialog, SegmentedControl } from "../ui/index.ts";
import {
  type ChangeList,
  changeCount,
  describeSheetChanges,
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

function Changes({ title, list }: { title: string; list: ChangeList }) {
  return (
    <div className="pl-sheetreview__changes">
      <h4 className="pl-sheetreview__changes-title">{title}</h4>
      {list.items.length === 0 ? (
        <p className="pl-sheetreview__none">No changes.</p>
      ) : (
        <ul>
          {list.items.map((item, i) => (
            // Items can repeat (two rows added with the same name); their order is fixed.
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list, never reordered
            <li key={i}>{item}</li>
          ))}
          {list.more > 0 && <li>and {list.more} more</li>}
        </ul>
      )}
    </div>
  );
}

function Grid({
  grid,
  label,
  onScroll,
  scrollRef,
}: {
  grid: ReviewGrid | null;
  label: string;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
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
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((r) => (
            <tr key={r.n} data-changed={r.changed ? "true" : undefined}>
              <th scope="row">
                {r.n}
                {r.changed && <span className="visually-hidden"> (changed)</span>}
              </th>
              {r.cells.map((c, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={i}
                  title={c.title}
                  data-number={c.number ? "true" : undefined}
                >
                  {c.text}
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
  const { base, current, draft, currentText } = conflict;
  const baseText = conflict.baseText ?? null;
  const [show, setShow] = useState<Side>("mine");
  const [confirming, setConfirming] = useState(false);
  const mine = useMemo(() => reviewGrid(draft, baseText), [draft, baseText]);
  const theirs = useMemo(() => reviewGrid(currentText, baseText), [currentText, baseText]);
  const mineChanges = useMemo(
    () => (baseText === null ? null : describeSheetChanges(baseText, draft)),
    [baseText, draft],
  );
  const theirChanges = useMemo(
    () => (baseText === null ? null : describeSheetChanges(baseText, currentText)),
    [baseText, currentText],
  );
  // The two grids scroll together, row by row.
  const mineRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const follow = (other: RefObject<HTMLDivElement | null>) => (e: UIEvent<HTMLDivElement>) => {
    const o = other.current;
    if (o && o.scrollTop !== e.currentTarget.scrollTop) o.scrollTop = e.currentTarget.scrollTop;
  };
  const next = current + 1;
  const lost = mineChanges ? changeCount(mineChanges) : 0;
  const discardDescription =
    (mineChanges && lost > 0
      ? `${lost === 1 ? "This change" : `These ${lost} changes`} will be lost: ${summarize(mineChanges)}. They are not kept anywhere.`
      : "The page changes will be lost. They are not kept anywhere.") +
    (mode === "room" ? " This drops the unpublished changes of everyone editing this sheet." : "");
  const mineLabel = `Your page changes (not published, based on v${base})`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`v${current} was published while you were editing`}
      description={`Your page changes were not combined with it. Choose which one to keep. The other stays available: v${current} in History, or your changes until you discard them.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            icon={TrashIcon}
            onClick={() => setConfirming(true)}
            disabled={saving}
          >
            Discard mine
          </Button>
          <Button variant="primary" icon={FloppyDiskIcon} onClick={onPublishMine} loading={saving}>
            Publish mine
          </Button>
        </>
      }
    >
      <div className="pl-sheetreview" data-show={show}>
        <p className="pl-sheetreview__choice">
          <WarningIcon aria-hidden="true" className="pl-sheetreview__icon" />
          <span>
            Publish mine: your page changes become v{next}. The changes v{current} made, listed
            below, will not be in v{next}. v{current} stays in History and can be restored.
          </span>
        </p>
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
          <section className="pl-sheetreview__pane" data-side="mine" aria-label={mineLabel}>
            <h3 className="pl-sheetreview__label">{mineLabel}</h3>
            {mineChanges && (
              <Changes title={`Your page changes, since v${base}`} list={mineChanges} />
            )}
            <Grid grid={mine} label={mineLabel} scrollRef={mineRef} onScroll={follow(theirsRef)} />
          </section>
          <section className="pl-sheetreview__pane" data-side="theirs" aria-label={`v${current}`}>
            <h3 className="pl-sheetreview__label">v{current}</h3>
            {theirChanges && (
              <Changes title={`What v${current} changed, since v${base}`} list={theirChanges} />
            )}
            <Grid
              grid={theirs}
              label={`v${current}`}
              scrollRef={theirsRef}
              onScroll={follow(mineRef)}
            />
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onDiscardMine();
        }}
        title="Discard the page changes?"
        description={discardDescription}
        confirmLabel="Discard the page changes"
        danger
      />
    </Dialog>
  );
}

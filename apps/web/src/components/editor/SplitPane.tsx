// Two panes side by side with a draggable, keyboard-operable divider (a window splitter:
// role="separator" with a value). Arrow keys move it, Home/End go to the limits, Enter or a double
// click resets it to the middle. Either pane can be shown alone.
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";

export type SplitView = "split" | "code" | "preview";

export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
const STEP = 5;

export const clampSplit = (n: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(n)));

/** The new divider position (percent) for a key, or null when the key does nothing. */
export function splitForKey(key: string, current: number): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clampSplit(current - STEP);
    case "ArrowRight":
    case "ArrowUp":
      return clampSplit(current + STEP);
    case "Home":
      return SPLIT_MIN;
    case "End":
      return SPLIT_MAX;
    case "Enter":
      return 50;
    default:
      return null;
  }
}

export interface SplitPaneProps {
  view: SplitView;
  start: ReactNode;
  end: ReactNode;
  /** Names what the divider resizes. */
  label: string;
  /** id of the start pane, for aria-controls. */
  startId: string;
}

export function SplitPane({ view, start, end, label, startId }: SplitPaneProps) {
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const fromPointer = (e: PointerEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setSplit(clampSplit(((e.clientX - rect.left) / rect.width) * 100));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = splitForKey(e.key, split);
    if (next === null) return;
    e.preventDefault();
    setSplit(next);
  };

  const startBasis = view === "split" ? `${split}%` : view === "code" ? "100%" : "0%";

  return (
    <div
      ref={rootRef}
      className={`pl-split pl-split--${view}${dragging ? " pl-split--dragging" : ""}`}
    >
      <div
        id={startId}
        className="pl-split__pane pl-split__pane--start"
        style={{ flexBasis: startBasis }}
        hidden={view === "preview"}
      >
        {start}
      </div>
      {view === "split" && (
        // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter has no native element
        <div
          className="pl-split__divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-controls={startId}
          aria-valuenow={split}
          aria-valuemin={SPLIT_MIN}
          aria-valuemax={SPLIT_MAX}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDoubleClick={() => setSplit(50)}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (dragging) fromPointer(e);
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
          }}
          onPointerCancel={() => setDragging(false)}
        />
      )}
      <div className="pl-split__pane pl-split__pane--end" hidden={view === "code"}>
        {end}
      </div>
    </div>
  );
}

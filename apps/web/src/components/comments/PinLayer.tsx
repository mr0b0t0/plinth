// Numbered pins drawn over the artifact frame. The layer covers the frame's box and lets every
// pointer event through; only the pins themselves take clicks, so the artifact stays usable.
// Positions come from the bridge (viewport coordinates inside the frame) and are untrusted:
// they were validated as finite numbers and are only used to place the pins, clamped to the frame.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PinPosition } from "./bridge.ts";
import { excerpt, type Thread } from "./model.ts";

export interface PinLayerProps {
  frame: HTMLIFrameElement | null;
  threads: Thread[];
  positions: Map<string, PinPosition>;
  activeId: string | null;
  /** The panel, so pins hidden behind it (on narrow screens it covers the frame) are not drawn. */
  panelRef: RefObject<HTMLElement | null>;
  onPinClick: (id: string) => void;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PIN_SIZE = 24;

function frameBox(frame: HTMLIFrameElement): Box {
  const r = frame.getBoundingClientRect();
  // The reported coordinates are relative to the frame's content box.
  return {
    top: r.top + frame.clientTop,
    left: r.left + frame.clientLeft,
    width: frame.clientWidth || r.width,
    height: frame.clientHeight || r.height,
  };
}

const sameBox = (a: Box | null, b: Box) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

function useFrameBox(frame: HTMLIFrameElement | null, tick: unknown): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-measures when positions change
  useLayoutEffect(() => {
    if (!frame) {
      setBox(null);
      return;
    }
    const measure = () => {
      const next = frameBox(frame);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(frame);
    if (frame.parentElement) ro?.observe(frame.parentElement);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [frame, tick]);
  return box;
}

/** The panel's box, re-measured after every render and whenever it resizes (picking mode). */
function usePanelBox(panelRef: RefObject<HTMLElement | null>): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  const measure = useCallback(() => {
    const r = panelRef.current?.getBoundingClientRect();
    const next = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
    setBox((prev) => (next === null ? null : sameBox(prev, next) ? prev : next));
  }, [panelRef]);
  useLayoutEffect(measure);
  useEffect(() => {
    const el = panelRef.current;
    const ro = el && typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (el) ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelRef, measure]);
  return box;
}

const inside = (b: Box, x: number, y: number) =>
  x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export function PinLayer({
  frame,
  threads,
  positions,
  activeId,
  panelRef,
  onPinClick,
}: PinLayerProps) {
  const box = useFrameBox(frame, positions);
  const panelBox = usePanelBox(panelRef);

  if (!frame || !box || box.width <= 0 || box.height <= 0) return null;

  const pins = threads.flatMap((t) => {
    const p = positions.get(t.root.id);
    if (!p?.visible || t.pin === null || t.root.status !== "open") return [];
    const ax = t.root.anchor?.x ?? 0;
    const ay = t.root.anchor?.y ?? 0;
    const x = clamp(p.left + p.width * ax, PIN_SIZE / 2, box.width - PIN_SIZE / 2);
    const y = clamp(p.top + p.height * ay, PIN_SIZE / 2, box.height - PIN_SIZE / 2);
    const vx = box.left + x;
    const vy = box.top + y;
    if (panelBox && inside(panelBox, vx, vy)) return [];
    return [{ thread: t, x, y }];
  });

  return createPortal(
    <div
      className="cm-pins"
      data-testid="comment-pins"
      // Pins sit on the artifact, not on app chrome: one palette that reads on any page.
      data-theme="light"
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    >
      {pins.map(({ thread, x, y }) => (
        <button
          key={thread.root.id}
          type="button"
          className="cm-pin"
          data-active={thread.root.id === activeId || undefined}
          data-thread-id={thread.root.id}
          style={{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` }}
          aria-label={`Comment ${thread.pin}: ${excerpt(thread.root.anchor?.text)}`}
          title={`Comment ${thread.pin}`}
          onClick={() => onPinClick(thread.root.id)}
        >
          {thread.pin}
        </button>
      ))}
    </div>,
    document.body,
  );
}

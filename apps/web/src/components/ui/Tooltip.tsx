import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./tooltip.css";

export interface TooltipProps {
  /** Short text. No links or buttons: a tooltip cannot be reached by keyboard. */
  content: ReactNode;
  /** One focusable element (a button, a link). It gets aria-describedby. */
  children: ReactElement<{ "aria-describedby"?: string; "aria-label"?: string; label?: unknown }>;
  placement?: "top" | "bottom";
  /** Hover delay in ms. Keyboard focus shows it at once. */
  delay?: number;
}

function isKeyboardFocus(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return true;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Tooltip on hover and keyboard focus. Escape hides it; pointer can move onto it without it
 * closing (WCAG 1.4.13). The trigger is described by it, unless the tooltip only repeats the
 * trigger's aria-label (then it would be read twice).
 */
export function Tooltip({ content, children, placement = "top", delay = 350 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = (wait: number) => {
    window.clearTimeout(timer.current);
    if (wait <= 0) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  // A short grace period lets the pointer cross the gap onto the tooltip.
  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Fixed positioning, clamped to the viewport, so a tooltip near an edge never causes scrolling.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchorRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a || !t) return;
    const gap = 6;
    const margin = 8;
    const vw = document.documentElement.clientWidth;
    const left = Math.min(
      Math.max(a.left + a.width / 2 - t.width / 2, margin),
      vw - t.width - margin,
    );
    let top = placement === "top" ? a.top - t.height - gap : a.bottom + gap;
    if (top < margin) top = a.bottom + gap;
    setPos({ left, top });
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.clearTimeout(timer.current);
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!isValidElement(children)) return children;
  // IconButton takes its name as `label`; plain elements as aria-label.
  const name = children.props["aria-label"] ?? children.props.label;
  const sameAsLabel = typeof content === "string" && name === content;
  const describedBy = sameAsLabel
    ? children.props["aria-describedby"]
    : [children.props["aria-describedby"], id].filter(Boolean).join(" ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only listens; the child is the control
    <span
      ref={anchorRef}
      className="pl-tooltip-anchor"
      onPointerEnter={(e) => e.pointerType !== "touch" && show(open ? 0 : delay)}
      onPointerLeave={hideSoon}
      onFocus={(e) => isKeyboardFocus(e.target) && show(0)}
      onBlur={hide}
    >
      {cloneElement(children, { "aria-describedby": describedBy || undefined })}
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        className="pl-tooltip"
        data-placed={pos ? "" : undefined}
        style={pos ? { left: pos.left, top: pos.top } : undefined}
        hidden={!open}
      >
        {content}
      </span>
    </span>
  );
}

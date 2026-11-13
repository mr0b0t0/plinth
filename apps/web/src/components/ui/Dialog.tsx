import { XIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "./Button.tsx";
import "./dialog.css";
import { focusElement, getFocusable } from "./focus.ts";

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button, a backdrop click, or a footer action you wire up. */
  onClose: () => void;
  title: ReactNode;
  /** One or two sentences under the title, read when the dialog opens. */
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, right-aligned. Put the primary action last. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Element to focus on open. Defaults to the first focusable element in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** "alertdialog" for confirmations that interrupt (delete, revoke). */
  role?: "dialog" | "alertdialog";
  /** Hide the close button (the dialog still closes on Escape). */
  hideClose?: boolean;
}

/**
 * Modal dialog: focus moves in on open and is trapped, Escape closes, focus returns to the
 * element that opened it, and the rest of the page is inert while it is open.
 */
export function Dialog(props: DialogProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<DialogPanel {...props} />, document.body);
}

function DialogPanel({
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocus,
  role = "dialog",
  hideClose = false,
}: DialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = description ? `${id}-desc` : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const initialFocusRef = useRef(initialFocus);

  // One effect, so the teardown order is fixed: stop watching focus, lift `inert` from the page,
  // then put focus back on the element that opened the dialog (it cannot take focus while inert).
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;

    // Make everything else inert and stop the page behind from scrolling.
    const others = [...document.body.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el !== root &&
        !el.hasAttribute("inert") &&
        !el.hasAttribute("data-pl-live"),
    );
    for (const el of others) el.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus in.
    const target =
      initialFocusRef.current?.current ??
      (bodyRef.current && getFocusable(bodyRef.current)[0]) ??
      getFocusable(panel)[0] ??
      panel;
    focusElement(target);

    // If focus escapes (e.g. a click on the backdrop), bring it back.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !panel.contains(t) && !t.closest?.("[data-pl-live]")) {
        focusElement(getFocusable(panel)[0] ?? panel);
      }
    };
    document.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      for (const el of others) el.removeAttribute("inert");
      document.body.style.overflow = overflow;
      if (previous && document.contains(previous)) focusElement(previous);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = getFocusable(panel);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      focusElement(last);
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      focusElement(first);
    }
  };

  return (
    <div ref={rootRef} className="pl-dialog-root">
      <div
        className="pl-dialog-backdrop"
        aria-hidden="true"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onCloseRef.current();
        }}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: role is "dialog" or "alertdialog" (a prop Biome cannot see); both support aria-modal and own the Tab/Escape keys */}
      <div
        ref={panelRef}
        className={`pl-dialog pl-dialog--${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="pl-dialog__header">
          <h2 id={titleId} className="pl-dialog__title">
            {title}
          </h2>
          {!hideClose && (
            <IconButton
              icon={XIcon}
              label="Close"
              size="sm"
              className="pl-dialog__close"
              onClick={() => onCloseRef.current()}
            />
          )}
        </div>
        {description && (
          <p id={descId} className="pl-dialog__description">
            {description}
          </p>
        )}
        {children && (
          <div ref={bodyRef} className="pl-dialog__body">
            {children}
          </div>
        )}
        {footer && <div className="pl-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Names the action, e.g. "Revoke connection". Never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive action: danger button, role="alertdialog", focus starts on Cancel. */
  danger?: boolean;
  loading?: boolean;
}

/** A yes/no question with a named action. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      role={danger ? "alertdialog" : "dialog"}
      initialFocus={danger ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? "danger" : "primary"}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ICON_SIZE } from "./icons.tsx";
import "./toast.css";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  /** Short and specific: say what happened ("Link copied", "Version 4 restored"). */
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it hides; 0 keeps it until dismissed. Defaults: 5s, 8s for danger. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: number;
  tone: ToastTone;
  duration: number;
}

// A tiny store, so toasts can be raised from anywhere (event handlers, API callbacks).
let toasts: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Show a toast. Returns its id (for dismissToast). */
export function showToast(opts: ToastOptions): number {
  const tone = opts.tone ?? "neutral";
  const duration = opts.duration ?? (opts.action ? 10000 : tone === "danger" ? 8000 : 5000);
  const record: ToastRecord = { ...opts, id: nextId++, tone, duration };
  toasts = [...toasts, record].slice(-4);
  emit();
  return record.id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** For tests. */
export function clearToasts(): void {
  toasts = [];
  emit();
}

export interface ToastApi {
  toast: (opts: ToastOptions) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const api: ToastApi = {
  toast: showToast,
  success: (title, description) => showToast({ title, description, tone: "success" }),
  error: (title, description) => showToast({ title, description, tone: "danger" }),
  dismiss: dismissToast,
};

/** Raise toasts. A <Toaster /> must be mounted (AppShell and PublicShell mount one). */
export function useToast(): ToastApi {
  return api;
}

// Only one Toaster renders even if two are mounted.
const owners: string[] = [];
const ownerListeners = new Set<() => void>();
const subscribeOwners = (l: () => void) => {
  ownerListeners.add(l);
  return () => {
    ownerListeners.delete(l);
  };
};

const ICONS = {
  neutral: InfoIcon,
  success: CheckCircleIcon,
  warning: WarningIcon,
  danger: WarningCircleIcon,
} as const;

/**
 * The toast viewport: two live regions (polite for most, assertive for danger) that always exist,
 * so screen readers announce what gets added.
 */
export function Toaster() {
  const me = useId();
  useEffect(() => {
    owners.push(me);
    for (const l of ownerListeners) l();
    return () => {
      owners.splice(owners.indexOf(me), 1);
      for (const l of ownerListeners) l();
    };
  }, [me]);
  const owner = useSyncExternalStore(
    subscribeOwners,
    () => owners[0],
    () => undefined,
  );
  const list = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  if (owner !== me || typeof document === "undefined") return null;
  const polite = list.filter((t) => t.tone !== "danger");
  const urgent = list.filter((t) => t.tone === "danger");
  return createPortal(
    <section className="pl-toaster" aria-label="Notifications" data-pl-live="">
      <div role="status" aria-live="polite" aria-atomic="false" className="pl-toaster__region">
        {polite.map((t) => (
          <ToastView key={t.id} toast={t} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="pl-toaster__region">
        {urgent.map((t) => (
          <ToastView key={t.id} toast={t} />
        ))}
      </div>
    </section>,
    document.body,
  );
}

/**
 * How long a pointer or focus resting on a toast holds it, at most: a pointer left on a toast
 * never keeps it on screen for good.
 */
export const TOAST_PAUSE_MAX_MS = 10_000;

function ToastView({ toast }: { toast: ToastRecord }) {
  const ToneIcon = ICONS[toast.tone];
  const paused = useRef(false);
  const pausedFor = useRef(0);
  const remaining = useRef(toast.duration);

  useEffect(() => {
    if (toast.duration <= 0) return;
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (paused.current && pausedFor.current < TOAST_PAUSE_MAX_MS) {
        pausedFor.current += now - last;
      } else remaining.current -= now - last;
      last = now;
      if (remaining.current <= 0) dismissToast(toast.id);
    }, 100);
    return () => window.clearInterval(timer);
  }, [toast.id, toast.duration]);

  const pause = () => {
    paused.current = true;
  };
  const resume = () => {
    paused.current = false;
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pausing on hover/focus is a convenience; it adds no action
    <div
      className={`pl-toast pl-toast--${toast.tone}`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <ToneIcon className="pl-toast__icon" size={ICON_SIZE.md} aria-hidden="true" />
      <div className="pl-toast__text">
        <p className="pl-toast__title">{toast.title}</p>
        {toast.description && <p className="pl-toast__description">{toast.description}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="pl-toast__action"
          onClick={() => {
            toast.action?.onClick();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="pl-toast__close"
        aria-label={`Dismiss: ${toast.title}`}
        onClick={() => dismissToast(toast.id)}
      >
        <XIcon size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
    </div>
  );
}

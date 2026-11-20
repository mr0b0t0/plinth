// A read-only, monospace value with a copy button: MCP URL, share link, a new token. CopyBlock is
// the same for multi-line text such as shell commands and config files.
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Field, IconButton, Tooltip, useToast } from "../ui/index.ts";
import { copyText } from "./clipboard.ts";

export interface CopyFieldProps {
  label: ReactNode;
  value: string;
  hint?: ReactNode;
  hideLabel?: boolean;
  /** Accessible name of the button, e.g. "Copy token". */
  copyLabel?: string;
  /** Toast title after copying, e.g. "Token copied". */
  copiedMessage?: string;
  /**
   * Wraps long values (tokens) instead of scrolling them, in a box with the copy button inside,
   * like CopyBlock's.
   */
  multiline?: boolean;
  className?: string;
}

/** Copy `value` on demand, with a toast and a check mark for two seconds. */
function useCopy(value: string, copiedMessage: string): { copied: boolean; onCopy: () => void } {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const onCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      toast.success(copiedMessage);
    } else {
      toast.error("Could not copy", "Select the text and copy it by hand.");
    }
  };
  return { copied, onCopy: () => void onCopy() };
}

export function CopyField({
  label,
  value,
  hint,
  hideLabel,
  copyLabel = "Copy",
  copiedMessage = "Copied",
  multiline = false,
  className,
}: CopyFieldProps) {
  const { copied, onCopy } = useCopy(value, copiedMessage);

  return (
    <Field label={label} hint={hint} hideLabel={hideLabel} className={className}>
      {(p) => (
        <div className={multiline ? "pl-acct-copy pl-acct-copy--box" : "pl-acct-copy"}>
          {multiline ? (
            <textarea
              {...p}
              readOnly
              rows={2}
              value={value}
              spellCheck={false}
              className="pl-acct-copy__value pl-acct-copy__value--wrap"
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            <input
              {...p}
              readOnly
              value={value}
              spellCheck={false}
              className="pl-control pl-control--mono pl-acct-copy__value"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
          <Tooltip content={copyLabel}>
            <IconButton
              icon={copied ? CheckIcon : CopyIcon}
              label={copyLabel}
              variant="secondary"
              onClick={onCopy}
            />
          </Tooltip>
        </div>
      )}
    </Field>
  );
}

export interface CopyBlockProps {
  /** Visible caption above the block, e.g. "Run in a terminal". */
  label: ReactNode;
  value: string;
  /** Accessible name of the button, e.g. "Copy commands". */
  copyLabel: string;
  copiedMessage?: string;
  /** false keeps each line whole and scrolls sideways (YAML, where a wrapped line reads wrong). */
  wrap?: boolean;
}

/** True while `el` has more to show past its right edge (scrolled sideways, or not yet). */
function useMoreToTheRight(el: HTMLElement | null, value: string): boolean {
  const [more, setMore] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `value` can change the width
  useEffect(() => {
    if (!el) return;
    const measure = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [el, value]);
  return more;
}

/** Preformatted text (commands, JSON) with a copy button. Wraps instead of scrolling by default. */
export function CopyBlock({
  label,
  value,
  copyLabel,
  copiedMessage = "Copied",
  wrap = true,
}: CopyBlockProps) {
  const { copied, onCopy } = useCopy(value, copiedMessage);
  const [pre, setPre] = useState<HTMLPreElement | null>(null);
  const more = useMoreToTheRight(wrap ? null : pre, value);
  return (
    <figure className="pl-acct-block">
      <figcaption className="pl-acct-block__label">{label}</figcaption>
      <div className="pl-acct-copy">
        <pre
          ref={setPre}
          className={
            wrap
              ? "pl-acct-block__code"
              : `pl-acct-block__code pl-acct-block__code--nowrap${more ? " pl-acct-block__code--more" : ""}`
          }
          // A scrolling region is reachable by keyboard.
          tabIndex={wrap ? undefined : 0}
        >
          <code>{value}</code>
        </pre>
        <Tooltip content={copyLabel}>
          <IconButton
            icon={copied ? CheckIcon : CopyIcon}
            label={copyLabel}
            variant="secondary"
            onClick={onCopy}
          />
        </Tooltip>
      </div>
    </figure>
  );
}

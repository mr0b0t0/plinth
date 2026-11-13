// A read-only, monospace value with a copy button: MCP URL, share link, a new token.
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
  /** Wraps long values (tokens) instead of scrolling them. */
  multiline?: boolean;
  className?: string;
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

  return (
    <Field label={label} hint={hint} hideLabel={hideLabel} className={className}>
      {(p) => (
        <div className="pl-acct-copy">
          {multiline ? (
            <textarea
              {...p}
              readOnly
              rows={2}
              value={value}
              spellCheck={false}
              className="pl-control pl-control--mono pl-acct-copy__value pl-acct-copy__value--wrap"
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

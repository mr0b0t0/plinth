// A Markdown text area with @ suggestions (keyboard navigable) and Ctrl/Cmd+Enter to send.
// The suggestion list follows the ARIA listbox pattern with aria-activedescendant on the textbox.
import { RobotIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, type RefObject, useId, useRef, useState } from "react";
import { Field, ICON_SIZE } from "../ui/index.ts";
import { applyMention, mentionOptions, mentionQuery } from "./model.ts";

const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export interface MentionTextareaProps {
  label: string;
  hideLabel?: boolean;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  maxLength?: number;
}

export function MentionTextarea({
  label,
  hideLabel,
  hint,
  error,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 3,
  disabled,
  textareaRef,
  maxLength,
}: MentionTextareaProps) {
  const listId = useId();
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? ownRef;
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const options = query ? mentionOptions(query.query) : [];
  const open = options.length > 0;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  const track = (el: HTMLTextAreaElement) => {
    const q = mentionQuery(el.value, el.selectionStart ?? el.value.length);
    setQuery((prev) => {
      if (q && prev && q.start === prev.start && q.query === prev.query) return prev;
      if (!q || !prev || q.start !== prev.start) setActive(0);
      return q;
    });
  };

  const choose = (name: string) => {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const next = applyMention(value, caret, query.start, name);
    onChange(next.text);
    setQuery(null);
    // Put the caret after the inserted mention once React has written the value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setQuery(null);
      onSubmit();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((activeIndex + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((activeIndex - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const name = options[activeIndex];
      if (name) {
        e.preventDefault();
        choose(name);
      }
    } else if (e.key === "Escape") {
      // Close the list only; the panel must not close.
      e.preventDefault();
      e.stopPropagation();
      setQuery(null);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <Field label={label} hideLabel={hideLabel} hint={hint} error={error}>
      {(p) => (
        <div className="cm-mention">
          <textarea
            {...p}
            ref={ref}
            className="pl-control pl-control--area cm-mention__input"
            rows={rows}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            maxLength={maxLength}
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? optionId(activeIndex) : undefined}
            onChange={(e) => {
              onChange(e.target.value);
              track(e.target);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => {
              if (CARET_KEYS.has(e.key)) track(e.currentTarget);
            }}
            onClick={(e) => track(e.currentTarget)}
            onBlur={() => setQuery(null)}
          />
          {open && (
            <div
              id={listId}
              role="listbox"
              aria-label="Mention an agent"
              className="cm-mention__list"
            >
              {options.map((name, i) => (
                <div
                  key={name}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeIndex}
                  className="cm-mention__option"
                  // mousedown, not click: keep focus in the text area.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(name);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <RobotIcon size={ICON_SIZE.sm} aria-hidden="true" />
                  <span>@{name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

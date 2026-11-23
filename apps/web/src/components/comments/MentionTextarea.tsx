// A Markdown text area with @ suggestions (keyboard navigable) and Ctrl/Cmd+Enter to send. Picking
// an agent here is how people ask one for a change (docs/spec.md "Asking an agent").
// The suggestion list follows the ARIA listbox pattern with aria-activedescendant on the textbox.
import { RobotIcon } from "@phosphor-icons/react";
import { type ClientType, OTHER_AGENT_MENTION } from "@plinth/shared";
import {
  type KeyboardEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  /** The owner's agents a mention can reach (the gate's `ask.targets`), for the suggestions. */
  agents?: readonly ClientType[];
}

/** The words beside a suggestion no name explains. */
const OPTION_HINT: Record<string, string> = {
  [OTHER_AGENT_MENTION]: "ChatGPT, Cursor, Gemini…",
};

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
  agents,
}: MentionTextareaProps) {
  const listId = useId();
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? ownRef;
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const options = query ? mentionOptions(query.query, agents) : [];
  const open = options.length > 0;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  // Where the caret goes after a mention is inserted; applied as soon as React writes the value,
  // before the next keystroke can land.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const at = pendingCaret.current;
    if (el && at !== null && el.value === value) {
      pendingCaret.current = null;
      el.setSelectionRange(at, at);
    }
  });

  const track = (el: HTMLTextAreaElement) => {
    const q = mentionQuery(el.value, el.selectionStart ?? el.value.length);
    if (q && query && q.start === query.start && q.query === query.query) return;
    if (!q || !query || q.start !== query.start) setActive(0);
    setQuery(q);
  };

  const choose = (name: string) => {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const next = applyMention(value, caret, query.start, name);
    pendingCaret.current = next.caret;
    onChange(next.text);
    setQuery(null);
    el.focus();
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
                  {OPTION_HINT[name] && (
                    <span className="cm-mention__hint">{OPTION_HINT[name]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

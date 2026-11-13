import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { focusElement } from "./focus.ts";
import { ICON_SIZE, type Icon } from "./icons.tsx";
import "./tabs.css";

export interface TabItem {
  id: string;
  label: string;
  icon?: Icon;
  /** Shown after the label, e.g. a count. */
  meta?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  /** Names the tab list for screen readers. */
  label: string;
  tabs: TabItem[];
  /** Controlled selected id. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  className?: string;
}

/**
 * Tabs (WAI-ARIA APG, automatic activation). One tab is in the Tab order; Left/Right move and
 * select, Home/End jump to the ends. Only the selected panel is rendered.
 */
export function Tabs({ label, tabs, value, defaultValue, onChange, className }: TabsProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultValue ?? tabs.find((t) => !t.disabled)?.id ?? "");
  const selected = value ?? inner;
  const refs = useRef(new Map<string, HTMLButtonElement | null>());
  const enabled = tabs.filter((t) => !t.disabled);

  const choose = (tabId: string, focus: boolean) => {
    if (value === undefined) setInner(tabId);
    onChange?.(tabId);
    if (focus) focusElement(refs.current.get(tabId));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const pos = enabled.findIndex((t) => t.id === selected);
    let next: TabItem | undefined;
    if (e.key === "ArrowRight") next = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    choose(next.id, true);
  };

  const current = tabs.find((t) => t.id === selected);
  const tabId = (t: string) => `${id}-tab-${t}`;
  const panelId = (t: string) => `${id}-panel-${t}`;

  return (
    <div className={`pl-tabs${className ? ` ${className}` : ""}`}>
      <div role="tablist" aria-label={label} className="pl-tabs__list" onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const isSel = t.id === selected;
          const TabIcon = t.icon;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current.set(t.id, el);
              }}
              id={tabId(t.id)}
              type="button"
              role="tab"
              className="pl-tabs__tab"
              aria-selected={isSel}
              aria-controls={isSel ? panelId(t.id) : undefined}
              tabIndex={isSel ? 0 : -1}
              disabled={t.disabled}
              onClick={() => choose(t.id, false)}
            >
              {TabIcon && <TabIcon size={ICON_SIZE.sm} aria-hidden="true" />}
              {t.label}
              {t.meta !== undefined && <span className="pl-tabs__meta">{t.meta}</span>}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          id={panelId(current.id)}
          role="tabpanel"
          aria-labelledby={tabId(current.id)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tab panels are focusable so keyboard users reach panels without focusable content
          tabIndex={0}
          className="pl-tabs__panel"
        >
          {current.content}
        </div>
      )}
    </div>
  );
}

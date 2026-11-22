import { CheckIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { navigate } from "../../lib/router.tsx";
import { type ButtonSize, type ButtonVariant, buttonClassName } from "./Button.tsx";
import { focusElement } from "./focus.ts";
import { ICON_SIZE, type Icon } from "./icons.tsx";
import "./menu.css";

export type MenuEntry =
  | {
      type?: "item";
      label: string;
      /** Called after the menu closes and focus is back on the trigger. */
      onSelect?: () => void;
      /** In-app path (navigates with the router) or an external URL. */
      href?: string;
      icon?: Icon;
      /** Destructive action: shown in the danger color. */
      danger?: boolean;
      disabled?: boolean;
      /**
       * One of a set of choices (e.g. the theme): the item becomes a menuitemradio and shows a
       * check when true. Leave undefined for a plain action.
       */
      checked?: boolean;
    }
  | { type: "separator" };

export interface MenuProps {
  /** Trigger text, or its accessible name when `iconOnly`. Also names the menu. */
  label: string;
  items: MenuEntry[];
  icon?: Icon;
  /** Trailing trigger icon (e.g. a caret). */
  iconEnd?: Icon;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Which edge of the trigger the menu lines up with. */
  align?: "start" | "end";
  /** Open below the trigger (default) or above it (triggers at the bottom of the screen). */
  placement?: "down" | "up";
  /** Extra class on the trigger button. */
  triggerClassName?: string;
  /** Replaces the trigger's visible content (the accessible name stays `label`). */
  triggerContent?: ReactNode;
  /** Non-interactive content at the top of the menu (e.g. the signed-in email). */
  header?: ReactNode;
  className?: string;
}

type Item = Extract<MenuEntry, { label: string }>;
const isItem = (e: MenuEntry): e is Item => e.type !== "separator";

/**
 * Menu button (WAI-ARIA APG pattern). Arrow keys move, Home/End jump, typing a letter jumps to
 * the next item starting with it, Escape closes and returns focus to the trigger.
 */
export function Menu({
  label,
  items,
  icon: IconStart,
  iconEnd: IconEnd,
  iconOnly = false,
  variant = "secondary",
  size = "md",
  align = "start",
  placement = "down",
  triggerClassName,
  triggerContent,
  header,
  className,
}: MenuProps) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const menuId = `${id}-menu`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const typeahead = useRef({ text: "", at: 0 });

  const enabled = items.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);

  const openAt = (which: "first" | "last") => {
    setOpen(true);
    setActive((which === "first" ? enabled[0] : enabled[enabled.length - 1]) ?? -1);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) focusElement(triggerRef.current);
  };

  // Focus follows the active item.
  useEffect(() => {
    if (open && active >= 0) focusElement(itemRefs.current[active]);
  }, [open, active]);

  // An aligned list that would run past the screen's edge (a card's menu in a phone's left
  // column) slides back inside it, keeping a small margin.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    list.style.translate = "";
    const margin = 8;
    const { left, right, width } = list.getBoundingClientRect();
    if (!width) return;
    const viewport = document.documentElement.clientWidth;
    const shift =
      left < margin ? margin - left : right > viewport - margin ? viewport - margin - right : 0;
    if (shift) list.style.translate = `${shift}px 0`;
  }, [open]);

  // Click outside closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  });

  const move = (delta: 1 | -1) => {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(active);
    const next = pos < 0 ? 0 : (pos + delta + enabled.length) % enabled.length;
    setActive(enabled[next] ?? -1);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt("last");
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(enabled[0] ?? -1);
        return;
      case "End":
        e.preventDefault();
        setActive(enabled[enabled.length - 1] ?? -1);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      const now = Date.now();
      const t = typeahead.current;
      const key = e.key.toLowerCase();
      const pos = enabled.indexOf(active);
      const startsWith = (i: number, text: string) => {
        const it = items[i];
        return Boolean(it && isItem(it) && it.label.toLowerCase().startsWith(text));
      };
      // Typing quickly builds a prefix matched from the current item; a single letter (or a
      // prefix that matches nothing) cycles through items starting with that letter.
      const fromCurrent = [...enabled.slice(pos), ...enabled.slice(0, pos)];
      const fromNext = [...enabled.slice(pos + 1), ...enabled.slice(0, pos + 1)];
      let hit: number | undefined;
      if (now - t.at <= 600 && t.text) {
        t.text += key;
        hit = fromCurrent.find((i) => startsWith(i, t.text));
      }
      if (hit === undefined) {
        t.text = key;
        hit = fromNext.find((i) => startsWith(i, key));
      }
      t.at = now;
      if (hit !== undefined) setActive(hit);
    }
  };

  const select = (item: Item, e: MouseEvent) => {
    if (item.disabled) {
      e.preventDefault();
      return;
    }
    if (item.href?.startsWith("/") && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      close(false);
      navigate(item.href);
      return;
    }
    close(!item.href);
    item.onSelect?.();
  };

  const iconPx = size === "lg" ? ICON_SIZE.md : ICON_SIZE.sm;
  // When some items have icons, the others get an empty 16px slot so every label lines up.
  const hasIcons = items.some((e) => isItem(e) && e.icon);

  return (
    <div
      ref={wrapRef}
      className={`pl-menu${placement === "up" ? " pl-menu--up" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`${buttonClassName({ variant, size, iconOnly })}${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={iconOnly || triggerContent ? label : undefined}
        onClick={() => (open ? close(false) : openAt("first"))}
        onKeyDown={onTriggerKey}
      >
        <span className="pl-button__content">
          {IconStart && <IconStart size={iconPx} aria-hidden="true" />}
          {triggerContent ?? (iconOnly ? null : label)}
          {IconEnd && <IconEnd size={iconPx} aria-hidden="true" />}
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className={`pl-menu__list pl-menu__list--${align}`}
          onKeyDown={onMenuKey}
        >
          {header && (
            <div className="pl-menu__header" role="none">
              {header}
            </div>
          )}
          {items.map((entry, i) => {
            if (!isItem(entry)) {
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
              return <hr key={`sep-${i}`} className="pl-menu__separator" />;
            }
            const ItemIcon = entry.icon;
            const common = {
              ref: (el: HTMLElement | null) => {
                itemRefs.current[i] = el;
              },
              role: entry.checked === undefined ? "menuitem" : "menuitemradio",
              "aria-checked": entry.checked,
              tabIndex: -1,
              "aria-disabled": entry.disabled || undefined,
              className: `pl-menu__item${entry.danger ? " pl-menu__item--danger" : ""}`,
              onClick: (e: MouseEvent) => select(entry, e),
              onPointerMove: () => !entry.disabled && active !== i && setActive(i),
            } as const;
            const body = (
              <>
                {ItemIcon ? (
                  <ItemIcon size={ICON_SIZE.sm} aria-hidden="true" />
                ) : (
                  hasIcons && <span className="pl-menu__icon-slot" aria-hidden="true" />
                )}
                <span className="pl-menu__label">{entry.label}</span>
                {entry.checked && (
                  <CheckIcon size={ICON_SIZE.sm} aria-hidden="true" className="pl-menu__check" />
                )}
              </>
            );
            return entry.href ? (
              <a key={entry.label} href={entry.href} {...common}>
                {body}
              </a>
            ) : (
              <button key={entry.label} type="button" {...common}>
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

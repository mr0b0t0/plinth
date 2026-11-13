// Version picker for the artifact top bar: a menu button showing the version on screen ("v3").
// Opening it loads the version list; choosing one goes to its permanent link (the current version
// goes to the bare artifact URL). Footer links lead to the full history and the compare page.
//
// Keyboard (WAI-ARIA APG menu button): Enter/Space/ArrowDown open on the shown version, ArrowUp
// opens on the last item, arrows move, Home/End jump, typing a number jumps to that version,
// Escape closes and returns focus to the trigger, Tab closes.
import {
  ArrowsLeftRightIcon,
  CaretDownIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import type { Paged, VersionInfo } from "@plinth/shared";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { versionsApiPath } from "../history/data.ts";
import {
  comparePath,
  excerpt,
  fullTimestamp,
  historyPath,
  relativeTime,
  versionPath,
} from "../history/format.ts";
import "../history/picker.css";
import { focusElement } from "../ui/focus.ts";
import { type ButtonSize, buttonClassName, ICON_SIZE, Spinner } from "../ui/index.ts";

export interface VersionPickerProps {
  slug: string;
  current: number;
  /** The version being shown. */
  shown: number;
  /** Trigger size (default "sm", for the top bar). */
  size?: ButtonSize;
  /** Which edge of the trigger the menu lines up with (default "start"). */
  align?: "start" | "end";
}

interface Entry {
  key: string;
  href: string;
  /** Label used for typeahead ("3" for v3). */
  number?: number;
  footer?: { label: string; icon: typeof CheckIcon };
  version?: VersionInfo;
}

export function VersionPicker({
  slug,
  current,
  shown,
  size = "sm",
  align = "start",
}: VersionPickerProps) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const menuId = `${id}-menu`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  /** Which item to focus once the list arrives: the shown version, or the last item. */
  const pendingFocus = useRef<"shown" | "last">("shown");

  const entries: Entry[] = [
    ...(versions ?? []).map((v) => ({
      key: `v${v.number}`,
      href: versionPath(slug, v.number, current),
      number: v.number,
      version: v,
    })),
    {
      key: "history",
      href: historyPath(slug),
      footer: { label: "All versions", icon: ClockCounterClockwiseIcon },
    },
  ];
  if (current > 1) {
    const to = shown > 1 ? shown : 2;
    entries.push({
      key: "compare",
      href: comparePath(slug, to - 1, to),
      footer: { label: "Compare", icon: ArrowsLeftRightIcon },
    });
  }
  const versionCount = versions?.length ?? 0;

  const load = useCallback(() => {
    setFailed(false);
    api<Paged<VersionInfo>>(versionsApiPath(slug)).then(
      (r) => setVersions(r.items),
      () => setFailed(true),
    );
  }, [slug]);

  const openMenu = (which: "shown" | "last") => {
    pendingFocus.current = which;
    setOpen(true);
    load();
    if (versions) setActive(indexFor(which));
    else setActive(-1);
  };

  const indexFor = (which: "shown" | "last", list = versions) => {
    if (which === "last") return (list?.length ?? 0) + (current > 1 ? 1 : 0);
    const i = list?.findIndex((v) => v.number === shown) ?? -1;
    return Math.max(i, 0);
  };

  // When the list first arrives while open, move focus onto the right item.
  const hadVersions = useRef(false);
  useEffect(() => {
    if (open && versions && !hadVersions.current) setActive(indexFor(pendingFocus.current));
    hadVersions.current = Boolean(versions);
  });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) focusElement(triggerRef.current);
  };

  // Focus follows the active item; keep it in view inside the scrolling list.
  useEffect(() => {
    if (!open) return;
    const el = active >= 0 ? itemRefs.current[active] : null;
    if (el) {
      focusElement(el);
      el.scrollIntoView?.({ block: "nearest" });
    } else focusElement(listRef.current);
  }, [open, active]);

  // A click outside closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  });

  const count = entries.length;
  const move = (delta: 1 | -1) =>
    setActive((a) => (a < 0 ? (delta === 1 ? 0 : count - 1) : (a + delta + count) % count));

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openMenu("shown");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
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
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(count - 1);
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
    // Typing digits jumps to that version ("1", "12"); "a" and "c" jump to the footer links.
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    const now = Date.now();
    const t = typed.current;
    const key = e.key.toLowerCase();
    if (/\d/.test(key)) {
      t.text = now - t.at <= 700 && /^\d+$/.test(t.text) ? t.text + key : key;
      t.at = now;
      const exact = entries.findIndex((x) => x.number === Number(t.text));
      const prefix = entries.findIndex((x) => x.number && String(x.number).startsWith(t.text));
      const hit = exact >= 0 ? exact : prefix;
      if (hit >= 0) setActive(hit);
      return;
    }
    const footer = entries.findIndex((x) => x.footer?.label.toLowerCase().startsWith(key));
    if (footer >= 0) setActive(footer);
  };

  const choose = (entry: Entry, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    close(false);
    navigate(entry.href);
  };

  const triggerName =
    shown === current
      ? `v${shown}, the current version. Choose a version`
      : `v${shown} of ${current}, an older version. Choose a version`;

  return (
    <div ref={wrapRef} className="pl-menu hx-picker">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`${buttonClassName({ variant: "ghost", size })} hx-picker__trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerName}
        onClick={() => (open ? close(false) : openMenu("shown"))}
        onKeyDown={onTriggerKey}
      >
        <span className="pl-button__content">
          <span className="type-mono hx-picker__shown">v{shown}</span>
          {shown !== current && <span className="hx-picker__of">of {current}</span>}
          <CaretDownIcon size={ICON_SIZE.sm} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          aria-busy={!versions || undefined}
          tabIndex={-1}
          className={`pl-menu__list pl-menu__list--${align} hx-picker__list`}
          onKeyDown={onMenuKey}
        >
          <div className="pl-menu__header hx-picker__header" role="none">
            Versions
          </div>
          {!versions && (
            <div className="hx-picker__status" role="none">
              {failed ? (
                "Could not load the versions."
              ) : (
                <>
                  <Spinner size={ICON_SIZE.sm} /> Loading versions…
                </>
              )}
            </div>
          )}
          <div className="hx-picker__scroll" role="none">
            {entries.slice(0, versionCount).map((entry, i) => {
              const v = entry.version as VersionInfo;
              const isShown = v.number === shown;
              const note = excerpt(v.note, 56);
              return (
                <a
                  key={entry.key}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  href={entry.href}
                  role="menuitemradio"
                  aria-checked={isShown}
                  tabIndex={-1}
                  className="pl-menu__item hx-picker__item"
                  onClick={(e) => choose(entry, e)}
                  onPointerMove={() => active !== i && setActive(i)}
                >
                  <span className="hx-picker__check" aria-hidden="true">
                    {isShown && <CheckIcon size={ICON_SIZE.sm} />}
                  </span>
                  <span className="hx-picker__body">
                    <span className="hx-picker__line">
                      <span className="type-mono hx-picker__n">v{v.number}</span>
                      {v.number === current && <span className="hx-picker__current">current</span>}
                      <span className="hx-picker__date" title={fullTimestamp(v.created_at)}>
                        <span className="visually-hidden">, </span>
                        {relativeTime(v.created_at)}
                      </span>
                    </span>
                    <span className="hx-picker__author">
                      <span className="visually-hidden">, by </span>
                      {v.author.label}
                      {v.author.kind === "connection" && (
                        <span className="hx-picker__agent"> (agent)</span>
                      )}
                    </span>
                    {note && (
                      <span className="hx-picker__note">
                        <span className="visually-hidden">, </span>
                        {note}
                      </span>
                    )}
                  </span>
                </a>
              );
            })}
          </div>
          <hr className="pl-menu__separator" />
          {entries.slice(versionCount).map((entry, k) => {
            const i = versionCount + k;
            const footer = entry.footer as NonNullable<Entry["footer"]>;
            const FooterIcon = footer.icon;
            return (
              <a
                key={entry.key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                href={entry.href}
                role="menuitem"
                tabIndex={-1}
                className="pl-menu__item"
                onClick={(e) => choose(entry, e)}
                onPointerMove={() => active !== i && setActive(i)}
              >
                <FooterIcon size={ICON_SIZE.sm} aria-hidden="true" />
                <span>{footer.label}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

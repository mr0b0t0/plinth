// How a computed value shows in a cell: numbers through Intl.NumberFormat with the column's format
// (an unknown currency falls back to plain), dates as YYYY-MM-DD (locale-independent, like the
// export), checkboxes as a glyph with a spoken label, links only when they pass the link rule again
// here, and errors as their code with what it means. Pure: no DOM.
import {
  isError,
  isSheetLinkUrl,
  numberText,
  round15,
  SHEET_ERROR_MEANINGS,
  type SheetColumn,
  type SheetNumberFormat,
  serialIso,
  type Value,
} from "@plinth/shared";

export type Display =
  | { kind: "empty"; text: "" }
  | { kind: "number"; text: string }
  | { kind: "text"; text: string }
  | { kind: "check"; text: string; label: "Yes" | "No" }
  | { kind: "link"; text: string; href: string }
  | { kind: "error"; text: string; title: string };

const formatters = new WeakMap<SheetNumberFormat, Intl.NumberFormat>();

function numberFormatter(f: SheetNumberFormat): Intl.NumberFormat {
  let nf = formatters.get(f);
  if (nf) return nf;
  const digits =
    f.decimals !== undefined
      ? { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals }
      : f.style === "plain"
        ? { maximumFractionDigits: 10 }
        : {};
  const grouping = { useGrouping: f.grouping ?? true };
  try {
    nf =
      f.style === "currency"
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: f.currency ?? "XXX",
            ...digits,
            ...grouping,
          })
        : new Intl.NumberFormat(undefined, {
            style: f.style === "percent" ? "percent" : "decimal",
            ...digits,
            ...grouping,
          });
  } catch {
    nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 10, ...grouping });
  }
  formatters.set(f, nf);
  return nf;
}

/** A number as its column shows it. */
export function formatNumber(n: number, col: SheetColumn): string {
  const r = round15(n);
  if (col.type === "date") return serialIso(r) ?? numberText(r);
  if (col.type === "number" && col.format) return numberFormatter(col.format).format(r);
  return numberText(r);
}

/** What a cell shows for its computed value. */
export function displayValue(v: Value, col: SheetColumn): Display {
  if (v === null || v === "") return { kind: "empty", text: "" };
  if (isError(v)) return { kind: "error", text: v.error, title: SHEET_ERROR_MEANINGS[v.error] };
  if (typeof v === "number") return { kind: "number", text: formatNumber(v, col) };
  if (typeof v === "boolean") {
    if (col.type === "checkbox") {
      return { kind: "check", text: v ? "☑" : "☐", label: v ? "Yes" : "No" };
    }
    return { kind: "text", text: v ? "TRUE" : "FALSE" };
  }
  if (col.type === "url" && isSheetLinkUrl(v)) return { kind: "link", text: v, href: v };
  return { kind: "text", text: v };
}

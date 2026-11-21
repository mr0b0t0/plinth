// How a sheet's cells look, apart from their values: which highlight rule colours a computed value,
// a style change merged into a cell's style (edit_sheet's `format` op and the page's Format menu),
// and the light values of the colour names, for the .xlsx export and import. The renderer maps the
// same names to classes in sheet.css, with a dark value for each; nothing here is CSS.
import {
  canonicalStyle,
  type SheetAlign,
  type SheetBorderSide,
  type SheetCellStyle,
  type SheetColor,
  type SheetColumn,
  type SheetColumnType,
  type SheetHighlightRule,
} from "./format.ts";
import { isError, isoDateSerial, numberText, type Value } from "./formula/values.ts";

/**
 * Each colour's light values as RRGGBB: the fill behind a cell and the text on it (a highlight or
 * an option's chip). sheet.css holds the same light values and a dark pair for each.
 */
export const SHEET_COLOR_HEX: Readonly<Record<SheetColor, { fill: string; text: string }>> = {
  gray: { fill: "EEF0F2", text: "3B434B" },
  red: { fill: "FDE2E1", text: "9F1C1C" },
  orange: { fill: "FDE7D3", text: "9A3A0B" },
  yellow: { fill: "FBF1C7", text: "7A5A00" },
  green: { fill: "DDF3E4", text: "1E6B3A" },
  teal: { fill: "D5F2EF", text: "116057" },
  blue: { fill: "DCEBFD", text: "1E4F9A" },
  purple: { fill: "EBE3FB", text: "5B2FA0" },
  pink: { fill: "FBE1EF", text: "9A1F5C" },
};

/** A colour's name as people read it ("Gray", "Red", ...). */
export function sheetColorLabel(c: SheetColor): string {
  return `${c[0]?.toUpperCase() ?? ""}${c.slice(1)}`;
}

function valueText(v: Value): string {
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return typeof v === "string" ? v : "";
}

/** A rule's value as the cells of its column compute it: a date as its serial. */
function ruleTarget(x: unknown, type: SheetColumnType): number | string | boolean | null {
  if (type === "date" && typeof x === "string") return isoDateSerial(x);
  if (typeof x === "number" || typeof x === "string" || typeof x === "boolean") return x;
  return null;
}

/**
 * Whether a computed value matches a rule. An empty cell matches only `empty`, and an error only
 * `not_empty`. A comparison matches only a value of the same kind (a number with a number, text
 * with text, without case, true or false with one of them); `between` takes numbers (dates in a
 * date column) and includes both ends; `contains` reads the value as text, without case.
 */
export function highlightMatches(
  rule: SheetHighlightRule,
  v: Value,
  type: SheetColumnType,
): boolean {
  const empty = v === null || v === "";
  if (rule.when === "empty") return empty;
  if (rule.when === "not_empty") return !empty;
  if (empty || isError(v)) return false;
  if (rule.when === "contains") {
    return valueText(v)
      .toLowerCase()
      .includes(String(rule.value ?? "").toLowerCase());
  }
  if (rule.when === "between") {
    const lo = ruleTarget(rule.value, type);
    const hi = ruleTarget(rule.to, type);
    return typeof v === "number" && typeof lo === "number" && typeof hi === "number"
      ? v >= lo && v <= hi
      : false;
  }
  const t = ruleTarget(rule.value, type);
  if (t === null || typeof t !== typeof v) return false;
  let c: number;
  if (typeof v === "string") {
    const a = v.toLowerCase();
    const b = (t as string).toLowerCase();
    c = a < b ? -1 : a > b ? 1 : 0;
  } else if (typeof v === "boolean") {
    c = v === t ? 0 : v ? 1 : -1;
  } else {
    c = v < (t as number) ? -1 : v > (t as number) ? 1 : 0;
  }
  switch (rule.when) {
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "=":
      return c === 0;
    default:
      return c !== 0;
  }
}

/** The colour a column's highlight rules give a computed value (the first match), or null. */
export function highlightColor(col: SheetColumn, v: Value): SheetColor | null {
  for (const r of col.highlight ?? []) if (highlightMatches(r, v, col.type)) return r.color;
  return null;
}

/**
 * A change to cells' styles: a key set to a value sets it, a key set to null (or false, for bold,
 * italic and wrap) clears it, and a key left out keeps what the cell has.
 */
export interface SheetStyleChange {
  bold?: boolean | null;
  italic?: boolean | null;
  fill?: SheetColor | null;
  align?: SheetAlign | null;
  wrap?: boolean | null;
  border?: SheetBorderSide[] | null;
}

/** A cell's style after a change (null: no style left). `change` null clears every key. */
export function mergeCellStyle(
  base: SheetCellStyle | null | undefined,
  change: SheetStyleChange | null,
): SheetCellStyle | null {
  if (change === null) return null;
  const out: SheetCellStyle = { ...(base ?? {}) };
  for (const k of ["bold", "italic", "wrap"] as const) {
    const v = change[k];
    if (v === undefined) continue;
    if (v === true) out[k] = true;
    else delete out[k];
  }
  if (change.fill !== undefined) {
    if (change.fill === null) delete out.fill;
    else out.fill = change.fill;
  }
  if (change.align !== undefined) {
    if (change.align === null) delete out.align;
    else out.align = change.align;
  }
  if (change.border !== undefined) {
    if (change.border === null || change.border.length === 0) delete out.border;
    else out.border = [...change.border];
  }
  const canon = canonicalStyle(out);
  return Object.keys(canon).length > 0 ? canon : null;
}

function channels(hex: string): [number, number, number] | null {
  const m = /^(?:[0-9A-Fa-f]{2})?([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)];
}

/**
 * The sheet colour nearest to an RGB or ARGB hex fill (an .xlsx import), or null for white, near
 * white or a value that is not hex. Gray takes the colours with little hue; every other colour is
 * matched by hue, so a strong fill and a pale one of the same hue read as the same colour.
 */
export function nearestSheetColor(hex: string): SheetColor | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const chroma = max - min;
  if (light > 0.96 && chroma < 0.06) return null;
  if (chroma < 0.08) return "gray";
  let h: number;
  if (max === r) h = ((g - b) / chroma) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  const hue = (h * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 40) return "orange";
  if (hue < 68) return "yellow";
  if (hue < 160) return "green";
  if (hue < 195) return "teal";
  if (hue < 250) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

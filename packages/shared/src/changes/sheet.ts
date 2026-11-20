// What changed in a sheet (sheet.jsonl): columns added, removed, renamed, or with another type,
// number format, option list or width; frozen columns; rows added or removed (counted, with their
// first cell as a label); and cells changed ("B7 changed: 12 → 14"). A formula cell says that its
// calculation changed, with both results when both sheets evaluate within the step budget. A total
// that only recomputed is left out: its formula is the same, or, when rows or columns were added
// or removed, it differs only in which cells it refers to.
import { a1, colLetter } from "../sheet/address.ts";
import {
  type Cell,
  isFormula,
  literalText,
  parseSheet,
  type Sheet,
  type SheetColumn,
} from "../sheet/format.ts";
import { evaluateSheet } from "../sheet/formula/evaluate.ts";
import { lexFormula } from "../sheet/formula/lexer.ts";
import { isError, numberText, type Value } from "../sheet/formula/values.ts";
import { diffSequence } from "./diff.ts";
import { pairInOrder } from "./pairs.ts";
import { changeExcerpt, count, quoted } from "./text.ts";
import { CHANGE_LIMITS, type ChangeCollector } from "./types.ts";

const TYPE_NAME: Record<SheetColumn["type"], string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  select: "Choice",
  url: "Link",
};

function formatText(c: SheetColumn): string {
  const f = c.format;
  if (!f) return "Automatic";
  const parts = [
    f.style === "plain"
      ? "Plain"
      : f.style === "percent"
        ? "Percent"
        : `Currency ${f.currency ?? ""}`.trim(),
  ];
  if (f.decimals !== undefined) parts.push(count(f.decimals, "decimal"));
  if (f.grouping === false) parts.push("no thousands separators");
  return parts.join(", ");
}

function cellText(cell: Cell | undefined, column: SheetColumn | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "boolean") {
    if (column?.type === "checkbox") return cell ? "checked" : "unchecked";
    return cell ? "TRUE" : "FALSE";
  }
  if (typeof cell === "number") return numberText(cell);
  return literalText(cell);
}

function valueText(v: Value): string {
  if (v === null) return "";
  if (isError(v)) return v.error;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return numberText(v);
  return v;
}

/** A formula with every cell and range reference replaced by one mark, or null if it does not lex. */
function formulaShape(cell: string): string | null {
  const src = cell.slice(1);
  try {
    let out = "";
    let last = 0;
    for (const t of lexFormula(src)) {
      if (t.t !== "ref" && t.t !== "range") continue;
      out += `${src.slice(last, t.start)}\u0000`;
      last = t.end;
    }
    return out + src.slice(last);
  } catch {
    return null;
  }
}

/**
 * Whether two formulas are one calculation whose references moved: the same apart from the cells
 * they refer to. Only asked when rows or columns were added or removed, which is what moves them.
 */
function sameCalculation(a: Cell, b: Cell): boolean {
  if (!isFormula(a) || !isFormula(b)) return false;
  const sa = formulaShape(a);
  return sa !== null && sa === formulaShape(b);
}

function sameColumn(a: SheetColumn, b: SheetColumn): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The first non-empty cell of a row, as a label. */
function rowLabel(row: readonly Cell[] | undefined, columns: readonly SheetColumn[]): string {
  for (const [k, c] of (row ?? []).entries()) {
    const t = isFormula(c) ? "" : cellText(c, columns[k]);
    if (t.trim() !== "") return quoted(t);
  }
  return "";
}

function rowsSpan(first: number, n: number): string {
  return n === 1 ? `Row ${first}` : `Rows ${first} to ${first + n - 1}`;
}

/** A calculation's item, whose results are read once both sheets are evaluated. */
interface Pending {
  /** Index of the item in the list. */
  at: number;
  /** The formula cell (A1 row, column) on each side, or null where the cell holds a value. */
  before: [number, number] | null;
  after: [number, number] | null;
  va: Cell;
  vb: Cell;
}

function describeColumns(out: ChangeCollector, a: Sheet, b: Sheet): { pairs: [number, number][] } {
  const ac = a.header.columns;
  const bc = b.header.columns;
  const { hunks } = diffSequence(
    ac.map((c) => c.name),
    bc.map((c) => c.name),
  );
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  const take = (toA: number) => {
    while (i < toA) pairs.push([i++, j++]);
  };
  for (const h of hunks) {
    take(h.aStart);
    const p = pairInOrder(
      ac.slice(h.aStart, h.aEnd).map((_, k) => h.aStart + k),
      bc.slice(h.bStart, h.bEnd).map((_, k) => h.bStart + k),
      // Only a column of the same type at the same place reads as renamed.
      (x, y) => ac[x]?.type === bc[y]?.type && h.aEnd - h.aStart === h.bEnd - h.bStart,
    );
    for (const x of p.removed) {
      out.add({
        kind: "removed",
        where: "",
        what: `Column ${quoted(ac[x]?.name ?? "")} removed`,
      });
    }
    for (const [x, y] of p.pairs) {
      pairs.push([x, y]);
      // A region the diff gave up on pairs unchanged columns too: they were not renamed.
      if (ac[x]?.name === bc[y]?.name) continue;
      out.add({
        kind: "changed",
        where: `Column ${colLetter(y)}`,
        what: `Column ${quoted(ac[x]?.name ?? "")} renamed`,
        before: ac[x]?.name,
        after: bc[y]?.name,
      });
    }
    for (const y of p.added) {
      out.add({
        kind: "added",
        where: `Column ${colLetter(y)}`,
        what: `Column ${quoted(bc[y]?.name ?? "")} added`,
      });
    }
    i = h.aEnd;
    j = h.bEnd;
  }
  take(ac.length);
  for (const [x, y] of pairs) {
    const ca = ac[x] as SheetColumn;
    const cb = bc[y] as SheetColumn;
    if (sameColumn({ ...ca, name: "" }, { ...cb, name: "" })) continue;
    const where = `Column ${colLetter(y)}`;
    const name = quoted(cb.name);
    if (ca.type !== cb.type) {
      out.add({
        kind: "changed",
        where,
        what: `${name}: type changed`,
        before: TYPE_NAME[ca.type],
        after: TYPE_NAME[cb.type],
      });
    }
    if (cb.type === "number" && formatText(ca) !== formatText(cb)) {
      out.add({
        kind: "changed",
        where,
        what: `${name}: number format changed`,
        before: formatText(ca),
        after: formatText(cb),
      });
    }
    if (JSON.stringify(ca.options ?? []) !== JSON.stringify(cb.options ?? [])) {
      out.add({
        kind: "changed",
        where,
        what: `${name}: choices changed`,
        before: changeExcerpt((ca.options ?? []).join(", ")),
        after: changeExcerpt((cb.options ?? []).join(", ")),
      });
    }
    if (ca.width !== cb.width) {
      out.add({
        kind: "changed",
        where,
        what: `${name}: width changed`,
        before: ca.width === undefined ? "Automatic" : `${ca.width} px`,
        after: cb.width === undefined ? "Automatic" : `${cb.width} px`,
      });
    }
  }
  const fa = a.header.freeze?.cols ?? 0;
  const fb = b.header.freeze?.cols ?? 0;
  if (fa !== fb) {
    const frozen = (n: number) => (n === 0 ? "None" : count(n, "column"));
    out.add({
      kind: "changed",
      where: "",
      what: "Frozen columns changed",
      before: frozen(fa),
      after: frozen(fb),
    });
  }
  return { pairs };
}

/** Adds the changes from `before` to `after`, two sheets, to `out`. False when one does not parse. */
export function describeSheet(out: ChangeCollector, before: string, after: string): boolean {
  const pa = parseSheet(before);
  const pb = parseSheet(after);
  if (!pa.ok || !pb.ok) return false;
  const a = pa.sheet;
  const b = pb.sheet;
  const { pairs } = describeColumns(out, a, b);
  const ac = a.header.columns;
  const bc = b.header.columns;

  // Rows compared on the columns both sides have, so an added column does not change every row.
  const key = (row: readonly Cell[], side: 0 | 1) =>
    JSON.stringify(pairs.map((p) => row[p[side]] ?? null));
  const { hunks, exact } = diffSequence(
    a.rows.map((r) => key(r, 0)),
    b.rows.map((r) => key(r, 1)),
  );
  if (!exact) out.truncated = true;
  // Rows or columns added or removed: a formula that only follows them is not a change of its own.
  const moved =
    pairs.length !== ac.length ||
    pairs.length !== bc.length ||
    hunks.some((h) => h.aEnd - h.aStart !== h.bEnd - h.bStart);

  const pending: Pending[] = [];
  for (const h of hunks) {
    if (out.full) {
      out.truncated = true;
      break;
    }
    // A row whose first shared cell is the same is the same row: a row added above "Total"
    // reads as one added row, not as "Total" overwritten.
    const labelColumn = pairs[0];
    const p = pairInOrder(
      a.rows.slice(h.aStart, h.aEnd).map((_, k) => h.aStart + k),
      b.rows.slice(h.bStart, h.bEnd).map((_, k) => h.bStart + k),
      undefined,
      labelColumn
        ? (x, y) =>
            ((a.rows[x] as Cell[])[labelColumn[0]] ?? null) ===
            ((b.rows[y] as Cell[])[labelColumn[1]] ?? null)
        : undefined,
    );
    if (p.removed.length > 0) {
      const first = (p.removed[0] as number) + 2;
      const label = rowLabel(a.rows[p.removed[0] as number], ac);
      out.add({
        kind: "removed",
        where: "",
        what: `${rowsSpan(first, p.removed.length)} removed${p.removed.length > 1 ? ` (${count(p.removed.length, "row")})` : ""}`,
        before: label === "" ? undefined : label,
      });
    }
    for (const [x, y] of p.pairs) {
      const ra = a.rows[x] as Cell[];
      const rb = b.rows[y] as Cell[];
      for (const [ca, cb] of pairs) {
        const va = ra[ca] ?? null;
        const vb = rb[cb] ?? null;
        if (va === vb) continue;
        const address = a1(y + 2, cb);
        const where = `Row ${y + 2}, ${quoted(bc[cb]?.name ?? "")}`;
        if (isFormula(va) || isFormula(vb)) {
          if (moved && sameCalculation(va, vb)) continue;
          // Its results are filled in below, once per sheet.
          if (out.add({ kind: "changed", where, what: `${address} calculation changed` })) {
            pending.push({
              at: out.items.length - 1,
              before: isFormula(va) ? [x + 2, ca] : null,
              after: isFormula(vb) ? [y + 2, cb] : null,
              va,
              vb,
            });
          }
          if (out.full) break;
          continue;
        }
        const ta = cellText(va, ac[ca]);
        const tb = cellText(vb, bc[cb]);
        out.add({
          kind: ta === "" ? "added" : tb === "" ? "removed" : "changed",
          where,
          what:
            ta === ""
              ? `${address} filled in`
              : tb === ""
                ? `${address} cleared`
                : `${address} changed`,
          before: changeExcerpt(ta),
          after: changeExcerpt(tb),
        });
        if (out.full) break;
      }
      if (out.full) break;
    }
    if (p.added.length > 0) {
      const first = (p.added[0] as number) + 2;
      const label = rowLabel(b.rows[p.added[0] as number], bc);
      out.add({
        kind: "added",
        where: "",
        what: `${rowsSpan(first, p.added.length)} added${p.added.length > 1 ? ` (${count(p.added.length, "row")})` : ""}`,
        after: label === "" ? undefined : label,
      });
    }
  }
  fillResults(out, pending, a, b);
  return true;
}

function fillResults(out: ChangeCollector, pending: readonly Pending[], a: Sheet, b: Sheet): void {
  if (pending.length === 0) return;
  const results = (sheet: Sheet, cells: [number, number][]) => {
    if (cells.length === 0) return null;
    try {
      const ev = evaluateSheet(sheet, { budget: CHANGE_LIMITS.sheetEvalSteps, cells });
      return ev.exhausted ? null : ev;
    } catch {
      return null;
    }
  };
  const ea = results(
    a,
    pending.flatMap((p) => (p.before ? [p.before] : [])),
  );
  const eb = results(
    b,
    pending.flatMap((p) => (p.after ? [p.after] : [])),
  );
  for (const p of pending) {
    const item = out.items[p.at];
    if (!item) continue;
    const before = p.before
      ? ea
        ? valueText(ea.value(p.before[0], p.before[1]))
        : null
      : cellText(p.va, undefined);
    const after = p.after
      ? eb
        ? valueText(eb.value(p.after[0], p.after[1]))
        : null
      : cellText(p.vb, undefined);
    // Both results, or neither: one alone would read as the whole story.
    if (before === null || after === null) continue;
    if (before !== "") item.before = changeExcerpt(before);
    if (after !== "") item.after = changeExcerpt(after);
  }
}

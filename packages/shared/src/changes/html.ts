// What changed in an HTML page or a design's boards, read with the string scanner (htmlScan.ts):
// the title, the visible text (located by the nearest heading), links, images and forms added or
// removed (counted), and whether styles or scripts changed. A page whose markup changed in a way
// none of these name gets one item, CHANGES_LAYOUT. Markup and code are never quoted.
import { type DesignBoard, type DesignSource, parseDesign } from "../design.ts";
import { diffSequence } from "./diff.ts";
import { type HtmlScan, type HtmlTextRun, markupSignature, scanHtml } from "./htmlScan.ts";
import { inReadingOrder, multisetChanges, pairInOrder, sharesWord } from "./pairs.ts";
import { changeExcerpt, count, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector } from "./types.ts";

/** A board's size as the list says it: "1080 × 1080". */
function sizeLabel(b: Pick<DesignBoard, "width" | "height">): string {
  return `${b.width} × ${b.height}`;
}

function join(prefix: string, rest: string): string {
  if (prefix === "") return rest;
  return rest === "" ? prefix : `${prefix}, ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}

/** Text runs added, removed and changed, each located by its heading. */
function describeRuns(
  out: ChangeCollector,
  a: readonly HtmlTextRun[],
  b: readonly HtmlTextRun[],
  prefix: string,
): void {
  const key = (r: HtmlTextRun) => `${r.heading ? "#" : ""}${r.text}`;
  const { hunks, exact } = diffSequence(a.map(key), b.map(key));
  if (!exact) out.truncated = true;
  const where = (r: HtmlTextRun) =>
    join(prefix, r.under === "" ? "" : `${r.after ? "After" : "Under"} ${quoted(r.under)}`);
  for (const h of hunks) {
    if (out.full) {
      out.truncated = true;
      return;
    }
    const removedRuns = a.slice(h.aStart, h.aEnd);
    const addedRuns = b.slice(h.bStart, h.bEnd);
    const index = new Map<HtmlTextRun, number>();
    for (const [k, r] of removedRuns.entries()) index.set(r, h.aStart + k);
    for (const [k, r] of addedRuns.entries()) index.set(r, h.bStart + k);
    const at = (r: HtmlTextRun) => index.get(r) as number;
    const paired = pairInOrder(
      removedRuns,
      addedRuns,
      (x, y) => x.heading === y.heading,
      // As in a doc: a heading renamed keeps a word, so one added before it is not taken for it.
      (x, y) => !x.heading || sharesWord(x.text, y.text),
    );
    // In the order a person reads the page, so a heading added above a changed one comes first.
    for (const { step } of inReadingOrder(paired, at, at, h.bStart)) {
      const { x, y } = step;
      // A region the diff gave up on pairs unchanged runs too: they are not changes.
      if (x && y && key(x) === key(y)) continue;
      if (x && y) {
        out.add(
          y.heading
            ? {
                kind: "changed",
                where: where(y),
                what: `Heading ${quoted(x.text)} changed`,
                before: changeExcerpt(x.text),
                after: changeExcerpt(y.text),
              }
            : {
                kind: "changed",
                where: where(y),
                what: "Text changed",
                ...differenceExcerpts(x.text, y.text),
              },
        );
      } else if (y) {
        out.add(
          y.heading
            ? { kind: "added", where: where(y), what: `Heading ${quoted(y.text)} added` }
            : { kind: "added", where: where(y), what: "Text added", after: changeExcerpt(y.text) },
        );
      } else if (x) {
        out.add(
          x.heading
            ? { kind: "removed", where: where(x), what: `Heading ${quoted(x.text)} removed` }
            : {
                kind: "removed",
                where: where(x),
                what: "Text removed",
                before: changeExcerpt(x.text),
              },
        );
      }
    }
  }
}

function describeCounts(
  out: ChangeCollector,
  a: readonly string[],
  b: readonly string[],
  where: string,
  one: string,
): void {
  const { added, removed } = multisetChanges(a, b);
  if (added.length > 0)
    out.add({ kind: "added", where, what: `${count(added.length, one)} added` });
  if (removed.length > 0) {
    out.add({ kind: "removed", where, what: `${count(removed.length, one)} removed` });
  }
}

function describeScans(out: ChangeCollector, a: HtmlScan, b: HtmlScan, where: string): void {
  describeRuns(out, a.runs, b.runs, where);
  describeCounts(out, a.links, b.links, where, "link");
  describeCounts(out, a.images, b.images, where, "image");
  if (a.forms !== b.forms) {
    const n = Math.abs(b.forms - a.forms);
    out.add({
      kind: b.forms > a.forms ? "added" : "removed",
      where,
      what: `${count(n, "form")} ${b.forms > a.forms ? "added" : "removed"}`,
    });
  }
  if (JSON.stringify(a.styles) !== JSON.stringify(b.styles)) {
    out.add({ kind: "changed", where, what: "Styles changed" });
  }
  if (JSON.stringify(a.scripts) !== JSON.stringify(b.scripts)) {
    out.add({ kind: "changed", where, what: "Scripts changed" });
  }
}

/**
 * Said for an HTML page whose markup changed in nothing the list names: a class, an attribute such
 * as `hidden` or an image's size, <b> or <em>, a video, frame or SVG shape, <pre> spacing.
 */
export const CHANGES_LAYOUT = "Layout or formatting changed";

/** Adds the changes from `before` to `after`, two HTML pages, to `out`. */
export function describeHtml(out: ChangeCollector, before: string, after: string): void {
  const a = scanHtml(before);
  const b = scanHtml(after);
  if ((a.title ?? "") !== (b.title ?? "")) {
    out.add({
      kind: a.title === null ? "added" : b.title === null ? "removed" : "changed",
      where: "",
      what: "Page title changed",
      before: changeExcerpt(a.title ?? ""),
      after: changeExcerpt(b.title ?? ""),
    });
  }
  describeScans(out, a, b, "");
  // Nothing named, yet the texts differ: only a change in how the markup is written is invisible.
  if (out.items.length === 0 && markupSignature(before) !== markupSignature(after)) {
    out.add({ kind: "changed", where: "", what: CHANGES_LAYOUT });
  }
}

/** Adds the changes from `before` to `after`, two designs, to `out`. False when one does not parse. */
export function describeDesign(out: ChangeCollector, before: string, after: string): boolean {
  const pa = parseDesign(before);
  const pb = parseDesign(after);
  if (!pa.ok || !pb.ok) return false;
  describeBoards(out, pa.design, pb.design);
  return true;
}

function describeBoards(out: ChangeCollector, a: DesignSource, b: DesignSource): void {
  const name = (x: DesignBoard) => `Board ${quoted(x.name)}`;
  if (a.shared !== b.shared) {
    out.add({ kind: "changed", where: "", what: "Styles or fonts shared by every board changed" });
  }
  // Boards in order by id: one taken out of one place and put into another moved; boards that
  // replace each other in one place are the same board renamed (a board's id comes from its name).
  const { hunks } = diffSequence(
    a.boards.map((x) => x.id),
    b.boards.map((x) => x.id),
  );
  const same: [DesignBoard, DesignBoard][] = [];
  let i = 0;
  let j = 0;
  const keep = (to: number) => {
    while (i < to) same.push([a.boards[i++] as DesignBoard, b.boards[j++] as DesignBoard]);
  };
  const removedAll: DesignBoard[] = [];
  const addedAll: DesignBoard[] = [];
  const regions: { removed: DesignBoard[]; added: DesignBoard[] }[] = [];
  for (const h of hunks) {
    keep(h.aStart);
    const region = {
      removed: a.boards.slice(h.aStart, h.aEnd),
      added: b.boards.slice(h.bStart, h.bEnd),
    };
    removedAll.push(...region.removed);
    addedAll.push(...region.added);
    regions.push(region);
    i = h.aEnd;
    j = h.bEnd;
  }
  keep(a.boards.length);
  const moved = new Set<DesignBoard>();
  for (const x of removedAll) {
    const y = addedAll.find((t) => t.id === x.id && !moved.has(t));
    if (!y) continue;
    moved.add(x).add(y);
    same.push([x, y]);
  }
  for (const region of regions) {
    const p = pairInOrder(
      region.removed.filter((x) => !moved.has(x)),
      region.added.filter((x) => !moved.has(x)),
    );
    for (const x of p.removed) out.add({ kind: "removed", where: "", what: `${name(x)} removed` });
    same.push(...p.pairs);
  }
  // Then every board of the new version, in its order.
  const was = new Map(same.map(([x, y]) => [y, x]));
  for (const y of b.boards) {
    const x = was.get(y);
    if (!x) {
      out.add({ kind: "added", where: "", what: `${name(y)} added`, after: sizeLabel(y) });
      continue;
    }
    if (moved.has(y)) out.add({ kind: "moved", where: "", what: `${name(y)} moved` });
    const where = name(y);
    if (x.name !== y.name) {
      out.add({
        kind: "changed",
        where,
        what: `${name(x)} renamed`,
        before: x.name,
        after: y.name,
      });
    }
    if (x.width !== y.width || x.height !== y.height) {
      out.add({
        kind: "changed",
        where,
        what: "Resized",
        before: sizeLabel(x),
        after: sizeLabel(y),
      });
    }
    if (x.background !== y.background) {
      out.add({
        kind: "changed",
        where,
        what: "Background changed",
        before: x.background,
        after: y.background,
      });
    }
    if ((x.section ?? "") !== (y.section ?? "")) {
      out.add({
        kind: "moved",
        where,
        what: y.section ? `Moved to section ${quoted(y.section)}` : "Moved out of its section",
        before: x.section ?? undefined,
        after: y.section ?? undefined,
      });
    }
    if (x.html !== y.html) {
      const sa = scanHtml(x.html);
      const sb = scanHtml(y.html);
      const items = out.items.length;
      describeRuns(out, sa.runs, sb.runs, where);
      if (JSON.stringify(sa.images) !== JSON.stringify(sb.images)) {
        out.add({ kind: "changed", where, what: "Images changed" });
      }
      if (JSON.stringify(sa.styles) !== JSON.stringify(sb.styles)) {
        out.add({ kind: "changed", where, what: "Styles changed" });
      }
      if (out.items.length === items && !out.full) {
        out.add({ kind: "changed", where, what: "Layout changed" });
      }
    }
    if (out.full) break;
  }
}

// What changed in an HTML page or a design's boards, read with the string scanner (htmlScan.ts):
// the title, the visible text (located by the nearest heading), links, images and forms added or
// removed (counted), and whether styles or scripts changed. A page whose markup changed in a way
// none of these name gets one item, CHANGES_LAYOUT. Markup and code are never quoted.
import { type DesignBoard, type DesignNote, type DesignSource, parseDesign } from "../design.ts";
import { alignRegion } from "./align.ts";
import { diffSequence } from "./diff.ts";
import { type HtmlScan, type HtmlTextRun, markupSignature, scanHtml } from "./htmlScan.ts";
import { inReadingOrder, multisetChanges } from "./pairs.ts";
import { changeExcerpt, count, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector } from "./types.ts";

/** A board's size as the list says it: "1080 × 1080". */
function sizeLabel(b: Pick<DesignBoard, "width" | "height" | "autoHeight">): string {
  return `${b.width} × ${b.autoHeight ? "auto" : b.height}`;
}

/** A note as Compare sees it: everything but the line it is on. */
const noteKey = (n: DesignNote) =>
  JSON.stringify([n.kind, n.text, n.width, n.color, n.x, n.y, n.after]);

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
  const { hunks, exact } = diffSequence(a.map(key), b.map(key), out.diffOptions());
  if (!exact) out.truncated = true;
  const where = (r: HtmlTextRun) =>
    join(prefix, r.under === "" ? "" : `${r.after ? "After" : "Under"} ${quoted(r.under)}`);
  for (const h of hunks) {
    if (out.done()) {
      out.truncated = true;
      return;
    }
    const removedRuns = a.slice(h.aStart, h.aEnd);
    const addedRuns = b.slice(h.bStart, h.bEnd);
    const index = new Map<HtmlTextRun, number>();
    for (const [k, r] of removedRuns.entries()) index.set(r, h.aStart + k);
    for (const [k, r] of addedRuns.entries()) index.set(r, h.bStart + k);
    const at = (r: HtmlTextRun) => index.get(r) as number;
    // Aligned by the content words they share, so a heading or paragraph added next to an edited
    // one is not taken for it.
    const paired = alignRegion(removedRuns, addedRuns, {
      key,
      text: (r) => r.text,
      compatible: (x, y) => x.heading === y.heading,
      budget: out.alignBudget,
    });
    // In the order a person reads the page, so a heading added above a changed one comes first.
    for (const { step } of inReadingOrder(paired, at, at, h.bStart)) {
      const { x, y } = step;
      // Equal runs (a region the diff gave up on holds unchanged ones too) are not changes.
      if (x && y && key(x) === key(y)) continue;
      // Every other step lists one item: once the list is full, the rest is cut.
      if (out.full) {
        out.truncated = true;
        return;
      }
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
  if (a.notes.map(noteKey).join("\n") !== b.notes.map(noteKey).join("\n")) {
    out.add({ kind: "changed", where: "", what: "Notes on the canvas changed" });
  }
  // Boards in order by id: one taken out of one place and put into another moved; boards that
  // replace each other in one place are the same board renamed (a board's id comes from its name).
  const { hunks, exact } = diffSequence(
    a.boards.map((x) => x.id),
    b.boards.map((x) => x.id),
    out.diffOptions(),
  );
  if (!exact) out.truncated = true;
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
  // Each id's added boards in order, taken from the front: linear however many boards moved.
  const moved = new Set<DesignBoard>();
  const waiting = new Map<string, { list: DesignBoard[]; next: number }>();
  for (const y of addedAll) {
    const w = waiting.get(y.id);
    if (w) w.list.push(y);
    else waiting.set(y.id, { list: [y], next: 0 });
  }
  for (const x of removedAll) {
    const w = waiting.get(x.id);
    const y = w?.list[w.next];
    if (!w || !y) continue;
    w.next++;
    moved.add(x).add(y);
    same.push([x, y]);
  }
  // A board renamed in place keeps its contents or the words of its name and text; one that
  // shares neither with any board it replaced is removed, and the new one added.
  const words = new Map<DesignBoard, string>();
  const text = (x: DesignBoard) => {
    let t = words.get(x);
    if (t === undefined) {
      t = [x.name, ...scanHtml(x.html).runs.map((r) => r.text)].join(" ");
      words.set(x, t);
    }
    return t;
  };
  for (const region of regions) {
    if (out.done()) {
      out.truncated = true;
      return;
    }
    const p = alignRegion(
      region.removed.filter((x) => !moved.has(x)),
      region.added.filter((x) => !moved.has(x)),
      // A board with no name and no text keys on its markup: such boards may pair with each other.
      { key: (x) => x.html, text, wordless: true, budget: out.alignBudget },
    );
    for (const x of p.removed) out.add({ kind: "removed", where: "", what: `${name(x)} removed` });
    same.push(...p.pairs);
  }
  // Then every board of the new version, in its order.
  const was = new Map(same.map(([x, y]) => [y, x]));
  for (const y of b.boards) {
    const x = was.get(y);
    const unchanged =
      x !== undefined &&
      !moved.has(y) &&
      x.name === y.name &&
      x.width === y.width &&
      x.height === y.height &&
      x.autoHeight === y.autoHeight &&
      x.x === y.x &&
      x.y === y.y &&
      x.background === y.background &&
      (x.section ?? "") === (y.section ?? "") &&
      x.html === y.html;
    if (unchanged) continue;
    // Every other board lists at least one item: once the list is full or out of time, the rest
    // is cut.
    if (out.done()) {
      out.truncated = true;
      break;
    }
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
    if (x.width !== y.width || x.height !== y.height || x.autoHeight !== y.autoHeight) {
      out.add({
        kind: "changed",
        where,
        what: "Resized",
        before: sizeLabel(x),
        after: sizeLabel(y),
      });
    }
    if (x.x !== y.x || x.y !== y.y) {
      out.add({ kind: "moved", where, what: "Moved on the canvas" });
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
      if (out.items.length === items && !out.done()) {
        out.add({ kind: "changed", where, what: "Layout changed" });
      }
    }
  }
}

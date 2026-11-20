// What changed in a doc (content.md), block by block, in the order a person reads them, each
// located by the nearest heading above it: headings added, removed or renamed; paragraphs, quotes,
// code blocks, tables and lists added, removed or changed, with excerpts of their visible text (a
// changed list's items one at a time); images added, removed or described differently.
// Also used for a design system's guidelines.

import { type AlignBudget, alignRegion } from "./align.ts";
import { diffSequence } from "./diff.ts";
import {
  type MdBlock,
  type MdBlockKind,
  type MdImage,
  type MdListItem,
  markdownBlocks,
} from "./markdownText.ts";
import { inReadingOrder, multisetChanges } from "./pairs.ts";
import { changeExcerpt, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector, ChangeItem } from "./types.ts";

const NOUN: Record<Exclude<MdBlockKind, "image" | "definition">, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list: "List",
  quote: "Quote",
  code: "Code block",
  table: "Table",
  divider: "Divider",
};

/** Where a block is: under a heading, or (for a heading) after one of the same level. */
interface Place {
  heading: string;
  after: boolean;
}

/**
 * For each block, its place. A block is under the nearest heading above it. A heading is under
 * the nearest heading above it of a higher level, or after the nearest one of its own level when
 * that one comes later: "Plot 5" is after "Plot 4", not under it.
 */
function placesOf(blocks: readonly MdBlock[]): Place[] {
  const out: Place[] = [];
  let last: MdBlock | null = null;
  // The latest heading of each level, 1 to 6, and its index.
  const latest: ({ block: MdBlock; at: number } | null)[] = [null, null, null, null, null, null];
  for (const [at, b] of blocks.entries()) {
    if (b.kind !== "heading") {
      out.push({ heading: last?.text ?? "", after: false });
      continue;
    }
    const level = b.level ?? 1;
    let near: { block: MdBlock; at: number } | null = null;
    for (let l = 1; l <= level; l++) {
      const h = latest[l - 1];
      if (h && (!near || h.at > near.at)) near = h;
    }
    out.push({ heading: near?.block.text ?? "", after: (near?.block.level ?? 1) === level });
    latest[level - 1] = { block: b, at };
    last = b;
  }
  return out;
}

function imageName(img: MdImage): string {
  if (img.alt.trim() !== "") return quoted(img.alt);
  const file = img.src.split(/[?#]/)[0]?.split("/").pop() ?? "";
  return file === "" ? "" : file;
}

export interface DocScope {
  /** Prefix for every `where` (a design system's "Guidelines"). */
  prefix?: string;
}

function place(p: Place, scope: DocScope): string {
  if (p.heading === "") return scope.prefix ?? "";
  const rel = `${p.after ? "after" : "under"} ${quoted(p.heading)}`;
  return scope.prefix ? `${scope.prefix}, ${rel}` : `${rel[0]?.toUpperCase()}${rel.slice(1)}`;
}

/** One item, with the position that sorts it into reading order. */
interface Event {
  key: number;
  item: ChangeItem;
}

/** A block's visible text, a list's items set apart with " · " so each one stays plain. */
function shownText(x: MdBlock): string {
  return x.kind === "list" && x.items ? x.items.map((i) => i.text).join(" · ") : x.text;
}

/** A list's items that changed, one item each, in the order of the list. */
function listItemChanges(x: MdBlock, y: MdBlock, where: string, budget: AlignBudget): ChangeItem[] {
  const ai = x.items ?? [];
  const bi = y.items ?? [];
  const at = new Map<MdListItem, number>();
  for (const [k, i] of ai.entries()) at.set(i, k);
  for (const [k, i] of bi.entries()) at.set(i, k);
  const { hunks } = diffSequence(
    ai.map((i) => i.text),
    bi.map((i) => i.text),
  );
  const out: ChangeItem[] = [];
  for (const h of hunks) {
    const p = alignRegion(ai.slice(h.aStart, h.aEnd), bi.slice(h.bStart, h.bEnd), {
      key: (i) => i.text,
      text: (i) => i.text,
      budget,
    });
    const pos = (i: MdListItem) => at.get(i) as number;
    for (const { step } of inReadingOrder(p, pos, pos, h.bStart)) {
      if (step.x && step.y && step.x.text === step.y.text) continue;
      if (step.x && step.y) {
        out.push({
          kind: "changed",
          where,
          what: "List item changed",
          ...differenceExcerpts(step.x.text, step.y.text),
        });
      } else if (step.y) {
        out.push({
          kind: "added",
          where,
          what: "List item added",
          after: changeExcerpt(step.y.text),
        });
      } else if (step.x) {
        out.push({
          kind: "removed",
          where,
          what: "List item removed",
          before: changeExcerpt(step.x.text),
        });
      }
    }
  }
  return out;
}

interface Placed {
  image: MdImage;
  where: string;
  key: number;
}

/** Images of one changed region: each side's images with the place of the block they are in. */
function imageEvents(a: readonly Placed[], b: readonly Placed[]): Event[] {
  const bySrc = (list: readonly Placed[]) => {
    const m = new Map<string, Placed>();
    for (const p of list) if (!m.has(p.image.src)) m.set(p.image.src, p);
    return m;
  };
  const { added, removed } = multisetChanges(
    a.map((p) => p.image.src),
    b.map((p) => p.image.src),
  );
  const oldBySrc = bySrc(a);
  const newBySrc = bySrc(b);
  const out: Event[] = [];
  for (const src of removed) {
    const { image, where, key } = oldBySrc.get(src) as Placed;
    const name = imageName(image);
    out.push({
      key,
      item: { kind: "removed", where, what: name ? `Image ${name} removed` : "Image removed" },
    });
  }
  for (const src of added) {
    const { image, where, key } = newBySrc.get(src) as Placed;
    const name = imageName(image);
    out.push({
      key,
      item: { kind: "added", where, what: name ? `Image ${name} added` : "Image added" },
    });
  }
  for (const [src, { image: was }] of oldBySrc) {
    const placed = newBySrc.get(src);
    const now = placed?.image;
    if (placed && now && now.alt !== was.alt && !removed.includes(src) && !added.includes(src)) {
      out.push({
        key: placed.key,
        item: {
          kind: "changed",
          where: placed.where,
          what: "Image description changed",
          before: changeExcerpt(was.alt),
          after: changeExcerpt(now.alt),
        },
      });
    }
  }
  return out;
}

/** Adds the changes from `before` to `after`, two Markdown texts, to `out`. */
export function describeMarkdown(
  out: ChangeCollector,
  before: string,
  after: string,
  scope: DocScope = {},
): void {
  const a = markdownBlocks(before);
  const b = markdownBlocks(after);
  const aPlace = placesOf(a);
  const bPlace = placesOf(b);
  const { hunks, exact } = diffSequence(
    a.map((x) => x.raw),
    b.map((x) => x.raw),
  );
  if (!exact) out.truncated = true;
  for (const h of hunks) {
    if (out.full) {
      out.truncated = true;
      return;
    }
    const removedBlocks = a.slice(h.aStart, h.aEnd);
    const addedBlocks = b.slice(h.bStart, h.bEnd);
    const index = new Map<MdBlock, number>();
    for (const [k, x] of removedBlocks.entries()) index.set(x, h.aStart + k);
    for (const [k, x] of addedBlocks.entries()) index.set(x, h.bStart + k);
    const at = (x: MdBlock) => index.get(x) as number;
    const whereA = (x: MdBlock) => place(aPlace[at(x)] as Place, scope);
    const whereB = (y: MdBlock) => place(bPlace[at(y)] as Place, scope);
    const shown = (x: MdBlock) => x.kind !== "image" && x.kind !== "definition";
    // Aligned by the content words they share: a heading renamed keeps one ("Notes" to "Field
    // notes"), and a block added next to an edited one is not taken for it. The same text in
    // other formatting is alike too; the same Markdown is no change.
    const paired = alignRegion(removedBlocks.filter(shown), addedBlocks.filter(shown), {
      key: (x) => `${x.kind}\u0000${x.text}`,
      text: (x) => x.text,
      compatible: (x, y) => x.kind === y.kind,
      budget: out.alignBudget,
    });
    const steps = inReadingOrder(paired, at, at, h.bStart);
    const events: Event[] = [];
    const push = (key: number, item: ChangeItem) => events.push({ key, item });
    // Where each removed block (an image's, too) sorts: just after the pair before it. One pass,
    // since both are in old-version order.
    const removedKeys = new Map<MdBlock, number>();
    {
      let key = h.bStart - 0.5;
      let k = 0;
      for (const x of removedBlocks) {
        for (
          ;
          k < paired.pairs.length && at((paired.pairs[k] as [MdBlock, MdBlock])[0]) < at(x);
          k++
        ) {
          key = at((paired.pairs[k] as [MdBlock, MdBlock])[1]) + 0.5;
        }
        removedKeys.set(x, key);
      }
    }
    const removedKey = (x: MdBlock) => removedKeys.get(x) as number;
    for (const { key, step } of steps) {
      const { x, y } = step;
      // The same Markdown (a region the diff gave up on holds unchanged blocks too) is no change.
      if (x && y && x.raw === y.raw) continue;
      if (x && y) {
        const where = whereB(y);
        if (y.kind === "heading") {
          if (x.text !== y.text) {
            push(key, {
              kind: "changed",
              where,
              what: `Heading ${quoted(x.text)} renamed`,
              before: changeExcerpt(x.text),
              after: changeExcerpt(y.text),
            });
          } else if (x.level !== y.level) {
            push(key, {
              kind: "changed",
              where,
              what: `Heading ${quoted(y.text)} is now level ${y.level}`,
              before: `Level ${x.level}`,
              after: `Level ${y.level}`,
            });
          }
          continue;
        }
        const noun = NOUN[y.kind as keyof typeof NOUN];
        if (x.text !== y.text) {
          if (y.kind === "list") {
            for (const item of listItemChanges(x, y, where, out.alignBudget)) push(key, item);
          } else {
            push(key, {
              kind: "changed",
              where,
              what: `${noun} changed`,
              ...differenceExcerpts(x.text, y.text),
            });
          }
        } else if (y.kind === "list") {
          // The same items, written differently: one line, not one per item.
          push(key, { kind: "changed", where, what: "List formatting or links changed" });
        } else if (y.kind !== "divider") {
          push(key, {
            kind: "changed",
            where,
            what: `${noun} formatting or links changed`,
            after: changeExcerpt(y.text),
          });
        }
      } else if (y) {
        const where = whereB(y);
        if (y.kind === "heading") {
          push(key, { kind: "added", where, what: `Heading ${quoted(y.text)} added` });
        } else {
          const noun = NOUN[y.kind as keyof typeof NOUN];
          push(key, {
            kind: "added",
            where,
            what: `${noun} added`,
            after: changeExcerpt(shownText(y)),
          });
        }
      } else if (x) {
        const where = whereA(x);
        if (x.kind === "heading") {
          push(key, { kind: "removed", where, what: `Heading ${quoted(x.text)} removed` });
        } else {
          const noun = NOUN[x.kind as keyof typeof NOUN];
          push(key, {
            kind: "removed",
            where,
            what: `${noun} removed`,
            before: changeExcerpt(shownText(x)),
          });
        }
      }
    }
    const placed = (blocks: MdBlock[], side: "a" | "b") =>
      blocks.flatMap((x) =>
        x.images.map((image) => ({
          image,
          where: side === "a" ? whereA(x) : whereB(x),
          key: side === "a" ? removedKey(x) : at(x),
        })),
      );
    events.push(...imageEvents(placed(removedBlocks, "a"), placed(addedBlocks, "b")));
    // Link definitions changed in this region, not just sitting in it (a region the diff gave up
    // on holds unchanged ones too).
    const defs = (list: MdBlock[]) => list.filter((x) => x.kind === "definition").map((x) => x.raw);
    const targets = multisetChanges(defs(removedBlocks), defs(addedBlocks));
    if (targets.added.length > 0 || targets.removed.length > 0) {
      const first = addedBlocks[0] ?? removedBlocks[0];
      push(h.bEnd, {
        kind: "changed",
        where: first ? (addedBlocks[0] ? whereB(first) : whereA(first)) : (scope.prefix ?? ""),
        what: "Link targets changed",
      });
    }
    // Stable: items of one block keep their order.
    events.sort((u, v) => u.key - v.key);
    for (const e of events) {
      if (!out.add(e.item)) break;
    }
  }
}

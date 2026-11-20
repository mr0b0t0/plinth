// What changed in a doc (content.md), block by block, each located by the nearest heading above
// it: headings added, removed or renamed; paragraphs, lists, quotes, code blocks and tables
// added, removed or changed, with excerpts of their visible text; images added, removed or
// described differently. Also used for a design system's guidelines.
import { diffSequence } from "./diff.ts";
import { type MdBlock, type MdBlockKind, type MdImage, markdownBlocks } from "./markdownText.ts";
import { multisetChanges, pairInOrder, sharesWord } from "./pairs.ts";
import { changeExcerpt, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector } from "./types.ts";

const NOUN: Record<Exclude<MdBlockKind, "image" | "definition">, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list: "List",
  quote: "Quote",
  code: "Code block",
  table: "Table",
  divider: "Divider",
};

/** For each block, the text of the nearest heading above it ("" before the first). */
function headingsAbove(blocks: readonly MdBlock[]): string[] {
  const out: string[] = [];
  let last = "";
  for (const b of blocks) {
    out.push(last);
    if (b.kind === "heading") last = b.text;
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

function place(heading: string, scope: DocScope): string {
  if (!scope.prefix) return heading === "" ? "" : `Under ${quoted(heading)}`;
  return heading === "" ? scope.prefix : `${scope.prefix}, under ${quoted(heading)}`;
}

interface Placed {
  image: MdImage;
  where: string;
}

/** Images of one changed region: each side's images with the place of the block they are in. */
function describeImages(out: ChangeCollector, a: readonly Placed[], b: readonly Placed[]): void {
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
  for (const src of removed) {
    const { image, where } = oldBySrc.get(src) as Placed;
    const name = imageName(image);
    out.add({ kind: "removed", where, what: name ? `Image ${name} removed` : "Image removed" });
  }
  for (const src of added) {
    const { image, where } = newBySrc.get(src) as Placed;
    const name = imageName(image);
    out.add({ kind: "added", where, what: name ? `Image ${name} added` : "Image added" });
  }
  for (const [src, { image: was }] of oldBySrc) {
    const placed = newBySrc.get(src);
    const now = placed?.image;
    if (placed && now && now.alt !== was.alt && !removed.includes(src) && !added.includes(src)) {
      out.add({
        kind: "changed",
        where: placed.where,
        what: "Image description changed",
        before: changeExcerpt(was.alt),
        after: changeExcerpt(now.alt),
      });
    }
  }
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
  const aAbove = headingsAbove(a);
  const bAbove = headingsAbove(b);
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
    const hunkWhere = place(bAbove[h.bStart] ?? aAbove[h.aStart] ?? "", scope);
    const shown = (x: MdBlock) => x.kind !== "image" && x.kind !== "definition";
    const { pairs, removed, added } = pairInOrder(
      removedBlocks.filter(shown),
      addedBlocks.filter(shown),
      (x, y) => x.kind === y.kind,
      // A heading renamed keeps a word ("Notes" to "Field notes"); one that shares none with it
      // but sits before one that does was added there.
      (x, y) => sharesWord(x.text, y.text),
    );
    // Removals, then changes, then additions, each in order; then the region's images.
    for (const x of removed) {
      const where = place(aAbove[index.get(x) as number] ?? "", scope);
      if (x.kind === "heading") {
        out.add({ kind: "removed", where, what: `Heading ${quoted(x.text)} removed` });
      } else {
        const noun = NOUN[x.kind as keyof typeof NOUN];
        out.add({ kind: "removed", where, what: `${noun} removed`, before: changeExcerpt(x.text) });
      }
    }
    for (const [x, y] of pairs) {
      const where = place(bAbove[index.get(y) as number] ?? "", scope);
      if (y.kind === "heading") {
        if (x.text !== y.text) {
          out.add({
            kind: "changed",
            where,
            what: `Heading ${quoted(x.text)} renamed`,
            before: changeExcerpt(x.text),
            after: changeExcerpt(y.text),
          });
        } else if (x.level !== y.level) {
          out.add({
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
        out.add({
          kind: "changed",
          where,
          what: `${noun} changed`,
          ...differenceExcerpts(x.text, y.text),
        });
      } else if (y.kind !== "divider") {
        out.add({
          kind: "changed",
          where,
          what: `${noun} formatting or links changed`,
          after: changeExcerpt(y.text),
        });
      }
    }
    for (const y of added) {
      const where = place(bAbove[index.get(y) as number] ?? "", scope);
      if (y.kind === "heading") {
        out.add({ kind: "added", where, what: `Heading ${quoted(y.text)} added` });
      } else {
        const noun = NOUN[y.kind as keyof typeof NOUN];
        out.add({ kind: "added", where, what: `${noun} added`, after: changeExcerpt(y.text) });
      }
    }
    const placed = (blocks: MdBlock[], above: string[]) =>
      blocks.flatMap((x) =>
        x.images.map((image) => ({
          image,
          where: place(above[index.get(x) as number] ?? "", scope),
        })),
      );
    describeImages(out, placed(removedBlocks, aAbove), placed(addedBlocks, bAbove));
    const defs = (list: MdBlock[]) => list.some((x) => x.kind === "definition");
    if (defs(removedBlocks) || defs(addedBlocks)) {
      out.add({ kind: "changed", where: hunkWhere, what: "Link targets changed" });
    }
  }
}

// What changed in a deck (slides.md): slides added, removed and moved; per slide its title, its
// text, its columns, its images and its speaker notes; and the deck settings.
import { type DeckSettings, parseDeck, type SlideSource } from "../slides.ts";
import { alignRegion } from "./align.ts";
import { diffSequence } from "./diff.ts";
import { markdownBlocks } from "./markdownText.ts";
import { inReadingOrder, multisetChanges } from "./pairs.ts";
import { changeExcerpt, count, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector } from "./types.ts";

interface Slide {
  n: number;
  key: string;
  title: string;
  /** Visible text of the slide besides its title. */
  text: string;
  notes: string;
  columns: number;
  images: string[];
}

function slideOf(s: SlideSource): Slide {
  const body = [s.head, ...s.columns].join("\n");
  const blocks = markdownBlocks(body);
  const first = blocks.findIndex((b) => b.kind === "heading");
  const title = first >= 0 ? (blocks[first]?.text ?? "") : "";
  const text = blocks
    // Images are listed on their own, by file.
    .filter((b, k) => k !== first && b.kind !== "image")
    .map((b) => b.text)
    .filter((t) => t !== "")
    .join(" ");
  return {
    n: s.n,
    key: `${body.trim()}\u0000${s.notes.trim()}`,
    title,
    text,
    notes: markdownBlocks(s.notes)
      .map((b) => b.text)
      .join(" "),
    columns: s.columns.length,
    images: blocks.flatMap((b) => b.images.map((i) => i.src)),
  };
}

function label(s: Slide): string {
  return s.title !== "" ? `Slide ${s.n} ${quoted(s.title)}` : `Slide ${s.n}`;
}

function describeSettings(out: ChangeCollector, a: DeckSettings, b: DeckSettings): void {
  const where = "Deck settings";
  if (a.aspect !== b.aspect) {
    out.add({ kind: "changed", where, what: "Aspect changed", before: a.aspect, after: b.aspect });
  }
  if (a.theme !== b.theme) {
    out.add({ kind: "changed", where, what: "Theme changed", before: a.theme, after: b.theme });
  }
  if (a.paginate !== b.paginate) {
    out.add({
      kind: "changed",
      where,
      what: b.paginate ? "Slide numbers turned on" : "Slide numbers turned off",
    });
  }
  if (a.footer !== b.footer) {
    out.add({
      kind: a.footer === "" ? "added" : b.footer === "" ? "removed" : "changed",
      where,
      what:
        a.footer === "" ? "Footer added" : b.footer === "" ? "Footer removed" : "Footer changed",
      before: changeExcerpt(a.footer),
      after: changeExcerpt(b.footer),
    });
  }
}

function describeSlide(out: ChangeCollector, a: Slide, b: Slide): void {
  const where = `Slide ${b.n}`;
  const before = out.items.length;
  if (a.title !== b.title) {
    out.add({
      kind: a.title === "" ? "added" : b.title === "" ? "removed" : "changed",
      where,
      what: a.title === "" ? "Title added" : b.title === "" ? "Title removed" : "Title changed",
      before: changeExcerpt(a.title),
      after: changeExcerpt(b.title),
    });
  }
  if (a.text !== b.text) {
    out.add({
      kind: "changed",
      where,
      what: "Text changed",
      ...differenceExcerpts(a.text, b.text),
    });
  }
  if (a.columns !== b.columns) {
    const cols = (n: number) => (n === 0 ? "One column" : count(n, "column"));
    out.add({
      kind: "changed",
      where,
      what: "Columns changed",
      before: cols(a.columns),
      after: cols(b.columns),
    });
  }
  const images = multisetChanges(a.images, b.images);
  for (const src of images.removed) {
    out.add({ kind: "removed", where, what: `Image ${src.split("/").pop() ?? src} removed` });
  }
  for (const src of images.added) {
    out.add({ kind: "added", where, what: `Image ${src.split("/").pop() ?? src} added` });
  }
  if (a.notes !== b.notes) {
    out.add({
      kind: a.notes === "" ? "added" : b.notes === "" ? "removed" : "changed",
      where,
      what:
        a.notes === ""
          ? "Speaker notes added"
          : b.notes === ""
            ? "Speaker notes removed"
            : "Speaker notes changed",
      ...differenceExcerpts(a.notes, b.notes),
    });
  }
  if (out.items.length === before && !out.full) {
    out.add({
      kind: "changed",
      where,
      what: "Formatting changed",
      after: changeExcerpt(b.title || b.text),
    });
  }
}

/** Adds the changes from `before` to `after`, two decks, to `out`. */
export function describeSlides(out: ChangeCollector, before: string, after: string): void {
  const da = parseDeck(before);
  const db = parseDeck(after);
  describeSettings(out, da.settings, db.settings);
  const a = da.slides.map(slideOf);
  const b = db.slides.map(slideOf);
  const { hunks, exact } = diffSequence(
    a.map((s) => s.key),
    b.map((s) => s.key),
  );
  if (!exact) out.truncated = true;

  // A slide taken out of one changed region and put into another moved: first slides that are
  // the same, then slides with the same title (which also changed). A slide whose own region has
  // its key on the other side changed in place: two "Agenda" slides edited where they are did not
  // trade places.
  const regions = hunks.map((h) => ({
    removed: a.slice(h.aStart, h.aEnd),
    added: b.slice(h.bStart, h.bEnd),
  }));
  const regionOf = new Map<Slide, number>();
  regions.forEach((r, k) => {
    for (const s of r.removed) regionOf.set(s, k);
    for (const s of r.added) regionOf.set(s, k);
  });
  const removedAll = regions.flatMap((r) => r.removed);
  const addedAll = regions.flatMap((r) => r.added);
  const moved = new Set<Slide>();
  const moves: [Slide, Slide][] = [];
  const match = (keyOf: (s: Slide) => string) => {
    const keysOf = (list: readonly Slide[]) =>
      new Set(list.filter((s) => !moved.has(s)).map(keyOf));
    const inRegion = regions.map((r) => ({ removed: keysOf(r.removed), added: keysOf(r.added) }));
    const region = (s: Slide) => inRegion[regionOf.get(s) as number] as (typeof inRegion)[number];
    // Each key's candidates in order, taken from the front. None is in the region of a slide that
    // looks for it (that slide would have its key on the other side), so nothing is scanned and a
    // deck of many same-titled slides stays linear.
    const waiting = new Map<string, { list: Slide[]; next: number }>();
    for (const s of addedAll) {
      const k = keyOf(s);
      if (k === "" || moved.has(s) || region(s).removed.has(k)) continue;
      const w = waiting.get(k);
      if (w) w.list.push(s);
      else waiting.set(k, { list: [s], next: 0 });
    }
    for (const s of removedAll) {
      const k = keyOf(s);
      if (k === "" || moved.has(s) || region(s).added.has(k)) continue;
      const w = waiting.get(k);
      const to = w?.list[w.next];
      if (!w || !to) continue;
      w.next++;
      moved.add(s).add(to);
      moves.push([s, to]);
    }
  };
  match((s) => s.key);
  match((s) => s.title);
  for (const [s, to] of moves.sort((x, y) => x[1].n - y[1].n)) {
    out.add({
      kind: "moved",
      where: s.title !== "" ? quoted(s.title) : "",
      what: `Slide ${s.n} moved to ${to.n}`,
    });
    if (s.key !== to.key) describeSlide(out, s, to);
  }

  for (const h of hunks) {
    if (out.full) {
      out.truncated = true;
      return;
    }
    const removedSlides = a.slice(h.aStart, h.aEnd).filter((s) => !moved.has(s));
    const addedSlides = b.slice(h.bStart, h.bEnd).filter((s) => !moved.has(s));
    const index = new Map<Slide, number>();
    for (const [k, s] of a.slice(h.aStart, h.aEnd).entries()) index.set(s, h.aStart + k);
    for (const [k, s] of b.slice(h.bStart, h.bEnd).entries()) index.set(s, h.bStart + k);
    const at = (s: Slide) => index.get(s) as number;
    // Aligned by the content words of their title and text, so a slide added next to an edited
    // one is not taken for it.
    const paired = alignRegion(removedSlides, addedSlides, {
      key: (s) => s.key,
      text: (s) => `${s.title} ${s.text}`,
    });
    // In the order a person reads the deck, so a slide added before an edited one comes first.
    for (const { step } of inReadingOrder(paired, at, at, h.bStart)) {
      const { x, y } = step;
      // The same slide (a region the diff gave up on holds unchanged ones too) is no change.
      if (x && y && x.key === y.key) continue;
      // Every other step lists at least one item: once the list is full, the rest is cut.
      if (out.full) {
        out.truncated = true;
        return;
      }
      if (x && y) {
        describeSlide(out, x, y);
      } else if (y) {
        out.add({
          kind: "added",
          where: "",
          what: `${label(y)} added`,
          after: y.title === "" ? changeExcerpt(y.text) : undefined,
        });
      } else if (x) {
        out.add({
          kind: "removed",
          where: "",
          what: `${label(x)} removed`,
          before: x.title === "" ? changeExcerpt(x.text) : undefined,
        });
      }
    }
  }
}

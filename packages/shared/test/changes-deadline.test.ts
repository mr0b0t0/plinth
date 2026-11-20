// One deadline for a whole change list (CHANGE_LIMITS.totalMs): a version of many changed lists
// or boards runs one diff per list or board, each with its own time cap, so the collector holds
// one clock for all of them. Past it, and once the list holds the size cap, every loop stops and
// the list says it was cut; it never describes an unchanged block and never comes back empty.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_LIMITS,
  ChangeCollector,
  type ChangeItem,
  changeClock,
  DESIGN_LIMITS,
  describeChanges,
} from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A clock that moves `step` ms each time it is read: work costs time however fast the machine. */
function fakeClock(step: number): void {
  let t = 0;
  vi.spyOn(changeClock, "now").mockImplementation(() => {
    t += step;
    return t;
  });
}

const N = 2000;
/** A five-character content word naming crate `k`, so every list and board is told apart. */
const tag = (k: number) => `c${String(k).padStart(4, "0")}`;

/**
 * A doc of `n` lists of three items. With `edit`, the middle item of every list says "ripe" too.
 * An unchanged paragraph after every 100 lists keeps each changed region small enough to align.
 */
function crates(n: number, edit: boolean): string {
  const blocks: string[] = [];
  for (let k = 0; k < n; k++) {
    if (k % 100 === 0) blocks.push(`Shelf ${tag(k)} holds the next crates.`);
    blocks.push(
      [
        `- Crate ${tag(k)} apples`,
        `- Crate ${tag(k)} pears${edit ? " ripe" : ""}`,
        `- Crate ${tag(k)} plums`,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

/** Every item is the edit of one list, in order from the first list: never an unchanged block. */
function expectCrateEdits(items: ChangeItem[]): void {
  expect(items.length).toBeGreaterThan(0);
  items.forEach((item, k) => {
    expect(item).toEqual({
      kind: "changed",
      where: "",
      what: "List item changed",
      before: `Crate ${tag(k)} pears`,
      after: `Crate ${tag(k)} pears ripe`,
    });
  });
}

/** As many boards as a design may hold. */
const BOARDS = DESIGN_LIMITS.maxBoards;

/** A design of `BOARDS` boards of 8 paragraphs; with `edit`, the even paragraphs say "edited". */
function boards(edit: boolean): string {
  return Array.from({ length: BOARDS }, (_, k) =>
    [
      `<!-- artboard name="Board ${tag(k)}" size="desktop" -->`,
      `<h1>Crate ${tag(k)}</h1>`,
      ...Array.from(
        { length: 8 },
        (_, p) => `<p>Crate ${tag(k)} shelf ${tag(p)}${edit && p % 2 === 0 ? ", edited" : ""}</p>`,
      ),
    ].join("\n"),
  ).join("\n");
}

/** Every item is one edited paragraph, in order: no unchanged paragraph is named. */
function expectBoardEdits(items: ChangeItem[]): void {
  expect(items.length).toBeGreaterThan(0);
  items.forEach((item, n) => {
    const k = Math.floor(n / 4);
    const p = 2 * (n % 4);
    expect(item).toEqual({
      kind: "changed",
      where: `Board “Board ${tag(k)}”, under “Crate ${tag(k)}”`,
      what: "Text changed",
      before: `Crate ${tag(k)} shelf ${tag(p)}`,
      after: `Crate ${tag(k)} shelf ${tag(p)}, edited`,
    });
  });
}

/**
 * `describeChanges` and its wall-clock time in ms, on a clock that stands still: the item cap has
 * to stop the list, since a slow machine can never reach the deadline first.
 */
function timed(...args: Parameters<typeof describeChanges>) {
  vi.spyOn(changeClock, "now").mockReturnValue(0);
  const t = Date.now();
  const list = describeChanges(...args);
  return { list, ms: Date.now() - t };
}

describe("the collector's deadline", () => {
  it("gives every diff the smaller of its own cap and the time left", () => {
    fakeClock(0);
    const clock = vi.mocked(changeClock.now);
    clock.mockReturnValue(0);
    const out = new ChangeCollector();
    expect(out.diffOptions()).toEqual({ timeoutMs: CHANGE_LIMITS.timeoutMs });
    clock.mockReturnValue(CHANGE_LIMITS.totalMs - 150);
    expect(out.diffOptions()).toEqual({ timeoutMs: 150 });
    clock.mockReturnValue(CHANGE_LIMITS.totalMs + 10);
    expect(out.diffOptions()).toEqual({ timeoutMs: 0 });
    expect(out.timeLeft()).toBe(0);
  });

  it("is passed only once a change was found, and then marks the list cut", () => {
    fakeClock(0);
    const clock = vi.mocked(changeClock.now);
    clock.mockReturnValue(0);
    const out = new ChangeCollector();
    clock.mockReturnValue(CHANGE_LIMITS.totalMs);
    // Nothing found yet: looking on is the only way not to return an empty list.
    expect(out.expired()).toBe(false);
    expect(out.done()).toBe(false);
    expect(out.truncated).toBe(false);
    // An item the caller holds counts as found.
    expect(out.expired(1)).toBe(true);
    expect(out.truncated).toBe(true);
    out.add({ kind: "changed", where: "", what: "Text changed" });
    expect(out.done()).toBe(true);
    // Items found before the deadline are still added.
    expect(out.items).toHaveLength(1);
  });
});

describe("one deadline for a whole change list", () => {
  // About three times what CI takes for the doc of 2,000 lists (0.7 to 1 s; 0.3 s on a laptop),
  // so a busy machine passes; work that ran on past the item cap would take ten times as long.
  const bound = 3000;

  it(`stops a doc of ${N} changed lists at the item cap, not the deadline`, () => {
    const { list, ms } = timed("doc", crates(N, false), crates(N, true));
    expect(ms).toBeLessThan(bound);
    expect(list.truncated).toBe(true);
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expectCrateEdits(list.items);
  });

  it("stops inside one changed region of many lists at the item cap", () => {
    // One region of 100 lists of 10 items, every item edited: the items wait in the region until
    // they are sorted, so the region itself must stop at the list's room.
    const lists = (edit: boolean) =>
      Array.from({ length: 100 }, (_, k) =>
        Array.from(
          { length: 10 },
          (_, i) => `- Crate ${tag(k)} item ${tag(i)}${edit ? " ripe" : ""}`,
        ).join("\n"),
      ).join("\n\n");
    const { list, ms } = timed("doc", lists(false), lists(true));
    expect(ms).toBeLessThan(bound);
    expect(list.truncated).toBe(true);
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    list.items.forEach((item, n) => {
      const k = Math.floor(n / 10);
      const i = n % 10;
      expect(item).toMatchObject({
        kind: "changed",
        what: "List item changed",
        before: `Crate ${tag(k)} item ${tag(i)}`,
        after: `Crate ${tag(k)} item ${tag(i)} ripe`,
      });
    });
  });

  it(`stops a doc of ${N} changed lists at the deadline, before the item cap`, () => {
    fakeClock(10);
    const list = describeChanges("doc", crates(N, false), crates(N, true));
    expect(list.truncated).toBe(true);
    expect(list.items.length).toBeLessThan(CHANGE_LIMITS.maxItems);
    expectCrateEdits(list.items);
  });

  it("names the first change a doc's lists hold even when the deadline has passed", () => {
    fakeClock(10 * CHANGE_LIMITS.totalMs);
    const list = describeChanges("doc", crates(N, false), crates(N, true));
    expect(list.truncated).toBe(true);
    expect(list.items).toHaveLength(1);
    expectCrateEdits(list.items);
  });

  it(`stops a design of ${BOARDS} changed boards at the item cap, not the deadline`, () => {
    const { list, ms } = timed("design", boards(false), boards(true));
    expect(ms).toBeLessThan(bound);
    expect(list.truncated).toBe(true);
    expect(list.items).toHaveLength(CHANGE_LIMITS.maxItems);
    expectBoardEdits(list.items);
  });

  it(`stops a design of ${BOARDS} changed boards at the deadline, before the item cap`, () => {
    fakeClock(10);
    const list = describeChanges("design", boards(false), boards(true));
    expect(list.truncated).toBe(true);
    expect(list.items.length).toBeLessThan(CHANGE_LIMITS.maxItems);
    expectBoardEdits(list.items);
  });

  it("names the first changed board even when the deadline has passed", () => {
    fakeClock(10 * CHANGE_LIMITS.totalMs);
    const list = describeChanges("design", boards(false), boards(true));
    expect(list.truncated).toBe(true);
    expect(list.items).toHaveLength(1);
    expectBoardEdits(list.items);
  });
});

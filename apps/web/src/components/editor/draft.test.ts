import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESCUE_REF, MAX_RESCUE_TOTAL, readRescueItems } from "../viewer/rendererProtocol.ts";
import {
  clearPageDraft,
  clearRescue,
  clearRescueStores,
  countRescue,
  loadPageDraft,
  loadRescue,
  mergeRescue,
  pageDraftKey,
  rescueKey,
  savePageDraft,
} from "./draft.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("page edits kept in sessionStorage (solo on-page editing)", () => {
  it("keeps one per artifact with the version it was edited from", () => {
    expect(savePageDraft("a1", 3, "# Page")).toBe(true);
    expect(loadPageDraft("a1")).toMatchObject({ text: "# Page", base: 3 });
    expect(loadPageDraft("a1")?.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A later save replaces it.
    savePageDraft("a1", 4, "# Page, later");
    expect(loadPageDraft("a1")).toMatchObject({ text: "# Page, later", base: 4 });
    expect(loadPageDraft("b2")).toBeNull();
    clearPageDraft("a1");
    expect(loadPageDraft("a1")).toBeNull();
  });

  it("ignores malformed copies: a base that is not a version is never used to publish", () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ text: 1, base: 3 }),
      JSON.stringify({ text: "x", base: 0 }),
      JSON.stringify({ text: "x", base: 2.5 }),
      JSON.stringify({ text: "x" }),
    ]) {
      sessionStorage.setItem(pageDraftKey("a1"), bad);
      expect(loadPageDraft("a1")).toBeNull();
    }
  });

  it("works without storage", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(savePageDraft("a1", 1, "x")).toBe(false);
    expect(loadPageDraft("a1")).toBeNull();
    expect(() => clearPageDraft("a1")).not.toThrow();
  });
});

describe("the doc frame's rescue store", () => {
  const item = (id: string, text = `text ${id}`) => ({ id, text, near: 0 });

  it("only merges: reports add or update by id, and only named ids leave", () => {
    sessionStorage.clear();
    expect(mergeRescue("u1", "art1", [item("a")], [])).toEqual(["a"]);
    // An empty report, or one naming other items, takes nothing out.
    expect(mergeRescue("u1", "art1", [], [])).toEqual(["a"]);
    expect(mergeRescue("u1", "art1", [item("b")], [])).toEqual(["a", "b"]);
    expect(mergeRescue("u1", "art1", [item("a", "new words")], [])).toEqual(["a", "b"]);
    expect(loadRescue("u1", "art1")).toEqual([item("a", "new words"), item("b")]);
    expect(mergeRescue("u1", "art1", [], ["a"])).toEqual(["b"]);
    clearRescue("u1", "art1");
    expect(sessionStorage.getItem(rescueKey("u1", "art1"))).toBeNull();
  });

  it("keeps what it has and takes the newest upserts that fit, within 20 items and 256 KiB", () => {
    sessionStorage.clear();
    mergeRescue("u1", "art1", [item("old")], []);
    const ids = mergeRescue(
      "u1",
      "art1",
      Array.from({ length: 21 }, (_, n) => item(`n${n}`)),
      [],
    );
    expect(ids).toHaveLength(20);
    expect(ids).toContain("old");
    expect(ids).toContain("n20");
    expect(ids).not.toContain("n0");
    sessionStorage.clear();
    const chunk = "y".repeat(100 * 1024);
    expect(
      mergeRescue("u1", "art1", [item("x", chunk), item("y", chunk), item("z", chunk)], []),
    ).toEqual(["z", "y"]);
  });

  it("keeps a deck item's part, slide and ref, and counts the ref against the cap", () => {
    sessionStorage.clear();
    const deck = {
      id: "d1",
      text: "abc",
      near: 4,
      part: "notes" as const,
      slide: 2,
      ref: "## Two",
    };
    expect(mergeRescue("u1", "art1", [deck], [])).toEqual(["d1"]);
    expect(readRescueItems(loadRescue("u1", "art1"))).toEqual([deck]);
    // A part that is neither a slide's nor notes, or a ref past its length, is not read.
    expect(readRescueItems([{ ...deck, part: "body" }])).toBeNull();
    expect(readRescueItems([{ ...deck, ref: "x".repeat(MAX_RESCUE_REF + 1) }])).toBeNull();
    expect(readRescueItems([{ ...deck, slide: 0 }])).toBeNull();
    // Text and refs together stay within the store's size, so what is kept always reads back.
    sessionStorage.clear();
    // Four texts that fit by themselves, but not with their refs: the newest three are kept.
    const big = (id: string) => ({
      ...deck,
      id,
      text: "y".repeat(MAX_RESCUE_TOTAL / 4 - 10),
      ref: "r".repeat(MAX_RESCUE_REF),
    });
    expect(mergeRescue("u1", "art1", ["a", "b", "c", "d"].map(big), [])).toEqual(["d", "c", "b"]);
    expect(readRescueItems(loadRescue("u1", "art1"))).toHaveLength(3);
  });

  it("leaves an update refused over the caps out of the ids it answers with, keeping the old text", () => {
    sessionStorage.clear();
    const chunk = "y".repeat(60 * 1024);
    const four = ["a", "b", "c", "d"].map((id) => item(id, chunk));
    mergeRescue("u1", "art1", [...four, item("e", "small")], []);
    // "e" grows past the 256 KiB total: refused, so its older text stays, and its id is not
    // answered as held (the frame then still offers Copy for the newer text).
    const ids = mergeRescue("u1", "art1", [item("e", "z".repeat(30 * 1024))], []);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain("e");
    expect(loadRescue("u1", "art1")).toContainEqual(item("e", "small"));
    // An update that fits is answered as held.
    expect(mergeRescue("u1", "art1", [item("e", "short")], [])).toContain("e");
  });

  it("is kept per person, counted per person once known, and cleared only by clearRescueStores", () => {
    sessionStorage.clear();
    mergeRescue("u0", "art1", [item("a")], []);
    mergeRescue("u1", "art1", [item("b"), item("c")], []);
    // Reading one account's store leaves another's alone.
    expect(loadRescue("u1", "art1")).toEqual(expect.arrayContaining([item("b"), item("c")]));
    expect(loadRescue("u0", "art1")).toEqual([item("a")]);
    expect(countRescue("art1")).toBe(3);
    expect(countRescue("art2")).toBe(0);
    // Once the session is known, only its own store counts: none when no one is signed in.
    expect(countRescue("art1", "u1")).toBe(2);
    expect(countRescue("art1", "u0")).toBe(1);
    expect(countRescue("art1", "u9")).toBe(0);
    expect(countRescue("art1", null)).toBe(0);
    expect(countRescue("art1", undefined)).toBe(3);
    // An explicit sign-out in the tab.
    clearRescueStores();
    expect(loadRescue("u0", "art1")).toBeNull();
    expect(countRescue("art1")).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

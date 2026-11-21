import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESCUE_REF, MAX_RESCUE_TOTAL, readRescueItems } from "../viewer/rendererProtocol.ts";
import {
  clearAllDrafts,
  clearDraft,
  clearPageDraft,
  clearRescue,
  clearRescueStores,
  countRescue,
  draftKey,
  listDrafts,
  loadDraft,
  loadPageDraft,
  loadRescue,
  mergeRescue,
  pageDraftKey,
  rescueKey,
  saveDraft,
  savePageDraft,
} from "./draft.ts";
import { initialState } from "./initial.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("drafts in sessionStorage", () => {
  it("keeps a draft per artifact and base version", () => {
    expect(saveDraft("a1", 3, "<p>three</p>", "note")).toBe(true);
    saveDraft("a1", 4, "<p>four</p>", "");
    saveDraft("b2", 3, "<p>other</p>", "");
    expect(Object.keys(sessionStorage)).toContain(draftKey("a1", 3));
    expect(loadDraft("a1", 3)).toMatchObject({ html: "<p>three</p>", note: "note", base: 3 });
    expect(listDrafts("a1").map((d) => d.base)).toEqual([4, 3]);
    clearDraft("a1", 4);
    expect(listDrafts("a1").map((d) => d.base)).toEqual([3]);
    clearAllDrafts("a1");
    expect(listDrafts("a1")).toEqual([]);
    expect(listDrafts("b2")).toHaveLength(1);
  });

  it("ignores malformed entries", () => {
    sessionStorage.setItem(draftKey("a1", 2), "{not json");
    sessionStorage.setItem(draftKey("a1", 5), JSON.stringify({ html: 5 }));
    sessionStorage.setItem("plinth-draft:a1:vX", JSON.stringify({ html: "x" }));
    expect(listDrafts("a1")).toEqual([]);
    expect(loadDraft("a1", 2)).toBeNull();
  });

  it("works without storage (blocked by the browser)", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(saveDraft("a1", 1, "<p>x</p>", "")).toBe(false);
    expect(loadDraft("a1", 1)).toBeNull();
    expect(listDrafts("a1")).toEqual([]);
    expect(() => clearAllDrafts("a1")).not.toThrow();
  });

  it("reports a full storage instead of throwing", () => {
    const full = {
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    } as unknown as Storage;
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(full);
    expect(saveDraft("a1", 1, "<p>x</p>", "")).toBe(false);
  });
});

describe("initialState", () => {
  const artifact = { id: "a1", version: 5, type: "html" as const, html: "<p>v5</p>" };
  const noFetch = () => Promise.reject(new Error("should not fetch"));

  it("opens the current version when no draft was kept", async () => {
    const s = await initialState(artifact, noFetch);
    expect(s).toEqual({
      html: "<p>v5</p>",
      note: "",
      base: { version: 5, html: "<p>v5</p>" },
      latest: { version: 5, html: "<p>v5</p>" },
      restored: false,
    });
  });

  it("restores a draft based on the current version", async () => {
    saveDraft("a1", 5, "<p>draft</p>", "my note");
    const s = await initialState(artifact, noFetch);
    expect(s).toMatchObject({
      html: "<p>draft</p>",
      note: "my note",
      base: { version: 5, html: "<p>v5</p>" },
      restored: true,
    });
  });

  it("keeps an older base, so saving the draft is checked against it", async () => {
    saveDraft("a1", 3, "<p>draft on v3</p>", "");
    const fetchVersion = vi.fn(async (n: number) => `<p>v${n}</p>`);
    const s = await initialState(artifact, fetchVersion);
    expect(fetchVersion).toHaveBeenCalledWith(3);
    expect(s).toMatchObject({
      html: "<p>draft on v3</p>",
      base: { version: 3, html: "<p>v3</p>" },
      latest: { version: 5, html: "<p>v5</p>" },
      restored: true,
    });
  });

  it("still keeps the old base when that version cannot be loaded", async () => {
    saveDraft("a1", 3, "<p>draft on v3</p>", "");
    const s = await initialState(artifact, () => Promise.reject(new Error("offline")));
    expect(s.base).toEqual({ version: 3, html: "" });
    expect(s.html).toBe("<p>draft on v3</p>");
  });

  it("ignores drafts for versions that do not exist", async () => {
    saveDraft("a1", 9, "<p>from the future</p>", "");
    const s = await initialState(artifact, noFetch);
    expect(s.restored).toBe(false);
    expect(s.html).toBe("<p>v5</p>");
  });
});

describe("page edits kept in sessionStorage (solo on-page editing)", () => {
  it("keeps one per artifact with the version it was edited from, apart from source drafts", () => {
    expect(savePageDraft("a1", 3, "# Page")).toBe(true);
    saveDraft("a1", 3, "<p>source</p>", "");
    expect(loadPageDraft("a1")).toMatchObject({ text: "# Page", base: 3 });
    expect(loadPageDraft("a1")?.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The source editor never lists it, and a later save replaces it.
    expect(listDrafts("a1").map((d) => d.html)).toEqual(["<p>source</p>"]);
    savePageDraft("a1", 4, "# Page, later");
    expect(loadPageDraft("a1")).toMatchObject({ text: "# Page, later", base: 4 });
    expect(loadPageDraft("b2")).toBeNull();
    clearPageDraft("a1");
    expect(loadPageDraft("a1")).toBeNull();
    expect(loadDraft("a1", 3)).not.toBeNull();
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

  it("is kept per person, counted for any person, and cleared only by clearRescueStores", () => {
    sessionStorage.clear();
    mergeRescue("u0", "art1", [item("a")], []);
    mergeRescue("u1", "art1", [item("b"), item("c")], []);
    // Reading one account's store leaves another's alone.
    expect(loadRescue("u1", "art1")).toEqual(expect.arrayContaining([item("b"), item("c")]));
    expect(loadRescue("u0", "art1")).toEqual([item("a")]);
    expect(countRescue("art1")).toBe(3);
    expect(countRescue("art2")).toBe(0);
    // An explicit sign-out in the tab.
    clearRescueStores();
    expect(loadRescue("u0", "art1")).toBeNull();
    expect(countRescue("art1")).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

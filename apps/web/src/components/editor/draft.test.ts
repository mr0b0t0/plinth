import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts, clearDraft, draftKey, listDrafts, loadDraft, saveDraft } from "./draft.ts";
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

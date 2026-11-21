// A deck's chrome: one Present control (a menu with Full screen and Presenter view, which becomes
// Audience window while presenter view is on) and, in the ⋯ menu, the print item (the frame
// prints the handout with notes from presenter view) and Download .pptx.
import { describe, expect, it, vi } from "vitest";
import { DECK_SETTINGS_LABEL, unpublishableReason } from "./deckItems.ts";
import type { StageContext } from "./stageItems.tsx";
import { presentEntries, TYPE_MENU_ITEMS } from "./stageItems.tsx";
import type { Presentation, PresentMode } from "./usePresentation.ts";

function presentation(mode: PresentMode, exporting = false) {
  return {
    available: true,
    mode,
    present: vi.fn(),
    presenterView: vi.fn(),
    openAudience: vi.fn(),
    exporting,
    exportPptx: vi.fn(),
  } as unknown as Presentation;
}

function context(mode: PresentMode, exporting = false) {
  const present = presentation(mode, exporting);
  return {
    present,
    gate: { artifact: { type: "slides" } },
    frame: null,
    config: null,
    contentOrigin: "",
  } as unknown as StageContext;
}

const labels = (entries: ReturnType<typeof presentEntries>) =>
  entries.map((e) => ("label" in e ? e.label : ""));

const deckMenu = (c: StageContext) => (TYPE_MENU_ITEMS.slides ?? []).flatMap((item) => item(c));

describe("a deck's ⋯ menu", () => {
  it("offers the print item and Download .pptx, in every mode", () => {
    for (const mode of ["off", "presenter", "audience"] as const) {
      expect(labels(deckMenu(context(mode)))).toEqual(["Print or save as PDF", "Download .pptx"]);
    }
  });

  it("asks the frame for the .pptx, and is disabled while one is being made", () => {
    const c = context("off");
    const item = deckMenu(c)[1];
    if (item && "onSelect" in item) item.onSelect?.();
    expect(c.present.exportPptx).toHaveBeenCalledTimes(1);

    const busy = deckMenu(context("off", true))[1];
    expect(busy && "label" in busy ? busy.label : "").toBe("Making the .pptx…");
    expect(busy && "disabled" in busy ? busy.disabled : false).toBe(true);
  });
});

describe("the Present control", () => {
  it("offers full screen and presenter view", () => {
    const p = presentation("off");
    const entries = presentEntries(p);
    expect(labels(entries)).toEqual(["Full screen", "Presenter view"]);
    for (const e of entries) if ("onSelect" in e) e.onSelect?.();
    expect(p.present).toHaveBeenCalledTimes(1);
    expect(p.presenterView).toHaveBeenCalledTimes(1);
  });

  it("offers the audience window in presenter view's place while it is on", () => {
    const p = presentation("presenter");
    const entries = presentEntries(p);
    expect(labels(entries)).toEqual(["Full screen", "Audience window"]);
    const audience = entries[1];
    if (audience && "onSelect" in audience) audience.onSelect?.();
    expect(p.openAudience).toHaveBeenCalledTimes(1);
  });

  it("offers full screen only in an audience window", () => {
    expect(labels(presentEntries(presentation("audience")))).toEqual(["Full screen"]);
  });
});

describe("a deck being edited on the page", () => {
  it("offers Slide size and footer… alone, which asks the frame at its exact origin to open them", () => {
    const post = vi.fn();
    const c = {
      ...context("off"),
      editing: true,
      live: { mode: "room" },
      frame: { contentWindow: { postMessage: post } },
      config: { content_isolation: "origin", content_path_fallback: false },
      contentOrigin: "http://art.content.localhost:8787",
    } as unknown as StageContext;
    const entries = deckMenu(c);
    // Print and Download .pptx wait until editing ends, as Present does: edit mode's slides
    // include empty ones the deck never shows.
    expect(labels(entries)).toEqual([DECK_SETTINGS_LABEL]);
    const item = entries[0];
    if (item && "onSelect" in item) item.onSelect?.();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deck_settings" }),
      "http://art.content.localhost:8787",
    );
    // Never to an opaque frame: there is no editing on the page there.
    post.mockClear();
    const opaque = {
      ...c,
      config: { content_isolation: "opaque", content_path_fallback: false },
    } as unknown as StageContext;
    const again = deckMenu(opaque)[0];
    if (again && "onSelect" in again) again.onSelect?.();
    expect(post).not.toHaveBeenCalled();
  });

  it("says why an empty deck's Publish is off, in the deck's words", () => {
    expect(unpublishableReason("slides")).toBe("Write something on a slide to publish");
    expect(unpublishableReason("doc")).toBeUndefined();
    expect(unpublishableReason("__proto__")).toBeUndefined();
  });
});

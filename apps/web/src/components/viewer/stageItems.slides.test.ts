// A deck's chrome: one Present control (a menu with Full screen and Presenter view, which becomes
// Audience window while presenter view is on) and, in the ⋯ menu, only the print item (the frame
// prints the handout with notes from presenter view).
import { describe, expect, it, vi } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { presentEntries, TYPE_MENU_ITEMS } from "./stageItems.tsx";
import type { Presentation, PresentMode } from "./usePresentation.ts";

function presentation(mode: PresentMode) {
  return {
    available: true,
    mode,
    present: vi.fn(),
    presenterView: vi.fn(),
    openAudience: vi.fn(),
  } as unknown as Presentation;
}

function context(mode: PresentMode) {
  const present = presentation(mode);
  return { present, frame: null, config: null, contentOrigin: "" } as unknown as StageContext;
}

const labels = (entries: ReturnType<typeof presentEntries>) =>
  entries.map((e) => ("label" in e ? e.label : ""));

describe("a deck's ⋯ menu", () => {
  it("offers only the print item, in every mode", () => {
    for (const mode of ["off", "presenter", "audience"] as const) {
      const c = context(mode);
      expect(labels((TYPE_MENU_ITEMS.slides ?? []).flatMap((item) => item(c)))).toEqual([
        "Print or save as PDF",
      ]);
    }
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

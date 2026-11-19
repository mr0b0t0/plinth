// A deck's menu items: Presenter view, which becomes Audience window while presenter view is on,
// and one print item (the frame prints the handout with notes from presenter view).
import { describe, expect, it, vi } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { TYPE_MENU_ITEMS } from "./stageItems.tsx";
import type { Presentation, PresentMode } from "./usePresentation.ts";

function context(mode: PresentMode) {
  const present = {
    available: true,
    mode,
    presenterView: vi.fn(),
    openAudience: vi.fn(),
  } as unknown as Presentation;
  return { present, frame: null, config: null, contentOrigin: "" } as unknown as StageContext;
}

const labels = (c: StageContext) =>
  (TYPE_MENU_ITEMS.slides ?? [])
    .flatMap((item) => item(c))
    .map((e) => ("label" in e ? e.label : ""));

describe("a deck's menu items", () => {
  it("offers Presenter view and one print item", () => {
    expect(labels(context("off"))).toEqual(["Presenter view", "Print or save as PDF"]);
  });

  it("offers Audience window in its place while presenter view is on", () => {
    const c = context("presenter");
    expect(labels(c)).toEqual(["Audience window", "Print or save as PDF"]);
    const [audience] = (TYPE_MENU_ITEMS.slides ?? []).flatMap((item) => item(c));
    if (audience && "onSelect" in audience) audience.onSelect?.();
    expect(c.present.openAudience).toHaveBeenCalledTimes(1);
  });

  it("offers neither in an audience window", () => {
    expect(labels(context("audience"))).toEqual(["Print or save as PDF"]);
  });
});

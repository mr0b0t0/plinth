// A whiteboard's ⋯ menu: Download as PNG and Download as SVG, which ask the frame (and only the
// frame, at the artifact's content origin) to draw the board and download it. The message names
// only a format.
import { describe, expect, it, vi } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { TYPE_MENU_ITEMS } from "./stageItems.tsx";

const ORIGIN = "http://art123.content.localhost:8787";

function context() {
  const postMessage = vi.fn();
  const c = {
    gate: { artifact: { type: "whiteboard" } },
    frame: { contentWindow: { postMessage } },
    config: { content_isolation: "origin", content_path_fallback: false },
    contentOrigin: ORIGIN,
  } as unknown as StageContext;
  return { c, postMessage };
}

describe("a whiteboard's ⋯ menu", () => {
  it("downloads the board as PNG or SVG from the frame", () => {
    const { c, postMessage } = context();
    const entries = (TYPE_MENU_ITEMS.whiteboard ?? []).flatMap((item) => item(c));
    expect(entries.map((e) => ("label" in e ? e.label : ""))).toEqual([
      "Download as PNG",
      "Download as SVG",
    ]);
    for (const e of entries) if ("onSelect" in e) e.onSelect?.();
    expect(postMessage.mock.calls).toEqual([
      [{ source: "plinth-renderer", v: 1, type: "export", format: "png" }, ORIGIN],
      [{ source: "plinth-renderer", v: 1, type: "export", format: "svg" }, ORIGIN],
    ]);
  });
});

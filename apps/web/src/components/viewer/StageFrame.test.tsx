import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { addLayer, markLoaded, StageFrame } from "./StageFrame.tsx";

afterEach(cleanup);

describe("StageFrame layers", () => {
  it("keeps the loaded frame under a new one until that one loads", () => {
    const a = [{ src: "a", loaded: true }];
    const ab = addLayer(a, "b");
    expect(ab).toEqual([
      { src: "a", loaded: true },
      { src: "b", loaded: false },
    ]);
    expect(addLayer(ab, "b")).toBe(ab);
    expect(markLoaded(ab, "b")).toEqual([{ src: "b", loaded: true }]);
    // A late load from the outgoing frame changes nothing.
    expect(markLoaded(ab, "a")).toBe(ab);
  });

  it("drops a frame that never loaded when another replaces it", () => {
    const ab = [
      { src: "a", loaded: true },
      { src: "b", loaded: false },
    ];
    expect(addLayer(ab, "c")).toEqual([
      { src: "a", loaded: true },
      { src: "c", loaded: false },
    ]);
    expect(addLayer([{ src: "a", loaded: false }], "b")).toEqual([{ src: "b", loaded: false }]);
  });
});

describe("StageFrame", () => {
  const frames = () => Array.from(document.querySelectorAll("iframe"));

  it("swaps frames without leaving an empty canvas, and shows loading meanwhile", () => {
    const props = { title: "Garden plan", loadingLabel: "Loading version 3" };
    const { rerender } = render(<StageFrame src="https://x.test/1" {...props} />);
    expect(screen.getByRole("status").textContent).toBe("Loading version 3");
    fireEvent.load(frames()[0] as HTMLIFrameElement);
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(<StageFrame src="https://x.test/2" {...props} />);
    const [outgoing, incoming] = frames() as [HTMLIFrameElement, HTMLIFrameElement];
    expect(frames()).toHaveLength(2);
    expect(outgoing.getAttribute("src")).toBe("https://x.test/1");
    expect(outgoing.hasAttribute("inert")).toBe(true);
    expect(outgoing.className).toContain("pl-viewer-frame--outgoing");
    expect(incoming.getAttribute("src")).toBe("https://x.test/2");
    expect(incoming.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Loading version 3");

    fireEvent.load(incoming);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]?.getAttribute("src")).toBe("https://x.test/2");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("hands the ref to the newest frame", () => {
    let el: HTMLIFrameElement | null = null;
    const ref = (node: HTMLIFrameElement | null) => {
      el = node;
    };
    const { rerender } = render(
      <StageFrame src="https://x.test/1" title="t" loadingLabel="l" ref={ref} />,
    );
    fireEvent.load(frames()[0] as HTMLIFrameElement);
    rerender(<StageFrame src="https://x.test/2" title="t" loadingLabel="l" ref={ref} />);
    expect((el as HTMLIFrameElement | null)?.getAttribute("src")).toBe("https://x.test/2");
  });
});

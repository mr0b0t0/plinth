import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SPLIT_MAX, SPLIT_MIN, SplitPane, splitForKey } from "./SplitPane.tsx";

afterEach(cleanup);

describe("splitForKey", () => {
  it("moves in steps and stays within the limits", () => {
    expect(splitForKey("ArrowLeft", 50)).toBe(45);
    expect(splitForKey("ArrowRight", 50)).toBe(55);
    expect(splitForKey("ArrowLeft", SPLIT_MIN)).toBe(SPLIT_MIN);
    expect(splitForKey("ArrowRight", SPLIT_MAX)).toBe(SPLIT_MAX);
    expect(splitForKey("Home", 50)).toBe(SPLIT_MIN);
    expect(splitForKey("End", 50)).toBe(SPLIT_MAX);
    expect(splitForKey("Enter", 30)).toBe(50);
    expect(splitForKey("a", 50)).toBeNull();
  });
});

describe("SplitPane", () => {
  const panes = (view: "split" | "code" | "preview") => (
    <SplitPane
      view={view}
      label="Resize code and preview"
      startId="code-pane"
      start={<p>code</p>}
      end={<p>preview</p>}
    />
  );

  it("has a keyboard-operable window splitter", () => {
    render(panes("split"));
    const sep = screen.getByRole("separator", { name: "Resize code and preview" });
    expect(sep.getAttribute("aria-valuenow")).toBe("50");
    expect(sep.getAttribute("aria-controls")).toBe("code-pane");
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(sep.getAttribute("aria-valuenow")).toBe("45");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(sep.getAttribute("aria-valuenow")).toBe(String(SPLIT_MIN));
    expect(document.getElementById("code-pane")?.style.flexBasis).toBe(`${SPLIT_MIN}%`);
    fireEvent.doubleClick(sep);
    expect(sep.getAttribute("aria-valuenow")).toBe("50");
  });

  it("shows one pane alone without a splitter", () => {
    const { rerender } = render(panes("code"));
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("preview").parentElement?.hidden).toBe(true);
    rerender(panes("preview"));
    expect(screen.getByText("code").parentElement?.hidden).toBe(true);
    expect(screen.getByText("preview").parentElement?.hidden).toBe(false);
  });
});

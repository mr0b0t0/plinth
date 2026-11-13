import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs.tsx";

afterEach(cleanup);

const TABS = [
  { id: "preview", label: "Preview", content: <p>Preview panel</p> },
  { id: "source", label: "Source", content: <p>Source panel</p> },
  { id: "settings", label: "Settings", disabled: true, content: <p>Settings panel</p> },
  { id: "history", label: "History", content: <p>History panel</p> },
];

describe("Tabs", () => {
  it("has one tab stop (roving tabindex) and a labelled panel", () => {
    render(<Tabs label="Artifact views" tabs={TABS} />);
    expect(screen.getByRole("tablist", { name: "Artifact views" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: "Preview" });
    expect(panel.textContent).toBe("Preview panel");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("moves and selects with arrow keys, skipping disabled tabs and wrapping", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Tabs label="Artifact views" tabs={TABS} onChange={onChange} />);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Preview");

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Source");
    expect(screen.getByRole("tabpanel").textContent).toBe("Source panel");
    expect(onChange).toHaveBeenLastCalledWith("source");

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("History");

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Preview");

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("History");
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("tabindex")).toBe("-1");
  });

  it("jumps with Home and End", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Artifact views" tabs={TABS} defaultValue="source" />);
    screen.getByRole("tab", { name: "Source" }).focus();
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("History");
    await user.keyboard("{Home}");
    expect(document.activeElement?.textContent).toBe("Preview");
  });

  it("Tab leaves the tab list for the panel", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Artifact views" tabs={TABS} />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});

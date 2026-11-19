// A menu item's second line (MenuEntry.description): shown under the label, read as the item's
// description and never as part of its name, for enabled and disabled items alike.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Menu } from "./Menu.tsx";

afterEach(cleanup);

/** The text an element's aria-describedby points at. */
const description = (el: HTMLElement) =>
  document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

describe("Menu item descriptions", () => {
  it("describe an item without changing its name", async () => {
    const user = userEvent.setup();
    render(
      <Menu
        label="New"
        items={[
          { label: "Document", onSelect: () => undefined },
          {
            label: "Replace with a file…",
            disabled: true,
            description: "Publish or discard the unpublished changes first",
          },
          {
            label: "Connect an agent",
            href: "/connections",
            description: "Pages come from agents.",
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New" }));
    const off = screen.getByRole("menuitem", { name: "Replace with a file…" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(description(off)).toBe("Publish or discard the unpublished changes first");
    expect(off.textContent).toContain("Publish or discard the unpublished changes first");
    const link = screen.getByRole("menuitem", { name: "Connect an agent" });
    expect(description(link)).toBe("Pages come from agents.");
    const plain = screen.getByRole("menuitem", { name: "Document" });
    expect(plain.getAttribute("aria-describedby")).toBeNull();
  });
});

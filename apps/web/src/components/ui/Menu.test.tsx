import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuEntry } from "./Menu.tsx";

afterEach(cleanup);

function setup(extra: Partial<Record<string, () => void>> = {}) {
  const items: MenuEntry[] = [
    { label: "Copy link", onSelect: extra.copy ?? (() => undefined) },
    { label: "Download HTML", onSelect: () => undefined },
    { label: "Disabled item", disabled: true },
    { label: "History", onSelect: () => undefined },
    { type: "separator" },
    { label: "Delete", danger: true, onSelect: extra.del ?? (() => undefined) },
  ];
  const user = userEvent.setup();
  render(<Menu label="Actions" items={items} />);
  const trigger = screen.getByRole("button", { name: "Actions" });
  return { user, trigger };
}

const focused = () => document.activeElement?.textContent;

describe("Menu", () => {
  it("is a menu button that opens on ArrowDown with the first item focused", async () => {
    const { user, trigger } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(screen.getAllByRole("menuitem")).toHaveLength(5);
    expect(focused()).toBe("Copy link");
  });

  it("opens on ArrowUp with the last item focused", async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe("Delete");
  });

  it("moves with arrows, skips disabled items, wraps, and jumps with Home/End", async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(focused()).toBe("Copy link");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("Download HTML");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("History");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("Delete");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("Copy link");
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe("Delete");
    await user.keyboard("{Home}");
    expect(focused()).toBe("Copy link");
    await user.keyboard("{End}");
    expect(focused()).toBe("Delete");
  });

  it("jumps by typed letters", async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard("h");
    expect(focused()).toBe("History");
    await user.keyboard("d");
    expect(focused()).toBe("Delete");
    await user.keyboard("d");
    expect(focused()).toBe("Download HTML");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("activates an item with Enter, closes, and returns focus", async () => {
    const del = vi.fn();
    const { user, trigger } = setup({ del });
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    expect(del).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a click outside", async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

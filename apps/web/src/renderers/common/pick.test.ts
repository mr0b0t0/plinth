// Picking a place for a comment while the page is edited on it: presses on the page reach no
// editor while picking, a press on a place posts it once and stops, a press where nothing can be
// pointed at goes on picking, and Esc cancels with `picked: null`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PagePick, type PagePlace } from "./pick.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function page() {
  const block = document.createElement("p");
  block.textContent = "First paragraph";
  const other = document.createElement("div");
  document.body.append(block, other);
  const post = vi.fn();
  const placeAt = (t: Element): PagePlace | null =>
    block.contains(t)
      ? { el: block, anchor: { key: "block-1", text: "First paragraph" }, what: "paragraph" }
      : null;
  const pick = new PagePick(window, { placeAt, post });
  // The editor's own handler, which a pick must keep from running.
  const editor = vi.fn();
  block.addEventListener("mousedown", editor);
  block.addEventListener("click", editor);
  return { block, other, post, pick, editor };
}

describe("PagePick", () => {
  it("posts the place pressed, once, and keeps the press from the editor", () => {
    const { block, post, pick, editor } = page();
    pick.set(true);
    expect(document.documentElement.hasAttribute("data-plinth-picking")).toBe(true);
    block.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(block.style.outline).not.toBe("");
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      type: "picked",
      anchor: { key: "block-1", text: "First paragraph" },
      what: "paragraph",
    });
    // Picking ends: the next press is the editor's again, and the outline is gone.
    expect(pick.picking).toBe(false);
    expect(block.style.outline).toBe("");
    expect(document.documentElement.hasAttribute("data-plinth-picking")).toBe(false);
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("goes on picking where nothing can be pointed at, and Esc cancels", () => {
    const { other, post, pick } = page();
    pick.set(true);
    other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(post).not.toHaveBeenCalled();
    expect(pick.picking).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(post).toHaveBeenCalledWith({ type: "picked", anchor: null });
    expect(pick.picking).toBe(false);
  });

  it("stops without a word when the app says so", () => {
    const { block, post, pick, editor } = page();
    pick.set(true);
    pick.set(false);
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(post).not.toHaveBeenCalled();
    expect(editor).toHaveBeenCalledTimes(1);
  });
});

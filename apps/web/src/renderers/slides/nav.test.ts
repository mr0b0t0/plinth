// The deck's key handling on its own: digits then Enter jump to a slide, and Enter or Space on a
// focused control is left to the control and drops the digits typed before it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindInput, DeckController, type DeckMode } from "./nav.ts";

let unbind: (() => void) | undefined;

afterEach(() => {
  unbind?.();
  unbind = undefined;
  document.body.innerHTML = "";
});

function setup(count: number) {
  document.body.innerHTML =
    '<main id="deck"><nav data-plinth-control><button type="button">Next</button></nav></main>';
  const root = document.getElementById("deck") as HTMLElement;
  const button = root.querySelector("button") as HTMLButtonElement;
  const deck = new DeckController(count);
  let mode: DeckMode = "deck";
  unbind = bindInput(window, root, deck, {
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    fullscreen: vi.fn(),
    print: vi.fn(),
    activity: vi.fn(),
    fixedOverview: false,
    columns: () => 3,
  });
  const press = (key: string, target: Element = root) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  return { deck, button, press };
}

describe("bindInput", () => {
  it("jumps to the slide typed as digits on Enter", () => {
    const { deck, press } = setup(60);
    press("4");
    press("2");
    press("Enter");
    expect(deck.current).toBe(42);
  });

  it("drops typed digits when Enter or Space acts on a focused control", () => {
    const { deck, button, press } = setup(60);
    press("5");
    // Enter on the focused Next button is the button's own; the 5 typed before it is dropped.
    expect(press("Enter", button).defaultPrevented).toBe(false);
    expect(deck.current).toBe(1);
    press("3");
    press("Enter");
    expect(deck.current).toBe(3);
    press("7");
    expect(press(" ", button).defaultPrevented).toBe(false);
    press("2");
    press("Enter");
    expect(deck.current).toBe(2);
  });
});

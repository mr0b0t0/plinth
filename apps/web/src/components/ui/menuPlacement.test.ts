import { afterEach, describe, expect, it } from "vitest";
import { MENU_GAP, MENU_MARGIN, placeMenu } from "./menuPlacement.ts";

// happy-dom has no layout: give the viewport, the trigger and the list their boxes by hand.
function setup(opts: {
  viewport?: [number, number];
  trigger: { left: number; top: number; width: number; height: number };
  list: { width: number; height: number };
}) {
  const [vw, vh] = opts.viewport ?? [1280, 720];
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: vw });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: vh });
  const trigger = document.createElement("button");
  const t = opts.trigger;
  trigger.getBoundingClientRect = () =>
    ({
      ...t,
      x: t.left,
      y: t.top,
      right: t.left + t.width,
      bottom: t.top + t.height,
    }) as DOMRect;
  const list = document.createElement("div");
  // The list's own size; once capped, its box is the cap and the rest scrolls.
  const box = () => {
    const cap = Number.parseFloat(list.style.maxHeight);
    return Number.isNaN(cap) ? opts.list.height : Math.min(cap, opts.list.height);
  };
  Object.defineProperty(list, "offsetWidth", { get: () => opts.list.width });
  Object.defineProperty(list, "offsetHeight", { get: box });
  Object.defineProperty(list, "clientHeight", { get: box });
  Object.defineProperty(list, "scrollHeight", { get: () => opts.list.height });
  document.body.append(trigger, list);
  return { trigger, list };
}

const at = (list: HTMLElement) => ({
  top: list.style.top,
  left: list.style.left,
  maxHeight: list.style.maxHeight,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("placeMenu", () => {
  it("opens below the trigger, lined up with its start or end edge", () => {
    const trigger = { left: 400, top: 100, width: 32, height: 28 };
    const list = { width: 180, height: 200 };
    const a = setup({ trigger, list });
    placeMenu(a.list, a.trigger, { align: "start", placement: "down" });
    expect(at(a.list)).toEqual({ top: `${128 + MENU_GAP}px`, left: "400px", maxHeight: "" });
    placeMenu(a.list, a.trigger, { align: "end", placement: "down" });
    expect(at(a.list)).toEqual({ top: `${128 + MENU_GAP}px`, left: "252px", maxHeight: "" });
  });

  it("opens above a trigger near the bottom of the screen instead of growing the page", () => {
    const a = setup({
      trigger: { left: 1200, top: 600, width: 28, height: 28 },
      list: { width: 180, height: 200 },
    });
    placeMenu(a.list, a.trigger, { align: "end", placement: "down" });
    expect(at(a.list)).toEqual({ top: `${600 - MENU_GAP - 200}px`, left: "1048px", maxHeight: "" });
  });

  it("opens below an upward trigger with no room above it", () => {
    const a = setup({
      trigger: { left: 8, top: 40, width: 200, height: 32 },
      list: { width: 200, height: 240 },
    });
    placeMenu(a.list, a.trigger, { align: "start", placement: "up" });
    expect(at(a.list).top).toBe(`${72 + MENU_GAP}px`);
    // With room above it opens upwards, as asked.
    const b = setup({
      trigger: { left: 8, top: 680, width: 200, height: 32 },
      list: { width: 200, height: 240 },
    });
    placeMenu(b.list, b.trigger, { align: "start", placement: "up" });
    expect(at(b.list).top).toBe(`${680 - MENU_GAP - 240}px`);
  });

  it("caps a list that fits neither way to the larger side, where it scrolls", () => {
    const a = setup({
      viewport: [360, 400],
      trigger: { left: 100, top: 150, width: 28, height: 28 },
      list: { width: 180, height: 600 },
    });
    placeMenu(a.list, a.trigger, { align: "start", placement: "down" });
    const room = 400 - MENU_MARGIN - (178 + MENU_GAP);
    expect(at(a.list)).toEqual({
      top: `${178 + MENU_GAP}px`,
      left: "100px",
      maxHeight: `${room}px`,
    });
  });

  it("slides a list back inside the side edges", () => {
    const a = setup({
      viewport: [360, 740],
      trigger: { left: 20, top: 100, width: 28, height: 28 },
      list: { width: 180, height: 200 },
    });
    placeMenu(a.list, a.trigger, { align: "end", placement: "down" });
    expect(at(a.list).left).toBe(`${MENU_MARGIN}px`);
    placeMenu(a.list, a.trigger, { align: "start", placement: "down" });
    expect(at(a.list).left).toBe("20px");
    const b = setup({
      viewport: [360, 740],
      trigger: { left: 300, top: 100, width: 28, height: 28 },
      list: { width: 180, height: 200 },
    });
    placeMenu(b.list, b.trigger, { align: "start", placement: "down" });
    expect(at(b.list).left).toBe(`${360 - MENU_MARGIN - 180}px`);
  });

  it("gives the list its trigger's width to use", () => {
    const a = setup({
      trigger: { left: 8, top: 680, width: 208, height: 32 },
      list: { width: 208, height: 200 },
    });
    placeMenu(a.list, a.trigger, { align: "start", placement: "up" });
    expect(a.list.style.getPropertyValue("--pl-menu-anchor-width")).toBe("208px");
  });
});

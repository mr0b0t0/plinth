// A design system's side of the whole-draft review (pane.ts): the site drawn read-only from one
// side's projection, with that version's files (its examples' frames and its fonts), the tokens,
// components, header and guidelines blocks that differ from the base marked, and change items that
// bring the pane to their row; a version that only spells the same JSON another way marks nothing.
import { describeChanges, designSystemToLive } from "@plinth/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CHANGED_ATTR } from "../common/review.ts";
import { systemPane } from "./pane.ts";
import { FIXTURE } from "./testFixture.ts";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures are walked by path
type Json = Record<string, any>;
const base = () => JSON.parse(JSON.stringify(FIXTURE)) as Json;
const live = (ds: Json, pretty = false) =>
  designSystemToLive(pretty ? JSON.stringify(ds, null, 2) : JSON.stringify(ds));

afterEach(() => {
  document.body.innerHTML = "";
  for (const n of document.head.querySelectorAll("link, style")) n.remove();
});

describe("the design system's review pane", () => {
  it("draws the side with its own version's files and marks what changed", () => {
    const after = base();
    after.tokens.color.bg.$value = "#fafafa";
    after.components[1].status = "deprecated";
    after.guidelines = `${after.guidelines}\n\nA new rule.`;
    const el = document.createElement("div");
    document.body.append(el);
    const goto = systemPane(document, () => "light").render(el, live(after), 6, live(base()));
    const marked = [...el.querySelectorAll(`[${CHANGED_ATTR}]`)];
    expect(marked.map((m) => m.getAttribute("data-path") ?? m.tagName)).toEqual(
      expect.arrayContaining(["color.bg", "H2", "P"]),
    );
    expect(el.querySelector('.ds-token[data-path="color.fg"]')?.hasAttribute(CHANGED_ATTR)).toBe(
      false,
    );
    // The examples' frames and the fonts come from version 6.
    const frame = el.querySelector<HTMLIFrameElement>(".ds-preview__frame");
    expect(frame?.srcdoc).toContain('<base href="/__plinth/v/6/">');
    const faces = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(faces).toContain('url("/__plinth/v/6/fonts/acme-mono.woff2")');
    // No navigation inside a pane, and no code.
    expect(el.querySelector(".ds-site--pane")).not.toBeNull();
    expect(el.querySelectorAll("pre, textarea")).toHaveLength(0);
    // A change item brings the pane to its row.
    const items = describeChanges("design_system", live(base()), live(after)).items;
    const token = items.find((i) => i.what === "color.bg changed");
    expect(token).toBeTruthy();
    expect(token && goto?.(token)).toBe(true);
  });

  it("marks nothing for a version that only spells the same JSON another way", () => {
    const el = document.createElement("div");
    systemPane(document, () => "light").render(el, live(base(), true), 7, live(base()));
    expect(el.querySelectorAll(`[${CHANGED_ATTR}]`)).toHaveLength(0);
    expect(describeChanges("design_system", live(base()), live(base(), true)).items).toEqual([]);
  });

  it("shows what an agent must fix for a side the format refuses", () => {
    const el = document.createElement("div");
    const bad = base();
    bad.tokens.color.bg.$value = "12px";
    systemPane(document, () => "light").render(el, live(bad), 7, live(base()));
    expect(el.querySelector(".ds-error p")?.textContent).toBe(
      "This design system has problems an agent needs to fix:",
    );
  });
});

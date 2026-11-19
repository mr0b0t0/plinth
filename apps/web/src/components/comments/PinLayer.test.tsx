import type { CommentInfo } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PinPosition } from "./bridge.ts";
import { buildThreads } from "./model.ts";
import { PinLayer } from "./PinLayer.tsx";

let n = 0;
function c(anchor: CommentInfo["anchor"]): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "a",
    version_number: 1,
    parent_id: null,
    author: { email: null, connection_id: null, label: "x" },
    body: "b",
    anchor,
    status: "open",
    created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    mentions: [],
    kind: "comment",
    request_data: null,
  };
}

function frame() {
  const f = document.createElement("iframe");
  f.getBoundingClientRect = () =>
    ({ top: 100, left: 50, width: 800, height: 600, right: 850, bottom: 700 }) as DOMRect;
  Object.defineProperty(f, "clientWidth", { value: 800 });
  Object.defineProperty(f, "clientHeight", { value: 600 });
  return f;
}

const at = (id: string, box: Omit<PinPosition, "id" | "visible">): [string, PinPosition] => [
  id,
  { id, ...box, visible: true },
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PinLayer", () => {
  it("puts a page anchor's pin on the reported point, or the middle of the reported box", () => {
    const point = c({ kind: "page", key: "canvas", x: 9999, y: -9999 });
    const box = c({ kind: "page", key: "node:1" });
    const el = c({ selector: "h1", x: 0.25, y: 0.5 });
    const positions = new Map([
      at(point.id, { left: 300, top: 200, width: 0, height: 0 }),
      at(box.id, { left: 100, top: 100, width: 40, height: 20 }),
      at(el.id, { left: 100, top: 300, width: 200, height: 40 }),
    ]);
    render(
      <PinLayer
        frame={frame()}
        threads={buildThreads([point, box, el])}
        positions={positions}
        activeId={null}
        panelRef={createRef()}
        onPinClick={() => undefined}
      />,
    );
    const pins = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid="comment-pins"] button'),
    ];
    // The anchor's own x/y are page coordinates, never fractions: they do not move the pin.
    expect(pins.map((p) => p.style.transform)).toEqual([
      "translate(300px, 200px)",
      "translate(120px, 110px)",
      "translate(150px, 320px)",
    ]);
    expect(pins.map((p) => p.getAttribute("aria-label"))).toEqual([
      "Comment 1: canvas",
      "Comment 2: node:1",
      "Comment 3: an element",
    ]);
    // A hover or active pin grows around its own spot, not around the layer's corner.
    expect(pins[0]?.getAttribute("style")).toContain(
      "transform-origin: calc(50% + 300px) calc(50% + 200px)",
    );
  });

  it("clamps a page anchor's pin to the frame", () => {
    const far = c({ kind: "page", key: "far" });
    render(
      <PinLayer
        frame={frame()}
        threads={buildThreads([far])}
        positions={new Map([at(far.id, { left: 5000, top: -40, width: 0, height: 0 })])}
        activeId={null}
        panelRef={createRef()}
        onPinClick={() => undefined}
      />,
    );
    const pin = document.querySelector<HTMLButtonElement>('[data-testid="comment-pins"] button');
    expect(pin?.style.transform).toBe("translate(788px, 12px)");
  });
});

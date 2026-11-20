// The people on the board: a cursor's tag and the people list show a short name (the name, or the
// email's local part) with the full one on hover, and a cursor near the viewport's right edge
// shows its tag on the pointer's left, so it never runs off the board.
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimePeer } from "./runtime.ts";
import { buildView, drawPeers, personName, placeCursorTags, shortName } from "./view.ts";

const peer = (over: Partial<RuntimePeer>): RuntimePeer => ({
  id: "p1",
  viewer: "v1",
  you: false,
  presence: {},
  ...over,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("people on the board", () => {
  it("shortens an email to its local part and keeps a name whole", () => {
    expect(shortName(peer({ email: "ben.ross@example.com" }))).toBe("ben.ross");
    expect(personName(peer({ email: "ben.ross@example.com" }))).toBe("ben.ross@example.com");
    expect(shortName(peer({ name: "Ben Ross", email: "ben@example.com" }))).toBe("Ben Ross");
    expect(shortName(peer({}))).toBe("Someone");
  });

  it("labels cursors and the people list with the short name, the full one on hover", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const v = buildView(document, root, "dots");
    drawPeers(document, v, [peer({ email: "ben.ross@example.com", presence: { x: 10, y: 20 } })], {
      x: 0,
      y: 0,
      zoom: 1,
    });
    const li = v.toolbar.people.querySelector("li");
    expect(li?.title).toBe("ben.ross@example.com");
    expect(li?.textContent).toBe("ben.ross");
    expect(root.querySelector(".wb-cursor span")?.textContent).toBe("ben.ross");
  });

  it("flips a cursor's tag to the pointer's left near the viewport's right edge", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const v = buildView(document, root, "dots");
    Object.defineProperty(v.viewport, "clientWidth", { value: 360, configurable: true });
    drawPeers(document, v, [peer({ email: "a@example.com", presence: { x: 100, y: 0 } })], {
      x: 0,
      y: 0,
      zoom: 1,
    });
    const cursor = root.querySelector(".wb-cursor");
    expect(cursor?.classList.contains("flip")).toBe(false);
    // Panned so the pointer sits 40 px from the right edge.
    placeCursorTags(v, { x: -220, y: 0, zoom: 1 });
    expect(cursor?.classList.contains("flip")).toBe(true);
  });
});

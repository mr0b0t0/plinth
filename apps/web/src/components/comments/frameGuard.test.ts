import { describe, expect, it } from "vitest";
import { acceptFrom, isExactOrigin, targetOriginFor } from "./frameGuard.ts";

const ORIGIN = "http://abc123.content.localhost:8787";

/** A frame whose window is `win` (happy-dom does not load frames). */
function frameWith(win: object | null): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => win });
  return frame;
}

describe("frame guard", () => {
  it("accepts a message only from the frame's window at the exact content origin", () => {
    const win = {};
    const accept = acceptFrom(frameWith(win), ORIGIN, false);
    expect(accept({ origin: ORIGIN, source: win as Window })).toBe(true);
    expect(accept({ origin: ORIGIN, source: {} as Window })).toBe(false);
    expect(accept({ origin: ORIGIN, source: null })).toBe(false);
    expect(accept({ origin: "null", source: win as Window })).toBe(false);
    expect(accept({ origin: "http://other.content.localhost:8787", source: win as Window })).toBe(
      false,
    );
  });

  it("checks the frame's window when the message arrives, not when the guard was made", () => {
    let win: object | null = null;
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => win });
    const accept = acceptFrom(frame, ORIGIN, false);
    expect(accept({ origin: ORIGIN, source: null })).toBe(false);
    win = {};
    expect(accept({ origin: ORIGIN, source: win as Window })).toBe(true);
  });

  it("refuses everything for an origin that is not exact", () => {
    const win = {};
    for (const bad of ["", "*", "null", `${ORIGIN}/`, `${ORIGIN}/path`, "javascript:alert(1)"]) {
      const accept = acceptFrom(frameWith(win), bad, false);
      expect(accept({ origin: bad, source: win as Window })).toBe(false);
      expect(targetOriginFor(bad, false)).toBeNull();
    }
  });

  it("under opaque isolation, takes 'null' from the frame's window and posts to '*'", () => {
    const win = {};
    const accept = acceptFrom(frameWith(win), ORIGIN, true);
    expect(accept({ origin: "null", source: win as Window })).toBe(true);
    expect(accept({ origin: ORIGIN, source: win as Window })).toBe(false);
    expect(accept({ origin: "null", source: {} as Window })).toBe(false);
    expect(targetOriginFor(ORIGIN, true)).toBe("*");
    expect(targetOriginFor("", true)).toBeNull();
    expect(acceptFrom(frameWith(win), "", true)({ origin: "null", source: win as Window })).toBe(
      false,
    );
  });

  it("posts to the exact content origin under origin isolation", () => {
    expect(targetOriginFor(ORIGIN, false)).toBe(ORIGIN);
    expect(isExactOrigin(ORIGIN)).toBe(true);
  });
});

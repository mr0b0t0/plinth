import { afterEach, describe, expect, it, vi } from "vitest";
import { postPrint, printMessage, rendererTargetOrigin } from "./rendererProtocol.ts";
import { CONFIG } from "./test-utils.ts";

const ORIGIN = "http://art123.content.localhost:8787";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer protocol", () => {
  it("builds the print message the doc renderer accepts", () => {
    expect(printMessage()).toEqual({ source: "plinth-renderer", v: 1, type: "print" });
  });

  it("addresses the exact content origin under origin isolation", () => {
    expect(rendererTargetOrigin(CONFIG, ORIGIN)).toBe(ORIGIN);
    // Before the config has loaded the default (origin) mode applies.
    expect(rendererTargetOrigin(null, ORIGIN)).toBe(ORIGIN);
  });

  it("posts to '*' under opaque isolation and the path fallback, whose frames are 'null'", () => {
    expect(rendererTargetOrigin({ ...CONFIG, content_isolation: "opaque" }, ORIGIN)).toBe("*");
    expect(
      rendererTargetOrigin(
        { ...CONFIG, content_path_fallback: true, content_isolation: "opaque" },
        CONFIG.app_origin,
      ),
    ).toBe("*");
    expect(rendererTargetOrigin({ ...CONFIG, content_path_fallback: true }, "")).toBe("*");
  });

  it("refuses to guess an origin it does not know", () => {
    expect(rendererTargetOrigin(CONFIG, "")).toBeNull();
    expect(rendererTargetOrigin(CONFIG, "null")).toBeNull();
    expect(rendererTargetOrigin(CONFIG, "*")).toBeNull();
  });

  it("posts the print message to the frame's window only", () => {
    const frame = document.createElement("iframe");
    const toFrame = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: toFrame } });
    const toApp = vi.spyOn(window, "postMessage");
    expect(postPrint(frame, ORIGIN)).toBe(true);
    expect(toFrame).toHaveBeenCalledTimes(1);
    expect(toFrame).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "print" },
      ORIGIN,
    );
    expect(toApp).not.toHaveBeenCalled();
  });

  it("does nothing without a frame or a target", () => {
    expect(postPrint(null, ORIGIN)).toBe(false);
    const frame = document.createElement("iframe");
    const toFrame = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: toFrame } });
    expect(postPrint(frame, null)).toBe(false);
    expect(toFrame).not.toHaveBeenCalled();
  });
});

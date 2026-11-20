// What the editor preview keeps while a draft has problems: the last draft without any, or
// nothing when the draft has never had none.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLastValid } from "./useLastValid.ts";

describe("useLastValid", () => {
  it("has nothing to keep when the draft is invalid on first load", () => {
    const { result, rerender } = renderHook(({ text, valid }) => useLastValid(text, valid), {
      initialProps: { text: "{ broken", valid: false },
    });
    expect(result.current).toBeNull();
    rerender({ text: "{ still broken", valid: false });
    expect(result.current).toBeNull();
  });

  it("follows a valid draft and keeps the last valid one while the draft is invalid", () => {
    const { result, rerender } = renderHook(({ text, valid }) => useLastValid(text, valid), {
      initialProps: { text: "{ broken", valid: false },
    });
    rerender({ text: "{}", valid: true });
    expect(result.current).toBe("{}");
    rerender({ text: "{ x", valid: false });
    expect(result.current).toBe("{}");
    rerender({ text: '{ "a": 1 }', valid: true });
    expect(result.current).toBe('{ "a": 1 }');
    rerender({ text: '{ "a": ', valid: false });
    expect(result.current).toBe('{ "a": 1 }');
  });
});

// The dictation consent dialog: armed only after a moment, focus on "Not now", no close button,
// the speech service named per browser, and the artifact's title shown as text.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationConsent } from "./DictationConsent.tsx";
import type { DictationConsentRequest } from "./useDictation.ts";
import { speechVendor, VOICE_LIMITS, vendorLine } from "./voiceProtocol.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(over: Partial<DictationConsentRequest> = {}): DictationConsentRequest {
  return {
    title: "Field notes",
    owner: "ada@example.com",
    vendor: "google",
    allow: vi.fn(),
    notNow: vi.fn(),
    dismiss: vi.fn(),
    ...over,
  };
}

describe("DictationConsent", () => {
  it("ignores clicks for a moment after it opens, and starts on Not now", () => {
    vi.useFakeTimers();
    const r = request();
    render(<DictationConsent request={r} />);
    const dialog = screen.getByRole("dialog", { name: "Allow dictation on this page?" });
    const notNow = screen.getByRole("button", { name: "Not now" });
    expect(document.activeElement).toBe(notNow);
    // Two answers only: Escape dismisses, and there is no close button.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Not now", "Allow"]);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(notNow);
    expect(r.allow).not.toHaveBeenCalled();
    expect(r.notNow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VOICE_LIMITS.dialogArmMs));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(r.allow).toHaveBeenCalledTimes(1);
    fireEvent.click(notNow);
    expect(r.notNow).toHaveBeenCalledTimes(1);
    // Escape dismisses.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(r.dismiss).toHaveBeenCalledTimes(1);
  });

  it("says who gets the words and who hears the audio; the title is text", () => {
    render(<DictationConsent request={request({ title: "<b>Notes</b>" })} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("<b>Notes</b>");
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.textContent).toContain(
      "<b>Notes</b>, by ada@example.com, gets the words you say",
    );
    expect(dialog.textContent).toContain("may save them for others with access.");
    expect(dialog.textContent).toContain("Chrome sends the audio to Google.");
  });

  it("names the speech service by browser", () => {
    expect(vendorLine("google")).toBe("Chrome sends the audio to Google.");
    expect(vendorLine("microsoft")).toBe("Edge sends the audio to Microsoft.");
    expect(vendorLine("apple")).toBe("Safari sends the audio to Apple.");
    expect(vendorLine(null)).toBe("Your browser may send the audio to its maker.");
    const brands = (list: string[]) =>
      Object.defineProperty(navigator, "userAgentData", {
        value: { brands: list.map((brand) => ({ brand })) },
        configurable: true,
      });
    brands(["Chromium", "Google Chrome"]);
    expect(speechVendor()).toBe("google");
    brands(["Chromium", "Microsoft Edge"]);
    expect(speechVendor()).toBe("microsoft");
    brands(["Chromium"]);
    expect(speechVendor()).toBeNull();
    Object.defineProperty(navigator, "userAgentData", { value: undefined, configurable: true });
    vi.stubGlobal("webkitSpeechRecognition", class {});
    expect(speechVendor()).toBe("apple");
  });

  it("renders nothing without a request", () => {
    render(<DictationConsent request={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

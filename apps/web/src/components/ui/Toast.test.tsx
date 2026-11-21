import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.tsx";
import { clearToasts, TOAST_PAUSE_MAX_MS, Toaster, useToast } from "./Toast.tsx";

afterEach(() => {
  act(() => clearToasts());
  cleanup();
  vi.useRealTimers();
});

function Raise() {
  const toast = useToast();
  return (
    <>
      <Button onClick={() => toast.success("Link copied")}>Copy</Button>
      <Button onClick={() => toast.error("Could not save", "Version 8 was published first.")}>
        Save
      </Button>
      <Button onClick={() => toast.toast({ title: "Pinned", duration: 0 })}>Pin</Button>
    </>
  );
}

describe("Toast", () => {
  it("announces in a polite live region that exists before any toast", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Raise />
      </>,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(status.textContent).toContain("Link copied");
  });

  it("puts errors in the assertive region", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Raise />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not save");
    expect(alert.textContent).toContain("Version 8 was published first.");
  });

  it("dismisses on its button", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Raise />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await user.click(screen.getByRole("button", { name: "Dismiss: Pinned" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("hides by itself after its duration", () => {
    vi.useFakeTimers();
    render(
      <>
        <Toaster />
        <Raise />
      </>,
    );
    act(() => screen.getByRole("button", { name: "Copy" }).click());
    expect(screen.getByRole("status").textContent).toContain("Link copied");
    act(() => {
      vi.advanceTimersByTime(4800);
    });
    expect(screen.getByRole("status").textContent).toContain("Link copied");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("a pointer left resting on a toast holds it only for a while, and it stays dismissible", () => {
    vi.useFakeTimers();
    render(
      <>
        <Toaster />
        <Raise />
      </>,
    );
    act(() => screen.getByRole("button", { name: "Copy" }).click());
    const toast = screen.getByText("Link copied").closest(".pl-toast") as HTMLElement;
    act(() => {
      toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_PAUSE_MAX_MS - 100);
    });
    // Held while the pointer rests on it...
    expect(screen.getByRole("status").textContent).toContain("Link copied");
    expect(screen.getByRole("button", { name: "Dismiss: Link copied" })).toBeTruthy();
    // ...but not for good: its own time runs once the hold is used up.
    act(() => {
      vi.advanceTimersByTime(5400);
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("renders once even when two toasters are mounted", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Toaster />
        <Raise />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getAllByText("Link copied")).toHaveLength(1);
  });
});

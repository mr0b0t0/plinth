import { CopyIcon } from "@phosphor-icons/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button.tsx";
import { Tooltip } from "./Tooltip.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tooltip", () => {
  it("describes its trigger with aria-describedby", () => {
    render(
      <Tooltip content="Anyone with the link can open it.">
        <Button>Unlisted</Button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Unlisted" });
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const tip = document.getElementById(id ?? "");
    expect(tip?.getAttribute("role")).toBe("tooltip");
    expect(tip?.textContent).toBe("Anyone with the link can open it.");
    expect(tip?.hidden).toBe(true);
  });

  it("does not repeat an icon button's own name as its description", () => {
    render(
      <Tooltip content="Copy link">
        <IconButton icon={CopyIcon} label="Copy link" />
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("shows on keyboard focus, hides on Escape and on blur", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip content="Anyone with the link can open it.">
          <Button>Unlisted</Button>
        </Tooltip>
        <Button>Next</Button>
      </>,
    );
    await user.tab();
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(document.activeElement?.textContent).toBe("Unlisted");
    expect(tip.hidden).toBe(false);

    await user.keyboard("{Escape}");
    expect(tip.hidden).toBe(true);

    await user.tab({ shift: true });
    await user.tab();
    expect(tip.hidden).toBe(false);
    await user.tab();
    expect(tip.hidden).toBe(true);
  });

  it("shows on hover after the delay and hides when the pointer leaves", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Copy the share link" delay={300}>
        <Button>Copy</Button>
      </Tooltip>,
    );
    const anchor = screen.getByRole("button", { name: "Copy" }).parentElement as HTMLElement;
    const tip = screen.getByRole("tooltip", { hidden: true });
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    expect(tip.hidden).toBe(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(tip.hidden).toBe(false);
    fireEvent.pointerLeave(anchor, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(tip.hidden).toBe(true);
  });
});

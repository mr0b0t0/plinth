// PresentStrip: presenter view says when a newer version was published and offers to show it,
// except on a permanent version link, which never moves to another version.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresentStrip } from "./PresentStrip.tsx";
import type { Presentation } from "./usePresentation.ts";

afterEach(cleanup);

const presenting = (over: Partial<Presentation> = {}): Presentation => ({
  available: true,
  pinned: false,
  slide: 3,
  count: 8,
  mode: "presenter",
  fullscreen: false,
  pause: "present",
  present: vi.fn(),
  presenterView: vi.fn(),
  exit: vi.fn(),
  openAudience: vi.fn(),
  print: vi.fn(),
  ...over,
});

describe("PresentStrip", () => {
  it("offers a newer version while presenting the current one", async () => {
    const onShowNewer = vi.fn();
    render(
      <PresentStrip
        present={presenting()}
        version={4}
        currentVersion={5}
        onShowNewer={onShowNewer}
      />,
    );
    expect(screen.getByLabelText("Presenter view").textContent).toContain("v5 was published");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(onShowNewer).toHaveBeenCalledOnce();
  });

  it("says nothing about newer versions on a permanent version link", () => {
    render(
      <PresentStrip
        present={presenting({ pinned: true })}
        version={2}
        currentVersion={5}
        onShowNewer={vi.fn()}
      />,
    );
    const strip = screen.getByLabelText("Presenter view");
    expect(strip.textContent).toContain("Slide 3 of 8");
    expect(strip.textContent).not.toContain("was published");
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.getByRole("button", { name: "Audience window" })).toBeTruthy();
  });
});

// The review of a sheet's page edits beside a version published meanwhile (#36): both sheets
// whole, the cells each side changed since the base marked, and exactly two choices. "Discard
// mine" asks once more in place (the button becomes the confirmation, no second dialog); closing
// the dialog keeps the draft (nothing is called).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LiveSheetReview from "./LiveSheetReview.tsx";

afterEach(cleanup);

const HEADER =
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"}]}';
const BASE = [HEADER, '["Apples",3]', '["Pears",5]'].join("\n");
const MINE = [HEADER, '["Apples",4]', '["Pears",5]'].join("\n");
// v6 adds a row whose text looks like markup.
const V6 = [HEADER, '["Apples",3]', '["Pears",5]', '["<img src=x onerror=alert(1)>",1]'].join("\n");

function setup(mode: "room" | "solo" = "room") {
  const p = {
    onClose: vi.fn(),
    onPublishMine: vi.fn(),
    onDiscardMine: vi.fn(),
  };
  render(
    <LiveSheetReview
      conflict={{ draft: MINE, base: 5, current: 6, currentText: V6, baseText: BASE, rev: 9 }}
      saving={false}
      mode={mode}
      {...p}
    />,
  );
  return p;
}

describe("LiveSheetReview", () => {
  it("shows both sheets whole, side by side, with the changed cells marked", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "v6 published while you edited" });
    // No subtitle and no change lists: the grids show the changes.
    expect(dialog.querySelector("ul")).toBeNull();
    const mine = screen.getByRole("region", { name: "Mine" });
    const changed = within(mine).getByRole("table").querySelectorAll("td[data-changed]");
    expect([...changed].map((td) => td.textContent)).toEqual(["4 (changed)"]);
    const theirs = screen.getByRole("region", { name: "v6" });
    const added = within(theirs).getByRole("table").querySelectorAll("td[data-changed]");
    expect([...added].map((td) => td.textContent)).toEqual([
      "<img src=x onerror=alert(1)> (changed)",
      "1 (changed)",
    ]);
    // Nothing here that a grid cannot show (rows removed, column settings), so no line under them.
    expect(dialog.querySelector(".pl-sheetreview__offgrid")).toBeNull();
    // Cell text is text, never markup.
    expect(dialog.querySelector("img")).toBeNull();
    // The phone-width switch between the two.
    expect(screen.getByRole("radio", { name: "Mine" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "v6" })).toBeTruthy();
  });

  it("has exactly two choices: Publish mine at once, Discard mine on a second press", async () => {
    const p = setup();
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    const named = buttons.map((b) => b.textContent?.trim()).filter(Boolean);
    expect(named).toEqual(expect.arrayContaining(["Discard mine", "Publish mine"]));
    expect(named).not.toContain("Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Publish mine" }));
    expect(p.onPublishMine).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    // No dialog over the dialog: the button itself asks.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(p.onDiscardMine).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard for everyone" }));
    expect(p.onDiscardMine).toHaveBeenCalledTimes(1);
  });

  it("asks a solo editor to confirm their own discard", async () => {
    const p = setup("solo");
    await userEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
    expect(p.onDiscardMine).toHaveBeenCalledTimes(1);
  });

  it("closing the review chooses nothing", async () => {
    const p = setup("solo");
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }),
    );
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onPublishMine).not.toHaveBeenCalled();
    expect(p.onDiscardMine).not.toHaveBeenCalled();
  });
});

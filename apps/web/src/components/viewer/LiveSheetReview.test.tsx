// The review of a sheet's page edits beside a version published meanwhile (#36): both sheets
// whole, what each side changed since the base, and exactly two choices. "Discard mine" asks
// first and names what would be lost; closing the dialog keeps the draft (nothing is called).
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
  it("shows both sheets whole, side by side, with what each side changed since the base", () => {
    setup();
    const dialog = screen.getByRole("dialog", {
      name: "v6 was published while you were editing",
    });
    expect(dialog.textContent).toContain(
      "Publish mine makes v7 without v6's changes. v6 stays in History.",
    );
    const mine = screen.getByRole("region", { name: "Mine" });
    expect(within(mine).getByText("B2: 3 → 4")).toBeTruthy();
    expect(within(mine).getByRole("table").textContent).toContain("Apples4");
    const theirs = screen.getByRole("region", { name: "v6" });
    expect(within(theirs).getByText("Row 4 added (<img src=x onerror=alert(1)>)")).toBeTruthy();
    // Cell text is text, never markup.
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(theirs).getByRole("table").textContent).toContain("<img src=x onerror=alert(1)>");
    // The phone-width switch between the two.
    expect(screen.getByRole("radio", { name: "Mine" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "v6" })).toBeTruthy();
  });

  it("has exactly two choices: Publish mine at once, Discard mine after naming what is lost", async () => {
    const p = setup();
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    const named = buttons.map((b) => b.textContent?.trim()).filter(Boolean);
    expect(named).toEqual(expect.arrayContaining(["Discard mine", "Publish mine"]));
    expect(named).not.toContain("Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Publish mine" }));
    expect(p.onPublishMine).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    const confirm = screen.getByRole("alertdialog", { name: "Discard your page changes?" });
    expect(confirm.textContent).toContain(
      "This change will be lost for everyone editing: B2: 3 → 4.",
    );
    expect(p.onDiscardMine).not.toHaveBeenCalled();
    // Backing out of the confirmation loses nothing.
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(p.onDiscardMine).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }),
    );
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

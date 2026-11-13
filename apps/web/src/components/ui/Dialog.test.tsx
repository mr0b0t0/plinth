import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.tsx";
import { ConfirmDialog, Dialog } from "./Dialog.tsx";
import { Input } from "./Field.tsx";

afterEach(cleanup);

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Rename artifact</Button>
      <Button>Outside</Button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Rename artifact"
        description="The link stays the same."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary">Rename</Button>
          </>
        }
      >
        <Input label="Title" defaultValue="Field notes" />
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("is a labelled modal dialog and moves focus to the first field", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Rename artifact" }));
    const dialog = screen.getByRole("dialog", { name: "Rename artifact" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("The link stays the same.");
    expect(document.activeElement).toBe(screen.getByLabelText("Title"));
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Rename artifact" }));
    const close = screen.getByRole("button", { name: "Close" });
    const rename = screen.getByRole("button", { name: "Rename" });

    rename.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rename);

    // Cycle all the way round without leaving the dialog.
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("makes the page behind inert while open", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Rename artifact" }));
    expect(
      container.closest("[inert]") ?? container.parentElement?.closest("[inert]"),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Rename artifact" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the close button and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Rename artifact" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("ConfirmDialog", () => {
  it("uses alertdialog for destructive actions and starts on Cancel", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        danger
        onClose={() => undefined}
        onConfirm={onConfirm}
        title="Revoke this connection?"
        confirmLabel="Revoke connection"
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Revoke this connection?" });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Revoke connection" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

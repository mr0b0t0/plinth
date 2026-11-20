// Board settings: the dialog reads the current version's settings, saves the two choices as
// board.json against that version, and after a 409 shows the newer version's settings, says so and
// tells the page (onNewer), saving nothing until the person saves again.
import { boardSettingsText, type ErrorCode } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { BoardSettingsDialog } from "./BoardSettingsDialog.tsx";
import { conflictNotice, newerVersion, settingsBody, settingsNote } from "./boardSettings.ts";
import { apiError, type Call, json, stubApi } from "./test-utils.ts";

const detail = (version: number, content: string) => ({
  id: "wb1",
  slug: "launch-board",
  title: "Launch board",
  type: "whiteboard",
  version,
  current_version: version,
  content,
});

const DOTS_COMMENTERS = '{\n  "v": 1,\n  "background": "dots",\n  "edit": "commenters"\n}\n';
const GRID_EDITORS = '{\n  "v": 1,\n  "background": "grid",\n  "edit": "editors"\n}\n';

function setup(handle: (c: Call) => Response | undefined, { strict = false } = {}) {
  const api = stubApi({ handle });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onNewer = vi.fn();
  const tree = (
    <>
      <BoardSettingsDialog artifactId="wb1" onClose={onClose} onSaved={onSaved} onNewer={onNewer} />
      <Toaster />
    </>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...api, onClose, onSaved, onNewer };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("board settings helpers", () => {
  it("serializes the two choices as Plinth's board.json, against the version read", () => {
    const before = { v: 1, background: "dots", edit: "commenters" } as const;
    const after = { v: 1, background: "grid", edit: "editors" } as const;
    expect(settingsBody(before, after, 4)).toEqual({
      content: boardSettingsText(after),
      base_version: 4,
      note: "Board settings: background grid, editors only",
    });
    expect(JSON.parse(settingsBody(before, after, 4).content)).toEqual({
      v: 1,
      background: "grid",
      edit: "editors",
    });
    expect(settingsNote(after, { ...after, edit: "commenters" })).toBe(
      "Board settings: commenters and editors",
    );
    expect(settingsNote(after, after)).toBe("Board settings");
    expect(conflictNotice(5)).toBe("v5 was published meanwhile. These are its settings.");
  });

  it("counts only the stale-version 409 as a conflict: code conflict, no reason, a newer version", () => {
    const refusal = (details: unknown, code: ErrorCode = "conflict", status = 409) => ({
      status,
      code,
      details,
    });
    expect(newerVersion(refusal({ current_version: 5 }), 3)).toBe(5);
    expect(newerVersion(refusal({ current_version: 3 }), 3)).toBeNull();
    expect(newerVersion(refusal({ current_version: "5" }), 3)).toBeNull();
    expect(newerVersion(refusal({ reason: "attempt_expired" }), 3)).toBeNull();
    expect(newerVersion(refusal(undefined), 3)).toBeNull();
    // A 409 of another kind names its reason, even when it also carries a version.
    expect(newerVersion(refusal({ current_version: 5, reason: "live_busy" }), 3)).toBeNull();
    expect(newerVersion(refusal({ current_version: 5, reason: "already_shared" }), 3)).toBeNull();
    // Another error code is never a version conflict, whatever its status or details.
    expect(newerVersion(refusal({ current_version: 5 }, "quota_exceeded"), 3)).toBeNull();
    expect(newerVersion(refusal({ current_version: 5 }, "rate_limited", 429), 3)).toBeNull();
    expect(newerVersion(refusal({ current_version: 5 }, "conflict", 400), 3)).toBeNull();
  });
});

describe("BoardSettingsDialog", () => {
  it("shows the current settings, and Save publishes the change with base_version", async () => {
    const user = userEvent.setup();
    const { calls, onSaved } = setup((c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1")
        return json(detail(3, DOTS_COMMENTERS));
      if (c.method === "PUT" && c.path === "/artifacts/wb1") return json({ id: "wb1", version: 4 });
      return undefined;
    });
    expect(
      ((await screen.findByRole("radio", { name: /^Dots/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: /^Commenters and editors/ }) as HTMLInputElement).checked,
    ).toBe(true);
    // Each group is one row of short labels.
    expect(
      within(screen.getByRole("group", { name: "Background" }))
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual(["Dots", "Grid", "Plain"]);
    expect(
      within(screen.getByRole("group", { name: "Who can change the board" }))
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual(["Editors only", "Commenters and editors"]);
    // No text field: only the two groups of choices.
    expect(screen.queryByRole("textbox")).toBeNull();
    // Short labels only: no sentence under a choice or under the title.
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.hasAttribute("aria-describedby")).toBe(false);
    }
    expect(document.querySelector(".pl-acct-choice__description")).toBeNull();
    expect(screen.getByRole("dialog").hasAttribute("aria-describedby")).toBe(false);
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("radio", { name: /^Grid/ }));
    await user.click(screen.getByRole("radio", { name: /^Editors only/ }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(4));
    const [put] = puts(calls);
    expect(put?.body).toEqual({
      content: boardSettingsText({ v: 1, background: "grid", edit: "editors" }),
      base_version: 3,
      note: "Board settings: background grid, editors only",
    });
    expect(put?.headers["x-plinth-csrf"]).toBe("tok-123");
    await screen.findByText("Saved as v4");
  });

  it("loads and saves under StrictMode, whose effects mount, unmount and mount again", async () => {
    // apps/web/src/main.tsx renders the app in <StrictMode>, so `pnpm dev` runs every effect's
    // cleanup once before running it again. The dialog must still apply what it reads and saves.
    const user = userEvent.setup();
    const { onSaved } = setup(
      (c) => {
        if (c.method === "GET" && c.path === "/artifacts/wb1")
          return json(detail(3, DOTS_COMMENTERS));
        if (c.method === "PUT" && c.path === "/artifacts/wb1")
          return json({ id: "wb1", version: 4 });
        return undefined;
      },
      { strict: true },
    );
    expect(
      ((await screen.findByRole("radio", { name: /^Dots/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByText("Loading the board settings")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /^Grid/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(4));
    await screen.findByText("Saved as v4");
  });

  it("on a conflict shows the newer version's settings, says so, and saves nothing more", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { calls, onSaved, onNewer } = setup((c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        reads += 1;
        return json(reads === 1 ? detail(3, DOTS_COMMENTERS) : detail(5, GRID_EDITORS));
      }
      if (c.method === "PUT") {
        return c.body && (c.body as { base_version: number }).base_version === 5
          ? json({ id: "wb1", version: 6 })
          : json(
              {
                error: {
                  code: "conflict",
                  message: "Version 3 is not current; current is 5",
                  details: { current_version: 5 },
                },
              },
              409,
            );
      }
      return undefined;
    });
    await user.click(await screen.findByRole("radio", { name: /^Plain/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("v5 was published meanwhile. These are its settings.");
    // The dialog now holds v5's values, and the person's choice is not saved behind their back.
    expect((screen.getByRole("radio", { name: /^Grid/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /^Editors only/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(puts(calls)).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
    // The page behind the dialog loads v5 too, so its version and board match the dialog.
    expect(onNewer).toHaveBeenCalledExactlyOnceWith(5);

    // Saving again goes against v5.
    await user.click(screen.getByRole("radio", { name: /^Plain/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(6));
    expect(puts(calls)[1]?.body).toMatchObject({ base_version: 5 });
  });

  it("treats a 409 that names no newer version as a failed save, not a conflict", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { calls, onSaved, onNewer } = setup((c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        reads += 1;
        return json(detail(2, DOTS_COMMENTERS));
      }
      if (c.method === "PUT") {
        // The stager's busy refusals: a conflict code, but no current_version.
        return json(
          {
            error: {
              code: "conflict",
              message: "Another version is being written; try again shortly",
              details: { reason: "busy" },
            },
          },
          409,
        );
      }
      return undefined;
    });
    await user.click(await screen.findByRole("radio", { name: /^Grid/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Another version is being written; try again shortly");
    expect(screen.queryByText(/was published meanwhile/)).toBeNull();
    // The choice stays, and Save stays on so the person can try again against the same version.
    expect((screen.getByRole("radio", { name: /^Grid/ }) as HTMLInputElement).checked).toBe(true);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(reads).toBe(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onNewer).not.toHaveBeenCalled();

    await user.click(save);
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.body).toMatchObject({ base_version: 2 });
  });

  it("shows a non-conflict 409's own message and offers no newer settings, even with a version", async () => {
    // A 409 of another kind (here `live_busy`) that also names a newer version: not a conflict.
    const user = userEvent.setup();
    let reads = 0;
    const { calls, onSaved } = setup((c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        reads += 1;
        return json(reads === 1 ? detail(3, DOTS_COMMENTERS) : detail(5, GRID_EDITORS));
      }
      if (c.method === "PUT") {
        return json(
          {
            error: {
              code: "conflict",
              message: "Someone is editing this page right now; try again when they finish",
              details: { reason: "live_busy", current_version: 5 },
            },
          },
          409,
        );
      }
      return undefined;
    });
    await user.click(await screen.findByRole("radio", { name: /^Plain/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Someone is editing this page right now; try again when they finish");
    // No conflict notice, no second read, and the person's choice stays as they left it.
    expect(screen.queryByText(/was published meanwhile/)).toBeNull();
    expect(document.querySelector(".pl-board-settings__notice")).toBeNull();
    expect(reads).toBe(1);
    expect((screen.getByRole("radio", { name: /^Plain/ }) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("radio", { name: /^Commenters and editors/ }) as HTMLInputElement).checked,
    ).toBe(true);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(onSaved).not.toHaveBeenCalled();
    // Trying again still saves against the version the dialog read, never over v5.
    await user.click(save);
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]?.body).toMatchObject({ base_version: 3 });
  });

  it("says why a save failed and keeps the choice", async () => {
    const user = userEvent.setup();
    const { onSaved } = setup((c) => {
      if (c.method === "GET") return json(detail(2, DOTS_COMMENTERS));
      if (c.method === "PUT") return apiError(403, "forbidden", "You cannot edit this artifact");
      return undefined;
    });
    await user.click(await screen.findByRole("radio", { name: /^Grid/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("You cannot edit this artifact");
    expect((screen.getByRole("radio", { name: /^Grid/ }) as HTMLInputElement).checked).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reads a stored board.json leniently, and offers a retry when it cannot load", async () => {
    const user = userEvent.setup();
    let fail = true;
    setup((c) => {
      if (c.method !== "GET") return undefined;
      if (fail) return apiError(500, "internal", "Something went wrong");
      return json(detail(1, '{"v":1}'));
    });
    await screen.findByText("Something went wrong");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    // Defaults for the keys board.json leaves out: dots, and editors only.
    expect(
      ((await screen.findByRole("radio", { name: /^Dots/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole("radio", { name: /^Editors only/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
});

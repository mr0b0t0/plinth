// "Replace with a file…" on a sheet (docs/spec.md "New and Import"): the ⋯ item for owners and
// editors on the current version, off with its reason while page changes exist or someone edits;
// the dialog confirms before sending, sends the file as it is with base_version and the note, asks
// again against a version published meanwhile (naming who published it), and shows a refusal with
// the cells it names. A file picked after that conflict is confirmed against the newer version;
// Replace waits while a draft started after the dialog opened; a person without an account is told
// to sign in instead.
import type { ViewGate } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshSession } from "../../lib/session.ts";
import { Toaster } from "../ui/index.ts";
import {
  confirmText,
  conflictText,
  ReplaceSheetDialog,
  type ReplaceSheetDialogProps,
  SIGN_IN_TEXT,
} from "./ReplaceSheetDialog.tsx";
import type { LiveFrameStatus } from "./rendererProtocol.ts";
import {
  REPLACE_BLOCKED,
  REPLACE_LABEL,
  REPLACE_SHEET_DIALOG,
  REPLACE_SIGN_IN,
  replaceSheet,
} from "./sheetReplaceItems.tsx";
import { STAGE_DIALOGS, type StageContext, TYPE_MENU_ITEMS } from "./stageItems.tsx";
import { type Call, json, ME, stubApi } from "./test-utils.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STATUS: LiveFrameStatus = {
  connected: true,
  failed: false,
  editing: false,
  holding: false,
  dirty: false,
  unflushed: false,
  rev: 1,
  base_version: 5,
  conflict_version: null,
  last_by_you: false,
  last_edit_at: null,
  editors: [],
  publishable: true,
};

function context(over: {
  role?: OkGate["role"];
  version?: number;
  current?: number;
  draft?: boolean;
  status?: LiveFrameStatus | null;
  editing?: boolean;
  signIn?: boolean;
}) {
  const openDialog = vi.fn();
  const c = {
    gate: {
      status: "ok",
      artifact: {
        id: "sheet1",
        slug: "sales",
        title: "Sales",
        type: "sheet",
        version: over.version ?? 5,
        current_version: over.current ?? 5,
      },
      role: over.role ?? "owner",
      enter_url: "",
      live: {
        mode: "room",
        ...(over.signIn ? { sign_in: true } : {}),
        draft: over.draft
          ? {
              base_version: 5,
              dirty: true,
              conflict_version: null,
              updated_at: "2026-11-19T10:00:00Z",
              updated_by_email: "ana@example.org",
            }
          : null,
      },
    },
    editing: over.editing ?? false,
    live: { status: over.status ?? null, restore: null },
    hrefs: { signIn: "/login?next=%2Fa%2Fsales" },
    actions: { openDialog, reload: vi.fn() },
  } as unknown as StageContext;
  return { c, openDialog };
}

describe("the ⋯ item", () => {
  it("is the sheet's, after its downloads and print, with its dialog in the stage", () => {
    expect(TYPE_MENU_ITEMS.sheet?.at(-1)).toBe(replaceSheet);
    expect(STAGE_DIALOGS.map((d) => d.id)).toContain(REPLACE_SHEET_DIALOG);
  });

  it("is for owners and editors on the current version, and opens the dialog", () => {
    const { c, openDialog } = context({});
    const [entry] = replaceSheet(c);
    expect(entry).toMatchObject({ label: REPLACE_LABEL, disabled: false });
    (entry as { onSelect: () => void }).onSelect();
    expect(openDialog).toHaveBeenCalledWith(REPLACE_SHEET_DIALOG);
    expect(replaceSheet(context({ role: "editor" }).c)).toHaveLength(1);
    expect(replaceSheet(context({ role: "commenter" }).c)).toEqual([]);
    expect(replaceSheet(context({ role: "viewer" }).c)).toEqual([]);
    expect(replaceSheet(context({ version: 4, current: 5 }).c)).toEqual([]);
  });

  it("is off with its reason while page changes exist or someone edits on the page", () => {
    const off = (o: Parameters<typeof context>[0]) => replaceSheet(context(o).c)[0];
    for (const o of [
      { draft: true },
      { editing: true },
      { status: { ...STATUS, dirty: true } },
      { status: { ...STATUS, editors: [{ email: "ana@example.org", block: false }] } },
      { status: { ...STATUS, conflict_version: 6 } },
    ]) {
      expect(off(o), JSON.stringify(o)).toMatchObject({
        label: REPLACE_LABEL,
        disabled: true,
        description: REPLACE_BLOCKED,
      });
    }
    expect(REPLACE_BLOCKED).toBe("Publish or discard the unpublished changes first");
    expect(off({ status: STATUS })).toMatchObject({ disabled: false });
  });

  it("is off with Sign in as its reason for an editor confirmed by code without an account", () => {
    const [entry] = replaceSheet(context({ role: "editor", signIn: true }).c);
    expect(entry).toMatchObject({
      label: REPLACE_LABEL,
      disabled: true,
      description: REPLACE_SIGN_IN,
    });
    expect(REPLACE_SIGN_IN).toBe("Sign in to replace it with a file");
  });

  it("gives the dialog the reason to wait, read from the stage on every render", () => {
    const dialog = STAGE_DIALOGS.find((d) => d.id === REPLACE_SHEET_DIALOG);
    if (!dialog) throw new Error("no Replace dialog in STAGE_DIALOGS");
    const props = (o: Parameters<typeof context>[0]) =>
      (dialog.render(context(o).c, vi.fn()) as { props: ReplaceSheetDialogProps }).props;
    expect(props({ status: STATUS })).toMatchObject({ blocked: null, mustSignIn: false });
    expect(
      props({ status: { ...STATUS, editors: [{ email: "a@b.c", block: false }] } }),
    ).toMatchObject({ blocked: REPLACE_BLOCKED });
    expect(props({ signIn: true })).toMatchObject({
      mustSignIn: true,
      signInHref: "/login?next=%2Fa%2Fsales",
    });
  });
});

function backend(
  answers: ((c: Call) => Response)[],
  versions = [{ number: 6, author: "Ana" }],
  me: typeof ME | null = ME,
) {
  let n = 0;
  return stubApi({
    me,
    handle: (c) => {
      if (c.method === "PUT" && c.path === "/artifacts/sheet1") {
        const a = answers[n++];
        return a ? a(c) : undefined;
      }
      if (c.method === "GET" && c.path === "/artifacts/sheet1/versions") {
        return json({
          items: versions.map((v) => ({
            number: v.number,
            size_bytes: 10,
            note: null,
            created_at: "2026-11-19T10:00:00Z",
            author: { kind: "user", label: v.author, user_id: null, connection_id: null },
            restored_from: null,
          })),
        });
      }
      return undefined;
    },
  });
}

const ok = (version: number) => () => json({ id: "sheet1", slug: "sales", version });
const stale = (current: number) => () =>
  json(
    {
      error: {
        code: "conflict",
        message: `Version 5 is not current; current is ${current}`,
        details: { current_version: current },
      },
    },
    409,
  );

async function open(
  onReplaced = vi.fn(),
  onClose = vi.fn(),
  extra: Partial<ReplaceSheetDialogProps> = {},
) {
  // The session (signed in, or not) as the stubbed API answers /me.
  await refreshSession();
  const tree = (more: Partial<ReplaceSheetDialogProps>) => (
    <>
      <ReplaceSheetDialog
        artifactId="sheet1"
        version={5}
        signInHref="/login?next=%2Fa%2Fsales"
        onClose={onClose}
        onReplaced={onReplaced}
        {...extra}
        {...more}
      />
      <Toaster />
    </>
  );
  const r = render(tree({}));
  return {
    onReplaced,
    onClose,
    rerender: (more: Partial<ReplaceSheetDialogProps>) => r.rerender(tree(more)),
    dialog: screen.getByRole("dialog", { name: "Replace with a file" }),
  };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

describe("the dialog", () => {
  it("confirms before sending, then sends the file as it is with base_version and the note", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const { onReplaced, dialog } = await open();
    await user.upload(
      screen.getByTestId("replace-sheet-file") as HTMLInputElement,
      new File(["Item,Qty\nApples,3\n"], "sales.csv"),
    );
    expect(await within(dialog).findByText(confirmText("sales.csv", 5))).toBeTruthy();
    expect(confirmText("sales.csv", 5)).toBe(
      "This makes v6 from sales.csv. Comments and sharing stay. v5 stays in history.",
    );
    expect(puts(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(6));
    expect(puts(calls).map((c) => c.body)).toEqual([
      {
        content_format: "csv",
        content: "Item,Qty\nApples,3\n",
        base_version: 5,
        note: "Replaced from sales.csv",
      },
    ]);
    expect(await screen.findByText("Replaced: v6 from sales.csv")).toBeTruthy();
  });

  it("asks again against a version published meanwhile, naming who published it", async () => {
    const { calls } = backend([stale(6), ok(7)]);
    const user = userEvent.setup();
    const { onReplaced, dialog } = await open();
    await user.upload(
      screen.getByTestId("replace-sheet-file") as HTMLInputElement,
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], "sales.xlsx"),
    );
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByText(conflictText(6, "Ana"))).toBeTruthy();
    expect(conflictText(6, "Ana")).toBe(
      "v6 was published by Ana since you chose the file. Replace v6 too?",
    );
    expect(onReplaced).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Replace v6" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(7));
    expect(puts(calls).map((c) => (c.body as { base_version: number }).base_version)).toEqual([
      5, 6,
    ]);
    expect(puts(calls)[1]?.body).toMatchObject({ content_format: "xlsx" });
  });

  it("confirms a file picked after a conflict against the newer version, not the one first shown", async () => {
    const { calls } = backend([stale(6), ok(7)]);
    const user = userEvent.setup();
    const { onReplaced, dialog } = await open();
    const input = screen.getByTestId("replace-sheet-file") as HTMLInputElement;
    await user.upload(input, new File(["a\n1\n"], "a.csv"));
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByText(conflictText(6, "Ana"))).toBeTruthy();
    await user.upload(input, new File(["b\n2\n"], "b.csv"));
    expect(await within(dialog).findByText(confirmText("b.csv", 6))).toBeTruthy();
    expect(confirmText("b.csv", 6)).toBe(
      "This makes v7 from b.csv. Comments and sharing stay. v6 stays in history.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(7));
    expect(puts(calls).map((c) => c.body)).toEqual([
      expect.objectContaining({ base_version: 5, note: "Replaced from a.csv" }),
      expect.objectContaining({ base_version: 6, content: "b\n2\n", note: "Replaced from b.csv" }),
    ]);
  });

  it("waits, sending nothing, when a draft started while the dialog was open", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const { onReplaced, dialog, rerender } = await open();
    await user.upload(
      screen.getByTestId("replace-sheet-file") as HTMLInputElement,
      new File(["a\n1\n"], "a.csv"),
    );
    await within(dialog).findByText(confirmText("a.csv", 5));
    rerender({ blocked: REPLACE_BLOCKED });
    const replace = within(dialog).getByRole("button", { name: "Replace" }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    expect(within(dialog).getByText(REPLACE_BLOCKED)).toBeTruthy();
    await user.click(replace);
    expect(puts(calls)).toHaveLength(0);
    // Once the changes are published or discarded, the same file goes.
    rerender({ blocked: null });
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(6));
    expect(puts(calls)).toHaveLength(1);
  });

  it("tells a person without an account to sign in, with no file picker", async () => {
    const { calls } = backend([], [], null);
    const { dialog } = await open();
    expect(within(dialog).getByText(SIGN_IN_TEXT)).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/login?next=%2Fa%2Fsales",
    );
    expect(screen.queryByTestId("replace-sheet-file")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Choose/ })).toBeNull();
    expect(puts(calls)).toHaveLength(0);
    expect(SIGN_IN_TEXT).toBe(
      "Sign in to replace this sheet with a file. Publishing a version needs an account.",
    );
  });

  it("tells the person to sign in when the save is refused for want of an account", async () => {
    backend([
      () =>
        json(
          { error: { code: "unauthorized", message: "Sign in or send a valid bearer token" } },
          401,
        ),
    ]);
    const user = userEvent.setup();
    const { dialog } = await open();
    await user.upload(
      screen.getByTestId("replace-sheet-file") as HTMLInputElement,
      new File(["a\n1\n"], "sales.csv"),
    );
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByText(SIGN_IN_TEXT)).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("shows a refusal with the cells it names, and Cancel sends nothing", async () => {
    const { calls } = backend([
      () =>
        json(
          {
            error: {
              code: "invalid_input",
              message: "This sheet has 1 problem; the first ones are listed in details.issues",
              details: {
                issues: [
                  { line: 3, cell: "B3", code: "cell", message: "B3: the text is too long" },
                ],
                count: 1,
              },
            },
          },
          400,
        ),
    ]);
    const user = userEvent.setup();
    const { onClose, dialog } = await open();
    await user.upload(
      screen.getByTestId("replace-sheet-file") as HTMLInputElement,
      new File(["a\n1\n"], "long.csv"),
    );
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("long.csv could not be used: This sheet has 1 problem");
    expect(within(alert).getByRole("listitem").textContent).toBe("B3: the text is too long");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(puts(calls)).toHaveLength(1);
  });
});

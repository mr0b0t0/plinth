// "Replace with a file…" on a sheet (docs/spec.md "New and Import"): the ⋯ item, next to Edit
// source, for owners and editors on the current version, hidden while page changes exist or
// someone edits, opens the file picker straight away; the dialog confirms the chosen file before
// sending, sends the file as it is with base_version and the note, asks again against a version
// published meanwhile (naming who published it and the file), and shows a refusal with the cells
// it names. A file picked after that conflict is confirmed against the newer version;
// Replace waits while a draft started after the dialog opened; a person without an account is told
// to sign in instead. What the import would leave out or change is listed under the confirmation;
// on a permanent version link, the page moves to the artifact's own link after the replace.
import type { ViewGate } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshSession } from "../../lib/session.ts";
import { CHOOSE_ANOTHER_LABEL, PICKER_ATTR } from "../account/newArtifact.ts";
import { Toaster } from "../ui/index.ts";
import {
  confirmText,
  conflictText,
  problemTitle,
  ReplaceSheetDialog,
  type ReplaceSheetDialogProps,
  SIGN_IN_TEXT,
} from "./ReplaceSheetDialog.tsx";
import type { LiveFrameStatus } from "./rendererProtocol.ts";
import {
  REPLACE_BLOCKED,
  REPLACE_LABEL,
  REPLACE_SHEET_DIALOG,
  replaceSheet,
} from "./sheetReplaceItems.tsx";
import { MENU_ITEMS, STAGE_DIALOGS, type StageContext, TYPE_MENU_ITEMS } from "./stageItems.tsx";
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
  pinned?: boolean;
  role?: OkGate["role"];
  version?: number;
  current?: number;
  draft?: boolean;
  status?: LiveFrameStatus | null;
  editing?: boolean;
  signIn?: boolean;
  type?: string;
}) {
  const openDialog = vi.fn();
  const c = {
    gate: {
      status: "ok",
      artifact: {
        id: "sheet1",
        slug: "sales",
        title: "Sales",
        type: over.type ?? "sheet",
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
    pinned: over.pinned ?? false,
    editing: over.editing ?? false,
    live: { status: over.status ?? null, restore: null },
    hrefs: { signIn: "/login?next=%2Fa%2Fsales", current: "/a/sales" },
    actions: { openDialog, reload: vi.fn() },
  } as unknown as StageContext;
  return { c, openDialog };
}

/** The file the picker pickSpreadsheetFile opened gives back, as a browser does on a pick. */
function pick(file: File) {
  const input = document.querySelector(`input[${PICKER_ATTR}]`);
  if (!(input instanceof HTMLInputElement)) throw new Error("no file picker open");
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
}

describe("the ⋯ item", () => {
  it("sits in Edit source's place, for sheets only, with its dialog in the stage", () => {
    const at = MENU_ITEMS.indexOf(replaceSheet);
    expect(at).toBeGreaterThan(0);
    expect(MENU_ITEMS[at - 1]?.name).toBe("editSource");
    expect(TYPE_MENU_ITEMS.sheet).not.toContain(replaceSheet);
    expect(replaceSheet(context({ type: "doc" }).c)).toEqual([]);
    expect(STAGE_DIALOGS.map((d) => d.id)).toContain(REPLACE_SHEET_DIALOG);
  });

  it("is for owners and editors on the current version, and opens the file picker first", async () => {
    stubApi({ me: ME });
    await refreshSession();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { c, openDialog } = context({});
    const [entry] = replaceSheet(c);
    expect(entry).toMatchObject({ label: REPLACE_LABEL });
    expect(entry).not.toHaveProperty("disabled");
    (entry as { onSelect: () => void }).onSelect();
    expect(click).toHaveBeenCalledTimes(1);
    expect(openDialog).not.toHaveBeenCalled();
    const input = document.querySelector(`input[${PICKER_ATTR}]`) as HTMLInputElement;
    expect(input.accept).toContain(".xlsx");
    const file = new File(["a\n1\n"], "sales.csv");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(openDialog).toHaveBeenCalledWith(REPLACE_SHEET_DIALOG);
    expect(document.querySelector(`input[${PICKER_ATTR}]`)).toBeNull();
    const dialog = STAGE_DIALOGS.find((d) => d.id === REPLACE_SHEET_DIALOG);
    if (!dialog) throw new Error("no Replace dialog in STAGE_DIALOGS");
    const props = () => (dialog.render(c, vi.fn()) as { props: ReplaceSheetDialogProps }).props;
    expect(props().file).toBe(file);
    // Closing forgets the file.
    props().onClose();
    expect(props().file).toBeNull();
    expect(replaceSheet(context({ role: "editor" }).c)).toHaveLength(1);
    expect(replaceSheet(context({ role: "commenter" }).c)).toEqual([]);
    expect(replaceSheet(context({ role: "viewer" }).c)).toEqual([]);
    expect(replaceSheet(context({ version: 4, current: 5 }).c)).toEqual([]);
  });

  it("after a replace, reloads the page, or leaves a pinned link for the artifact's own", () => {
    const dialog = STAGE_DIALOGS.find((d) => d.id === REPLACE_SHEET_DIALOG);
    if (!dialog) throw new Error("no Replace dialog in STAGE_DIALOGS");
    window.history.replaceState(null, "", "/a/sales");
    const plain = context({});
    (dialog.render(plain.c, vi.fn()) as { props: ReplaceSheetDialogProps }).props.onReplaced(6);
    expect(plain.c.actions.reload).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/a/sales");

    // /a/sales/v/5 while v5 is current: reloading it would show v5 again, so the page moves on.
    window.history.replaceState(null, "", "/a/sales/v/5");
    const pinned = context({ pinned: true });
    (dialog.render(pinned.c, vi.fn()) as { props: ReplaceSheetDialogProps }).props.onReplaced(6);
    expect(pinned.c.actions.reload).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/a/sales");
  });

  it("is hidden while page changes exist or someone edits on the page", () => {
    const items = (o: Parameters<typeof context>[0]) => replaceSheet(context(o).c);
    for (const o of [
      { draft: true },
      { editing: true },
      { status: { ...STATUS, dirty: true } },
      { status: { ...STATUS, editors: [{ email: "ana@example.org", block: false }] } },
      { status: { ...STATUS, conflict_version: 6 } },
    ]) {
      expect(items(o), JSON.stringify(o)).toEqual([]);
    }
    expect(items({ status: STATUS })).toHaveLength(1);
  });

  it("opens the sign-in step without a picker for an editor confirmed by code", async () => {
    stubApi({ me: ME });
    await refreshSession();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { c, openDialog } = context({ role: "editor", signIn: true });
    const [entry] = replaceSheet(c);
    expect(entry).toMatchObject({ label: REPLACE_LABEL });
    (entry as { onSelect: () => void }).onSelect();
    expect(click).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith(REPLACE_SHEET_DIALOG);
  });

  it("opens the sign-in step without a picker for a person without an account", async () => {
    stubApi({ me: null });
    await refreshSession();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { c, openDialog } = context({ role: "editor" });
    const [entry] = replaceSheet(c);
    (entry as { onSelect: () => void }).onSelect();
    expect(click).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith(REPLACE_SHEET_DIALOG);
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
    const { onReplaced, dialog } = await open(vi.fn(), vi.fn(), {
      file: new File(["Item,Qty\nApples,3\n"], "sales.csv"),
    });
    const sentence = await within(dialog).findByText(confirmText("sales.csv", 5));
    expect(confirmText("sales.csv", 5)).toBe("sales.csv becomes v6. v5 stays in history.");
    // The sentence is the dialog's one muted description line, with no body and no second picker.
    expect(sentence.closest(".pl-dialog__description")).toBeTruthy();
    expect(dialog.querySelector(".pl-dialog__body")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Choose/ })).toBeNull();
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
    expect(await screen.findByText("Replaced with sales.csv")).toBeTruthy();
  });

  it("asks again against a version published meanwhile, naming who published it", async () => {
    const { calls } = backend([stale(6), ok(7)]);
    const user = userEvent.setup();
    const { onReplaced, dialog } = await open(vi.fn(), vi.fn(), {
      file: new File([new Uint8Array([0x50, 0x4b, 3, 4])], "sales.xlsx"),
    });
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    const asked = await within(dialog).findByText(conflictText(6, "Ana", "sales.xlsx"));
    expect(asked.closest(".pl-dialog__description")).toBeTruthy();
    expect(conflictText(6, "Ana", "sales.csv")).toBe(
      "Ana published v6 meanwhile. Replace it with sales.csv?",
    );
    expect(conflictText(6, null, "sales.csv")).toBe(
      "v6 was published meanwhile. Replace it with sales.csv?",
    );
    expect(onReplaced).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(7));
    expect(puts(calls).map((c) => (c.body as { base_version: number }).base_version)).toEqual([
      5, 6,
    ]);
    expect(puts(calls)[1]?.body).toMatchObject({ content_format: "xlsx" });
  });

  it("confirms a file picked after a conflict against the newer version, not the one first shown", async () => {
    const refused = () =>
      json({ error: { code: "invalid_input", message: "This sheet has 1 problem" } }, 400);
    const { calls } = backend([stale(6), refused, ok(7)]);
    const user = userEvent.setup();
    const { onReplaced, dialog } = await open(vi.fn(), vi.fn(), {
      file: new File(["a\n1\n"], "a.csv"),
    });
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    expect(await within(dialog).findByText(conflictText(6, "Ana", "a.csv"))).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await within(dialog).findByRole("heading", { name: problemTitle("a.csv") });
    // "Choose another file…" opens the ⋯ item's picker, from its click.
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await user.click(within(dialog).getByRole("button", { name: CHOOSE_ANOTHER_LABEL }));
    expect(click).toHaveBeenCalledTimes(1);
    pick(new File(["b\n2\n"], "b.csv"));
    expect(document.querySelector(`input[${PICKER_ATTR}]`)).toBeNull();
    expect(await within(dialog).findByText(confirmText("b.csv", 6))).toBeTruthy();
    expect(confirmText("b.csv", 6)).toBe("b.csv becomes v7. v6 stays in history.");
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(7));
    expect(puts(calls).map((c) => c.body)).toEqual([
      expect.objectContaining({ base_version: 5, note: "Replaced from a.csv" }),
      expect.objectContaining({ base_version: 6, note: "Replaced from a.csv" }),
      expect.objectContaining({ base_version: 6, content: "b\n2\n", note: "Replaced from b.csv" }),
    ]);
  });

  it("waits, sending nothing, when a draft started while the dialog was open", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const { onReplaced, dialog, rerender } = await open(vi.fn(), vi.fn(), {
      file: new File(["a\n1\n"], "a.csv"),
    });
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
    expect(within(dialog).getByText(SIGN_IN_TEXT).closest(".pl-dialog__description")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/login?next=%2Fa%2Fsales",
    );
    expect(document.querySelector(`input[${PICKER_ATTR}]`)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Choose/ })).toBeNull();
    expect(puts(calls)).toHaveLength(0);
    expect(SIGN_IN_TEXT).toBe("Sign in to replace this sheet.");
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
    const { dialog } = await open(vi.fn(), vi.fn(), { file: new File(["a\n1\n"], "sales.csv") });
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
    const { onClose, dialog } = await open(vi.fn(), vi.fn(), {
      file: new File(["a\n1\n"], "long.csv"),
    });
    await user.click(await within(dialog).findByRole("button", { name: "Replace" }));
    // Laid out as New's Import error: the problem as the title, the cause as the description,
    // the cells in the body, and Cancel beside "Choose another file…".
    await within(dialog).findByRole("heading", { name: problemTitle("long.csv") });
    expect(problemTitle("long.csv")).toBe("Could not use long.csv");
    expect(screen.getByRole("dialog", { name: "Could not use long.csv" })).toBe(dialog);
    expect(dialog.querySelector(".pl-dialog__description")?.textContent).toBe(
      "This sheet has 1 problem; the first ones are listed in details.issues",
    );
    expect(within(dialog).getByRole("listitem").textContent).toBe("B3: the text is too long");
    expect(within(dialog).getByRole("button", { name: CHOOSE_ANOTHER_LABEL })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(puts(calls)).toHaveLength(1);
  });

  it("lists what the import would leave out or change under the confirmation, before sending", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const parts: Record<string, string> = {
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Q4" r:id="rId1"/><sheet name="Q3" r:id="rId2"/><sheet name="Q2" r:id="rId3"/><sheet name="Q1" r:id="rId4"/><sheet name="Plan" r:id="rId5"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${"Long name ".repeat(12)}</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="str"><f>WEBSERVICE("x")</f><v>a</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">1+1</f><v>2</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/><v>2</v></c></row></sheetData></worksheet>`,
    };
    const zip = zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])));
    const { dialog } = await open(vi.fn(), vi.fn(), { file: new File([zip], "sales.xlsx") });
    const sentence = await within(dialog).findByText(confirmText("sales.xlsx", 5));
    expect(sentence.closest(".pl-dialog__description")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Only the first sheet is used; “Q3”, “Q2”, “Q1” and 1 more are left out.",
      "3 formulas become plain values.",
      "1 column name is cut to 100 characters.",
    ]);
    // Said in a live region, with no button of its own: Cancel and Replace stay the choice.
    expect(within(dialog).getByRole("list").closest("[role=status]")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.anything(), "Cancel", "Replace"]);
    expect(puts(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
  });

  it("reads a CSV that is not UTF-8 as Windows-1252 and says so before sending", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const bytes = new Uint8Array([...strToU8("Item\nCaf"), 0xe9, ...strToU8("\n")]);
    const { dialog } = await open(vi.fn(), vi.fn(), { file: new File([bytes], "menu.csv") });
    await within(dialog).findByText(confirmText("menu.csv", 5));
    expect(within(dialog).getByRole("listitem").textContent).toBe(
      "The file is not UTF-8, so it is read as Windows-1252. Check accented letters.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toMatchObject({ content: "Item\nCafé\n" });
  });

  it("names the file without control or bidi characters, in the dialog and the note", async () => {
    const { calls } = backend([ok(6)]);
    const user = userEvent.setup();
    const { dialog } = await open(vi.fn(), vi.fn(), {
      file: new File(["a\n1\n"], "\u202Esales\u200E\u0000\u009B\u2069.csv"),
    });
    await within(dialog).findByText(confirmText("sales.csv", 5));
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toMatchObject({ note: "Replaced from sales.csv" });
    expect(await screen.findByText("Replaced with sales.csv")).toBeTruthy();
  });
});

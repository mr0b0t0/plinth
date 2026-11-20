// The renderer protocol's kind tables: every kind is listed once, unknown and prototype-key kinds
// are refused, and matchFrameMessage runs exactly the handler for the message's kind.
import { describe, expect, it, vi } from "vitest";
import {
  APP_MESSAGE_KINDS,
  boardExportMessage,
  collectMessage,
  editMessage,
  exportMessage,
  FRAME_MESSAGE_KINDS,
  type FrameMessage,
  gotoMessage,
  leadMessage,
  matchFrameMessage,
  pairedMessage,
  printMessage,
  readFrameMessage,
  sheetExportMessage,
  viewMessage,
} from "./rendererProtocol.ts";

const ORIGIN = "http://art123.content.localhost:8787";

function event(data: unknown) {
  const win = {} as Window;
  const frame = { contentWindow: win } as HTMLIFrameElement;
  return {
    e: { source: win, origin: ORIGIN, data },
    opts: { frame, contentOrigin: ORIGIN, solo: true, nonce: "n".repeat(16) },
  };
}

describe("renderer protocol kinds", () => {
  it("lists each kind once, at version 1", () => {
    expect([...APP_MESSAGE_KINDS]).toEqual([
      "print",
      "edit",
      "collect",
      "goto",
      "view",
      "export",
      "paired",
      "lead",
    ]);
    expect([...FRAME_MESSAGE_KINDS]).toEqual(["live", "save", "draft"]);
    expect(
      [
        printMessage(),
        editMessage(true),
        collectMessage("n".repeat(16)),
        gotoMessage(2),
        viewMessage("presenter"),
        exportMessage("n".repeat(16)),
        pairedMessage(),
        leadMessage(),
      ].map((m) => m.type),
    ).toEqual([...APP_MESSAGE_KINDS]);
    const all = [
      printMessage(),
      editMessage(false),
      collectMessage("x".repeat(16)),
      gotoMessage(1),
      viewMessage("deck"),
      exportMessage("x".repeat(16)),
      sheetExportMessage("csv"),
      boardExportMessage("png"),
      pairedMessage(),
      leadMessage(),
    ];
    for (const m of all) {
      expect(m).toMatchObject({ source: "plinth-renderer", v: 1 });
    }
  });

  it("refuses kinds that are not in the table, prototype keys included", () => {
    for (const type of ["print", "edit", "collect", "toString", "__proto__", "constructor", 1]) {
      const { e, opts } = event({ source: "plinth-renderer", v: 1, type });
      expect(readFrameMessage(e, opts)).toBeNull();
    }
  });

  it("runs only the handler for the message's kind", () => {
    const handlers = {
      live: vi.fn(() => "live"),
      save: vi.fn(() => "save"),
      draft: vi.fn(() => "draft"),
    };
    const messages: FrameMessage[] = [
      { type: "save" },
      { type: "draft", nonce: "n".repeat(16), text: "x" },
    ];
    expect(messages.map((m) => matchFrameMessage(m, handlers))).toEqual(["save", "draft"]);
    expect(handlers.live).not.toHaveBeenCalled();
    expect(handlers.save).toHaveBeenCalledTimes(1);
    expect(handlers.draft).toHaveBeenCalledWith(messages[1]);
  });
});

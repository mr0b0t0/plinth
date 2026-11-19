// The editor on a design: HTML mode with draft.html, a preview that is the design's shell around
// the draft, and the parser's problems (each with its line) before Save.
import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../viewer/test-utils.ts";
import { draftModelName, previewDocument } from "./EditorWorkspace.tsx";
import { sourceProblems } from "./sourceChecks.ts";

const DRAFT = '<!-- artboard name="Home" size="iphone" -->\n<h1>Hi</h1>';

describe("editing a design", () => {
  const def = TYPE_REGISTRY.design;

  it("edits design HTML in the HTML editor as draft.html", () => {
    expect(def.editor).toEqual({ language: "html", wordWrap: "on" });
    expect(draftModelName(def)).toBe("draft.html");
    expect(def.sourceField).toBe("content");
  });

  it("previews the design's shell with the draft, and no deck view", () => {
    const html = previewDocument(def, { id: "art123", title: "Kit", text: DRAFT, config: CONFIG });
    const p = JSON.parse(/id="__plinth-content">([^<]*)<\/script>/.exec(html)?.[1] ?? "null");
    expect(p).toMatchObject({ type: "design", path: "design.html", text: DRAFT });
    expect(p).not.toHaveProperty("view");
    expect(html).toContain('<script src="/__plinth/types/design/design.js"></script>');
  });

  it("lists the parser's problems by line before Save", () => {
    expect(sourceProblems("design", DRAFT)).toEqual([]);
    expect(sourceProblems("design", '<!-- artboard name="A" size="iphon" -->')).toEqual([
      {
        path: "line 1",
        message: expect.stringMatching(/^"iphon" is not a size preset\./),
      },
    ]);
    expect(sourceProblems("design", "<p>none</p>")).toEqual([
      { path: "design.html", message: expect.stringMatching(/^A design needs artboards/) },
    ]);
  });
});

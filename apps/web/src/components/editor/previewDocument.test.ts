// What the editor preview renders: a page's own HTML, a doc's shell as the content host serves
// it, and a deck's shell with every slide stacked (view: "overview").
import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../viewer/test-utils.ts";
import { previewDocument } from "./EditorWorkspace.tsx";
import { sourceProblems } from "./sourceChecks.ts";

const payload = (html: string) =>
  JSON.parse(/id="__plinth-content">([^<]*)<\/script>/.exec(html)?.[1] ?? "null");

describe("previewDocument", () => {
  const o = { id: "art123", title: "T", text: "# A", config: CONFIG };

  it("shows a deck as the overview and a doc as before", () => {
    expect(payload(previewDocument(TYPE_REGISTRY.slides, o))).toMatchObject({
      type: "slides",
      view: "overview",
    });
    expect(payload(previewDocument(TYPE_REGISTRY.doc, o))).not.toHaveProperty("view");
    expect(previewDocument(TYPE_REGISTRY.html, { ...o, text: "<p>x</p>" })).toBe("<p>x</p>");
  });

  it("marks a whiteboard preview so its renderer calls nothing and draws only the draft", () => {
    const html = previewDocument(TYPE_REGISTRY.whiteboard, { ...o, text: '{"v":1}' });
    expect(payload(html)).toMatchObject({ type: "whiteboard", preview: true });
    expect(html).toContain('<script src="/__plinth/runtime.js"></script>');
    expect(payload(previewDocument(TYPE_REGISTRY.doc, o))).not.toHaveProperty("preview");
    expect(previewDocument(TYPE_REGISTRY.html, { ...o, text: "<p>x</p>" })).toBe("<p>x</p>");
    expect(sourceProblems("whiteboard", '{"v":1}')).toEqual([]);
    expect(sourceProblems("whiteboard", '{"v":1,"blocks":[{"id":"a"}]}')).toEqual([
      { path: "blocks[0].kind", message: "must be one of note, text, rect, ellipse" },
    ]);
  });

  it("puts renderer URLs under the artifact in the path fallback", () => {
    const html = previewDocument(TYPE_REGISTRY.slides, {
      ...o,
      config: { ...CONFIG, content_path_fallback: true },
    });
    expect(html).toContain('<script src="/__content/art123/__plinth/types/slides/slides.js">');
  });
});

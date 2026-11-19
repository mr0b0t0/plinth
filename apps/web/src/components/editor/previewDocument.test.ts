// What the editor preview renders: a page's own HTML, a doc's shell as the content host serves
// it, and a deck's shell with every slide stacked (view: "overview").
import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../viewer/test-utils.ts";
import { previewDocument } from "./EditorWorkspace.tsx";

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

  it("puts renderer URLs under the artifact in the path fallback", () => {
    const html = previewDocument(TYPE_REGISTRY.slides, {
      ...o,
      config: { ...CONFIG, content_path_fallback: true },
    });
    expect(html).toContain('<script src="/__content/art123/__plinth/types/slides/slides.js">');
  });
});

// The registry is assembled from per-type modules (artifactTypes/<id>.ts): each row is its own
// module's export, and the renderer file list is what both the build and the content host use.
import { describe, expect, it } from "vitest";
import { design } from "../src/artifactTypes/design.ts";
import { doc } from "../src/artifactTypes/doc.ts";
import { html } from "../src/artifactTypes/html.ts";
import { slides } from "../src/artifactTypes/slides.ts";
import { ARTIFACT_TYPES, RENDERERS_DIR, rendererFiles, TYPE_REGISTRY } from "../src/index.ts";

describe("type modules", () => {
  it("builds each registry row from its own module", () => {
    expect(TYPE_REGISTRY.html).toBe(html);
    expect(TYPE_REGISTRY.doc).toBe(doc);
    expect(TYPE_REGISTRY.slides).toBe(slides);
    expect(TYPE_REGISTRY.design).toBe(design);
    expect(Object.keys(TYPE_REGISTRY)).toEqual([...ARTIFACT_TYPES]);
  });

  it("lists a renderer's script and style with the only type each may be served as", () => {
    expect(rendererFiles(TYPE_REGISTRY.html)).toEqual([]);
    expect(rendererFiles(TYPE_REGISTRY.doc)).toEqual([
      { name: "doc.js", contentType: "text/javascript" },
      { name: "doc.css", contentType: "text/css" },
    ]);
    expect(rendererFiles(TYPE_REGISTRY.slides)).toEqual([
      { name: "slides.js", contentType: "text/javascript" },
      { name: "slides.css", contentType: "text/css" },
    ]);
    for (const t of ARTIFACT_TYPES) {
      const names = rendererFiles(TYPE_REGISTRY[t]).map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(/^[a-z0-9-]+\.(js|css)$/);
    }
    expect(RENDERERS_DIR).toBe("__plinth-renderers");
  });
});

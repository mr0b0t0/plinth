// The sheet row of the type registry and its shell: the other rows and the doc shell's bytes stay
// as they are (artifactTypes.golden.test.ts); a sheet stores sheet.jsonl and takes no assets.
import { describe, expect, it } from "vitest";
import { sheet } from "../src/artifactTypes/sheet.ts";
import {
  ARTIFACT_TYPES,
  rendererFiles,
  TYPE_REGISTRY,
  TYPED_SHELL_SCRIPT_SRC,
  typeDef,
  typedShellHtml,
} from "../src/index.ts";

describe("sheet type", () => {
  it("is its own module, listed after design", () => {
    expect(ARTIFACT_TYPES.indexOf("sheet")).toBe(ARTIFACT_TYPES.indexOf("design") + 1);
    expect(TYPE_REGISTRY.sheet).toBe(sheet);
    expect(typeDef("sheet")).toBe(sheet);
  });

  it("keeps ids and source paths unique", () => {
    const ids = ARTIFACT_TYPES.map((t) => TYPE_REGISTRY[t].id);
    const paths = ARTIFACT_TYPES.map((t) => TYPE_REGISTRY[t].sourcePath);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("stores sheet.jsonl as text, reserves it, and takes no asset of any type", () => {
    const d = TYPE_REGISTRY.sheet;
    expect(d.sourcePath).toBe("sheet.jsonl");
    expect(d.sourceField).toBe("content");
    expect(d.contentType).toBe("text/plain; charset=utf-8");
    expect(d.reservedPaths).toEqual(["index.html", "sheet.jsonl"]);
    for (const t of ["", "image/png", "text/css", "text/plain", "application/octet-stream"]) {
      expect(d.assetTypes?.test(t), t).toBe(false);
    }
    expect(d.liveEdit).toBe(false);
    expect(d.editor).toEqual({ language: "plaintext", wordWrap: "off" });
    expect(rendererFiles(d)).toEqual([
      { name: "sheet.js", contentType: "text/javascript" },
      { name: "sheet.css", contentType: "text/css" },
    ]);
  });

  it("embeds the JSON lines as text in the strict shell", () => {
    const text =
      '{"plinth":"sheet","v":1,"columns":[{"name":"</script><script>x"}]}\n["<img src=x onerror=1>"]';
    const html = typedShellHtml(TYPE_REGISTRY.sheet, {
      title: "<b>Budget</b>",
      text,
      base: "",
      appOrigin: "https://app.example",
    });
    expect(
      html.startsWith(
        `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${TYPED_SHELL_SCRIPT_SRC}">`,
      ),
    ).toBe(true);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain('<main id="__plinth-sheet" class="plinth-sheet"');
    expect(html).toContain("<title>&lt;b&gt;Budget&lt;/b&gt;</title>");
    expect(html).toContain('src="/__plinth/types/sheet/sheet.js"');
  });
});

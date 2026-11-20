// The design_system row of the type registry and its shell: the doc rows and shell bytes stay as
// they are (artifactTypes.golden.test.ts), and this type's own shell embeds its JSON as text.
import { describe, expect, it } from "vitest";
import { designSystem } from "../src/artifactTypes/design_system.ts";
import {
  ARTIFACT_TYPES,
  rendererFiles,
  sourceOf,
  TYPE_REGISTRY,
  TYPED_SHELL_SCRIPT_SRC,
  typeDef,
  typedShellHtml,
} from "../src/index.ts";

describe("design_system type", () => {
  it("is its own module, listed after slides", () => {
    expect(ARTIFACT_TYPES).toEqual(["html", "doc", "slides", "design_system"]);
    expect(TYPE_REGISTRY.design_system).toBe(designSystem);
    expect(typeDef("design_system")).toBe(designSystem);
  });

  it("stores system.json, reserves index.html and takes images and fonts", () => {
    const d = TYPE_REGISTRY.design_system;
    expect(d.sourcePath).toBe("system.json");
    expect(d.sourceField).toBe("content");
    expect(d.reservedPaths).toEqual(["index.html", "system.json"]);
    for (const t of [
      "image/png",
      "image/svg+xml",
      "font/woff2",
      "font/woff",
      "font/ttf",
      "font/otf",
    ]) {
      expect(d.assetTypes?.test(t)).toBe(true);
    }
    for (const t of ["text/javascript", "text/css", "text/html", "application/json"]) {
      expect(d.assetTypes?.test(t)).toBe(false);
    }
    expect(d.liveEdit).toBe(false);
    expect(d.editor).toEqual({ language: "json", wordWrap: "off" });
    expect(rendererFiles(d)).toEqual([
      { name: "ds.js", contentType: "text/javascript" },
      { name: "ds.css", contentType: "text/css" },
    ]);
  });

  it("reads its source from content", () => {
    expect(sourceOf({ type: "design_system", content: "{}" })).toEqual({
      def: TYPE_REGISTRY.design_system,
      text: "{}",
    });
  });

  it("has a shell that loads ds.js under script-src 'self' and embeds the JSON safely", () => {
    const shell = typedShellHtml(TYPE_REGISTRY.design_system, {
      title: "Acme </title>",
      text: '{"name":"</script><script>alert(1)</script>"}',
      base: "",
      appOrigin: "https://plinth.example",
    });
    expect(
      shell.startsWith(
        `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${TYPED_SHELL_SCRIPT_SRC}">`,
      ),
    ).toBe(true);
    expect(shell).toContain('<link rel="stylesheet" href="/__plinth/types/design_system/ds.css">');
    expect(shell).toContain('<script src="/__plinth/types/design_system/ds.js"></script>');
    expect(shell).toContain('<main id="__plinth-design_system" class="plinth-design_system"');
    expect(shell).toContain("<title>Acme &lt;/title&gt;</title>");
    expect(shell).not.toContain("</script><script>alert(1)");
    const json = /<script type="application\/json" id="__plinth-content">(.*?)<\/script>/.exec(
      shell,
    )?.[1];
    expect(JSON.parse(json ?? "null")).toMatchObject({
      v: 1,
      type: "design_system",
      path: "system.json",
      text: '{"name":"</script><script>alert(1)</script>"}',
    });
  });
});

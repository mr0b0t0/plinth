// The doc renderer's prose styles moved to shared/prose.css, which doc.css imports first. The doc
// page's CSS must not change: with the import inlined and comments and whitespace collapsed,
// doc.css is the same text as before the split (its sha256 was taken from doc.css at that point).
// The built doc.css was also compared byte for byte when the split was made.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const normalize = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();

const DOC_CSS_BEFORE_SPLIT = "1937c2c27885c6d993671fd19eb5ec5159864261a11970fa3f0c9749e46cb926";

describe("shared prose styles", () => {
  it("leave the doc page's CSS as it was", () => {
    const doc = read("../doc/doc.css");
    const prose = read("./prose.css");
    const importLine = '@import "../shared/prose.css";';
    expect(doc.split(importLine)).toHaveLength(2);
    // The import comes first: nothing but the file's comment before it.
    expect(normalize(doc.slice(0, doc.indexOf(importLine)))).toBe("");
    const inlined = doc.replace(importLine, prose);
    expect(createHash("sha256").update(normalize(inlined)).digest("hex")).toBe(
      DOC_CSS_BEFORE_SPLIT,
    );
  });
});

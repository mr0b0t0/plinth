// The doc renderer's prose styles moved to shared/prose.css, which doc.css imports first. The doc
// page's reading CSS must not change: with the import inlined and comments and whitespace
// collapsed, doc.css up to its on-page editing section is the same text as before the split (its
// sha256 was taken from doc.css at that point). The built doc.css was also compared byte for byte
// when the split was made. The editing section after it belongs to on-page editing, whose look
// changes with the editor (the open block's focus mark and heading type), so it is not pinned here.
// Rules added since (narrow-window insert buttons) go below the file's "Added after the prose
// split" line, after the editing section.
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

const EDITING_SECTION = "/* ---------- On-page editing (#36)";
const DOC_READING_CSS_BEFORE_SPLIT =
  "26abf052182167c638eb9bd699775f700349ac05a0e9150a392516698ce615ac";

describe("shared prose styles", () => {
  it("leave the doc page's reading CSS as it was", () => {
    const later = "/* ---------- Added after the prose split";
    const doc = read("../doc/doc.css");
    expect(doc.split(later)).toHaveLength(2);
    expect(doc.indexOf(later)).toBeGreaterThan(doc.indexOf(EDITING_SECTION));
    const prose = read("./prose.css");
    const importLine = '@import "../shared/prose.css";';
    expect(doc.split(importLine)).toHaveLength(2);
    // The import comes first: nothing but the file's comment before it.
    expect(normalize(doc.slice(0, doc.indexOf(importLine)))).toBe("");
    const inlined = doc.replace(importLine, prose);
    const reading = inlined.slice(0, inlined.indexOf(EDITING_SECTION));
    expect(inlined.indexOf(EDITING_SECTION)).toBeGreaterThan(0);
    expect(createHash("sha256").update(normalize(reading)).digest("hex")).toBe(
      DOC_READING_CSS_BEFORE_SPLIT,
    );
  });
});

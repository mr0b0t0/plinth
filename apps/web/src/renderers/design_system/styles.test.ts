// The design system site's stylesheet starts with the shared prose styles (renderers/shared), so
// guidelines and descriptions look like a doc.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ds.css", () => {
  it("imports the shared prose styles first", () => {
    const ds = read("./ds.css");
    const at = ds.indexOf('@import "../shared/prose.css";');
    expect(at).toBeGreaterThan(-1);
    expect(
      ds
        .slice(0, at)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim(),
    ).toBe("");
  });
});

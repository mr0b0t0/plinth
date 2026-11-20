// The sheet renderer never parses data as HTML: its sources call no HTML sink at all. Every data
// string reaches the DOM through textContent (grid.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SINKS =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc)\b/;

describe("sheet renderer sources", () => {
  const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("are the files the renderer is made of", () => {
    expect(sources.sort()).toEqual([
      "boot.ts",
      "edit.ts",
      "export.ts",
      "format.ts",
      "grid.ts",
      "input.ts",
      "main.ts",
      "protocol.ts",
      "view.ts",
      "xlsx.ts",
    ]);
  });

  it("use no HTML parser or sink", () => {
    for (const f of sources) {
      expect(readFileSync(path.join(DIR, f), "utf8"), f).not.toMatch(SINKS);
    }
  });
});

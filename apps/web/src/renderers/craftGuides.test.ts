// The plinth-artifacts skill's craft guides (integrations/skill/plinth-artifacts/craft/) quote how
// the renderers draw: how far a slide's text shrinks, how tall an image under a heading is, how
// wide a sheet's default column is and that its cells do not wrap, and a board's text size and
// fit. Those numbers are pinned here, so a renderer change that makes a guide wrong fails a test.
// The format limits the guides quote are pinned in apps/worker/test/craft-guides.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TEXT_PX } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_WIDTH } from "./sheet/grid.ts";
import { FIT_STEPS } from "./slides/layout.ts";
import { fitCamera } from "./whiteboard/camera.ts";

// Vitest runs in apps/web.
const CRAFT = path.join(process.cwd(), "../../integrations/skill/plinth-artifacts/craft");
const here = path.join(process.cwd(), "src/renderers");
const read = (p: string) => readFileSync(p, "utf8");
/** A guide with its line wrapping collapsed, so a sentence matches across lines. */
const guide = (type: string) => read(path.join(CRAFT, `${type}.md`)).replace(/\s+/g, " ");
/** The declarations of one CSS rule, by its exact selector. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("the craft guides match the renderers", () => {
  it("slides: text shrinks to the last fit step, and an image under a heading is 400 px at most", () => {
    const slides = guide("slides");
    expect(slides).toContain(`down to ${Math.round((FIT_STEPS.at(-1) as number) * 100)}%`);
    expect(slides).toContain("1280 by 720 canvas (4:3 is 1024 by 768)");
    const css = read(path.join(here, "slides/slides.css"));
    expect(rule(css, ".plinth-slides__body img")).toContain("max-height: 400px");
    expect(slides).toContain("at most 400 px tall");
  });

  it("sheet: the default column width, and cells cut with an ellipsis rather than wrap", () => {
    const sheet = guide("sheet");
    expect(sheet).toContain(`A default column (${DEFAULT_WIDTH} px)`);
    const cells = rule(read(path.join(here, "sheet/sheet.css")), ".plinth-sheet__grid td");
    expect(cells).toContain("white-space: nowrap");
    expect(cells).toContain("text-overflow: ellipsis");
    expect(sheet).toContain("Cells do not wrap");
  });

  it("whiteboard: 14 px text unless a block names a size, and a board opens fitted at no more than 100%", () => {
    const wb = guide("whiteboard");
    const text = rule(read(path.join(here, "whiteboard/whiteboard.css")), ".wb-text");
    expect(text).toContain("font-size: 14px");
    expect(DEFAULT_TEXT_PX).toBe(14);
    expect(wb).toContain("Block text is 14 px unless a block names a `size`");
    // A small board is not blown up past 100%.
    expect(fitCamera({ x: 0, y: 0, w: 200, h: 140 }, 1200, 800).zoom).toBe(1);
    expect(wb).toContain("at most 100%");
    expect(read(path.join(here, "whiteboard/board.ts"))).toContain("const NARROW_MIN_FIT = 0.75;");
    expect(wb).toContain("Fit stops at 75%");
  });
});

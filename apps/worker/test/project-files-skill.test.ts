// The plinth-artifacts skill's "Project files for a page" recipe restates server behaviour, and
// docs/spec.md must say the same (AGENTS.md: the skill restates server rules, keep it in sync).
// These pins cover the parts an agent could get wrong in a way that breaks a page or exposes a
// viewer: a refresh through a bundle or CLI folder (the whole version, nothing carried forward),
// project files that Plinth would serve as page code, reference warnings on project files, and
// the one dot-segment file the recipe reads.
import { describe, expect, it } from "vitest";
import spec from "../../../docs/spec.md?raw";
import skill from "../../../integrations/skill/plinth-artifacts/SKILL.md?raw";

/** The text of one `##` section of a Markdown file, up to the next `##` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

/** Collapse Markdown line wrapping so a sentence can be matched across lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const recipe = flat(section(skill, "Project files for a page"));
const specSection = (() => {
  const start = spec.indexOf("### Project files for a page");
  expect(start).toBeGreaterThanOrEqual(0);
  return flat(spec.slice(start, spec.indexOf("\n### ", start + 1)));
})();

describe("the project files recipe (skill and spec)", () => {
  it("a bundle or CLI folder refresh holds every file the version keeps", () => {
    expect(recipe).not.toMatch(/staging folder that holds only the chosen files/);
    expect(recipe).toContain("A bundle or a folder is the whole new version and carries nothing");
    expect(recipe).toContain("it must hold the page and every file the version keeps");
    expect(specSection).toContain("is the whole new version and carries nothing forward");
    expect(specSection).toContain("holds the page and every file the version keeps");
  });

  it("page and code types go up with .txt added, never at their own extension", () => {
    for (const text of [recipe, specSection]) {
      for (const ext of [".html", ".htm", ".svg", ".xml", ".js", ".mjs", ".cjs", ".css"]) {
        expect(text, ext).toContain(`\`${ext}\``);
      }
      expect(text).toContain("`files/src/app.js.txt`");
    }
    expect(recipe).toContain("and `content_type` cannot change that");
    expect(specSection).toContain(
      "a named `content_type` applies only to extensions Plinth does not know",
    );
  });

  it("a warning on a project file never leads to reading or adding another file", () => {
    expect(recipe).toContain("Never fix it by reading or adding another file");
    expect(specSection).toContain("the agent never reads or adds another file to fix it");
  });

  it("the dot-segment rule names the record as its one exception", () => {
    expect(recipe).toContain("you read `.plinth-files.json` itself (never send it)");
    expect(specSection).toContain("The record itself is the one dot-segment file the agent reads");
  });
});

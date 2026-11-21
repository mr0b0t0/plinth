// The plinth-artifacts skill's "Project files for a page" recipe restates server behaviour, and
// docs/spec.md must say the same (AGENTS.md: the skill restates server rules, keep it in sync).
// These pins cover the parts an agent could get wrong in a way that breaks a page or exposes a
// viewer: a refresh through a bundle or CLI folder (the whole version, nothing carried forward),
// project files that Plinth would serve as page code, project files embedded in the page as JSON
// (a `</script>` in the file would end the block), reference warnings on project files, and the
// one dot-segment file the recipe reads.
import { describe, expect, it } from "vitest";
import spec from "../../../docs/spec.md?raw";
import skill from "../../../integrations/skill/plinth-artifacts/SKILL.md?raw";
import { assetContentType, contentTypeFor } from "../src/services/storage.ts";

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

  it("the .txt rule holds in any letter case, and a project file never names a type", () => {
    // contentTypeFor lowercases the extension, so app.HTML is served as HTML.
    expect(contentTypeFor("files/x/App.HTML")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("files/x/App.HTML.txt")).toBe("text/plain; charset=utf-8");
    // A named type is honoured for an extension Plinth does not know: only text/plain is safe.
    expect(assetContentType("files/src/app.ts", "application/xhtml+xml")).toBe(
      "application/xhtml+xml",
    );
    expect(assetContentType("files/src/app.ts", "text/plain")).toBe("text/plain");
    expect(recipe).toContain("Plinth serves a file by its extension, in any letter case");
    expect(recipe).toContain("and `.HTML` or `.Svg` too");
    expect(recipe).toContain(
      "Send a project file with no `content_type` or with `text/plain`, never a named type such as `application/xhtml+xml`",
    );
    expect(specSection).toContain("served by its extension, in any letter case");
    expect(specSection).toContain(
      "sends a project file with no `content_type` or with `text/plain` only, never a named type such as `application/xhtml+xml`",
    );
  });

  it("a list built from the artifact marks paths the record lacks, and who added them", () => {
    expect(recipe).toContain(
      "mark every path that is not in this artifact's entry in `.plinth-files.json`",
    );
    expect(recipe).toContain("say who added it: the author of the earliest version that has it");
    expect(specSection).toContain(
      "marks each path that is not in the local record and names who added it",
    );
  });

  it("a project file embedded as JSON has every < escaped, so </script> cannot end the block", () => {
    expect(recipe).toContain(
      'with every `<` written as `\\u003c`: `JSON.stringify(text).replace(/</g, "\\\\u003c")`',
    );
    expect(recipe).toContain("`JSON.stringify` alone leaves `</script>` as it is");
    // The opaque-instance alternative, where embedding is the only way, points at the same rule.
    expect(recipe).toContain(
      '`<script type="application/json" id="f-data">` instead, with `<` escaped as above',
    );
    // Every place the recipe or the spec says to embed a file also says to escape `<`.
    for (const text of [recipe, specSection]) {
      const embeds = text.split('`<script type="application/json"').slice(1);
      expect(embeds.length).toBeGreaterThan(0);
      for (const e of embeds) expect(e.slice(0, 80)).toContain("`<`");
    }

    // The escape the recipe gives keeps a hostile file inside the block and round-trips it.
    const file = "log: GET /?q=</script><img src=x onerror=alert(1)> <!-- </SCRIPT >";
    expect(JSON.stringify(file)).toMatch(/<\/script/i);
    const embedded = JSON.stringify(file).replace(/</g, "\\u003c");
    expect(embedded).not.toContain("<");
    expect(JSON.parse(embedded)).toBe(file);
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

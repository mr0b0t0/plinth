// The plinth-artifacts skill's craft guides (SKILL.md "Making it good (craft)", one file per
// artifact type in craft/) and the MCP lines that point at them. A type added to ARTIFACT_TYPES
// needs its guide. The guides name Plinth's real limits and choices, so the numbers and names
// they quote are pinned to the code here (the renderers' numbers in apps/web's
// craftGuides.test.ts): a guide must never teach a feature Plinth lacks.
import {
  ARTIFACT_TYPES,
  type ArtifactType,
  BLOCK_KINDS,
  BOARD_COLORS,
  DESIGN_PRESETS,
  SHEET_COLUMN_TYPES,
  SLIDE_DENSE,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import design from "../../../integrations/skill/plinth-artifacts/craft/design.md?raw";
import designSystem from "../../../integrations/skill/plinth-artifacts/craft/design_system.md?raw";
import doc from "../../../integrations/skill/plinth-artifacts/craft/doc.md?raw";
import html from "../../../integrations/skill/plinth-artifacts/craft/html.md?raw";
import sheet from "../../../integrations/skill/plinth-artifacts/craft/sheet.md?raw";
import slides from "../../../integrations/skill/plinth-artifacts/craft/slides.md?raw";
import whiteboard from "../../../integrations/skill/plinth-artifacts/craft/whiteboard.md?raw";
import skill from "../../../integrations/skill/plinth-artifacts/SKILL.md?raw";
import { CRAFT_INSTRUCTION, CRAFT_NOTE, CRAFT_UPDATE_NOTE } from "../src/mcp/notes.ts";
import { agent, mcpClient } from "./helpers.ts";

/** The guide for each type: a type added to ARTIFACT_TYPES does not compile here without one. */
const guides: Record<ArtifactType, string> = {
  html,
  doc,
  slides,
  design_system: designSystem,
  design,
  sheet,
  whiteboard,
};
const guide = (type: ArtifactType): string => guides[type];

/** Collapse Markdown line wrapping so a sentence can be matched across lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/** The text of one `##` section of SKILL.md, up to the next `##` heading. */
function section(heading: string): string {
  const start = skill.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = skill.indexOf("\n## ", start + 1);
  return skill.slice(start, next === -1 ? undefined : next);
}

describe("the craft guides", () => {
  it("there is one guide for every artifact type", () => {
    expect(Object.keys(guides).sort()).toEqual([...ARTIFACT_TYPES].sort());
    for (const type of ARTIFACT_TYPES) {
      expect(guide(type)).toMatch(/^# Craft: .+\n/);
      expect(guide(type)).toContain(`(type ${type})`);
    }
  });

  it("SKILL.md lists every guide and says where they are", () => {
    const craft = section("Making it good (craft)");
    for (const type of ARTIFACT_TYPES) expect(craft).toContain(`| \`craft/${type}.md\` |`);
    // scripts/integrations.mjs rewrites this sentence for the builds that inline the guides.
    expect(craft).toContain("The guides are files in this skill's folder, next to this one.");
  });

  it("the listings ship the guides as they are, so they name nothing outside Plinth", () => {
    for (const [type, text] of Object.entries(guides)) {
      for (const word of ["Claude", "Codex", "built-in", "/plinth:"]) {
        expect(text, `craft/${type}.md: ${word}`).not.toContain(word);
      }
    }
  });

  it("the whiteboard guide's colors, kinds and grid are the board's", () => {
    const wb = flat(guide("whiteboard"));
    expect(BOARD_COLORS).toHaveLength(6);
    expect(wb).toContain("at most four of the six colors");
    for (const named of ["green", "pink"]) expect(BOARD_COLORS).toContain(named);
    for (const kind of ["note", "text"]) expect(BLOCK_KINDS).toContain(kind);
    // The skill's placement rule and its block sizes.
    expect(flat(skill)).toContain("Place blocks on a 240 grid");
    expect(flat(skill)).toContain("A note is 200x140, a box 200x100");
    expect(wb).toContain("A note (200 by 140)");
    expect(wb).toContain("a box (200 by 100)");
    expect(wb).toContain("next multiple of 240");
  });

  it("the sheet guide's column types and widths are the format's", () => {
    const sheet = flat(guide("sheet"));
    for (const type of SHEET_COLUMN_TYPES) expect(sheet).toContain(`\`${type}\``);
    expect(sheet).toContain("between 40 and 800");
    expect(flat(skill)).toContain('any column may have `"width"` in pixels (40 to 800)');
  });

  it("the slides guide's density limit is the parser's", () => {
    const slides = flat(guide("slides"));
    expect(slides).toContain(
      `past ${SLIDE_DENSE.lines} lines or ${SLIDE_DENSE.chars} characters on a slide`,
    );
    // Today's decks are Markdown: the guide teaches no HTML or CSS of its own.
    expect(slides).not.toMatch(/<[a-z]+[\s>]/);
    expect(slides).not.toMatch(/\bstyle=|\bbackground:/);
  });

  it("the design guide names only presets that exist", () => {
    const design = guide("design");
    const named = [...design.matchAll(/`([a-z0-9-]+)`/g)]
      .map((m) => m[1] as string)
      .filter((n) => ["iphone", "android", "desktop"].includes(n));
    expect(named.length).toBeGreaterThan(0);
    for (const preset of named) expect(DESIGN_PRESETS[preset], preset).toBeDefined();
  });
});

describe("the MCP lines that point at the guides", () => {
  it("publish_artifact carries CRAFT_NOTE, update_artifact CRAFT_UPDATE_NOTE, the instructions CRAFT_INSTRUCTION", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    await client.close();
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    expect(description("publish_artifact")).toContain(CRAFT_NOTE);
    expect(description("update_artifact")).toContain(CRAFT_UPDATE_NOTE);
    expect(instructions).toContain(CRAFT_INSTRUCTION);
    expect(CRAFT_NOTE).toContain("craft/<type>.md");
    expect(CRAFT_INSTRUCTION).toContain("plinth-artifacts skill");
  });
});

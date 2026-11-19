// The golden fidelity list (doc-blocks): for every fixture of testCorpus.ts, which blocks the
// formatted-text editor edits in place, and as what, and which it shows read-only with Ask an agent
// because the model cannot hold them or would write them back differently. A change to the model
// or the serializer that changes this list shows up here. Every block marked editable round trips:
// its Markdown, written back from its model, renders exactly as the original.
import {
  blockFromSource,
  editableBlock,
  type RichBlock,
  sameBlock,
  sameRendering,
  serializeBlock,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "./blocks.ts";
import { docEnv, docMarkdownTools } from "./markdown.ts";
import { CORPUS, FEATURES } from "./testCorpus.ts";

const TOOLS = docMarkdownTools();

function describeBlock(b: RichBlock | null): string {
  if (!b) return "read-only";
  return b.t === "heading" ? `heading ${b.level}${b.setext ? " (setext)" : ""}` : b.t;
}

function fidelity(text: string) {
  const lines = text.split("\n");
  const env = docEnv(text);
  return parseBlocks(text).map((b) => {
    const core = lines.slice(b.core.start, b.core.end).join("\n");
    const model = editableBlock(core, TOOLS, env);
    if (model) {
      // What the editor would send for an unedited block renders as the original.
      const out = serializeBlock(model);
      expect(sameRendering(core, out, TOOLS.render, env), core).toBe(true);
      const again = blockFromSource(out, TOOLS.source, env);
      expect(again && sameBlock(model, again), core).toBe(true);
    }
    return `${b.core.start + 1}: ${describeBlock(model)}`;
  });
}

describe("golden fidelity lists over the doc corpus", () => {
  it("records, per fixture, which blocks are edited in place", async () => {
    const features: Record<string, string[]> = {};
    const hostile: Record<string, string[]> = {};
    for (const [name, text] of Object.entries(FEATURES)) features[name] = fidelity(text);
    for (const [name, text] of Object.entries(CORPUS)) hostile[name] = fidelity(text);
    const out = { features, hostile };
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/fidelity.txt",
    );
  });

  it("never offers to edit a block that defines references or holds a fence in a list", () => {
    const list = fidelity(FEATURES["what the model lacks"] as string);
    expect(list[0]).toBe("1: read-only");
    expect(list.find((l) => l.startsWith("10:"))).toBe("10: read-only");
  });
});

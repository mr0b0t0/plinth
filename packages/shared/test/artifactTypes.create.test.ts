// The registry's `create` rows (docs/spec.md "New and Import"): what "New" on the dashboard offers
// blank, and the placeholder v1 it publishes. Only types people edit on the page have one, in
// registry order, and each row's content is a source its type stores as it is.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPES,
  creatableTypes,
  HTML_DOCUMENT_RE,
  isLiveType,
  LIMITS,
  parseSheet,
  publishArtifactInput,
  restPublishArtifactInput,
  serializeSheet,
  TYPE_REGISTRY,
  titleSchema,
  utf8Length,
} from "../src/index.ts";

describe("create rows", () => {
  it("offers a blank doc, deck and sheet, in registry order, and nothing agents alone make", () => {
    expect(creatableTypes().map((d) => [d.id, d.create.label])).toEqual([
      ["doc", "Document"],
      ["slides", "Slide deck"],
      ["sheet", "Sheet"],
    ]);
    for (const t of ARTIFACT_TYPES) {
      const def = TYPE_REGISTRY[t] as (typeof TYPE_REGISTRY)[typeof t] & { create?: unknown };
      if (def.create !== undefined) expect(isLiveType(def), t).toBe(true);
    }
    // HTML pages and designs come only from agents.
    expect("create" in TYPE_REGISTRY.html).toBe(false);
    expect("create" in TYPE_REGISTRY.design).toBe(false);
  });

  it("gives each row a title and content the publish schema accepts", () => {
    for (const d of creatableTypes()) {
      expect(titleSchema.safeParse(d.create.title).success, d.id).toBe(true);
      expect(d.create.content.length, d.id).toBeGreaterThan(0);
      expect(utf8Length(d.create.content)).toBeLessThan(d.maxSourceBytes);
      expect(HTML_DOCUMENT_RE.test(d.create.content), d.id).toBe(false);
      const body = publishArtifactInput.safeParse({
        title: d.create.title,
        type: d.id,
        content: d.create.content,
      });
      expect(body.success, d.id).toBe(true);
    }
  });

  it("starts a doc on its title heading", () => {
    expect(TYPE_REGISTRY.doc.create).toEqual({
      label: "Document",
      title: "Untitled document",
      content: "# Untitled document\n",
    });
  });

  it("starts a sheet with three text columns and 20 empty rows, already canonical", () => {
    const row = TYPE_REGISTRY.sheet.create;
    expect(row?.title).toBe("Untitled sheet");
    const parsed = parseSheet(row?.content ?? "");
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(parsed.sheet.header.columns.map((c) => [c.name, c.type])).toEqual([
      ["Column 1", "text"],
      ["Column 2", "text"],
      ["Column 3", "text"],
    ]);
    expect(parsed.sheet.rows).toHaveLength(20);
    expect(parsed.sheet.rows.every((r) => r.length === 0)).toBe(true);
    // Stored byte for byte as sent, so v1 is exactly the row.
    expect(serializeSheet(parsed.sheet)).toBe(row?.content);
  });
});

describe("REST publish input", () => {
  it("takes a version note for v1, which the MCP tool's input does not list", () => {
    const ok = restPublishArtifactInput.parse({
      title: "Untitled sheet",
      type: "sheet",
      content: "x",
      note: "  Created in the app  ",
    });
    expect(ok.note).toBe("Created in the app");
    expect(
      restPublishArtifactInput.safeParse({ title: "t", note: "x".repeat(LIMITS.maxNoteLength + 1) })
        .success,
    ).toBe(false);
    expect(Object.keys(publishArtifactInput.shape)).not.toContain("note");
    expect(Object.keys(restPublishArtifactInput.shape)).toEqual([
      ...Object.keys(publishArtifactInput.shape),
      "note",
    ]);
  });
});

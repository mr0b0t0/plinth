// write_artifact_data's merge op: its input shape and the shallow merge it applies at a rev.
import { describe, expect, it } from "vitest";
import { dataOpSchema, mergeDocData } from "../src/index.ts";

describe("merge", () => {
  it("puts each changed field in place, removes a field set to null, and replaces nested values whole", () => {
    const stored = { kind: "rect", x: 0, color: "blue", rows: { r1: { at: 1, c1: "a" } } };
    expect(
      mergeDocData(stored, { x: 40, color: null, rows: { r2: { at: 2 } }, size: "large" }),
    ).toEqual({ kind: "rect", x: 40, rows: { r2: { at: 2 } }, size: "large" });
    expect(stored.x).toBe(0);
    // "__proto__" stays an ordinary field and never reaches the prototype.
    const merged = mergeDocData({}, JSON.parse('{"__proto__": {"polluted": 1}}'));
    expect(Object.keys(merged)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("needs a doc_id and a rev of at least 1", () => {
    const op = { op: "merge", collection: "blocks", doc_id: "a", data: { x: 1 }, if_rev: 3 };
    expect(dataOpSchema.safeParse(op).success).toBe(true);
    expect(dataOpSchema.safeParse({ ...op, if_rev: 0 }).success).toBe(false);
    expect(dataOpSchema.safeParse({ ...op, doc_id: undefined }).success).toBe(false);
    expect(dataOpSchema.safeParse({ ...op, data: [1] }).success).toBe(false);
  });
});

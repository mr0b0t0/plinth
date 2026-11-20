// The plinth-artifacts skill shows agents an example sheet: it must be one Plinth accepts, already
// in canonical form, and its formulas must compute, so an agent that copies it publishes as is.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateSheet,
  isError,
  parseSheet,
  SHEET_FUNCTION_NAMES,
  serializeSheet,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";

// Vitest runs in apps/web.
const SKILL = path.join(process.cwd(), "../../integrations/skill/plinth-artifacts/SKILL.md");

describe("the skill's sheet example", () => {
  const text = readFileSync(SKILL, "utf8");
  const section = text.slice(text.indexOf("## Sheets (type sheet)"));

  it("parses, is canonical and computes", () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(json).toBeTruthy();
    const call = JSON.parse(json ?? "{}") as { type: string; content: string };
    expect(call.type).toBe("sheet");
    const r = parseSheet(call.content);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(serializeSheet(r.sheet)).toBe(call.content);
    const ev = evaluateSheet(r.sheet, { budget: 10_000 });
    expect(ev.value(4, 3)).toBe(7.6);
    for (let row = 2; row <= r.sheet.rows.length + 1; row++) {
      for (let col = 0; col < r.sheet.header.columns.length; col++) {
        expect(isError(ev.value(row, col))).toBe(false);
      }
    }
  });

  it("lists exactly the functions sheets support", () => {
    const list = /Functions:\s*([\s\S]*?)\. Nothing else/.exec(section)?.[1] ?? "";
    const names = list
      .split(/,\s*/)
      .flatMap((n) => {
        const m = /^([A-Z]+)\(S\)$/.exec(n.trim());
        return m ? [m[1] as string, `${m[1]}S`] : [n.trim()];
      })
      .filter(Boolean);
    expect([...names].sort()).toEqual([...SHEET_FUNCTION_NAMES]);
  });
});

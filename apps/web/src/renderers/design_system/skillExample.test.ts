// The plinth-artifacts skill shows agents an example design system: it must be one Plinth
// accepts, with no warnings, so an agent that copies it publishes without a refusal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { liveRules, parseDesignSystem } from "@plinth/shared";
import { describe, expect, it } from "vitest";

// Vitest runs in apps/web.
const SKILL = path.join(process.cwd(), "../../integrations/skill/plinth-artifacts/SKILL.md");

describe("the skill's design system example", () => {
  it("parses with no warnings", () => {
    const text = readFileSync(SKILL, "utf8");
    const section = text.slice(text.indexOf("## Design systems (type design_system)"));
    const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(json).toBeTruthy();
    const r = parseDesignSystem(json ?? "");
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(r.ok && r.warnings).toEqual([]);
  });

  it("projects for editing on the page and back to the same value", () => {
    const text = readFileSync(SKILL, "utf8");
    const section = text.slice(text.indexOf("## Design systems (type design_system)"));
    const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
    const rules = liveRules("design_system");
    const live = rules?.toLive(json) ?? "";
    expect(rules?.valid(live)).toBe(true);
    expect(JSON.parse(rules?.fromLive(live) ?? "null")).toEqual(JSON.parse(json));
  });
});

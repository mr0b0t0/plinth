// Display names (displayName.ts) and the `people` declaration token: the write rules, the cleaning
// every read applies, and how `people` is parsed and stored.
import { describe, expect, it } from "vitest";
import {
  type Capabilities,
  categoryProblem,
  displayNameProblem,
  LIMITS,
  normalizeDisplayName,
  pageDisplayName,
  parseCapabilities,
  readStoredCapabilities,
  serializeCapabilities,
  updateProfileInput,
  utf8Length,
} from "../src/index.ts";

const meta = (content: string) => `<meta name="plinth-capabilities" content="${content}">`;

describe("display names", () => {
  it("normalise to NFC with single spaces, trimmed", () => {
    expect(normalizeDisplayName("  Ana \t\n  Lima  ")).toBe("Ana Lima");
    expect(normalizeDisplayName("José")).toBe("José");
  });

  it("refuse @, control, bidi and zero-width characters and over 100 on write; empty clears", () => {
    expect(displayNameProblem("Ana Lima")).toBeNull();
    expect(displayNameProblem("")).toBeNull();
    expect(displayNameProblem("x".repeat(LIMITS.maxDisplayNameLength))).toBeNull();
    expect(displayNameProblem("x".repeat(LIMITS.maxDisplayNameLength + 1))).toMatch(/at most 100/);
    expect(displayNameProblem("ana@example.com")).toMatch(/@/);
    for (const bad of ["Ana‮Owner", "An​a", "Ana\u0007", "Ana﻿"]) {
      expect(displayNameProblem(bad), JSON.stringify(bad)).toMatch(/invisible/);
    }
    // The same character class as categories.
    expect(categoryProblem("An​a")).toMatch(/invisible/);
  });

  it("updateProfileInput applies the rules and stays a plain string schema", () => {
    expect(updateProfileInput.safeParse({ name: "  Ana  " })).toMatchObject({
      success: true,
      data: { name: "Ana" },
    });
    for (const name of ["a@b", "Ana‮", "x".repeat(101)]) {
      expect(updateProfileInput.safeParse({ name }).success, name).toBe(false);
    }
  });

  it("pageDisplayName cleans legacy values, cuts at 64 code points, and gives null for nothing", () => {
    expect(pageDisplayName(null)).toBeNull();
    expect(pageDisplayName(undefined)).toBeNull();
    expect(pageDisplayName("")).toBeNull();
    expect(pageDisplayName("​ ‮")).toBeNull();
    expect(pageDisplayName("‮Ana​ Owner@home\u0007")).toBe("Ana Ownerhome");
    expect(pageDisplayName("Ana\nLima")).toBe("Ana Lima");
    const smiles = "\u{1F600}".repeat(70);
    const cut = pageDisplayName(smiles) as string;
    expect(Array.from(cut)).toHaveLength(LIMITS.maxPageDisplayNameLength);
    // Never half a surrogate pair.
    expect(cut).toBe("\u{1F600}".repeat(64));
    expect(utf8Length(cut)).toBeLessThanOrEqual(256);
    expect(pageDisplayName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });
});

describe("the people declaration", () => {
  it("counts only with data and viewer, and is not a declaration on its own", () => {
    expect(parseCapabilities(meta("data viewer people"))?.people).toBe(true);
    expect(parseCapabilities(meta("data viewer room people"))?.people).toBe(true);
    expect(parseCapabilities(meta("data people"))?.people).toBe(false);
    expect(parseCapabilities(meta("room viewer people"))?.people).toBe(false);
    expect(parseCapabilities(meta("viewer people"))).toBeNull();
    expect(parseCapabilities(meta("people"))).toBeNull();
  });

  it("is stored only when declared, so every other declaration is stored as before", () => {
    const withIt = parseCapabilities(meta("data viewer people")) as Capabilities;
    expect(serializeCapabilities(withIt)).toBe(
      '{"data":true,"viewer":true,"shared":[],"people":true}',
    );
    for (const c of ["data viewer", "data", "data viewer room", "room viewer", "data people"]) {
      const json = serializeCapabilities(parseCapabilities(meta(c)) as Capabilities);
      expect(json, c).not.toContain("people");
    }
    // Rows without the field read as people: false; a stored true counts only with viewer.
    expect(readStoredCapabilities('{"data":true,"viewer":true,"shared":[]}')?.people).toBe(false);
    expect(
      readStoredCapabilities('{"data":true,"viewer":true,"shared":[],"people":true}')?.people,
    ).toBe(true);
    expect(
      readStoredCapabilities('{"data":true,"viewer":false,"shared":[],"people":true}')?.people,
    ).toBe(false);
    expect(
      readStoredCapabilities('{"data":true,"viewer":true,"shared":[],"people":"yes"}')?.people,
    ).toBe(false);
  });
});

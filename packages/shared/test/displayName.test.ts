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

  it("refuse on write, and drop on read, every character whose compatibility form is @", () => {
    // U+FE6B and U+FF20 survive NFC and render as "@": "boss\uFF20company.com" reads as an address.
    const atSigns: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (ch.normalize("NFKC").includes("@")) atSigns.push(ch);
    }
    expect(atSigns).toEqual(["@", "\uFE6B", "\uFF20"]);
    for (const at of atSigns) {
      const forged = `boss${at}company.com`;
      expect(normalizeDisplayName(forged), JSON.stringify(at)).toBe(forged);
      expect(displayNameProblem(forged), JSON.stringify(at)).toMatch(/@/);
      expect(updateProfileInput.safeParse({ name: forged }).success, JSON.stringify(at)).toBe(
        false,
      );
      expect(pageDisplayName(forged), JSON.stringify(at)).toBe("bosscompany.com");
    }
  });

  it("refuse on write, and read as null, a name that shows nothing", () => {
    // Hangul fillers (letters that render as nothing), blank Braille, and combining marks alone.
    const blanks = ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u2800"];
    for (const b of blanks) {
      for (const name of [b, b.repeat(5), `${b} ${b}`]) {
        expect(displayNameProblem(name), JSON.stringify(name)).toMatch(/you can see/);
        expect(updateProfileInput.safeParse({ name }).success, JSON.stringify(name)).toBe(false);
        expect(pageDisplayName(name), JSON.stringify(name)).toBeNull();
      }
      // Beside something visible they are just characters.
      expect(displayNameProblem(`Ana${b}`), JSON.stringify(b)).toBeNull();
    }
    for (const name of [
      "\u0301",
      "\u0301\u0302\u0303",
      "\u20DD",
      "\u0301 \u0302",
      "\u3164\u0301",
    ]) {
      expect(displayNameProblem(name), JSON.stringify(name)).toMatch(/you can see/);
      expect(pageDisplayName(name), JSON.stringify(name)).toBeNull();
    }
    // A stored name that is blank once the refused characters are dropped reads as null too.
    expect(pageDisplayName("\u202E\u3164\u200B")).toBeNull();
    // Letters, numbers, symbols and punctuation all count.
    for (const name of ["José", "7", "\u{1F98A}", "\u2014", "e\u0301"]) {
      expect(displayNameProblem(name), JSON.stringify(name)).toBeNull();
      expect(pageDisplayName(name), JSON.stringify(name)).toBe(name.normalize("NFC"));
    }
  });

  it("messages are full sentences, the same in the app and the API", () => {
    expect(displayNameProblem("a@b")).toBe("A name cannot contain @.");
    for (const bad of ["a@b", "Ana\u202E", "x".repeat(101), "\u3164"]) {
      expect(displayNameProblem(bad), JSON.stringify(bad)).toMatch(/\.$/);
    }
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

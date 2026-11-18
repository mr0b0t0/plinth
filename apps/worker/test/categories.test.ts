// The pure category helpers (packages/shared/src/categories.ts; docs/spec.md "Categories").
import {
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  snapCategory,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";

describe("normalizeCategory", () => {
  it("trims and collapses every whitespace run to one space", () => {
    expect(normalizeCategory("  Acme \t  site   v2  ")).toBe("Acme site v2");
  });

  it("stores the NFC form", () => {
    const decomposed = "Café"; // "e" + combining acute
    expect(normalizeCategory(decomposed)).toBe("Café");
  });

  it("keeps case, separators and punctuation", () => {
    expect(normalizeCategory("ACME_site-web.app/v2")).toBe("ACME_site-web.app/v2");
  });
});

describe("categoryProblem", () => {
  it("accepts an ordinary name", () => {
    expect(categoryProblem("Acme site")).toBeNull();
    expect(categoryProblem("x".repeat(LIMITS.maxCategoryLength))).toBeNull();
    expect(categoryProblem("Café — 東京")).toBeNull();
  });

  it("refuses an empty name", () => {
    expect(categoryProblem("")).not.toBeNull();
  });

  it("refuses a name over the length cap", () => {
    expect(LIMITS.maxCategoryLength).toBe(60);
    expect(categoryProblem("x".repeat(61))).not.toBeNull();
  });

  it("refuses control, format and line or paragraph separator characters", () => {
    for (const bad of [
      "acme‮site", // right-to-left override (Cf)
      "acme​site", // zero-width space (Cf)
      "acme\nsite", // line feed (Cc)
      "acme\u0000site", // NUL (Cc)
      "acme site", // line separator (Zl)
      "acme site", // paragraph separator (Zp)
      "﻿acme", // byte order mark (Cf)
    ]) {
      expect(categoryProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("categoryKey", () => {
  it("matches case, whitespace, '-' and '_'", () => {
    const k = categoryKey("acme-site");
    expect(categoryKey("Acme Site")).toBe(k);
    expect(categoryKey("ACME_site")).toBe(k);
    expect(categoryKey("  acme -_ site ")).toBe(k);
  });

  it("folds compatibility forms (NFKC)", () => {
    expect(categoryKey("Ａcme")).toBe(categoryKey("acme")); // fullwidth A
  });

  it("keeps '.' and '/' distinct", () => {
    expect(categoryKey("a.b")).not.toBe(categoryKey("a b"));
    expect(categoryKey("a/b")).not.toBe(categoryKey("a b"));
    expect(categoryKey("a.b")).not.toBe(categoryKey("a/b"));
  });
});

describe("snapCategory", () => {
  it("returns the existing spelling when the keys match", () => {
    expect(snapCategory("acme-site", ["Other", "Acme Site"])).toBe("Acme Site");
    expect(snapCategory("ACME_SITE", ["Acme Site"])).toBe("Acme Site");
  });

  it("returns the name itself when nothing matches", () => {
    expect(snapCategory("acme.site", ["Acme Site"])).toBe("acme.site");
    expect(snapCategory("New one", [])).toBe("New one");
  });
});

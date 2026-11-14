import { describe, expect, it } from "vitest";
import {
  ASSET_PATH_RE,
  assetInputSchema,
  assetsSchema,
  LIMITS,
  SHA256_RE,
  STORED_AT_RE,
  startUploadInput,
} from "../src/index.ts";

/** STORED_AT_RE as the server applies it: parse, then test the remainder on its own. */
const storedAtOk = (s: string) => {
  const m = STORED_AT_RE.exec(s);
  return !!m && ASSET_PATH_RE.test(m[3] ?? "");
};

describe("ASSET_PATH_RE", () => {
  it("refuses empty segments, a trailing slash, dot segments, absolute and reserved paths", () => {
    for (const p of ["a//b", "dir/", "a/../x", "./x", "a/.", "/x", "__plinth/x", "..", "."]) {
      expect(ASSET_PATH_RE.test(p), p).toBe(false);
    }
  });
  it("accepts ordinary build paths, dots inside names included", () => {
    for (const p of ["x..y/z", "assets/index-abc.js", "img/a.png", "a/.well-known/x", "f.txt"]) {
      expect(ASSET_PATH_RE.test(p), p).toBe(true);
    }
  });
});

describe("STORED_AT_RE", () => {
  it("accepts legacy and nonce prefixes with a valid path", () => {
    expect(storedAtOk("v1/a.js")).toBe(true);
    expect(storedAtOk("v12.abcdefghij12/assets/x.css")).toBe(true);
  });
  it("refuses traversal, empty segments, version 0 and malformed nonces", () => {
    for (const s of [
      "v1/../x",
      "v1/./x",
      "v1//x",
      "v0/x",
      "v1.ABCDEFGHIJKL/x",
      "v1.short/x",
      "x",
    ]) {
      expect(storedAtOk(s), s).toBe(false);
    }
  });
});

describe("asset input", () => {
  it("takes content, sha256 or both; sha256 must be lowercase hex", () => {
    const sha = "a".repeat(64);
    expect(SHA256_RE.test(sha)).toBe(true);
    expect(assetInputSchema.safeParse({ path: "a.js", content: "x" }).success).toBe(true);
    expect(assetInputSchema.safeParse({ path: "a.js", sha256: sha }).success).toBe(true);
    expect(assetInputSchema.safeParse({ path: "a.js", content: "x", sha256: sha }).success).toBe(
      true,
    );
    expect(assetInputSchema.safeParse({ path: "a.js", sha256: "A".repeat(64) }).success).toBe(
      false,
    );
    expect(assetInputSchema.safeParse({ path: "a.js", sha256: "abc" }).success).toBe(false);
  });
  it("caps the list at the ceiling; the instance limit is the Worker's", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `f${i}`, content: "" }));
    expect(assetsSchema.safeParse(many(LIMITS.maxAssetsCeiling)).success).toBe(true);
    expect(assetsSchema.safeParse(many(LIMITS.maxAssetsCeiling + 1)).success).toBe(false);
  });
});

describe("startUploadInput", () => {
  it("is flat: every field is optional, cross-field rules live in the Worker", () => {
    expect(startUploadInput.safeParse({}).success).toBe(true);
    expect(startUploadInput.safeParse({ id: "abc", base_version: 3, note: "n" }).success).toBe(
      true,
    );
    expect(startUploadInput.safeParse({ type: "doc", title: "T" }).success).toBe(true);
    expect(startUploadInput.safeParse({ type: "pdf" }).success).toBe(false);
    expect(startUploadInput.safeParse({ base_version: 0 }).success).toBe(false);
  });
});

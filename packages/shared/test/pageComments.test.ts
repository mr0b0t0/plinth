// Comments from the page: the `comments` declaration and the page anchor (schemas.ts,
// pageComments.ts). Element anchors keep their shape and stored bytes.
import { describe, expect, it } from "vitest";
import {
  anchorSchema,
  capabilityList,
  createCommentInput,
  elementAnchorSchema,
  isPageAnchor,
  PAGE_COMMENT_LIMITS,
  pageAnchorSchema,
  parseCapabilities,
  readStoredCapabilities,
  serializeCapabilities,
} from "../src/index.ts";
import { PAGE_ANCHOR_VECTORS } from "./pageAnchorVectors.ts";

const caps = (content: string) => `<meta name="plinth-capabilities" content="${content}">`;

describe("the comments declaration", () => {
  it("declares on its own, and alongside data and room", () => {
    expect(parseCapabilities(caps("comments"))).toEqual({
      data: false,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      people: false,
      comments: true,
      dictation: false,
    });
    expect(parseCapabilities(caps("data comments"))).toMatchObject({ data: true, comments: true });
    expect(parseCapabilities(caps("room comments"))).toMatchObject({ room: true, comments: true });
    // `viewer comments` declares page comments only: viewer still means nothing without data.
    expect(parseCapabilities(caps("viewer comments"))).toMatchObject({
      data: false,
      viewer: true,
      room: false,
      comments: true,
    });
    expect(parseCapabilities(caps("data"))?.comments).toBe(false);
  });

  it("stores `comments` only when declared, so other declarations keep their bytes", () => {
    const only = parseCapabilities(caps("comments"));
    expect(serializeCapabilities(only as NonNullable<typeof only>)).toBe(
      '{"data":false,"viewer":false,"shared":[],"comments":true}',
    );
    const all = parseCapabilities(caps("data viewer room comments"));
    expect(serializeCapabilities(all as NonNullable<typeof all>)).toBe(
      '{"data":true,"viewer":true,"shared":[],"room":true,"roomOpen":[],"comments":true}',
    );
    // With `people` (who is viewing), each optional key in registry order.
    const people = parseCapabilities(caps("data viewer people comments"));
    expect(serializeCapabilities(people as NonNullable<typeof people>)).toBe(
      '{"data":true,"viewer":true,"shared":[],"people":true,"comments":true}',
    );
    const data = parseCapabilities(caps("data viewer"));
    expect(serializeCapabilities(data as NonNullable<typeof data>)).toBe(
      '{"data":true,"viewer":true,"shared":[]}',
    );
  });

  it("reads stored rows back, and rows without the key as no page comments", () => {
    expect(
      readStoredCapabilities('{"data":false,"viewer":false,"shared":[],"comments":true}'),
    ).toEqual({
      data: false,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      people: false,
      comments: true,
      dictation: false,
    });
    expect(readStoredCapabilities('{"data":true,"viewer":true,"shared":[]}')?.comments).toBe(false);
    // Only `true` counts.
    expect(readStoredCapabilities('{"data":false,"viewer":false,"comments":"yes"}')).toBeNull();
    expect(readStoredCapabilities('{"data":true,"viewer":false,"comments":1}')?.comments).toBe(
      false,
    );
  });

  it("lists comments last", () => {
    expect(capabilityList(parseCapabilities(caps("comments room viewer data")))).toEqual([
      "data",
      "viewer",
      "room",
      "comments",
    ]);
    expect(capabilityList(parseCapabilities(caps("comments")))).toEqual(["comments"]);
  });
});

describe("page anchors", () => {
  it("follows the shared vectors", () => {
    for (const v of PAGE_ANCHOR_VECTORS) {
      const input =
        v.anchor && typeof v.anchor === "object" && !Array.isArray(v.anchor)
          ? { kind: "page", ...v.anchor }
          : v.anchor;
      // A `kind` the page passes would be overwritten by the spread above; it is refused.
      const ok =
        pageAnchorSchema.safeParse(input).success &&
        !(v.anchor && typeof v.anchor === "object" && "kind" in v.anchor);
      expect(ok, v.name).toBe(v.ok);
    }
  });

  it("are strict, and a page kind never falls through to an element anchor", () => {
    const withSelector = { kind: "page", key: "canvas", selector: "h1" };
    expect(pageAnchorSchema.safeParse(withSelector).success).toBe(false);
    expect(anchorSchema.safeParse(withSelector).success).toBe(false);
    expect(anchorSchema.safeParse({ kind: "page", selector: "h1" }).success).toBe(false);
    expect(anchorSchema.safeParse({ kind: "element", selector: "h1" }).success).toBe(false);
    expect(anchorSchema.parse({ kind: "page", key: "canvas", x: 3, y: -4 })).toEqual({
      kind: "page",
      key: "canvas",
      x: 3,
      y: -4,
    });
  });

  it("keep element anchors as they were", () => {
    const fixtures = [
      { selector: "h1" },
      { selector: "main > p:nth-of-type(2)", text: "Three steps", x: 0.25, y: 0.5 },
      { selector: "#x", x: 0, y: 1 },
      { selector: "s".repeat(1000), text: "t".repeat(500) },
    ];
    for (const f of fixtures) {
      expect(anchorSchema.parse(f)).toEqual(f);
      expect(elementAnchorSchema.parse(f)).toEqual(f);
      expect(isPageAnchor(anchorSchema.parse(f))).toBe(false);
      expect(createCommentInput.parse({ body: "hi", anchor: f }).anchor).toEqual(f);
    }
    // Unknown fields of an element anchor are dropped, as before.
    expect(anchorSchema.parse({ selector: "h1", extra: 1 })).toEqual({ selector: "h1" });
    expect(anchorSchema.safeParse({ selector: "h1", x: 2 }).success).toBe(false);
  });

  it("are told apart by isPageAnchor", () => {
    expect(isPageAnchor({ kind: "page", key: "a" })).toBe(true);
    expect(isPageAnchor({ selector: "h1" })).toBe(false);
    expect(isPageAnchor(null)).toBe(false);
    expect(isPageAnchor(undefined)).toBe(false);
  });

  it("count data bytes as UTF-8", () => {
    // 4 keys of 200 two-byte characters: under 1024 characters, over 1024 bytes.
    const data = Object.fromEntries(["a", "b", "c", "d"].map((k) => [k, "é".repeat(200)]));
    const json = JSON.stringify(data);
    expect(json.length).toBeLessThan(PAGE_COMMENT_LIMITS.maxDataBytes);
    expect(pageAnchorSchema.safeParse({ kind: "page", key: "a", data }).success).toBe(false);
  });
});

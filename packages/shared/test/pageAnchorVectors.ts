// One table of page anchors, valid and not, as the page passes them to plinth.comments.compose
// (without `kind`). The shared zod schema (pageAnchorSchema, given { kind: "page", ...anchor }),
// the runtime's inlined validator (apps/worker/src/content/runtime/comments.ts) and the app's
// parser (apps/web/src/components/comments/pageChannel.ts) are each tested against it, so the three
// stay in step.

const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

export const PAGE_ANCHOR_VECTORS: { name: string; anchor: unknown; ok: boolean }[] = [
  // valid
  { name: "a key alone", anchor: { key: "canvas" }, ok: true },
  { name: "a canvas point", anchor: { key: "canvas", x: 10.5, y: 240 }, ok: true },
  { name: "negative and huge coordinates", anchor: { key: "map", x: -1e9, y: 1e9 }, ok: true },
  { name: "every key character", anchor: { key: "node:42/a.b_c-d" }, ok: true },
  { name: "a 128-character key", anchor: { key: "k".repeat(128) }, ok: true },
  { name: "a label", anchor: { key: "slide-3", text: "Slide 3, top left" }, ok: true },
  { name: "a 120-character label", anchor: { key: "a", text: "t".repeat(120) }, ok: true },
  {
    name: "flat data of every value type",
    anchor: { key: "a", data: { zoom: 2, layer: "top", on: true, none: null } },
    ok: true,
  },
  { name: "16 data keys", anchor: { key: "a", data: many(16) }, ok: true },
  {
    name: "a 200-character data string",
    anchor: { key: "a", data: { s: "s".repeat(200) } },
    ok: true,
  },
  { name: "empty data", anchor: { key: "a", data: {} }, ok: true },
  {
    // `compose({ key, x, y, text, data })` with some of them unset: an absent field.
    name: "optional fields set to undefined",
    anchor: { key: "a", x: undefined, y: undefined, text: undefined, data: undefined },
    ok: true,
  },
  { name: "a label set to undefined", anchor: { key: "slide-3", text: undefined }, ok: true },
  // not valid
  { name: "no key", anchor: {}, ok: false },
  { name: "an empty key", anchor: { key: "" }, ok: false },
  { name: "a key starting with a dash", anchor: { key: "-a" }, ok: false },
  { name: "a key with a space", anchor: { key: "a b" }, ok: false },
  { name: "a 129-character key", anchor: { key: "k".repeat(129) }, ok: false },
  { name: "a number key", anchor: { key: 5 }, ok: false },
  { name: "x is NaN", anchor: { key: "a", x: Number.NaN }, ok: false },
  { name: "y is Infinity", anchor: { key: "a", y: Number.POSITIVE_INFINITY }, ok: false },
  { name: "x beyond 1e9", anchor: { key: "a", x: 1e9 + 1 }, ok: false },
  { name: "x as a string", anchor: { key: "a", x: "3" }, ok: false },
  { name: "a 121-character label", anchor: { key: "a", text: "t".repeat(121) }, ok: false },
  { name: "a number label", anchor: { key: "a", text: 3 }, ok: false },
  { name: "17 data keys", anchor: { key: "a", data: many(17) }, ok: false },
  {
    name: "data over 1 KiB",
    anchor: {
      key: "a",
      data: {
        a: "x".repeat(200),
        b: "x".repeat(200),
        c: "x".repeat(200),
        d: "x".repeat(200),
        e: "x".repeat(200),
      },
    },
    ok: false,
  },
  { name: "a nested object in data", anchor: { key: "a", data: { o: { p: 1 } } }, ok: false },
  { name: "an array in data", anchor: { key: "a", data: { l: [1] } }, ok: false },
  { name: "a data key starting with a digit", anchor: { key: "a", data: { "1a": 1 } }, ok: false },
  { name: "a data key with a dash", anchor: { key: "a", data: { "a-b": 1 } }, ok: false },
  {
    name: "a 201-character data string",
    anchor: { key: "a", data: { s: "s".repeat(201) } },
    ok: false,
  },
  { name: "a non-finite data number", anchor: { key: "a", data: { n: Number.NaN } }, ok: false },
  { name: "data as an array", anchor: { key: "a", data: [1] }, ok: false },
  { name: "data as null", anchor: { key: "a", data: null }, ok: false },
  { name: "an unknown field", anchor: { key: "a", selector: "h1" }, ok: false },
  { name: "an undefined key", anchor: { key: undefined }, ok: false },
  {
    name: "an unknown field set to undefined",
    anchor: { key: "a", selector: undefined },
    ok: false,
  },
  {
    name: "a data value set to undefined",
    anchor: { key: "a", data: { z: undefined } },
    ok: false,
  },
  { name: "a kind field", anchor: { key: "a", kind: "page" }, ok: false },
  { name: "null", anchor: null, ok: false },
  { name: "a string", anchor: "canvas", ok: false },
  { name: "an array", anchor: ["canvas"], ok: false },
];

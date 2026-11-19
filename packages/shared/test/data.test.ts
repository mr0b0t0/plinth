import { describe, expect, it } from "vitest";
import {
  CONTENT_DATA_HEADER,
  DATA_CAPABILITIES,
  DEFAULTS,
  dataByteSize,
  dataCollectionSchema,
  dataDocIdSchema,
  dataObjectSchema,
  dataObjectWithin,
  isPersonalDocId,
  LIMITS,
  listArtifactDataInput,
  parseCapabilities,
  ROOM_LIMITS,
  serializeCapabilities,
  writeArtifactDataInput,
} from "../src/index.ts";

/** No room, and (later tokens) no people list, no page comments and no dictation. */
const NO_ROOM = { room: false, roomOpen: [], people: false, comments: false, dictation: false };
const caps = (content: string) => `<meta name="plinth-capabilities" content="${content}">`;

describe("parseCapabilities", () => {
  it("returns null when nothing is declared", () => {
    expect(parseCapabilities("<!doctype html><title>x</title><h1>Hello</h1>")).toBeNull();
    expect(parseCapabilities("")).toBeNull();
    expect(parseCapabilities('<meta name="description" content="data viewer">')).toBeNull();
  });

  it("reads data and viewer", () => {
    expect(parseCapabilities(caps("data viewer"))).toEqual({
      data: true,
      viewer: true,
      shared: [],
      ...NO_ROOM,
    });
    expect(parseCapabilities(caps("data"))).toEqual({
      data: true,
      viewer: false,
      shared: [],
      ...NO_ROOM,
    });
  });

  it("viewer without data declares nothing: the viewer is learned through the data API", () => {
    expect(parseCapabilities(caps("viewer"))).toBeNull();
    expect(
      parseCapabilities(`${caps("viewer")}<meta name="plinth-data-shared" content="tasks">`),
    ).toBeNull();
  });

  it("ignores unknown tokens and returns null when no known one is left", () => {
    expect(parseCapabilities(caps("camera data  files"))).toEqual({
      data: true,
      viewer: false,
      shared: [],
      ...NO_ROOM,
    });
    expect(parseCapabilities(caps("camera files"))).toBeNull();
    expect(parseCapabilities(caps(""))).toBeNull();
  });

  it("accepts any attribute order, either quote style, unquoted values and any case", () => {
    const expected = { data: true, viewer: true, shared: [], ...NO_ROOM };
    expect(parseCapabilities(`<meta content="data viewer" name="plinth-capabilities">`)).toEqual(
      expected,
    );
    expect(parseCapabilities(`<meta name='plinth-capabilities' content='data viewer'>`)).toEqual(
      expected,
    );
    expect(parseCapabilities(`<META NAME="Plinth-Capabilities" CONTENT="Data VIEWER" />`)).toEqual(
      expected,
    );
    expect(
      parseCapabilities(`<meta\n  charset-x="1"\n  name=plinth-capabilities\n  content=data>`),
    ).toEqual({ data: true, viewer: false, shared: [], ...NO_ROOM });
    expect(parseCapabilities(`<meta name="plinth-capabilities" content="data,viewer">`)).toEqual(
      expected,
    );
  });

  it("does not mistake a longer attribute name or a value containing > for the real one", () => {
    expect(parseCapabilities(`<meta data-name="plinth-capabilities" content="data">`)).toBeNull();
    expect(
      parseCapabilities(`<meta title="a > b" name="plinth-capabilities" content="data viewer">`),
    ).toEqual({ data: true, viewer: true, shared: [], ...NO_ROOM });
  });

  it("counts only the first tag of each name", () => {
    expect(parseCapabilities(caps("data") + caps("viewer"))).toEqual({
      data: true,
      viewer: false,
      shared: [],
      ...NO_ROOM,
    });
    // A first tag that declares nothing known still wins.
    expect(parseCapabilities(caps("camera") + caps("data"))).toBeNull();
    const shared = `<meta name="plinth-data-shared" content="tasks"><meta name="plinth-data-shared" content="notes">`;
    expect(parseCapabilities(caps("data") + shared)?.shared).toEqual(["tasks"]);
  });

  it("ignores tags inside HTML comments", () => {
    expect(parseCapabilities(`<!-- ${caps("data viewer")} -->`)).toBeNull();
    expect(parseCapabilities(`<!-- ${caps("viewer")} -->${caps("data")}`)).toEqual({
      data: true,
      viewer: false,
      shared: [],
      ...NO_ROOM,
    });
  });

  it("reads shared collections: valid names, deduplicated, at most 20", () => {
    const names = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const html = `${caps("data")}<meta name="plinth-data-shared" content="Tasks tasks Bad! -x ${names.join(" ")}">`;
    const parsed = parseCapabilities(html);
    expect(parsed?.shared).toHaveLength(LIMITS.maxDataShared);
    expect(parsed?.shared[0]).toBe("tasks");
    expect(parsed?.shared).not.toContain("bad!");
    expect(parsed?.shared).not.toContain("-x");
    expect(parsed?.shared[1]).toBe("c0");
  });

  it("keeps shared names only alongside a known capability", () => {
    expect(parseCapabilities(`<meta name="plinth-data-shared" content="tasks">`)).toBeNull();
  });

  it("does not choke on a large document without tags", () => {
    const big = `<!doctype html>${"<p>x</p><meta charset=utf-8>".repeat(50_000)}<meta name="plinth`;
    expect(parseCapabilities(big)).toBeNull();
  });
});

describe("parseCapabilities: rooms", () => {
  const open = (content: string) => `<meta name="plinth-room-open" content="${content}">`;

  it("room alone is a declaration, and never counts as data", () => {
    expect(parseCapabilities(caps("room"))).toEqual({
      data: false,
      viewer: false,
      shared: [],
      room: true,
      roomOpen: [],
      people: false,
      comments: false,
      dictation: false,
    });
    expect(parseCapabilities(caps("viewer room"))).toMatchObject({ data: false, viewer: true });
    expect(parseCapabilities(caps("data viewer room"))).toMatchObject({
      data: true,
      viewer: true,
      room: true,
    });
  });

  it("reads open topics: valid, lowercased, deduplicated, * kept, at most 16", () => {
    const topics = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const parsed = parseCapabilities(
      `${caps("room")}${open(`Cursor cursor note.move * bad! .x ${topics.join(" ")}`)}`,
    );
    expect(parsed?.roomOpen).toHaveLength(ROOM_LIMITS.maxOpenTopics);
    expect(parsed?.roomOpen.slice(0, 4)).toEqual(["cursor", "note.move", "*", "t0"]);
    expect(parsed?.roomOpen).not.toContain("bad!");
    expect(parsed?.roomOpen).not.toContain(".x");
    // Only the first tag counts, and comments are ignored.
    expect(
      parseCapabilities(`<!-- ${open("hidden")} -->${caps("room")}${open("a")}${open("b")}`)
        ?.roomOpen,
    ).toEqual(["a"]);
  });

  it("keeps each list only with its own capability", () => {
    const shared = `<meta name="plinth-data-shared" content="tasks">`;
    expect(parseCapabilities(`${caps("room")}${shared}`)?.shared).toEqual([]);
    expect(parseCapabilities(`${caps("data")}${open("cursor")}`)?.roomOpen).toEqual([]);
    expect(parseCapabilities(open("cursor"))).toBeNull();
    expect(parseCapabilities(`${caps("viewer")}${open("cursor")}`)).toBeNull();
  });

  it("stores every declaration without room exactly as before rooms existed", () => {
    const cases: [string, string][] = [
      [caps("data"), '{"data":true,"viewer":false,"shared":[]}'],
      [caps("data viewer"), '{"data":true,"viewer":true,"shared":[]}'],
      [
        `${caps("data")}<meta name="plinth-data-shared" content="tasks notes">`,
        '{"data":true,"viewer":false,"shared":["tasks","notes"]}',
      ],
      // An open list without room is dropped, so the stored row is unchanged too.
      [`${caps("data viewer")}${open("cursor")}`, '{"data":true,"viewer":true,"shared":[]}'],
    ];
    for (const [html, stored] of cases) {
      const c = parseCapabilities(html);
      expect(c).not.toBeNull();
      expect(serializeCapabilities(c as NonNullable<typeof c>)).toBe(stored);
    }
    const room = parseCapabilities(`${caps("data room")}${open("cursor")}`);
    expect(serializeCapabilities(room as NonNullable<typeof room>)).toBe(
      '{"data":true,"viewer":false,"shared":[],"room":true,"roomOpen":["cursor"]}',
    );
  });
});

describe("data constants", () => {
  it("names the header, capabilities, defaults and fixed limits", () => {
    expect(CONTENT_DATA_HEADER).toBe("x-plinth-data");
    expect(DATA_CAPABILITIES).toEqual([
      "data",
      "viewer",
      "room",
      "people",
      "comments",
      "dictation",
    ]);
    expect(DEFAULTS.data).toEqual({
      maxDocsPerArtifact: 1000,
      maxBytesPerArtifact: 1024 * 1024,
      maxBytesPerUser: 16 * 1024 * 1024,
      maxDocBytes: 16 * 1024,
      writesPerViewerPerHour: 300,
      writesPerArtifactPerHour: 2000,
    });
    expect(LIMITS.maxDataCollections).toBe(50);
    expect(LIMITS.maxDataDepth).toBe(16);
    expect(LIMITS.maxDataListLimit).toBe(200);
    expect(LIMITS.maxDataOps).toBe(50);
    expect(LIMITS.maxDataShared).toBe(20);
  });
});

describe("data schemas", () => {
  it("collection names", () => {
    for (const ok of ["votes", "a", "sign-ups", "task_list", `a${"b".repeat(39)}`]) {
      expect(dataCollectionSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["", "Votes", "1votes", "-a", "_a", "a b", "a.b", `a${"b".repeat(40)}`]) {
      expect(dataCollectionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("document ids, including ~me and personal u_ ids", () => {
    for (const ok of ["a", "A1", "doc_1-x", "~me", `u_${"0".repeat(24)}`, "x".repeat(64)]) {
      expect(dataDocIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["", "_a", "-a", "~you", "~me2", "a/b", "a.b", "x".repeat(65)]) {
      expect(dataDocIdSchema.safeParse(bad).success).toBe(false);
    }
    expect(isPersonalDocId(`u_${"a".repeat(24)}`)).toBe(true);
    expect(isPersonalDocId("user_1")).toBe(false);
    expect(isPersonalDocId("U_abc")).toBe(false);
  });

  it("data is a plain JSON object", () => {
    expect(dataObjectSchema.safeParse({ a: 1, b: [1, "x", null, { c: true }] }).success).toBe(true);
    expect(dataObjectSchema.safeParse({}).success).toBe(true);
    for (const bad of [null, [], [1], "x", 1, true, undefined]) {
      expect(dataObjectSchema.safeParse(bad).success).toBe(false);
    }
    expect(dataObjectSchema.safeParse({ a: Number.NaN }).success).toBe(false);
    expect(dataObjectSchema.safeParse({ a: undefined }).success).toBe(false);
    expect(dataObjectSchema.safeParse({ a: new Date() }).success).toBe(false);
  });

  it("data nests at most 16 levels", () => {
    const nest = (depth: number): Record<string, unknown> => {
      let v: Record<string, unknown> = { leaf: 1 };
      for (let i = 1; i < depth; i++) v = { n: v };
      return v;
    };
    expect(dataObjectSchema.safeParse(nest(16)).success).toBe(true);
    expect(dataObjectSchema.safeParse(nest(17)).success).toBe(false);
    // Arrays count as levels too.
    let arr: unknown = 1;
    for (let i = 0; i < 16; i++) arr = [arr];
    expect(dataObjectSchema.safeParse({ a: arr }).success).toBe(false);
    // Deep input fails without blowing the stack.
    expect(dataObjectSchema.safeParse(nest(100_000)).success).toBe(false);
  });

  it("the size check takes a limit in UTF-8 bytes of the JSON", () => {
    const value = { s: "é".repeat(10) };
    // {"s":""} is 8 bytes, each é is 2.
    expect(dataByteSize(value)).toBe(28);
    // Astral characters are 4 bytes, other BMP characters 3.
    expect(dataByteSize({ s: "😀€" })).toBe(8 + 4 + 3);
    const size = dataByteSize(value);
    expect(dataObjectWithin(size).safeParse(value).success).toBe(true);
    expect(dataObjectWithin(size - 1).safeParse(value).success).toBe(false);
    // It still checks depth and shape.
    expect(dataObjectWithin(1_000_000).safeParse([]).success).toBe(false);
  });

  it("list_artifact_data input", () => {
    expect(listArtifactDataInput.parse({ id: "abc" })).toEqual({ id: "abc", limit: 50 });
    expect(
      listArtifactDataInput.parse({ id: "abc", collection: "votes", doc_id: "~me", limit: 200 }),
    ).toMatchObject({ collection: "votes", doc_id: "~me", limit: 200 });
    expect(listArtifactDataInput.safeParse({ id: "abc", limit: 0 }).success).toBe(false);
    expect(listArtifactDataInput.safeParse({ id: "abc", limit: 201 }).success).toBe(false);
    expect(listArtifactDataInput.safeParse({ id: "abc", collection: "Bad" }).success).toBe(false);
    // A document needs its collection.
    expect(listArtifactDataInput.safeParse({ id: "abc", doc_id: "x" }).success).toBe(false);
  });

  it("write_artifact_data input requires if_rev on every op", () => {
    const set = { op: "set", collection: "votes", data: { choice: "a" }, if_rev: 0 };
    const del = { op: "delete", collection: "votes", doc_id: "x", if_rev: 3 };
    expect(writeArtifactDataInput.parse({ id: "abc", ops: [set, del] }).ops).toHaveLength(2);
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...set, doc_id: "x" }] }).success,
    ).toBe(true);
    const { if_rev: _s, ...setNoRev } = set;
    const { if_rev: _d, ...delNoRev } = del;
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: [setNoRev] }).success).toBe(false);
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: [delNoRev] }).success).toBe(false);
    // Deleting needs an existing rev (>= 1) and a doc id; set accepts 0 (create).
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...del, if_rev: 0 }] }).success,
    ).toBe(false);
    const { doc_id: _id, ...delNoId } = del;
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: [delNoId] }).success).toBe(false);
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...set, if_rev: -1 }] }).success,
    ).toBe(false);
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...set, if_rev: 1.5 }] }).success,
    ).toBe(false);
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...set, op: "clear" }] }).success,
    ).toBe(false);
    expect(
      writeArtifactDataInput.safeParse({ id: "abc", ops: [{ ...set, data: [1] }] }).success,
    ).toBe(false);
  });

  it("write_artifact_data takes 1 to 50 ops", () => {
    const op = { op: "delete", collection: "votes", doc_id: "x", if_rev: 1 };
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: [] }).success).toBe(false);
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: Array(50).fill(op) }).success).toBe(
      true,
    );
    expect(writeArtifactDataInput.safeParse({ id: "abc", ops: Array(51).fill(op) }).success).toBe(
      false,
    );
  });
});

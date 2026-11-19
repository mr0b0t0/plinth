// Following the presenter: the slides channel's frames (slidesRoom.ts), the room kind and the
// shell's `follow` payload field.
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  parseSlidesClientFrame,
  parseSlidesServerFrame,
  ROOM_KINDS,
  SLIDES_FRAME_BYTES,
  TYPE_REGISTRY,
  typedShellHtml,
} from "../src/index.ts";

describe("parseSlidesClientFrame", () => {
  it("accepts exactly start, goto and stop", () => {
    expect(parseSlidesClientFrame('{"t":"start","slide":1}')).toEqual({ t: "start", slide: 1 });
    expect(parseSlidesClientFrame('{"t":"goto","slide":500}')).toEqual({ t: "goto", slide: 500 });
    expect(parseSlidesClientFrame('{"t":"stop"}')).toEqual({ t: "stop" });
  });

  it("refuses anything else", () => {
    const bad = [
      "",
      "ping",
      "null",
      "[]",
      "1",
      '"start"',
      "{",
      '{"t":"start"}',
      '{"t":"start","slide":0}',
      `{"t":"goto","slide":${LIMITS.maxSlides + 1}}`,
      '{"t":"goto","slide":1.5}',
      '{"t":"goto","slide":"3"}',
      '{"t":"goto","slide":-1}',
      '{"t":"stop","slide":1}',
      '{"t":"start","slide":1,"by":"s_x"}',
      '{"t":"at","slide":1}',
      '{"t":"join","room":"main"}',
      '{"t":"emit","topic":"x","data":1}',
      `{"t":"stop","pad":"${"x".repeat(SLIDES_FRAME_BYTES)}"}`,
    ];
    for (const raw of bad) expect(parseSlidesClientFrame(raw), raw).toBeNull();
  });
});

describe("parseSlidesServerFrame", () => {
  it("reads every server frame", () => {
    expect(
      parseSlidesServerFrame(
        '{"t":"welcome","v":1,"you":{"id":"s_abc","present":true},"at":{"slide":3,"by":"s_def"}}',
      ),
    ).toEqual({
      t: "welcome",
      v: 1,
      you: { id: "s_abc", present: true },
      at: { slide: 3, by: "s_def" },
    });
    expect(
      parseSlidesServerFrame('{"t":"welcome","v":1,"you":{"id":"s_a","present":false},"at":null}'),
    ).toMatchObject({ at: null });
    expect(parseSlidesServerFrame('{"t":"at","slide":7,"by":"s_x"}')).toEqual({
      t: "at",
      slide: 7,
      by: "s_x",
    });
    expect(parseSlidesServerFrame('{"t":"stopped"}')).toEqual({ t: "stopped" });
    expect(parseSlidesServerFrame('{"t":"audience","n":3}')).toEqual({ t: "audience", n: 3 });
    expect(parseSlidesServerFrame('{"t":"error","code":"not_leading"}')).toEqual({
      t: "error",
      code: "not_leading",
    });
  });

  it("drops frames it does not know or that are out of range", () => {
    for (const raw of [
      "pong",
      '{"t":"welcome","v":2,"you":{"id":"s_a","present":true},"at":null}',
      '{"t":"welcome","v":1,"you":{"id":"a@b.c","present":true},"at":null}',
      '{"t":"welcome","v":1,"you":{"id":"s_a"},"at":null}',
      '{"t":"welcome","v":1,"you":{"id":"s_a","present":true},"at":{"slide":0,"by":"s_b"}}',
      '{"t":"at","slide":0,"by":"s_x"}',
      '{"t":"at","slide":2,"by":"someone@example.com"}',
      '{"t":"audience","n":-1}',
      '{"t":"error","code":"boom"}',
      '{"t":"peer"}',
    ])
      expect(parseSlidesServerFrame(raw), raw).toBeNull();
  });
});

describe("slides room kind and payload", () => {
  it("adds the slides kind after page and doc; only slides follows", () => {
    expect([...ROOM_KINDS]).toEqual(["page", "doc", "slides"]);
    expect(TYPE_REGISTRY.slides.follow).toBe(true);
    for (const t of ["html", "doc", "design_system", "design"] as const)
      expect(TYPE_REGISTRY[t].follow ?? false, t).toBe(false);
  });

  it("the shell carries follow only when asked, so every other shell keeps its bytes", () => {
    const o = { title: "Deck", text: "# A", base: "", appOrigin: "https://app.example" };
    const plain = typedShellHtml(TYPE_REGISTRY.slides, o);
    expect(plain).not.toContain('"follow"');
    const watch = typedShellHtml(TYPE_REGISTRY.slides, { ...o, follow: "watch" });
    expect(watch).toContain('"follow":"watch"');
    expect(watch.replace(',"follow":"watch"', "")).toBe(plain);
    expect(typedShellHtml(TYPE_REGISTRY.slides, { ...o, follow: "present" })).toContain(
      '"follow":"present"',
    );
  });
});

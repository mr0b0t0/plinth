// How an open view applies a newer version (docs/spec.md "Live views"): the plan for each
// situation, and the checks on what a frame's runtime answers.
import { describe, expect, it } from "vitest";
import { carryPath, planUpdate, readViewMessage, type UpdateSituation } from "./viewUpdate.ts";

const BASE: UpdateSituation = {
  enabled: true,
  type: "html",
  pinned: false,
  pause: null,
  review: false,
  isolation: "origin",
  pathFallback: false,
  runtimeHello: false,
  frameFocused: false,
  liveRoomFrame: false,
  holdDeclared: false,
};
const plan = (over: Partial<UpdateSituation>) => planUpdate({ ...BASE, ...over }).kind;

describe("planUpdate", () => {
  it("keeps a pinned link and a paused frame, whatever else holds", () => {
    expect(plan({ pinned: true, holdDeclared: true, frameFocused: true })).toBe("keep");
    for (const pause of ["follow", "hold", "present"] as const) {
      expect(plan({ pause, type: "doc" })).toBe("keep");
      expect(plan({ pause, runtimeHello: true })).toBe("keep");
    }
    expect(plan({ pinned: true, enabled: false })).toBe("keep");
  });

  it("swaps every frame, as before, while live views are off on the instance", () => {
    for (const over of [
      { type: "doc" as const },
      { runtimeHello: true },
      { holdDeclared: true, frameFocused: true },
    ]) {
      expect(plan({ ...over, enabled: false })).toBe("swap");
    }
  });

  it("shows a doc in place under origin isolation, and swaps it otherwise", () => {
    expect(plan({ type: "doc" })).toBe("in-place");
    expect(plan({ type: "doc", isolation: "opaque" })).toBe("swap");
    expect(plan({ type: "doc", pathFallback: true })).toBe("swap");
    expect(plan({ type: "doc", review: true })).toBe("swap");
    expect(plan({ type: "doc", liveRoomFrame: true })).toBe("swap");
    // A doc never holds: the frame keeps its place by updating in place.
    expect(plan({ type: "doc", holdDeclared: true, frameFocused: true })).toBe("in-place");
  });

  it("asks a page whose runtime said hello, under origin isolation only", () => {
    expect(plan({ runtimeHello: true })).toBe("ask");
    expect(plan({ runtimeHello: true, review: true })).toBe("ask");
    expect(plan({ runtimeHello: true, isolation: "opaque" })).toBe("swap");
    expect(plan({ runtimeHello: true, pathFallback: true })).toBe("swap");
    // Declaring hold without focus in the frame: still asked.
    expect(plan({ runtimeHello: true, holdDeclared: true })).toBe("ask");
  });

  it("holds a page that declares hold and has focus even when its runtime said hello", () => {
    // The runtime's carry keeps scroll and handed-over state, not what the viewer is typing.
    expect(plan({ runtimeHello: true, holdDeclared: true, frameFocused: true })).toBe("hold");
    expect(plan({ runtimeHello: true, holdDeclared: false, frameFocused: true })).toBe("ask");
  });

  it("holds only a page that declares hold, and only while focus is in its frame", () => {
    expect(plan({ holdDeclared: true, frameFocused: true })).toBe("hold");
    expect(plan({ holdDeclared: true, frameFocused: true, isolation: "opaque" })).toBe("hold");
    expect(plan({ holdDeclared: true, frameFocused: false })).toBe("swap");
    // Without the declaration, a page the viewer is using is replaced, as before.
    expect(plan({ holdDeclared: false, frameFocused: true })).toBe("swap");
    expect(plan({})).toBe("swap");
  });

  it("swaps the other typed artifacts", () => {
    for (const type of ["slides", "design_system", "design"] as const) {
      expect(plan({ type, holdDeclared: true, frameFocused: true, runtimeHello: true })).toBe(
        "swap",
      );
    }
  });
});

describe("carryPath", () => {
  it("keeps a path inside the artifact, and lands on the root otherwise", () => {
    // Never the hash: `next` goes into request URLs, and a fragment stays in the browser.
    expect(carryPath("/guide.html?tab=2#step-3")).toBe("/guide.html?tab=2");
    expect(carryPath("/guide.html#q=salary%20of%20Jane")).toBe("/guide.html");
    expect(carryPath("/#/route/7")).toBeNull();
    expect(carryPath("/")).toBeNull();
    expect(carryPath("/index.html")).toBeNull();
    expect(carryPath("/a?plinth-review=1&x=1#h")).toBe("/a?x=1");
    for (const bad of [
      "",
      "//evil.example/x",
      "/\\evil",
      "\\x",
      "/a\u0000b",
      "/a\nb",
      "relative",
      "https://evil.example/",
      "/__plinth/v/1/index.html",
      "/__plinth/enter?t=x",
      `/${"a".repeat(2048)}`,
      null,
      42,
    ]) {
      expect(carryPath(bad)).toBeNull();
    }
  });
});

describe("readViewMessage", () => {
  const ORIGIN = "http://art123.content.localhost:8787";
  const NONCE = "n".repeat(16);
  const win = {} as Window;
  const frame = { contentWindow: win } as HTMLIFrameElement;
  const opts: Parameters<typeof readViewMessage>[1] = {
    frame,
    contentOrigin: ORIGIN,
    nonce: NONCE,
  };
  const msg = (data: Record<string, unknown>) => ({ source: "plinth-view", v: 1, ...data });
  const read = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}, o = opts) =>
    readViewMessage(
      { source: (over.source ?? win) as Window, origin: over.origin ?? ORIGIN, data },
      o,
    );

  it("reads hello, update:ok and update:hold from the frame at its exact origin", () => {
    expect(read(msg({ type: "hello" }))).toEqual({ type: "hello" });
    expect(read(msg({ type: "update:ok", nonce: NONCE, path: "/p#x" }))).toEqual({
      type: "update:ok",
      nonce: NONCE,
      path: "/p",
    });
    expect(read(msg({ type: "update:hold", nonce: NONCE }))).toEqual({
      type: "update:hold",
      nonce: NONCE,
    });
    // An unsafe or missing path lands on the root.
    expect(read(msg({ type: "update:ok", nonce: NONCE, path: "//evil.example" }))).toEqual({
      type: "update:ok",
      nonce: NONCE,
      path: null,
    });
    expect(read(msg({ type: "update:ok", nonce: NONCE }))).toEqual({
      type: "update:ok",
      nonce: NONCE,
      path: null,
    });
  });

  it("refuses another window, another origin, and the opaque and wildcard origins", () => {
    const data = msg({ type: "hello" });
    expect(read(data, { source: {} })).toBeNull();
    expect(read(data, { source: window })).toBeNull();
    expect(read(data, { origin: "http://other.content.localhost:8787" })).toBeNull();
    expect(read(data, { origin: "null" })).toBeNull();
    for (const contentOrigin of ["*", "null", null]) {
      expect(
        read(data, { origin: contentOrigin ?? ORIGIN }, { ...opts, contentOrigin }),
      ).toBeNull();
    }
    expect(read(data, {}, { ...opts, frame: null })).toBeNull();
  });

  it("refuses the wrong nonce, the wrong source or version, and unknown types", () => {
    expect(read(msg({ type: "update:ok", nonce: "m".repeat(16), path: "/" }))).toBeNull();
    expect(read(msg({ type: "update:ok", nonce: NONCE }), {}, { ...opts, nonce: null })).toBeNull();
    expect(read(msg({ type: "update:hold", nonce: "short" }))).toBeNull();
    expect(read(msg({ type: "update:ok", nonce: NONCE, path: 5 }))).toBeNull();
    expect(read({ source: "plinth-renderer", v: 1, type: "hello" })).toBeNull();
    expect(read(msg({ type: "hello", v: 2 }))).toBeNull();
    expect(read(msg({ type: "update" }))).toBeNull();
    expect(read("hello")).toBeNull();
    expect(read(null)).toBeNull();
  });
});

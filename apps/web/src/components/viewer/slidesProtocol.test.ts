// The app's side of a deck: which frame messages it accepts (exact origin under origin isolation,
// "null" plus the frame's window under opaque isolation, decks only), the audience channel's
// messages and the URL fragment, and the version watch holding the frame while presenting.
import type { ViewGate } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import {
  channelName,
  isPairId,
  openPresentChannel,
  readFragment,
  readPresentMessage,
  writeFragment,
} from "./presentChannel.ts";
import { readSlidesFrameMessage, SLIDES_FRAME_KINDS } from "./slidesProtocol.ts";
import { nextGate } from "./useVersionWatch.ts";

const ORIGIN = "http://art123.content.localhost:8787";
const win = {} as Window;
const frame = { contentWindow: win } as HTMLIFrameElement;
const data = (m: Record<string, unknown>) => ({ source: "plinth-renderer", v: 1, ...m });

const read = (
  e: { source: unknown; origin: string; data: unknown },
  o: Partial<{ opaque: boolean; type: string; contentOrigin: string }> = {},
) =>
  readSlidesFrameMessage(e as MessageEvent, {
    frame,
    contentOrigin: o.contentOrigin ?? ORIGIN,
    opaque: o.opaque ?? false,
    type: o.type ?? "slides",
  });

describe("readSlidesFrameMessage", () => {
  it("lists the deck's frame kinds", () => {
    expect([...SLIDES_FRAME_KINDS]).toEqual([
      "ready",
      "position",
      "view",
      "fullscreen",
      "exported",
    ]);
  });

  it("accepts ready, position, view and fullscreen from the frame at the exact content origin", () => {
    const pos = {
      source: win,
      origin: ORIGIN,
      data: data({ type: "position", slide: 2, count: 5 }),
    };
    expect(read(pos)).toEqual({ type: "position", slide: 2, count: 5 });
    expect(read({ ...pos, data: data({ type: "ready", slide: 1, count: 1 }) })).toEqual({
      type: "ready",
      slide: 1,
      count: 1,
    });
    expect(read({ ...pos, data: data({ type: "fullscreen" }) })).toEqual({ type: "fullscreen" });
    for (const mode of ["deck", "presenter", "overview"]) {
      expect(read({ ...pos, data: data({ type: "view", mode }) })).toEqual({ type: "view", mode });
    }
  });

  it("under opaque isolation accepts only origin null from the frame's window", () => {
    const e = { source: win, origin: "null", data: data({ type: "position", slide: 2, count: 5 }) };
    expect(read(e, { opaque: true })).toEqual({ type: "position", slide: 2, count: 5 });
    expect(read(e)).toBeNull();
    expect(read({ ...e, origin: ORIGIN }, { opaque: true })).toBeNull();
    expect(read({ ...e, source: {} }, { opaque: true })).toBeNull();
  });

  it("refuses other windows, other origins, bad numbers, unknown kinds and non-deck artifacts", () => {
    const ok = {
      source: win,
      origin: ORIGIN,
      data: data({ type: "position", slide: 2, count: 5 }),
    };
    expect(read({ ...ok, source: {} })).toBeNull();
    expect(read({ ...ok, source: null })).toBeNull();
    expect(read({ ...ok, origin: "http://evil.example" })).toBeNull();
    expect(read(ok, { type: "doc" })).toBeNull();
    expect(read(ok, { type: "html" })).toBeNull();
    expect(read(ok, { contentOrigin: "*" })).toBeNull();
    for (const bad of [
      { type: "position", slide: 1.5, count: 5 },
      { type: "position", slide: 6, count: 5 },
      { type: "position", slide: 0, count: 5 },
      { type: "position", slide: "2", count: 5 },
      { type: "ready", slide: 1, count: 501 },
      { type: "view", mode: "audience" },
      { type: "view", mode: "toString" },
      { type: "view" },
      { type: "live" },
      { type: "toString" },
      { type: "__proto__" },
    ]) {
      expect(read({ ...ok, data: data(bad) })).toBeNull();
    }
    expect(read({ ...ok, data: { type: "position", slide: 1, count: 2 } })).toBeNull();
  });
});

describe("the audience channel", () => {
  it("validates messages: integers in range and known types only", () => {
    expect(readPresentMessage({ v: 1, type: "slide", slide: 3 })).toEqual({
      v: 1,
      type: "slide",
      slide: 3,
    });
    expect(readPresentMessage({ v: 1, type: "hello" })).toEqual({ v: 1, type: "hello" });
    for (const bad of [
      null,
      { v: 2, type: "hello" },
      { v: 1, type: "slide", slide: 0 },
      { v: 1, type: "slide", slide: 2.5 },
      { v: 1, type: "slide", slide: "2" },
      { v: 1, type: "text", text: "x" },
    ]) {
      expect(readPresentMessage(bad)).toBeNull();
    }
  });

  it("joins the pair's channel; hello gets the current slide", () => {
    const channels: { name: string; posted: unknown[]; onmessage?: (e: MessageEvent) => void }[] =
      [];
    class FakeChannel {
      posted: unknown[] = [];
      onmessage?: (e: MessageEvent) => void;
      constructor(readonly name: string) {
        channels.push(this);
      }
      postMessage(m: unknown) {
        this.posted.push(m);
        for (const c of channels)
          if (c !== this && c.name === this.name) c.onmessage?.({ data: m } as MessageEvent);
      }
      close() {}
    }
    const Channel = FakeChannel as unknown as typeof BroadcastChannel;
    const pair = "p".repeat(24);
    let current = 4;
    const presenter = openPresentChannel(
      "art",
      pair,
      (m) => {
        if (m.type === "hello") presenter?.post({ v: 1, type: "slide", slide: current });
      },
      Channel,
    );
    const got = vi.fn();
    const audience = openPresentChannel("art", pair, got, Channel);
    audience?.post({ v: 1, type: "hello" });
    expect(got).toHaveBeenCalledWith({ v: 1, type: "slide", slide: 4 });
    current = 5;
    presenter?.post({ v: 1, type: "slide", slide: current });
    expect(got).toHaveBeenLastCalledWith({ v: 1, type: "slide", slide: 5 });
    expect(channels.map((c) => c.name)).toEqual([
      channelName("art", pair),
      channelName("art", pair),
    ]);
    expect(openPresentChannel("art", "short", got, Channel)).toBeNull();
    expect(openPresentChannel("art", pair, got, null)).toBeNull();
  });

  it("reads and writes the URL fragment", () => {
    expect(readFragment("#slide=4")).toEqual({ slide: 4, pair: null });
    expect(readFragment("#slide=0")).toEqual({ slide: null, pair: null });
    expect(readFragment("#slide=2x")).toEqual({ slide: null, pair: null });
    expect(readFragment("")).toEqual({ slide: null, pair: null });
    const pair = "abcdefghijklmnop";
    expect(readFragment(`#present=audience&pair=${pair}`)).toEqual({ slide: null, pair });
    expect(readFragment("#present=audience&pair=bad")).toEqual({ slide: null, pair: null });
    expect(writeFragment("", 3)).toBe("#slide=3");
    expect(writeFragment(`#present=audience&pair=${pair}`, 2)).toBe(
      `#present=audience&pair=${pair}&slide=2`,
    );
    expect(isPairId(pair)).toBe(true);
    expect(isPairId("a b")).toBe(false);
  });
});

describe("the version watch while presenting", () => {
  type OkGate = Extract<ViewGate, { status: "ok" }>;
  const gate = (current: number, version: number, enter: string): OkGate => ({
    status: "ok",
    artifact: {
      id: "a1",
      slug: "s",
      title: "T",
      type: "slides",
      current_version: current,
      version,
      visibility: "unlisted",
      owner_name: null,
    },
    enter_url: enter,
    role: null,
  });

  it("present: keeps the frame and moves only the count of versions on", () => {
    const next = nextGate(gate(3, 3, "shown"), gate(4, 4, "new"), false, "present");
    expect(next?.enter_url).toBe("shown");
    expect(next?.artifact.version).toBe(3);
    expect(next?.artifact.current_version).toBe(4);
  });
});

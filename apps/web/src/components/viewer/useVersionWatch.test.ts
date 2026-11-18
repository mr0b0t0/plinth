import type { ViewGate } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { nextGate } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const gate = (current: number, version: number, enter = `e${current}`): OkGate => ({
  status: "ok",
  artifact: {
    id: "a1",
    slug: "s",
    title: "T",
    type: "html",
    current_version: current,
    version,
    visibility: "unlisted",
    owner_name: null,
  },
  enter_url: enter,
  role: null,
});

describe("nextGate", () => {
  it("keeps the shown gate when nothing newer exists", () => {
    expect(nextGate(gate(3, 3), gate(3, 3, "other"), false)).toBeNull();
    expect(nextGate(gate(3, 3), gate(2, 2), false)).toBeNull();
  });

  it("ignores gates that are not ok", () => {
    expect(nextGate(gate(3, 3), { status: "not_found" }, false)).toBeNull();
  });

  it("follows the current version with the fresh gate", () => {
    const fresh = gate(4, 4);
    expect(nextGate(gate(3, 3), fresh, false)).toBe(fresh);
  });

  it("keeps a pinned frame and only moves the current version on", () => {
    const shown = gate(3, 2, "pinned");
    const next = nextGate(shown, gate(4, 2, "new"), true);
    expect(next?.enter_url).toBe("pinned");
    expect(next?.artifact.version).toBe(2);
    expect(next?.artifact.current_version).toBe(4);
  });
});

describe("nextGate while a doc is edited on its page", () => {
  it("follow: keeps the frame and moves the bar to the new version", () => {
    const shown = gate(3, 3, "live");
    const next = nextGate(shown, gate(4, 4, "new"), false, "follow");
    expect(next?.enter_url).toBe("live");
    expect(next?.artifact.version).toBe(4);
    expect(next?.artifact.current_version).toBe(4);
  });

  it("hold: keeps the frame and the shown version, so the page can say a newer one exists", () => {
    const shown = gate(3, 3, "solo");
    const next = nextGate(shown, gate(4, 4, "new"), false, "hold");
    expect(next?.enter_url).toBe("solo");
    expect(next?.artifact.version).toBe(3);
    expect(next?.artifact.current_version).toBe(4);
  });

  it("changes nothing when no newer version exists", () => {
    expect(nextGate(gate(3, 3), gate(3, 3, "x"), false, "follow")).toBeNull();
    expect(nextGate(gate(3, 3), gate(3, 3, "x"), false, "hold")).toBeNull();
  });
});

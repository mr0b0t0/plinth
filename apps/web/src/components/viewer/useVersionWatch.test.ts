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

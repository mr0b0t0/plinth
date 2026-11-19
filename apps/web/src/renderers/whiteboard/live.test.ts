// The live room: may this viewer change the board, recomputed each time the room opens (a
// commenter on a board that just became editors-only reconnects without the right to emit, and
// their board turns read-only); and what peers send is checked before it is used.
import { describe, expect, it, vi } from "vitest";
import { Live } from "./live.ts";
import type { RoomStatus, RuntimeRoom } from "./runtime.ts";

function room(canEmit: { value: boolean }) {
  const statusSubs: ((s: RoomStatus) => void)[] = [];
  const topics = new Map<string, (d: unknown) => void>();
  const r = {
    get ready() {
      return Promise.resolve({ available: true, reason: null, canEmit: () => canEmit.value });
    },
    presence: vi.fn(() => true),
    onPeers: vi.fn(() => () => {}),
    emit: vi.fn(() => true),
    on: vi.fn((t: string, fn: (d: unknown) => void) => {
      topics.set(t, fn);
      return () => {};
    }),
    onStatus: vi.fn((fn: (s: RoomStatus) => void) => {
      statusSubs.push(fn);
      fn("open");
      return () => {};
    }),
    join: vi.fn(),
  };
  return {
    r: r as unknown as RuntimeRoom,
    raw: r,
    status: (s: RoomStatus) => {
      for (const fn of statusSubs) fn(s);
    },
    fire: (t: string, d: unknown) => topics.get(t)?.(d),
  };
}

const hooks = () => ({
  peers: vi.fn(),
  moved: vi.fn(),
  saved: vi.fn(),
  status: vi.fn(),
  canWrite: vi.fn(),
});

describe("Live", () => {
  it("turns the board read-only after a reconnect that took the right to emit away", async () => {
    const can = { value: true };
    const rm = room(can);
    const h = hooks();
    const live = new Live(rm.r, true, h);
    await live.start();
    expect(h.canWrite).toHaveBeenLastCalledWith(true);
    // The settings version lands: 4410, the runtime re-reads /room, the socket opens again.
    can.value = false;
    rm.status("reconnecting");
    rm.status("open");
    expect(h.canWrite).toHaveBeenLastCalledWith(false);
    expect(h.status).toHaveBeenCalledWith("reconnecting");
    expect(live.mayWrite()).toBe(false);
  });

  it("never lets a viewer the session refuses write, whatever the room says", async () => {
    const h = hooks();
    const live = new Live(room({ value: true }).r, false, h);
    await live.start();
    expect(h.canWrite).toHaveBeenLastCalledWith(false);
  });

  it("follows the session alone when the room is unavailable", async () => {
    const h = hooks();
    const r = {
      get ready() {
        return Promise.resolve({ available: false, reason: "disabled", canEmit: () => false });
      },
    } as unknown as RuntimeRoom;
    const live = new Live(r, true, h);
    expect((await live.start()).available).toBe(false);
    expect(h.canWrite).toHaveBeenLastCalledWith(true);
  });

  it("checks peers' events for shape", async () => {
    const rm = room({ value: true });
    const h = hooks();
    await new Live(rm.r, true, h).start();
    rm.fire("block.move", { id: "goal", x: 3, y: 4 });
    rm.fire("block.move", { id: "<x>", x: 3, y: 4 });
    rm.fire("block.move", { id: "goal", x: "3", y: 4 });
    rm.fire("block.move", null);
    expect(h.moved.mock.calls).toEqual([["goal", 3, 4]]);
    rm.fire("block.saved", { id: "goal" });
    rm.fire("arrow.saved", { id: 5 });
    rm.fire("arrow.saved", { id: "a1" });
    expect(h.saved.mock.calls).toEqual([
      ["blocks", "goal"],
      ["arrows", "a1"],
    ]);
  });
});

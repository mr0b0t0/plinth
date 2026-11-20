// The live room: may this viewer change the board, recomputed each time the room opens (a
// commenter on a board that just became editors-only reconnects without the right to emit, and
// their board turns read-only), with the session read again on each reconnect (a board opened to
// commenters becomes editable for them); and what peers send is checked before it is used.
import { describe, expect, it, vi } from "vitest";
import { Live } from "./live.ts";
import { type RoomStatus, type RuntimeRoom, readSessionCanWrite } from "./runtime.ts";

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

  it("reads the session again on a reconnect: a board opened to commenters lets them change it", async () => {
    const can = { value: false };
    const rm = room(can);
    const session = { value: false as boolean | null };
    const recheck = vi.fn(async () => session.value);
    const h = { ...hooks(), recheck };
    const live = new Live(rm.r, false, h);
    await live.start();
    expect(h.canWrite).toHaveBeenLastCalledWith(false);
    // The first open is not a reconnect: the session just loaded.
    expect(recheck).not.toHaveBeenCalled();
    // A settings version opens the board to commenters: 4410, /room again, then the session.
    can.value = true;
    session.value = true;
    rm.status("reconnecting");
    rm.status("open");
    await vi.waitFor(() => expect(h.canWrite).toHaveBeenLastCalledWith(true));
    expect(recheck).toHaveBeenCalledOnce();
    expect(live.mayWrite()).toBe(true);
    // And back: editors only again. The room and the session both say no.
    can.value = false;
    session.value = false;
    rm.status("reconnecting");
    rm.status("open");
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(2));
    expect(h.canWrite).toHaveBeenLastCalledWith(false);
    expect(live.mayWrite()).toBe(false);
    // A session that cannot be read keeps the last answer; the room still narrows it.
    session.value = null;
    can.value = true;
    rm.status("reconnecting");
    rm.status("open");
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(3));
    expect(live.mayWrite()).toBe(false);
  });

  it("reads can_write the way the runtime does, and null when it cannot", async () => {
    const answer = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const win = (fetch: unknown) => ({ fetch }) as unknown as Window;
    const ok = answer(200, { available: true, can_write: true });
    expect(await readSessionCanWrite(win(ok))).toBe(true);
    expect(ok).toHaveBeenCalledWith("/__plinth/api/v1/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-plinth-data": "1" },
    });
    expect(await readSessionCanWrite(win(answer(200, { available: true, can_write: false })))).toBe(
      false,
    );
    expect(await readSessionCanWrite(win(answer(200, { available: false })))).toBeNull();
    expect(await readSessionCanWrite(win(answer(401, {})))).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await readSessionCanWrite(win(down))).toBeNull();
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

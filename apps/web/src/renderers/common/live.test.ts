// The live draft socket client: the gen and rev rules, resync, unflushed text and its re-take after a
// reconnect, backoff, the hidden-tab rule and the solo fallback when the room never answers.
import {
  applySheetStruct,
  applySlidesStruct,
  LIMITS,
  liveDocServerFrameSchema,
  type SlidesStructOp,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClientLease,
  docSocketUrl,
  HIDDEN_CLOSE_MS,
  LiveDocClient,
  type LiveDocListener,
  locateBlock,
  readServerFrame,
} from "./live.ts";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1 as const;
  sent: unknown[] = [];
  closed: number | null = null;
  /**
   * Each frame's `id` (the room answers with it as `re`), kept apart so the frames read as before:
   * `idOf(t)` is the id of the last frame of kind `t` sent.
   */
  ids: { t: string; id: number }[] = [];
  idOf(t: string): number {
    const hit = this.ids.filter((x) => x.t === t).at(-1);
    if (!hit) throw new Error(`no ${t} sent`);
    return hit.id;
  }
  private unId(f: Record<string, unknown>): Record<string, unknown> {
    if (typeof f.id === "number") this.ids.push({ t: String(f.t), id: f.id });
    const { id: _id, ...rest } = f;
    return rest;
  }
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    this.sent.push(raw === "ping" ? raw : this.unId(JSON.parse(raw)));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** The server sends a frame. */
  frame(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
  }
  /** The server (or the network) closes it. */
  drop(code = 1006) {
    this.onclose?.({ code } as CloseEvent);
  }
  last() {
    return this.sent.at(-1) as Record<string, unknown>;
  }
}

function listener(): LiveDocListener & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...a: unknown[]) =>
      calls.push(a.length ? `${name}:${a.join(",")}` : name);
  return {
    calls,
    changed: rec("changed"),
    status: () => undefined,
    granted: (l: ClientLease) => calls.push(`granted:${l.start}-${l.end}`),
    denied: rec("denied"),
    lost: rec("lost"),
    version: (kind: string, n: number, info: { why?: string; was: number | null }) =>
      calls.push(
        `version:${kind},${n}${info.why ? `,${info.why}` : ""}${info.was ? `,was ${info.was}` : ""}`,
      ),
    // The code only: which frame it answered is the client's own bookkeeping.
    error: (code: string) => calls.push(`error:${code}`),
  };
}

const YOU = { id: "s1", email: "ada@example.org", right: "write" as const };

function welcome(ws: FakeSocket, text: string, over: Record<string, unknown> = {}) {
  ws.frame({
    t: "welcome",
    v: 1,
    you: YOU,
    gen: "g1",
    rev: 3,
    base_version: 2,
    flushed_rev: 3,
    conflict_version: null,
    last_by_you: false,
    leases: [],
    peers: [],
    ...over,
  });
  const gen = (over.gen as string) ?? "g1";
  const parts = text.length > 4 ? [text.slice(0, 4), text.slice(4)] : [text];
  parts.forEach((chunk, part) => {
    ws.frame({ t: "text", gen, part, of: parts.length, chunk });
  });
}

let L: ReturnType<typeof listener>;
let client: LiveDocClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  L = listener();
  client = new LiveDocClient({
    win: window,
    listener: L,
    connect: (u, p) => new FakeSocket(u, p),
    random: () => 0,
  });
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
});

const sock = () => FakeSocket.all.at(-1) as FakeSocket;

describe("LiveDocClient", () => {
  it("connects to the doc path with the room subprotocol and loads the chunked draft", () => {
    expect(docSocketUrl({ protocol: "https:", host: "a1.usercontent.example" })).toBe(
      "wss://a1.usercontent.example/__plinth/room/v1/doc",
    );
    client.start();
    expect(sock().protocols).toEqual(["plinth.room.v1"]);
    expect(sock().url).toMatch(/^ws:\/\/.*\/__plinth\/room\/v1\/doc$/);
    welcome(sock(), "# Title\n\nPara");
    expect(client.connected).toBe(true);
    expect(client.text).toBe("# Title\n\nPara");
    expect(client.rev).toBe(3);
    expect(client.baseVersion).toBe(2);
  });

  it("applies the next op only, and asks for a sync on a gap or another gen", () => {
    client.start();
    welcome(sock(), "a\n\nb");
    sock().frame({
      t: "leased",
      lease: "l1",
      start: 2,
      end: 3,
      holder: "s2",
      by: "bo@example.org",
    });
    sock().frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "l1",
      start: 2,
      del: 1,
      ins: "b2\nb3",
      by: "s2",
    });
    expect(client.lines).toEqual(["a", "", "b2", "b3"]);
    expect(client.leases.get("l1")).toMatchObject({ start: 2, end: 4 });
    expect(client.lastByYou).toBe(false);
    // A gap: not applied, a sync goes out once.
    sock().frame({ t: "op", gen: "g1", rev: 6, lease: "l1", start: 2, del: 2, ins: "x", by: "s2" });
    expect(client.lines).toEqual(["a", "", "b2", "b3"]);
    expect(sock().last()).toEqual({ t: "sync" });
    // Another gen is never taken for a continuation.
    const before = sock().sent.length;
    sock().frame({ t: "op", gen: "g9", rev: 5, lease: "l1", start: 0, del: 1, ins: "z", by: "s2" });
    expect(client.lines[0]).toBe("a");
    expect(sock().sent.length).toBe(before);
  });

  /** The ids of the frames of kind `t` sent on the current socket, oldest first. */
  const idsOf = (t: string) =>
    sock()
      .ids.filter((x) => x.t === t)
      .map((x) => x.id);

  it("puts an id on every frame the room answers directly, each its own", () => {
    client.start();
    welcome(sock(), "a\n\nb");
    client.lease({ start: 0, end: 1 });
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    client.edit("x");
    client.keep();
    client.release();
    client.takeover("l2");
    const ids = sock().ids.map((x) => x.t);
    expect(ids).toEqual(["lease", "edit", "keep", "release", "takeover"]);
    const nums = sock().ids.map((x) => x.id);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("an edit the room refuses (by its re) is not waiting for an ack, while a later one still is", () => {
    client.start();
    welcome(sock(), "a\n\nb");
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    expect(client.edit("x")).toBe(true);
    sock().frame({ t: "error", code: "invalid", re: idsOf("edit")[0] });
    expect(L.calls).toContain("error:invalid");
    expect(client.unflushed).toBe(false);
    // Two edits out; the room refuses the first: the second is still on its way.
    expect(client.edit("y")).toBe(true);
    expect(client.edit("z")).toBe(true);
    sock().frame({ t: "error", code: "too_large", re: idsOf("edit")[1] });
    expect(client.unflushed).toBe(true);
    sock().frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "mine",
      start: 0,
      del: 1,
      ins: "z",
      by: "s1",
      seq: 3,
      re: idsOf("edit")[2],
    });
    sock().frame({ t: "flushed", rev: 4 });
    expect(client.unflushed).toBe(false);
  });

  it("an edit answered not_held or with a denial is not waiting any more, and a refusal ends the edit it names", () => {
    const answers: unknown[] = [];
    const denied: string[] = [];
    const c = new LiveDocClient({
      win: window,
      listener: {
        ...L,
        error: (code, a) => answers.push([code, a]),
        editDenied: (r, seq) => denied.push(`${r}:${seq}`),
      },
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      countLeases: true,
    });
    c.start();
    try {
      welcome(sock(), "a\n\nb");
      sock().frame({ t: "leased", lease: "L1", start: 0, end: 1, holder: "s1", by: YOU.email });
      // Edit 1 goes on a lease the room had replaced: not_held.
      expect(c.edit("x")).toBe(true);
      sock().frame({ t: "error", code: "not_held", re: idsOf("edit")[0] });
      expect(answers.at(-1)).toEqual(["not_held", { edit: 1 }]);
      expect(c.unflushed).toBe(false);
      // Edit 2 comes after a freeze: denied, never taken for a lease request's answer.
      expect(c.edit("y")).toBe(true);
      sock().frame({ t: "lease_denied", reason: "frozen", re: idsOf("edit")[1] });
      expect(denied).toEqual(["frozen:2"]);
      expect(L.calls.filter((x) => x.startsWith("denied"))).toEqual([]);
      expect(c.unflushed).toBe(false);
      // Edits 3 and 4; the room refuses 4 first by its re (whatever the order): 3 is still out.
      expect(c.edit("z")).toBe(true);
      expect(c.edit("w")).toBe(true);
      sock().frame({ t: "error", code: "invalid", re: idsOf("edit")[3] });
      expect(answers.at(-1)).toEqual(["invalid", { edit: 4 }]);
      expect(c.unflushed).toBe(true);
      sock().frame({
        t: "op",
        gen: "g1",
        rev: 4,
        lease: "L1",
        start: 0,
        del: 1,
        ins: "z",
        by: "s1",
        seq: 3,
        re: idsOf("edit")[2],
      });
      sock().frame({ t: "flushed", rev: 4 });
      expect(c.unflushed).toBe(false);
    } finally {
      c.stop();
    }
  });

  it("errors and released frames with no re answer nothing: draft_limit, a takeover's released", () => {
    const answers: unknown[] = [];
    const c = new LiveDocClient({
      win: window,
      listener: { ...L, error: (code, a) => answers.push([code, a]) },
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      countLeases: true,
    });
    c.start();
    try {
      welcome(sock(), "a\n\nb\n\nc", {
        leases: [{ id: "B1", start: 2, end: 3, by: "bo@example.org" }],
      });
      sock().frame({ t: "leased", lease: "L1", start: 0, end: 1, holder: "s1", by: YOU.email });
      c.release();
      expect(c.takeover("B1")).toBe(true);
      // A flush's draft_limit (to every socket) answers nothing.
      sock().frame({ t: "error", code: "draft_limit" });
      expect(answers.at(-1)).toEqual(["draft_limit", undefined]);
      // Someone else takes L1 over first: its released has no re and is not the release's answer.
      sock().frame({ t: "released", lease: "L1" });
      // The release's own answer: not_held, by its re.
      sock().frame({ t: "error", code: "not_held", re: idsOf("release")[0] });
      expect(answers.at(-1)).toEqual(["not_held", { release: true }]);
      sock().frame({ t: "released", lease: "B1" });
      sock().frame({
        t: "leased",
        lease: "L2",
        start: 2,
        end: 3,
        holder: "s1",
        by: YOU.email,
        re: idsOf("takeover")[0],
      });
      expect(L.calls).toContain("granted:2-3");
      // A takeover the room answers not_held (its holder let go first) says so as the lease's.
      expect(c.takeover("B7")).toBe(true);
      sock().frame({ t: "error", code: "not_held", re: idsOf("takeover")[1] });
      expect(answers.at(-1)).toEqual(["not_held", { lease: true }]);
    } finally {
      c.stop();
    }
  });

  it("a sync the room drops over the rate (its re) is asked for again, and eats no other answer", () => {
    client.start();
    const ws = sock();
    welcome(ws, "a\nb\nc");
    ws.frame({ t: "op", gen: "g1", rev: 9, lease: "X1", start: 0, del: 1, ins: "z", by: "s2" });
    expect(idsOf("sync")).toHaveLength(1);
    client.lease({ start: 1, end: 2 });
    ws.frame({ t: "error", code: "rate_limited", re: idsOf("sync")[0] });
    ws.frame({ t: "lease_denied", reason: "held", by: "ben@example.org", re: idsOf("lease")[0] });
    expect(L.calls).toContain("denied:held,ben@example.org");
    expect(L.calls.filter((c) => c.startsWith("error"))).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(idsOf("sync")).toHaveLength(2);
  });

  it("with countLeases, passes on a denial for each request out, not only the first", () => {
    const counted = new LiveDocClient({
      win: window,
      listener: L,
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      countLeases: true,
    });
    counted.start();
    try {
      welcome(sock(), "a\n\nb");
      expect(counted.lease({ start: 0, end: 1 })).toBe(true);
      expect(counted.lease({ start: 2, end: 3 })).toBe(true);
      sock().frame({ t: "lease_denied", reason: "stale" });
      sock().frame({ t: "lease_denied", reason: "held", by: "bo@example.org" });
      // A third denial answers nothing this socket asked.
      sock().frame({ t: "lease_denied", reason: "stale" });
      expect(L.calls.filter((c) => c.startsWith("denied"))).toEqual([
        "denied:stale,",
        "denied:held,bo@example.org",
      ]);
    } finally {
      counted.stop();
    }
  });

  it("shifts other leases and recognizes its own ack", () => {
    client.start();
    welcome(sock(), "a\n\nb\n\nc");
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    sock().frame({
      t: "leased",
      lease: "l2",
      start: 4,
      end: 5,
      holder: "s2",
      by: "bo@example.org",
    });
    expect(L.calls).toContain("granted:0-1");
    expect(client.edit("a1\na2\na3")).toBe(true);
    expect(client.unflushed).toBe(true);
    sock().frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "mine",
      start: 0,
      del: 1,
      ins: "a1\na2\na3",
      by: "s1",
      seq: 1,
    });
    expect(client.mine).toMatchObject({ start: 0, end: 3 });
    expect(client.leases.get("l2")).toMatchObject({ start: 6, end: 7 });
    expect(client.lastByYou).toBe(true);
    expect(client.ackedText).toBe("a1\na2\na3");
    // Acked but not yet in D1: still unflushed until the room says it wrote rev 4.
    expect(client.unflushed).toBe(true);
    sock().frame({ t: "flushed", rev: 4 });
    expect(client.unflushed).toBe(false);
    expect(client.durableText).toBe("a1\na2\na3");
  });

  it("refuses an edit larger than one frame: sends nothing, says too_large, and returns false", () => {
    client.start();
    welcome(sock(), "a\n\nb");
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    const before = sock().sent.length;
    expect(client.edit("x".repeat(LIMITS.liveDocFrameBytes))).toBe(false);
    expect(sock().sent.length).toBe(before);
    expect(L.calls).toContain("error:too_large");
    expect(client.unflushed).toBe(false);
    // The lease stays, and an edit that fits goes out.
    expect(client.edit("a!")).toBe(true);
    expect(sock().last()).toMatchObject({ t: "edit", lease: "mine", text: "a!" });
  });

  it("loses its lease on a new gen after a reconnect, keeping the durable text to re-take", () => {
    client.start();
    welcome(sock(), "a\n\nb");
    sock().frame({ t: "leased", lease: "mine", start: 2, end: 3, holder: "s1", by: YOU.email });
    client.edit("b!");
    sock().frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "mine",
      start: 2,
      del: 1,
      ins: "b!",
      by: "s1",
      seq: 1,
    });
    // Evicted before the flush: the room comes back from D1 with the older text.
    sock().drop(1006);
    expect(L.calls).toContain("lost:reconnect");
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all.length).toBe(2);
    welcome(sock(), "a\n\nb", { gen: "g2", rev: 3 });
    expect(client.gen).toBe("g2");
    expect(client.text).toBe("a\n\nb");
    // The durable text is the block as it was leased: the editor finds it and resends "b!".
    expect(client.durableText).toBe("b");
    expect(locateBlock(client.lines, client.durableText ?? "", 2)).toBe(2);
  });

  it("backs off 1, 2, 5, 10 then 30 s between reconnects", () => {
    client.start();
    welcome(sock(), "a");
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = FakeSocket.all.length;
      sock().drop(1006);
      let ms = 0;
      while (FakeSocket.all.length === n) {
        vi.advanceTimersByTime(100);
        ms += 100;
      }
      waits.push(ms);
    }
    // random() = 0 gives half of each step.
    expect(waits).toEqual([500, 1000, 2500, 5000, 15000, 15000]);
  });

  it("reports failed and stops when the first connection never gets through", () => {
    client.start();
    sock().drop(1006);
    expect(client.failed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it("stops for good when access changed or the artifact is gone", () => {
    client.start();
    welcome(sock(), "a");
    sock().drop(4401);
    expect(client.ended).toBe("unauthorized");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it("closes a socket hidden for 60 s unless it holds unflushed text, and reopens when visible", () => {
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    client.start();
    welcome(sock(), "a");
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    client.edit("a!");
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 10);
    // Unacked text: the socket stays.
    expect(sock().closed).toBeNull();
    sock().frame({
      t: "op",
      gen: "g1",
      rev: 4,
      lease: "mine",
      start: 0,
      del: 1,
      ins: "a!",
      by: "s1",
      seq: 1,
    });
    sock().frame({ t: "flushed", rev: 4 });
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 10);
    expect(sock().closed).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBe(1);
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.all.length).toBe(2);
  });

  it("keep: answered `kept`; a room without it (invalid) gets no more, and not_held says nothing", () => {
    client.start();
    welcome(sock(), "a");
    sock().frame({ t: "leased", lease: "mine", start: 0, end: 1, holder: "s1", by: YOU.email });
    expect(client.keep()).toBe(true);
    expect(sock().last()).toEqual({ t: "keep", lease: "mine" });
    sock().frame({ t: "kept", lease: "mine" });
    // A keep racing a takeover: the lease went, and the room says not_held. Nothing for the editor.
    expect(client.keep()).toBe(true);
    sock().frame({ t: "error", code: "not_held" });
    // A room deployed before `keep` refuses it as invalid: none is sent again, and the editor
    // hears nothing (its block is not reset).
    expect(client.keep()).toBe(true);
    sock().frame({ t: "error", code: "invalid" });
    const sent = sock().sent.length;
    expect(client.keep()).toBe(false);
    expect(sock().sent.length).toBe(sent);
    expect(L.calls.filter((c) => c.startsWith("error"))).toEqual([]);
    // An edit's own error still reaches the editor.
    client.edit("a!");
    sock().frame({ t: "error", code: "invalid" });
    expect(L.calls).toContain("error:invalid");
  });

  it("keeps a hidden tab's socket while the editor holds text not in the draft (keepOpen)", () => {
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    let holding = true;
    const kept = new LiveDocClient({
      win: window,
      listener: listener(),
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      keepOpen: () => holding,
    });
    kept.start();
    welcome(sock(), "a");
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 10);
    expect(sock().closed).toBeNull();
    holding = false;
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS + 10);
    expect(sock().closed).toBe(1000);
    kept.stop();
  });

  it("follows reset, rebased, saved and conflict", () => {
    client.start();
    welcome(sock(), "a\nb");
    sock().frame({ t: "saved", version: 3, rev: 3 });
    expect(client.baseVersion).toBe(3);
    sock().frame({ t: "rebased", version: 4, gen: "g1", rev: 5 });
    sock().frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: "merged" });
    expect(client.text).toBe("merged");
    expect(client.rev).toBe(5);
    expect(client.baseVersion).toBe(4);
    expect(L.calls).toContain("version:rebased,4");
    const files = {
      added: [{ path: "new.png", kind: "added", after: 3 }],
      removed: [],
      replaced: [{ path: "chart.png", kind: "replaced", before: 2, after: 4 }],
      more: 12,
      same: 1,
    };
    sock().frame({ t: "conflict", version: 5, files });
    expect(client.conflictVersion).toBe(5);
    expect(client.conflictFiles).toEqual(files);
    expect(client.lease({ start: 0, end: 1 })).toBe(false);
    // A choice resolved it: the reset says which, and the draft was frozen against v5.
    sock().frame({ t: "reset", version: 6, gen: "g1", rev: 7, why: "published" });
    sock().frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: "mine" });
    expect(L.calls).toContain("version:reset,6,published,was 5");
    expect(client.conflictVersion).toBeNull();
    expect(client.conflictFiles).toBeNull();
  });

  it("refuses a conflict frame whose files part is not a summary, and a reset with another why", () => {
    client.start();
    welcome(sock(), "a");
    sock().frame({ t: "conflict", version: 5, files: { added: "x" } });
    expect(client.conflictVersion).toBeNull();
    sock().frame({
      t: "conflict",
      version: 5,
      files: { added: [], removed: [], replaced: [], more: -1, same: 0 },
    });
    expect(client.conflictVersion).toBeNull();
    sock().frame({ t: "reset", version: 6, gen: "g1", rev: 2, why: "merged" });
    sock().frame({ t: "text", gen: "g1", part: 0, of: 1, chunk: "x" });
    expect(client.text).toBe("a");
  });

  it("ignores frames that fail validation and denials it did not ask for", () => {
    client.start();
    welcome(sock(), "a");
    sock().frame({ t: "op", gen: "g1", rev: "4", lease: "x", start: 0, del: 0, ins: "", by: "s" });
    sock().onmessage?.({ data: "not json" } as MessageEvent);
    sock().frame({ t: "lease_denied", reason: "held", by: "bo@example.org" });
    expect(client.text).toBe("a");
    expect(L.calls.filter((c) => c.startsWith("denied"))).toEqual([]);
    client.lease({ start: 0, end: 1 });
    sock().frame({ t: "lease_denied", reason: "stale" });
    expect(L.calls).toContain("denied:stale,");
  });

  it("watch sockets never ask for a lease", () => {
    client.start();
    welcome(sock(), "a", { you: { ...YOU, right: "watch" } });
    expect(client.lease({ start: 0, end: 1 })).toBe(false);
  });
});

describe("locateBlock", () => {
  it("finds the nearest copy of a block, and keeps an empty one as an insert point", () => {
    const lines = ["x", "b", "", "b", "", "c"];
    expect(locateBlock(lines, "b", 4)).toBe(3);
    expect(locateBlock(lines, "b", 0)).toBe(1);
    expect(locateBlock(lines, "nope", 2)).toBe(-1);
    expect(locateBlock(lines, "", 99)).toBe(6);
  });
});

describe("LiveDocClient: a sheet's struct frames", () => {
  const SHEET = [
    '{"plinth":"sheet","v":1,"columns":[{"name":"A","type":"text"},{"name":"B","type":"number"}]}',
    '["x",1]',
    '["=B2",2]',
  ].join("\n");

  function sheetClient() {
    const l = listener();
    const denied: string[] = [];
    l.structDenied = (r, by) => denied.push(`${r}:${by ?? ""}`);
    const c = new LiveDocClient({
      win: window,
      listener: l,
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      applyStruct: applySheetStruct,
    });
    return { c, l, denied };
  }

  it("sends a struct at the current rev and applies the room's, unflushed until written", () => {
    const { c } = sheetClient();
    c.start();
    welcome(sock(), SHEET);
    const op = { op: "insert_rows", before: 2, count: 1 } as const;
    expect(c.struct(op)).toBe(true);
    expect(sock().last()).toEqual({ t: "struct", rev: 3, op });
    expect(c.unflushed).toBe(true);
    sock().frame({ t: "struct", gen: "g1", rev: 4, op, by: "s1" });
    expect(c.rev).toBe(4);
    expect(c.lines.slice(1)).toEqual(["[]", '["x",1]', '["=B3",2]']);
    expect(c.lastByYou).toBe(true);
    expect(c.unflushed).toBe(true);
    sock().frame({ t: "flushed", rev: 4 });
    expect(c.unflushed).toBe(false);
    c.stop();
  });

  it("resyncs on a gap, another gen, a lease it still sees, or without an applier", () => {
    const { c } = sheetClient();
    c.start();
    welcome(sock(), SHEET);
    const op = { op: "delete_rows", from: 2, count: 1 };
    sock().frame({ t: "struct", gen: "g1", rev: 9, op, by: "s2" });
    expect(sock().last()).toEqual({ t: "sync" });
    expect(c.rev).toBe(3);
    c.stop();
    // A doc's client has no applier: any struct frame asks for the draft again.
    client.start();
    welcome(sock(), "# Doc");
    sock().frame({ t: "struct", gen: "g1", rev: 4, op, by: "s2" });
    expect(sock().last()).toEqual({ t: "sync" });
    expect(client.text).toBe("# Doc");
    expect(client.struct({ op: "insert_rows", before: 2, count: 1 })).toBe(false);
  });

  it("tells the editor when its struct was refused, only for its own", () => {
    const { c, denied } = sheetClient();
    c.start();
    welcome(sock(), SHEET);
    sock().frame({ t: "struct_denied", reason: "held", by: "bo@example.org" });
    expect(denied).toEqual([]);
    c.struct({ op: "delete_columns", from: "B", count: 1 });
    sock().frame({ t: "struct_denied", reason: "held", by: "bo@example.org" });
    expect(denied).toEqual(["held:bo@example.org"]);
    expect(c.unflushed).toBe(false);
    c.stop();
  });
});

describe("LiveDocClient: a deck's struct frames", () => {
  const DECK = ["# A", "", "alpha", "", "---", "", "# B", "", "beta"].join("\n");

  it("applies a deck's op while others hold leases, and moves every lease by its line map", () => {
    const c = new LiveDocClient({
      win: window,
      listener: listener(),
      connect: (u, p) => new FakeSocket(u, p),
      random: () => 0,
      applyStruct: (lines, op) => applySlidesStruct(lines, op as SlidesStructOp),
    });
    c.start();
    welcome(sock(), DECK, {
      leases: [{ id: "lb", start: 8, end: 9, by: "bo@example.org" }],
      peers: [{ id: "s2", email: "bo@example.org", lease: "lb" }],
    });
    sock().frame({ t: "struct", gen: "g1", rev: 4, op: { op: "add_notes", n: 1 }, by: "s1" });
    expect(c.rev).toBe(4);
    expect(c.lines.slice(0, 6)).toEqual(["# A", "", "alpha", "", "Note:", ""]);
    expect(c.leases.get("lb")).toMatchObject({ start: 10, end: 11 });
    c.stop();
  });

  it("accepts a deck's ops and refuses a footer on two lines", () => {
    const bad = { op: "set_deck", aspect: "16:9", theme: "auto", paginate: true, footer: "a\nb" };
    expect(readServerFrame({ t: "struct", gen: "g", rev: 4, op: bad, by: "s" })).toBeNull();
    expect(
      readServerFrame({ t: "struct", gen: "g", rev: 4, op: { op: "add_notes", n: 0 }, by: "s" }),
    ).toBeNull();
  });
});

describe("readServerFrame", () => {
  const FRAMES: Record<string, unknown>[] = [
    {
      t: "welcome",
      v: 1,
      you: { id: "s", email: "a@b.c", right: "write" },
      gen: "g",
      rev: 0,
      base_version: 1,
      flushed_rev: 0,
      conflict_version: null,
      last_by_you: false,
      leases: [{ id: "l", start: 0, end: 1, by: "a@b.c" }],
      peers: [{ id: "p", email: "a@b.c", lease: null }],
    },
    { t: "text", gen: "g", part: 0, of: 1, chunk: "x" },
    { t: "leased", lease: "l", start: 0, end: 2, holder: "s", by: "a@b.c" },
    { t: "lease_denied", reason: "held", by: "a@b.c" },
    { t: "lease_denied", reason: "stale" },
    { t: "op", gen: "g", rev: 1, lease: "l", start: 0, del: 1, ins: "x", by: "s", seq: 3 },
    { t: "released", lease: "l" },
    { t: "lease_lost", lease: "l", reason: "takeover" },
    { t: "flushed", rev: 2 },
    { t: "saved", version: 2, rev: 3 },
    { t: "reset", version: 2, gen: "g", rev: 3 },
    { t: "rebased", version: 2, gen: "g", rev: 3 },
    { t: "conflict", version: 4 },
    { t: "status", dirty: true, editors: ["a@b.c"], last_edit_at: null, last_by_you: false },
    { t: "error", code: "draft_limit" },
    { t: "struct", gen: "g", rev: 4, op: { op: "insert_rows", before: 2, count: 1 }, by: "s" },
    { t: "struct", gen: "g", rev: 4, op: { op: "delete_rows", from: 3, count: 2 }, by: "s" },
    {
      t: "struct",
      gen: "g",
      rev: 4,
      op: {
        op: "insert_columns",
        before: "B",
        columns: [
          { name: "Price", type: "number", format: { style: "currency", currency: "EUR" } },
          { name: "Stage", type: "select", options: ["a", "b"], width: 120 },
        ],
      },
      by: "s",
    },
    { t: "struct", gen: "g", rev: 4, op: { op: "delete_columns", from: "C", count: 1 }, by: "s" },
    { t: "struct", gen: "g", rev: 4, op: { op: "move_rows", from: 5, count: 2, to: 2 }, by: "s" },
    { t: "struct", gen: "g", rev: 4, op: { op: "add_notes", n: 3 }, by: "s" },
    { t: "struct", gen: "g", rev: 4, op: { op: "remove_notes", n: 1 }, by: "s" },
    { t: "struct", gen: "g", rev: 4, op: { op: "trim_start" }, by: "s" },
    {
      t: "struct",
      gen: "g",
      rev: 4,
      op: { op: "set_deck", aspect: "4:3", theme: "dark", paginate: false, footer: "Q4" },
      by: "s",
    },
    { t: "struct_denied", reason: "held", by: "a@b.c" },
    { t: "struct_denied", reason: "stale" },
    { t: "kept", lease: "l_abc" },
  ];

  it("accepts every well-formed frame, as the shared schema does", () => {
    for (const f of FRAMES) {
      expect(readServerFrame(f), JSON.stringify(f)).not.toBeNull();
      expect(liveDocServerFrameSchema.safeParse(f).success).toBe(true);
    }
  });

  it("never accepts a frame the shared schema refuses (field-by-field mutations)", () => {
    const bad: unknown[] = [-1, 1.5, "1", null, true, {}, [], "x".repeat(300), "bad id!"];
    for (const f of FRAMES) {
      for (const key of Object.keys(f)) {
        for (const value of bad) {
          const m = { ...f, [key]: value };
          if (readServerFrame(m)) {
            expect(
              liveDocServerFrameSchema.safeParse(m).success,
              `${f.t}.${key}=${JSON.stringify(value)}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(readServerFrame({ t: "nope" })).toBeNull();
    expect(readServerFrame("op")).toBeNull();
  });

  it("never accepts a struct op the shared schema refuses", () => {
    const bad: unknown[] = [-1, 0, 1.5, "1", "c", null, true, {}, [], "x".repeat(300)];
    for (const f of FRAMES.filter((x) => x.t === "struct")) {
      const op = f.op as Record<string, unknown>;
      for (const key of [...Object.keys(op), "values"]) {
        for (const value of bad) {
          const m = { ...f, op: { ...op, [key]: value } };
          if (readServerFrame(m)) {
            expect(
              liveDocServerFrameSchema.safeParse(m).success,
              `${op.op}.${key}=${JSON.stringify(value)}`,
            ).toBe(true);
          }
        }
      }
    }
    const cols = FRAMES.find((x) => (x.op as { op?: string } | undefined)?.op === "insert_columns");
    const withColumn = (c: unknown) => ({
      ...cols,
      op: { op: "insert_columns", before: "B", columns: [c] },
    });
    for (const c of [
      { name: "" },
      { name: "x", type: "money" },
      { name: "x", colour: "red" },
      { name: "x", format: { style: "currency", currency: "eur" } },
      { name: "x", options: [] },
      { name: "x", width: 10 },
    ]) {
      expect(readServerFrame(withColumn(c)), JSON.stringify(c)).toBeNull();
      expect(liveDocServerFrameSchema.safeParse(withColumn(c)).success).toBe(false);
    }
  });
});

// Round 4 review: frames the room sends that are not the answer to this socket's oldest frame.
describe("round 4: answers matched to frames, against doc.ts's unsolicited and untracked answers", () => {
  it("a draft_limit error from a flush (doc.ts flush, to every socket) does not eat a lease's denial", () => {
    client.start();
    const ws = sock();
    welcome(ws, "a\nb\nc");
    client.lease({ start: 1, end: 2 });
    // The room flushes someone's edits while the owner is at the draft limit: every socket gets it.
    ws.frame({ t: "error", code: "draft_limit" });
    // Then the room answers the lease: Ben holds those lines.
    ws.frame({ t: "lease_denied", reason: "held", by: "ben@example.org" });
    expect(L.calls).toContain("denied:held,ben@example.org");
  });

  it("a rate-limited sync (untracked) does not eat the answer of the lease sent after it", () => {
    client.start();
    const ws = sock();
    welcome(ws, "a\nb\nc");
    // A gap: the client asks for a sync.
    ws.frame({ t: "op", gen: "g1", rev: 9, lease: "X1", start: 0, del: 1, ins: "z", by: "s2" });
    expect(ws.sent.some((f) => (f as { t?: string }).t === "sync")).toBe(true);
    client.lease({ start: 1, end: 2 });
    // ArtifactRoom drops the sync as over the rate: `error rate_limited`, then answers the lease.
    ws.frame({ t: "error", code: "rate_limited" });
    ws.frame({ t: "lease_denied", reason: "held", by: "ben@example.org" });
    expect(L.calls).toContain("denied:held,ben@example.org");
  });
});

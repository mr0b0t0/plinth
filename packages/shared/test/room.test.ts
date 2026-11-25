import { describe, expect, it } from "vitest";
import {
  canEmitTopic,
  mergePresence,
  ROOM_BOUNDS,
  ROOM_CLOSE,
  ROOM_DEFAULTS,
  ROOM_LIMITS,
  ROOM_NAME_RE,
  ROOM_PROTOCOL,
  ROOM_TOPIC_RE,
  roomClientFrameSchema,
} from "../src/index.ts";

describe("room constants", () => {
  it("names the protocol, close codes and limits", () => {
    expect(ROOM_PROTOCOL).toBe("plinth.room.v1");
    expect(ROOM_CLOSE).toEqual({
      invalid: 4400,
      unauthorized: 4401,
      forbidden: 4403,
      gone: 4404,
      full: 4409,
      redeclared: 4410,
      resync: 4412,
      rate: 4429,
    });
    expect(ROOM_LIMITS.presenceBytes).toBe(400);
    expect(ROOM_LIMITS.roomsPerConnection).toBe(3);
    expect(ROOM_LIMITS.socketsPerViewer).toBe(8);
    expect(ROOM_LIMITS.connectsPerViewerPerMinute).toBe(20);
    expect(ROOM_LIMITS.maxOpenTopics).toBe(16);
    // Presence in every joined room fits the hibernation attachment.
    expect(ROOM_LIMITS.presenceBytes * ROOM_LIMITS.roomsPerConnection).toBeLessThan(
      ROOM_LIMITS.attachmentBytes,
    );
    expect(ROOM_DEFAULTS).toEqual({
      maxConnectionsPerArtifact: 50,
      maxMessageBytes: 8192,
      messagesPerSecond: 20,
    });
    expect(ROOM_BOUNDS.maxMessageBytes).toEqual([512, 65536]);
  });

  it("topic and room names", () => {
    for (const ok of ["cursor", "note.move", "a:b", "x_y-z", `a${"b".repeat(39)}`])
      expect(ROOM_TOPIC_RE.test(ok)).toBe(true);
    for (const bad of ["", "Cursor", "1a", ".a", "a b", "*", `a${"b".repeat(40)}`])
      expect(ROOM_TOPIC_RE.test(bad)).toBe(false);
    for (const ok of ["main", "board-2", "a_b"]) expect(ROOM_NAME_RE.test(ok)).toBe(true);
    for (const bad of ["", "Main", "a.b", "a:b", "2"]) expect(ROOM_NAME_RE.test(bad)).toBe(false);
  });
});

describe("room helpers", () => {
  it("presence merges shallowly, null deletes a key, a null patch clears", () => {
    expect(mergePresence({ x: 1, y: 2 }, { y: 3, z: 4 })).toEqual({ x: 1, y: 3, z: 4 });
    expect(mergePresence({ x: 1, y: 2 }, { y: null })).toEqual({ x: 1 });
    expect(mergePresence({ x: 1 }, null)).toEqual({});
    const prev = { x: 1 };
    mergePresence(prev, { x: 2 });
    expect(prev).toEqual({ x: 1 });
  });

  it("emit: owners and editors any topic, commenters only open ones, viewers none", () => {
    expect(canEmitTopic("all", [], "note.move")).toBe(true);
    expect(canEmitTopic("open", [], "note.move")).toBe(false);
    expect(canEmitTopic("open", ["cursor"], "cursor")).toBe(true);
    expect(canEmitTopic("open", ["cursor"], "note.move")).toBe(false);
    expect(canEmitTopic("open", ["*"], "note.move")).toBe(true);
    // A viewer never emits, even a topic the page opens to everyone.
    expect(canEmitTopic("none", ["*"], "note.move")).toBe(false);
    expect(canEmitTopic("none", ["cursor"], "cursor")).toBe(false);
    // An invalid topic is refused whoever sends it.
    expect(canEmitTopic("all", ["*"], "Bad Topic")).toBe(false);
  });

  it("client frames", () => {
    for (const f of [
      { t: "join", room: "board-2" },
      { t: "leave", room: "main" },
      { t: "presence", room: "main", state: { x: 1, y: 2 } },
      { t: "presence", room: "main", state: null },
      { t: "emit", room: "main", topic: "note.move", data: { id: "a", x: 1 } },
    ])
      expect(roomClientFrameSchema.safeParse(f).success, JSON.stringify(f)).toBe(true);
    for (const f of [
      { t: "join", room: "Main" },
      { t: "presence", room: "main", state: [1] },
      { t: "emit", room: "main", topic: "*", data: 1 },
      { t: "welcome" },
    ])
      expect(roomClientFrameSchema.safeParse(f).success, JSON.stringify(f)).toBe(false);
  });
});

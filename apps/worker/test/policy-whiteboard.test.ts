// The write floor on fixed capabilities (policy.ts pageWriteFloor): who may write a whiteboard's
// shared data from its page and emit its open topics. A whiteboard's versions carry `writers`
// (set by the server from its settings); a missing or unknown value fails closed to commenter, and
// an HTML page keeps the rule it always had (any identified viewer writes).
import {
  type ArtifactType,
  BOARD_TOPICS,
  boardCapabilities,
  type Capabilities,
  type EffectiveRole,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  liveViewAccess,
  meetsFloor,
  type PageClaim,
  type Principal,
  pageDataAccess,
  pageWriteFloor,
  roomAccess,
  roomOpenTopics,
} from "../src/policy.ts";
import { roomDeclaration } from "../src/rooms/notify.ts";

const ROLES: EffectiveRole[] = ["viewer", "commenter", "editor", "owner"];
const claimOf = (role: EffectiveRole): PageClaim => ({
  email: `${role}@example.com`,
  role,
  viewerId: "u_0123456789abcdef01234567",
  account: true,
});
const board = (edit: "commenters" | "editors") =>
  boardCapabilities({ v: 1, background: "dots", edit });
const withoutWriters = (c: Capabilities): Capabilities => {
  const { writers: _, ...rest } = c;
  return rest;
};
const html = (over: Partial<Capabilities> = {}): Capabilities => ({
  data: true,
  viewer: true,
  shared: [],
  room: true,
  roomOpen: ["cursor"],
  people: false,
  comments: false,
  dictation: false,
  hold: false,
  files: false,
  requests: false,
  requestsTo: [],
  ...over,
});

describe("policy: pageWriteFloor", () => {
  it("is any identified viewer on an HTML page, and fails closed on every other type", () => {
    expect(pageWriteFloor("html", html())).toBe("viewer");
    expect(pageWriteFloor("html", null)).toBe("viewer");
    expect(pageWriteFloor("whiteboard", withoutWriters(board("commenters")))).toBe("commenter");
    expect(pageWriteFloor("whiteboard", null)).toBe("commenter");
    expect(pageWriteFloor("whiteboard", board("commenters"))).toBe("commenter");
    expect(pageWriteFloor("whiteboard", board("editors"))).toBe("editor");
    // A type this Worker does not know counts as fixed.
    expect(pageWriteFloor("future-type", html())).toBe("commenter");
    // A stored floor is honoured on any type (only the server ever sets it).
    expect(pageWriteFloor("html", html({ writers: "editor" }))).toBe("editor");
  });

  it("ranks viewer < commenter < editor < owner", () => {
    expect(meetsFloor("viewer", "commenter")).toBe(false);
    expect(meetsFloor("commenter", "commenter")).toBe(true);
    expect(meetsFloor("commenter", "editor")).toBe(false);
    expect(meetsFloor("owner", "editor")).toBe(true);
  });
});

describe("policy: pageDataAccess on a whiteboard", () => {
  it("viewers read and see who wrote, but never write; commenters write only on a commenters board", () => {
    const rows: [EffectiveRole, "commenters" | "editors", boolean][] = [
      ["viewer", "commenters", false],
      ["viewer", "editors", false],
      ["commenter", "commenters", true],
      ["commenter", "editors", false],
      ["editor", "commenters", true],
      ["editor", "editors", true],
      ["owner", "commenters", true],
      ["owner", "editors", true],
    ];
    for (const [role, edit, write] of rows) {
      expect(
        pageDataAccess(claimOf(role), board(edit), true, "whiteboard"),
        `${role} ${edit}`,
      ).toEqual({
        read: true,
        write,
        seeIdentity: true,
      });
    }
    // An anonymous reader reads only, and sees nobody.
    expect(pageDataAccess(null, board("commenters"), true, "whiteboard")).toEqual({
      read: true,
      write: false,
      seeIdentity: false,
    });
    // Shared data off: nothing.
    expect(pageDataAccess(claimOf("owner"), board("commenters"), false, "whiteboard")).toEqual({
      read: false,
      write: false,
      seeIdentity: false,
    });
  });

  it("fails closed when the stored floor is missing", () => {
    const caps = withoutWriters(board("editors"));
    expect(pageDataAccess(claimOf("viewer"), caps, true, "whiteboard").write).toBe(false);
    expect(pageDataAccess(claimOf("commenter"), caps, true, "whiteboard").write).toBe(true);
  });

  it("keeps HTML as it was: every identified viewer writes, seeIdentity is the old write && viewer", () => {
    for (const role of ROLES) {
      for (const viewer of [true, false]) {
        for (const enabled of [true, false]) {
          const caps = html({ viewer });
          const r = pageDataAccess(claimOf(role), caps, enabled, "html");
          expect(r.write).toBe(enabled);
          expect(r.seeIdentity).toBe(r.write && viewer);
          const anon = pageDataAccess(null, caps, enabled, "html");
          expect(anon).toEqual({ read: enabled, write: false, seeIdentity: false });
        }
      }
    }
  });
});

describe("policy: roomAccess on a whiteboard", () => {
  const on = { active: true, type: "whiteboard" as ArtifactType };

  it("owners and editors emit everything; commenters the board's topics on a commenters board only", () => {
    for (const edit of ["commenters", "editors"] as const) {
      for (const role of ["owner", "editor"] as const) {
        expect(roomAccess(claimOf(role), board(edit), "page", on)).toMatchObject({
          join: true,
          emit: "all",
          seeIdentity: true,
          doc: "none",
        });
      }
    }
    expect(roomAccess(claimOf("commenter"), board("commenters"), "page", on)).toEqual({
      join: true,
      emit: "open",
      openTopics: [...BOARD_TOPICS],
      seeIdentity: true,
      doc: "none",
    });
    expect(roomAccess(claimOf("commenter"), board("editors"), "page", on)).toEqual({
      join: true,
      emit: "none",
      openTopics: [],
      seeIdentity: true,
      doc: "none",
    });
    for (const edit of ["commenters", "editors"] as const) {
      expect(roomAccess(claimOf("viewer"), board(edit), "page", on)).toMatchObject({
        join: true,
        emit: "none",
      });
    }
  });

  it("treats a board without a stored floor as a commenters board", () => {
    expect(
      roomAccess(claimOf("commenter"), withoutWriters(board("commenters")), "page", on),
    ).toMatchObject({ emit: "open", openTopics: [...BOARD_TOPICS] });
  });

  it("gives no doc socket on a whiteboard, and no page room on a doc", () => {
    expect(roomAccess(claimOf("owner"), board("commenters"), "doc", on).join).toBe(false);
    const doc = { active: true, type: "doc" as ArtifactType };
    expect(roomAccess(claimOf("owner"), board("commenters"), "page", doc).join).toBe(false);
  });

  it("keeps HTML's open topics as declared", () => {
    const html1 = { active: true, type: "html" as ArtifactType };
    expect(
      roomAccess(claimOf("commenter"), html({ roomOpen: ["a", "b"] }), "page", html1),
    ).toMatchObject({
      emit: "open",
      openTopics: ["a", "b"],
    });
  });
});

describe("room declarations", () => {
  it("opens no topics when only editors write", () => {
    expect(roomOpenTopics(board("editors"))).toEqual([]);
    expect(roomOpenTopics({ roomOpen: ["x"], writers: "editor" })).toEqual([]);
    expect(roomOpenTopics(board("commenters"))).toEqual([...BOARD_TOPICS]);
    expect(roomOpenTopics(null)).toEqual([]);
  });

  it("differs between the two edit modes, so a settings version reconnects the room", () => {
    const a = roomDeclaration(board("commenters"));
    const b = roomDeclaration(board("editors"));
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    // A socket admitted under editors mode carries no open topics: the alarm sees no change.
    expect(roomDeclaration({ room: true, viewer: true, roomOpen: [] })).toBe(b);
    // Background only: the same declaration.
    expect(
      roomDeclaration(boardCapabilities({ v: 1, background: "grid", edit: "commenters" })),
    ).toBe(a);
  });
});

describe("policy: liveViewAccess on a whiteboard", () => {
  it("sends data signals on a whiteboard, as on an HTML page", () => {
    const anon: Principal = { kind: "anonymous" };
    const r = liveViewAccess(anon, { allow: true, role: null }, board("commenters"), {
      active: true,
      sharedData: true,
      type: "whiteboard",
    });
    expect(r).toEqual({ watch: true, data: true });
  });
});

// Following the presenter: the `slides` branch of roomAccess (policy.ts slidesRoomAccess), for
// every role and type. Owners and editors present, everyone else identified watches; nobody's
// identity is shown, nobody emits, and nothing but a type with `follow` has the channel.
import { ARTIFACT_TYPES, type Capabilities, TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { type PageClaim, roomAccess } from "../src/policy.ts";

const claimOf = (role: PageClaim["role"], account?: boolean): PageClaim => ({
  email: `${role}@example.com`,
  role,
  viewerId: "u_0123456789abcdef01234567",
  ...(account === undefined ? {} : { account }),
});
const NONE = { join: false, emit: "none", openTopics: [], seeIdentity: false, doc: "none" };
const deck = { active: true, type: "slides" as const };

describe("policy: roomAccess for the slides channel", () => {
  it("owners and editors present; commenters and viewers watch; signed in or by code alike", () => {
    const want = { owner: "present", editor: "present", commenter: "watch", viewer: "watch" };
    for (const role of ["owner", "editor", "commenter", "viewer"] as const)
      for (const account of [true, false, undefined]) {
        expect(roomAccess(claimOf(role, account), null, "slides", deck), role).toEqual({
          join: true,
          emit: "none",
          openTopics: [],
          seeIdentity: false,
          doc: "none",
          slides: want[role],
        });
      }
  });

  it("nothing while rooms are inactive, without an identity claim, or for a type without follow", () => {
    expect(roomAccess(claimOf("owner", true), null, "slides", { ...deck, active: false })).toEqual(
      NONE,
    );
    expect(roomAccess(null, null, "slides", deck)).toEqual(NONE);
    for (const type of ARTIFACT_TYPES) {
      if (TYPE_REGISTRY[type].follow) continue;
      expect(
        roomAccess(claimOf("owner", true), null, "slides", { active: true, type }),
        type,
      ).toEqual(NONE);
    }
  });

  it("ignores what a version declares, and gives no right on the other kinds", () => {
    const caps: Capabilities = {
      data: true,
      viewer: true,
      shared: [],
      room: true,
      roomOpen: ["*"],
      people: true,
      comments: false,
      dictation: false,
      hold: false,
      files: false,
      requests: false,
      requestsTo: [],
    };
    expect(roomAccess(claimOf("viewer"), caps, "slides", deck)).toMatchObject({
      seeIdentity: false,
      emit: "none",
      openTopics: [],
      slides: "watch",
    });
    // A deck has no page room and no doc channel.
    expect(roomAccess(claimOf("owner", true), caps, "page", deck)).toEqual(NONE);
    expect(roomAccess(claimOf("owner", true), null, "doc", deck)).toEqual(NONE);
    // Page and doc sockets carry no slides right.
    expect(
      roomAccess(claimOf("owner", true), caps, "page", { active: true, type: "html" }),
    ).not.toHaveProperty("slides");
    expect(
      roomAccess(claimOf("owner", true), null, "doc", { active: true, type: "doc" }),
    ).not.toHaveProperty("slides");
  });
});

// Who may list an artifact's people (policy.ts): pagePeopleAccess on the page, and the `people`
// action for agents and the app. Owners and editors only, never anyone else, and only where the
// page offers the list (peopleListOffered). Whose names an access list shows (accessListShowsName).
import { type Capabilities, type EffectiveRole, ROLES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type ArtifactFacts,
  accessListShowsName,
  decide,
  type PageClaim,
  type Principal,
  pagePeopleAccess,
  peopleListOffered,
  scopeFor,
} from "../src/policy.ts";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  data: true,
  viewer: true,
  shared: [],
  room: false,
  roomOpen: [],
  comments: false,
  people: true,
  ...over,
});

const claimOf = (role: EffectiveRole): PageClaim => ({
  email: `${role}@example.com`,
  role,
  viewerId: "u_0123456789abcdef01234567",
});

describe("policy: pagePeopleAccess", () => {
  it("lists only for owners and editors, on a declared page, while shared data is active", () => {
    const roles: EffectiveRole[] = ["owner", ...ROLES];
    for (const role of [...roles, null]) {
      for (const declared of [true, false]) {
        for (const active of [true, false]) {
          const claim = role ? claimOf(role) : null;
          const c = declared ? caps() : caps({ people: false });
          const want = active && declared && (role === "owner" || role === "editor");
          expect(pagePeopleAccess(claim, c, active), `${role} ${declared} ${active}`).toEqual({
            list: want,
          });
        }
      }
    }
  });

  it("needs `data` and `viewer` too, and nothing without a declaration", () => {
    const owner = claimOf("owner");
    expect(pagePeopleAccess(owner, caps({ viewer: false }), true).list).toBe(false);
    expect(pagePeopleAccess(owner, caps({ data: false, room: true }), true).list).toBe(false);
    expect(pagePeopleAccess(owner, null, true).list).toBe(false);
  });
});

describe("policy: the people action", () => {
  const artifact = (over: Partial<ArtifactFacts> = {}): ArtifactFacts => ({
    id: "peopleartifact000001",
    ownerId: "u-owner",
    visibility: "unlisted",
    hasPassword: false,
    deleted: false,
    takenDown: false,
    ...over,
  });
  const user = (id: string): Principal => ({
    kind: "user",
    userId: id,
    email: `${id}@example.com`,
    isAdmin: false,
  });
  const agent = (id: string, scopes: string[]): Principal => ({
    kind: "agent",
    userId: id,
    email: `${id}@example.com`,
    connectionId: "c1",
    connectionLabel: "Work",
    clientType: "claude",
    scopes: new Set(scopes) as never,
    boundArtifactId: null,
  });
  const access = (grantRole: "viewer" | "commenter" | "editor" | null) => ({
    grantRole,
    passwordPassed: false,
  });

  it("needs artifacts:read", () => {
    expect(scopeFor("people")).toBe("artifacts:read");
  });

  it("allows owners and editors; refuses commenters, viewers, link viewers and scope-less agents", () => {
    expect(decide(user("u-owner"), "people", artifact(), access(null))).toEqual({
      allow: true,
      role: "owner",
    });
    expect(decide(user("u-ed"), "people", artifact(), access("editor"))).toEqual({
      allow: true,
      role: "editor",
    });
    expect(
      decide(agent("u-ed", ["artifacts:read"]), "people", artifact(), access("editor")),
    ).toMatchObject({ allow: true });
    for (const role of ["commenter", "viewer"] as const) {
      expect(decide(user("u-x"), "people", artifact(), access(role))).toMatchObject({
        allow: false,
        reason: "forbidden",
      });
    }
    // An unlisted artifact opens for anyone with the link; its people list does not.
    expect(decide({ kind: "anonymous" }, "people", artifact(), access(null))).toMatchObject({
      allow: false,
      reason: "login_required",
    });
    expect(decide(user("u-none"), "people", artifact(), access(null))).toMatchObject({
      allow: false,
      reason: "forbidden",
    });
    expect(
      decide(agent("u-owner", ["mentions"]), "people", artifact(), access(null)),
    ).toMatchObject({ allow: false, reason: "scope" });
  });

  it("is refused on a taken-down or deleted artifact, even for the owner", () => {
    expect(
      decide(user("u-owner"), "people", artifact({ takenDown: true }), access(null)),
    ).toMatchObject({ allow: false, reason: "taken_down" });
    expect(
      decide(user("u-owner"), "people", artifact({ deleted: true }), access(null)),
    ).toMatchObject({ allow: false, reason: "not_found" });
  });
});

describe("policy: peopleListOffered", () => {
  it("is the one switch for the page, agents and REST: `data viewer people` while active", () => {
    expect(peopleListOffered(caps(), true)).toBe(true);
    expect(peopleListOffered(caps(), false)).toBe(false);
    expect(peopleListOffered(caps({ people: false }), true)).toBe(false);
    expect(peopleListOffered(caps({ viewer: false }), true)).toBe(false);
    expect(peopleListOffered(caps({ data: false, room: true }), true)).toBe(false);
    expect(peopleListOffered(null, true)).toBe(false);
  });
});

describe("policy: accessListShowsName", () => {
  it("names the owner, the reader's own row and holders who took part, nobody else", () => {
    const roles: EffectiveRole[] = ["owner", ...ROLES];
    for (const role of roles) {
      for (const you of [true, false]) {
        for (const tookPart of [true, false]) {
          expect(
            accessListShowsName({ role, you, tookPart }),
            `${role} you=${you} tookPart=${tookPart}`,
          ).toBe(role === "owner" || you || tookPart);
        }
      }
    }
  });
});

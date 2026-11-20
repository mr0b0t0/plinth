// The policy for tokens limited to one artifact (issue #51): on that artifact only view and edit,
// each still needing the person's role and the token's scope; every other artifact is not_found for
// every action and every scope set (the binding is checked before the scope); takedown and delete
// still win; and the helpers outside decide.
import type { Capabilities } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  boundArtifactOf,
  canActOnMention,
  captureReadsData,
  decide,
  mayCreateArtifacts,
  type Principal,
  pageDataAccess,
  scopeFor,
  seesOwnerMetadata,
  seesPeople,
  seesThumbnails,
} from "../src/policy.ts";

const OWNER = "u-owner";
const BOUND = "boundartifact0000001";

/** Every action, checked exhaustively by the type. */
const ACTIONS = Object.keys({
  view: true,
  comment: true,
  mention: true,
  edit: true,
  restore: true,
  manage: true,
  delete: true,
  report: true,
  data_read: true,
  data_write: true,
  data_clear: true,
  views: true,
  live_edit: true,
  comments_read: true,
  enter: true,
} satisfies Record<ArtifactAction, true>) as ArtifactAction[];

const ALL = ["artifacts:read", "artifacts:write", "mentions"] as const;

const boundAgent = (
  scopes: readonly (typeof ALL)[number][] = ["artifacts:read", "artifacts:write"],
  over: Partial<Extract<Principal, { kind: "agent" }>> = {},
): Principal => ({
  kind: "agent",
  userId: OWNER,
  email: "owner@example.com",
  connectionId: "c-ci",
  connectionLabel: "CI: report",
  clientType: "other",
  scopes: new Set(scopes),
  boundArtifactId: BOUND,
  ...over,
});

const art = (extra: Partial<ArtifactFacts> = {}): ArtifactFacts => ({
  id: BOUND,
  ownerId: OWNER,
  visibility: "allowlist",
  hasPassword: false,
  deleted: false,
  takenDown: false,
  ...extra,
});

const access = (extra: Partial<AccessFacts> = {}): AccessFacts => ({
  grantRole: null,
  passwordPassed: false,
  ...extra,
});

describe("policy: a token bound to one artifact", () => {
  it("on its artifact allows only view and edit; the rest is token_bound", () => {
    for (const action of ACTIONS) {
      const d = decide(boundAgent(ALL), action, art(), access());
      if (action === "view" || action === "edit") {
        expect(d, action).toEqual({ allow: true, role: "owner" });
      } else {
        expect(d, action).toEqual({ allow: false, reason: "token_bound", role: "owner" });
      }
    }
  });

  it("edit still needs owner or editor: an editor's token publishes, a commenter's does not", () => {
    const other = { userId: "u-other", email: "other@example.com" };
    const editor = decide(
      boundAgent(undefined, other),
      "edit",
      art(),
      access({ grantRole: "editor" }),
    );
    expect(editor).toEqual({ allow: true, role: "editor" });
    const commenter = decide(
      boundAgent(undefined, other),
      "edit",
      art(),
      access({ grantRole: "commenter" }),
    );
    expect(commenter).toMatchObject({ allow: false, reason: "forbidden", role: "commenter" });
    // No grant left on a private artifact: view is refused, like the person's own.
    expect(decide(boundAgent(undefined, other), "view", art(), access())).toMatchObject({
      allow: false,
    });
  });

  it("every other artifact is not_found, for every action and scope set, before the scope check", () => {
    for (const scopes of [ALL, ["artifacts:read"], ["artifacts:write"], []] as const) {
      for (const action of ACTIONS) {
        const d = decide(boundAgent(scopes), action, art({ id: "other" }), access());
        expect(d, `${scopes.join(" ")} ${action}`).toEqual({
          allow: false,
          reason: "not_found",
          role: null,
        });
      }
    }
    // Shared with the person as editor, unlisted: still not_found for this token.
    expect(
      decide(
        boundAgent(),
        "view",
        art({ id: "other", visibility: "unlisted" }),
        access({ grantRole: "editor" }),
      ),
    ).toMatchObject({ allow: false, reason: "not_found" });
  });

  it("a read-only bound token asking to edit its own artifact is refused by scope", () => {
    expect(decide(boundAgent(["artifacts:read"]), "edit", art(), access())).toEqual({
      allow: false,
      reason: "scope",
      role: null,
    });
    expect(decide(boundAgent(["artifacts:read"]), "view", art(), access())).toMatchObject({
      allow: true,
    });
  });

  it("takedown and delete still win on its artifact", () => {
    expect(decide(boundAgent(), "view", art({ takenDown: true }), access())).toMatchObject({
      allow: false,
      reason: "taken_down",
    });
    expect(decide(boundAgent(), "edit", art({ takenDown: true }), access())).toMatchObject({
      allow: false,
      reason: "taken_down",
    });
    // The owner's own manage on a taken-down artifact is still not the token's; it answers as
    // view does (taken_down), never with a token_bound that view would not give.
    expect(decide(boundAgent(), "manage", art({ takenDown: true }), access())).toMatchObject({
      allow: false,
      reason: "taken_down",
    });
    expect(decide(boundAgent(), "view", art({ deleted: true }), access())).toEqual({
      allow: false,
      reason: "not_found",
      role: null,
    });
  });

  it("once its person cannot view the artifact, every action answers as view does, never token_bound", () => {
    const other = { userId: "u-other", email: "other@example.com" };
    for (const action of ACTIONS) {
      const d = decide(boundAgent(ALL, other), action, art(), access());
      expect(d, action).toEqual(decide(boundAgent(ALL, other), "view", art(), access()));
      expect(d.allow, action).toBe(false);
      if (!d.allow) expect(d.reason, action).not.toBe("token_bound");
    }
    // With the grant still there, the same actions are token_bound (they reveal nothing then).
    expect(
      decide(boundAgent(ALL, other), "delete", art(), access({ grantRole: "editor" })),
    ).toEqual({ allow: false, reason: "token_bound", role: "editor" });
  });

  it("comments_read: refused for a bound token, the same as view for everyone else", () => {
    expect(scopeFor("comments_read")).toBe("artifacts:read");
    expect(decide(boundAgent(ALL), "comments_read", art(), access())).toEqual({
      allow: false,
      reason: "token_bound",
      role: "owner",
    });
    const wide: Principal = {
      ...(boundAgent(ALL) as Extract<Principal, { kind: "agent" }>),
      boundArtifactId: null,
    };
    const user: Principal = { kind: "user", userId: "u-x", email: "x@example.com", isAdmin: false };
    const anon: Principal = { kind: "anonymous" };
    for (const p of [wide, user, anon]) {
      for (const visibility of ["public", "unlisted", "allowlist", "password"] as const) {
        for (const grantRole of [null, "viewer", "commenter"] as const) {
          const facts = art({ visibility, hasPassword: visibility === "password" });
          const acc = access({ grantRole });
          expect(
            decide(p, "comments_read", facts, acc),
            `${p.kind} ${visibility} ${grantRole}`,
          ).toEqual(decide(p, "view", facts, acc));
        }
      }
    }
  });

  it("enter: refused for a bound token, exactly view for everyone else, takedowns included", () => {
    expect(scopeFor("enter")).toBe("artifacts:read");
    expect(decide(boundAgent(ALL), "enter", art(), access())).toEqual({
      allow: false,
      reason: "token_bound",
      role: "owner",
    });
    // A page the token could open signed out: it still gets no pass of its own.
    expect(decide(boundAgent(ALL), "enter", art({ visibility: "public" }), access())).toEqual({
      allow: false,
      reason: "token_bound",
      role: "owner",
    });
    const wide: Principal = {
      ...(boundAgent(ALL) as Extract<Principal, { kind: "agent" }>),
      boundArtifactId: null,
    };
    const noRead: Principal = {
      ...(boundAgent(["artifacts:write"]) as Extract<Principal, { kind: "agent" }>),
      boundArtifactId: null,
    };
    const user: Principal = { kind: "user", userId: "u-x", email: "x@example.com", isAdmin: false };
    const admin: Principal = { ...user, isAdmin: true };
    const owner: Principal = {
      kind: "user",
      userId: OWNER,
      email: "o@example.com",
      isAdmin: false,
    };
    const viewer: Principal = { kind: "viewer", email: "v@example.com" };
    const anon: Principal = { kind: "anonymous" };
    for (const p of [wide, noRead, user, admin, owner, viewer, anon]) {
      for (const visibility of ["public", "unlisted", "allowlist", "password"] as const) {
        for (const grantRole of [null, "viewer", "commenter", "editor"] as const) {
          for (const takenDown of [false, true]) {
            for (const passwordPassed of [false, true]) {
              const facts = art({ visibility, hasPassword: visibility === "password", takenDown });
              const acc = access({ grantRole, passwordPassed, isAdmin: p === admin });
              expect(
                decide(p, "enter", facts, acc),
                `${p.kind} ${visibility} ${grantRole} ${takenDown} ${passwordPassed}`,
              ).toEqual(decide(p, "view", facts, acc));
            }
          }
        }
      }
      // A summary's thumbnail_url follows the same rule.
      expect(seesThumbnails(p), p.kind).toBe(true);
    }
    expect(seesThumbnails(boundAgent(ALL))).toBe(false);
  });

  it("the helpers: boundArtifactOf, mayCreateArtifacts, seesOwnerMetadata, seesPeople, canActOnMention", () => {
    const wide = {
      ...(boundAgent(ALL) as Extract<Principal, { kind: "agent" }>),
      boundArtifactId: null,
    };
    const user: Principal = { kind: "user", userId: OWNER, email: "o@example.com", isAdmin: false };
    const viewer: Principal = { kind: "viewer", email: "v@example.com" };
    const anon: Principal = { kind: "anonymous" };
    expect(boundArtifactOf(boundAgent())).toBe(BOUND);
    for (const p of [wide, user, viewer, anon]) {
      expect(boundArtifactOf(p), p.kind).toBeNull();
      expect(mayCreateArtifacts(p), p.kind).toBe(true);
    }
    expect(mayCreateArtifacts(boundAgent())).toBe(false);
    expect(seesOwnerMetadata(boundAgent(), "owner")).toBe(false);
    expect(seesOwnerMetadata(wide, "owner")).toBe(true);
    expect(seesOwnerMetadata(user, "owner")).toBe(true);
    // Who the people are: role holders, never a bound token (even the owner's) or a link viewer.
    for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
      expect(seesPeople(boundAgent(), role), role).toBe(false);
      expect(seesPeople(wide, role), role).toBe(true);
      expect(seesPeople(user, role), role).toBe(true);
    }
    expect(seesPeople(user, null)).toBe(false);
    expect(seesPeople(anon, null)).toBe(false);
    const task = { targetConnection: "c-ci", targetClientType: null };
    expect(canActOnMention(boundAgent(ALL), task, OWNER)).toBe(false);
    expect(canActOnMention({ ...wide, connectionId: "c-ci" }, task, OWNER)).toBe(true);
  });

  it("a capture of a version a bound token wrote reads no shared data; a person's capture does", () => {
    // Who wrote the version decides the capture's pass.
    expect(captureReadsData({ userId: OWNER, boundArtifactId: null })).toBe(true);
    expect(captureReadsData({ userId: OWNER, boundArtifactId: BOUND })).toBe(false);
    // A writer whose account was erased is nobody anyone can vouch for.
    expect(captureReadsData({ userId: null, boundArtifactId: null })).toBe(false);
    // The pass then reads nothing, exactly as an in-chat preview reads nothing.
    const caps: Capabilities = {
      data: true,
      viewer: false,
      shared: [],
      room: false,
      roomOpen: [],
      comments: false,
    };
    expect(pageDataAccess(null, caps, true)).toEqual({
      read: true,
      write: false,
      seeIdentity: false,
    });
    expect(pageDataAccess(null, caps, true, {}).read).toBe(true);
    expect(pageDataAccess(null, caps, true, { noData: true }).read).toBe(false);
    expect(pageDataAccess(null, caps, true, { preview: true }).read).toBe(false);
  });
});

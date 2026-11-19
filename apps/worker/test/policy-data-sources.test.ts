// Data sources and provenance in the policy module (docs/spec.md "Live data from the owner's
// agents"): sourcedWrite narrows only commenter- and viewer-role writers in a sourced collection and
// keeps stamps to the owner's agent, canModifyDoc is unchanged, and the three new actions: who reads
// sources, who sets them, and that only the signed-in owner confirms (never an agent, whatever its
// scopes, never a viewer confirmed by code).
import type { EffectiveRole, Role, Scope } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactFacts,
  canModifyDoc,
  decide,
  type Principal,
  scopeFor,
  seesSourceRecipe,
  sourceActive,
  sourcedWrite,
} from "../src/policy.ts";

const OWNER = "u-owner";
const art: ArtifactFacts = {
  id: "a1",
  ownerId: OWNER,
  visibility: "unlisted",
  hasPassword: false,
  deleted: false,
  takenDown: false,
};
const access = (grantRole: Role | null = null): AccessFacts => ({
  grantRole,
  passwordPassed: false,
});

const user = (userId: string): Principal => ({
  kind: "user",
  userId,
  email: `${userId}@example.com`,
  isAdmin: false,
});
const agent = (
  userId: string,
  scopes: Scope[] = ["artifacts:read", "artifacts:write", "mentions"],
  boundArtifactId: string | null = null,
): Principal => ({
  kind: "agent",
  userId,
  email: `${userId}@example.com`,
  connectionId: "c1",
  connectionLabel: "laptop",
  clientType: "claude",
  scopes: new Set(scopes),
  boundArtifactId,
});
const viewer: Principal = { kind: "viewer", email: "v@example.com" };
const anonymous: Principal = { kind: "anonymous" };

const ROLES: EffectiveRole[] = ["owner", "editor", "commenter", "viewer"];
const VIAS = ["page", "app", "agent"] as const;

describe("sourcedWrite", () => {
  it("owners and editors write in a sourced collection from every channel, with or without a stamp", () => {
    for (const role of ["owner", "editor"] as const) {
      for (const via of VIAS) {
        expect(
          sourcedWrite({ via, role, hasSource: false, collectionSourced: true }),
          `${role} ${via}`,
        ).toEqual({ allow: true });
      }
    }
    expect(
      sourcedWrite({ via: "agent", role: "owner", hasSource: true, collectionSourced: true }),
    ).toEqual({ allow: true });
  });

  it("refuses commenter- and viewer-role writers there (sets and deletes go through it alike)", () => {
    for (const role of ["commenter", "viewer"] as const) {
      for (const via of VIAS) {
        expect(sourcedWrite({ via, role, hasSource: false, collectionSourced: true })).toEqual({
          allow: false,
          reason: "sourced",
        });
      }
    }
  });

  it("lets every role write in a collection that is not sourced", () => {
    for (const role of ROLES) {
      for (const via of VIAS) {
        expect(sourcedWrite({ via, role, hasSource: false, collectionSourced: false })).toEqual({
          allow: true,
        });
      }
    }
  });

  it("keeps stamps to the owner's agent", () => {
    const cases: [(typeof VIAS)[number], EffectiveRole][] = [
      ["agent", "editor"],
      ["page", "owner"],
      ["app", "owner"],
      ["agent", "commenter"],
      ["page", "editor"],
    ];
    for (const [via, role] of cases) {
      for (const collectionSourced of [true, false]) {
        expect(
          sourcedWrite({ via, role, hasSource: true, collectionSourced }),
          `${via} ${role}`,
        ).toEqual({ allow: false, reason: "source_owner_only" });
      }
    }
  });

  it("leaves canModifyDoc as it was: owners and editors change and delete anyone's document", () => {
    for (const role of ["owner", "editor"] as const) {
      const w = { email: "w@example.com", role, viewerId: "u_000000000000000000000000" };
      for (const op of ["update", "delete"] as const) {
        expect(canModifyDoc(w, { docId: "d1", creatorEmail: "x@example.com" }, op, false)).toEqual({
          allow: true,
        });
      }
    }
  });
});

describe("sourceActive and seesSourceRecipe", () => {
  it("is active only while the confirmation names the current config", () => {
    expect(sourceActive({ configHash: "a", confirmedHash: null })).toBe(false);
    expect(sourceActive({ configHash: "a", confirmedHash: "b" })).toBe(false);
    expect(sourceActive({ configHash: "a", confirmedHash: "a" })).toBe(true);
  });

  it("shows the recipe to the owner only, never through a token bound to the artifact", () => {
    expect(seesSourceRecipe(user(OWNER), "owner")).toBe(true);
    expect(seesSourceRecipe(agent(OWNER), "owner")).toBe(true);
    expect(seesSourceRecipe(agent(OWNER, ["artifacts:read"], "a1"), "owner")).toBe(false);
    for (const role of ["editor", "commenter", "viewer", null] as const) {
      expect(seesSourceRecipe(user("u-x"), role)).toBe(false);
    }
  });
});

describe("decide: sources_read, sources_manage, sources_confirm", () => {
  it("needs artifacts:read to read and artifacts:write to manage or confirm", () => {
    expect(scopeFor("sources_read")).toBe("artifacts:read");
    expect(scopeFor("sources_manage")).toBe("artifacts:write");
    expect(scopeFor("sources_confirm")).toBe("artifacts:write");
    const mentionsOnly = agent(OWNER, ["mentions"]);
    for (const action of ["sources_read", "sources_manage", "sources_confirm"] as const) {
      expect(decide(mentionsOnly, action, art, access())).toMatchObject({
        allow: false,
        reason: "scope",
      });
    }
    expect(decide(agent(OWNER, ["artifacts:read"]), "sources_manage", art, access())).toMatchObject(
      { allow: false, reason: "scope" },
    );
  });

  it("reads: owners and editors; commenters, viewers, link viewers and strangers do not", () => {
    expect(decide(user(OWNER), "sources_read", art, access()).allow).toBe(true);
    expect(decide(agent(OWNER), "sources_read", art, access()).allow).toBe(true);
    expect(decide(user("u-e"), "sources_read", art, access("editor")).allow).toBe(true);
    expect(decide(agent("u-e"), "sources_read", art, access("editor")).allow).toBe(true);
    for (const role of ["commenter", "viewer", null] as const) {
      expect(decide(user("u-x"), "sources_read", art, access(role)).allow, String(role)).toBe(
        false,
      );
    }
    expect(decide(anonymous, "sources_read", art, access())).toMatchObject({
      allow: false,
      reason: "login_required",
    });
  });

  it("manages: the owner, signed in or the owner's agent; never an editor or an editor's agent", () => {
    expect(decide(user(OWNER), "sources_manage", art, access()).allow).toBe(true);
    expect(decide(agent(OWNER), "sources_manage", art, access()).allow).toBe(true);
    for (const p of [user("u-e"), agent("u-e")]) {
      expect(decide(p, "sources_manage", art, access("editor"))).toMatchObject({
        allow: false,
        reason: "forbidden",
      });
    }
    expect(decide(viewer, "sources_manage", art, access("editor")).allow).toBe(false);
    expect(decide(anonymous, "sources_manage", art, access()).allow).toBe(false);
  });

  it("confirms: the signed-in owner only; the owner's agent with every scope and a viewer by code never", () => {
    expect(decide(user(OWNER), "sources_confirm", art, access())).toEqual({
      allow: true,
      role: "owner",
    });
    expect(decide(agent(OWNER), "sources_confirm", art, access())).toMatchObject({
      allow: false,
      reason: "forbidden",
      role: "owner",
    });
    expect(
      decide(agent(OWNER, ["artifacts:read"], "a1"), "sources_confirm", art, access()),
    ).toMatchObject({ allow: false, reason: "token_bound" });
    expect(decide(viewer, "sources_confirm", art, access("editor")).allow).toBe(false);
    expect(decide(user("u-e"), "sources_confirm", art, access("editor")).allow).toBe(false);
    expect(decide(anonymous, "sources_confirm", art, access()).allow).toBe(false);
  });

  it("a takedown stops all three, for the owner too", () => {
    const down = { ...art, takenDown: true };
    for (const action of ["sources_read", "sources_manage", "sources_confirm"] as const) {
      expect(decide(user(OWNER), action, down, access())).toMatchObject({
        allow: false,
        reason: "taken_down",
      });
    }
  });
});

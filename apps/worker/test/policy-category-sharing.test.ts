// The filing safeguard in policy.ts (docs/spec.md "Category sharing and personal categories"): a
// category grant counts only for an artifact the owner reviewed as shared, against this very share,
// while that share is the one on the artifact's current key and the feature is on.
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  categoryRoleOf,
  decide,
  decidePortal,
  grantedRole,
  mayManageCategoryShares,
  type Principal,
  roleOf,
  seesCategorySharing,
  seesPersonalCategory,
  strongerRole,
} from "../src/policy.ts";

const OWNER = "owner-id";
const owner: Principal = { kind: "user", userId: OWNER, email: "o@example.com", isAdmin: false };
const client: Principal = {
  kind: "user",
  userId: "client",
  email: "client@example.com",
  isAdmin: false,
};
const viewer: Principal = { kind: "viewer", email: "client@example.com" };
const anon: Principal = { kind: "anonymous" };
const agentOf = (userId: string, email: string): Principal => ({
  kind: "agent",
  userId,
  email,
  connectionId: "c1",
  connectionLabel: "Work Claude",
  clientType: "claude",
  scopes: new Set(["artifacts:read", "artifacts:write", "mentions"] as const),
  boundArtifactId: null,
});

const SHARE = "share-acme";
const KEY = "acme";

const art = (extra: Partial<ArtifactFacts> = {}): ArtifactFacts => ({
  id: "art-1",
  ownerId: OWNER,
  visibility: "allowlist",
  hasPassword: false,
  deleted: false,
  takenDown: false,
  categoryShare: { key: KEY, review: "shared", reviewShareId: SHARE },
  ...extra,
});
const access = (extra: Partial<AccessFacts> = {}): AccessFacts => ({
  grantRole: null,
  categoryGrant: { shareId: SHARE, shareOwnerId: OWNER, shareKey: KEY, role: "commenter" },
  categorySharing: true,
  passwordPassed: false,
  ...extra,
});

describe("categoryRoleOf: the filing safeguard", () => {
  it("counts only when every fact matches", () => {
    expect(categoryRoleOf(art(), access())).toBe("commenter");
    expect(
      categoryRoleOf(
        art(),
        access({
          categoryGrant: { shareId: SHARE, shareOwnerId: OWNER, shareKey: KEY, role: "viewer" },
        }),
      ),
    ).toBe("viewer");
  });

  it.each<[string, ArtifactFacts, AccessFacts]>([
    ["the switch off", art(), access({ categorySharing: false })],
    ["the switch absent", art(), access({ categorySharing: undefined })],
    ["no artifact facts", art({ categoryShare: undefined }), access()],
    ["null artifact facts", art({ categoryShare: null }), access()],
    ["no grant", art(), access({ categoryGrant: null })],
    [
      "pending (never reviewed)",
      art({ categoryShare: { key: KEY, review: null, reviewShareId: null } }),
      access(),
    ],
    [
      "kept private",
      art({ categoryShare: { key: KEY, review: "private", reviewShareId: SHARE } }),
      access(),
    ],
    [
      "reviewed against another share",
      art({ categoryShare: { key: KEY, review: "shared", reviewShareId: "old" } }),
      access(),
    ],
    [
      "moved to another key",
      art({ categoryShare: { key: "other", review: "shared", reviewShareId: SHARE } }),
      access(),
    ],
    [
      "no key (not backfilled)",
      art({ categoryShare: { key: null, review: "shared", reviewShareId: SHARE } }),
      access(),
    ],
    [
      "a grant on the share of another key",
      art(),
      access({
        categoryGrant: {
          shareId: SHARE,
          shareOwnerId: OWNER,
          shareKey: "other",
          role: "commenter",
        },
      }),
    ],
    [
      "a grant on a share another owner holds",
      art(),
      access({
        categoryGrant: {
          shareId: SHARE,
          shareOwnerId: "someone-else",
          shareKey: KEY,
          role: "commenter",
        },
      }),
    ],
  ])("gives nothing: %s", (_label, a, x) => {
    expect(categoryRoleOf(a, x)).toBeNull();
    expect(grantedRole(a, x)).toBeNull();
  });

  it("clamps a stray role to viewer", () => {
    const stray = { shareId: SHARE, shareOwnerId: OWNER, shareKey: KEY, role: "editor" as never };
    expect(categoryRoleOf(art(), access({ categoryGrant: stray }))).toBe("viewer");
  });
});

describe("grantedRole and strongerRole", () => {
  it("is the stronger of the direct grant and the category grant", () => {
    expect(strongerRole(null, null)).toBeNull();
    expect(strongerRole("viewer", null)).toBe("viewer");
    expect(strongerRole(null, "commenter")).toBe("commenter");
    expect(strongerRole("editor", "commenter")).toBe("editor");
    expect(strongerRole("viewer", "commenter")).toBe("commenter");
    expect(grantedRole(art(), access({ categoryGrant: null, grantRole: "viewer" }))).toBe("viewer");
    expect(grantedRole(art(), access())).toBe("commenter");
    expect(grantedRole(art(), access({ grantRole: "viewer" }))).toBe("commenter");
    expect(grantedRole(art(), access({ grantRole: "editor" }))).toBe("editor");
  });
});

describe("decide with a category grant", () => {
  const allow = (p: Principal, action: ArtifactAction, a = art(), x = access()) =>
    decide(p, action, a, x).allow;

  it("views, comments and mentions as the role says, on any visibility", () => {
    for (const v of ["allowlist", "unlisted", "password", "public"] as const) {
      expect(allow(client, "view", art({ visibility: v }))).toBe(true);
    }
    expect(allow(client, "comment")).toBe(true);
    expect(allow(client, "mention")).toBe(true);
    const asViewer = access({
      categoryGrant: { shareId: SHARE, shareOwnerId: OWNER, shareKey: KEY, role: "viewer" },
    });
    expect(allow(client, "view", art(), asViewer)).toBe(true);
    expect(allow(client, "comment", art(), asViewer)).toBe(false);
    // A viewer confirmed by code holds it too.
    expect(allow(viewer, "view")).toBe(true);
  });

  it.each<ArtifactAction>([
    "edit",
    "restore",
    "manage",
    "delete",
    "data_read",
    "live_edit",
    "views",
  ])("never reaches %s", (action) => {
    expect(allow(client, action)).toBe(false);
  });

  it("a pending artifact answers a grantee as a stranger's private one does", () => {
    const pending = art({ categoryShare: { key: KEY, review: null, reviewShareId: null } });
    expect(decide(client, "view", pending, access())).toEqual({
      allow: false,
      reason: "forbidden",
      role: null,
    });
    expect(decide(anon, "view", pending, access())).toMatchObject({ allow: false });
  });

  it("a takedown and a delete beat every category grant", () => {
    expect(allow(client, "view", art({ takenDown: true }))).toBe(false);
    expect(decide(client, "view", art({ deleted: true }), access())).toMatchObject({
      allow: false,
      reason: "not_found",
    });
  });

  it("agent scopes still apply to a grantee's agent", () => {
    const a = agentOf("client", "client@example.com");
    expect(allow(a, "view")).toBe(true);
    const readOnly: Principal = { ...a, scopes: new Set(["artifacts:read"] as const) } as Principal;
    expect(decide(readOnly, "comment", art(), access())).toMatchObject({ reason: "scope" });
  });

  it("anonymous callers never hold a category grant", () => {
    expect(allow(anon, "view")).toBe(false);
  });
});

describe("who manages shares, opens portals and files personally", () => {
  it("mayManageCategoryShares: a signed-in person only", () => {
    expect(mayManageCategoryShares(owner)).toBe(true);
    expect(mayManageCategoryShares(agentOf(OWNER, "o@example.com"))).toBe(false);
    expect(mayManageCategoryShares(viewer)).toBe(false);
    expect(mayManageCategoryShares(anon)).toBe(false);
  });

  it("decidePortal: the owner previews, grant holders open, others confirm an email", () => {
    const share = { ownerId: OWNER };
    expect(decidePortal(owner, share, null, true)).toEqual({ allow: true, role: "owner" });
    expect(decidePortal(client, share, "viewer", true)).toEqual({ allow: true, role: "viewer" });
    expect(decidePortal(viewer, share, "commenter", true)).toEqual({
      allow: true,
      role: "commenter",
    });
    expect(decidePortal(client, share, null, true)).toEqual({
      allow: false,
      reason: "email_required",
    });
    expect(decidePortal(anon, share, null, true)).toEqual({
      allow: false,
      reason: "email_required",
    });
    // Agents never open a portal, even the owner's; the switch off hides every portal.
    expect(decidePortal(agentOf(OWNER, "o@example.com"), share, null, true)).toMatchObject({
      reason: "not_found",
    });
    expect(decidePortal(owner, share, null, false)).toMatchObject({ reason: "not_found" });
  });

  it("seesPersonalCategory: a signed-in person with a role that is not owner", () => {
    expect(seesPersonalCategory(client, "viewer")).toBe(true);
    expect(seesPersonalCategory(client, "editor")).toBe(true);
    expect(seesPersonalCategory(owner, "owner")).toBe(false);
    expect(seesPersonalCategory(client, null)).toBe(false);
    expect(seesPersonalCategory(agentOf("client", "client@example.com"), "viewer")).toBe(false);
    expect(seesPersonalCategory(viewer, "viewer")).toBe(false);
  });
});

describe("a token limited to one artifact", () => {
  const bound = (userId: string, email: string): Principal => ({
    kind: "agent",
    userId,
    email,
    connectionId: "c-ci",
    connectionLabel: "CI: report",
    clientType: "other",
    scopes: new Set(["artifacts:read", "artifacts:write"] as const),
    boundArtifactId: "art-1",
  });

  it("never sees category sharing, even the owner's own token", () => {
    expect(seesCategorySharing(bound(OWNER, "o@example.com"))).toBe(false);
    expect(seesCategorySharing(bound("client", "client@example.com"))).toBe(false);
    expect(seesCategorySharing(agentOf("client", "client@example.com"))).toBe(true);
    expect(seesCategorySharing(client)).toBe(true);
    expect(seesCategorySharing(viewer)).toBe(true);
  });

  it("holds the direct grant only: a category grant gives it no role", () => {
    const t = bound("client", "client@example.com");
    expect(roleOf(t, art(), access())).toBeNull();
    expect(decide(t, "view", art(), access())).toMatchObject({ allow: false });
    expect(roleOf(t, art(), access({ grantRole: "editor" }))).toBe("editor");
    expect(decide(t, "edit", art(), access({ grantRole: "editor" }))).toMatchObject({
      allow: true,
      role: "editor",
    });
    // The same person's account-wide agent keeps the category's role.
    expect(roleOf(agentOf("client", "client@example.com"), art(), access())).toBe("commenter");
    // The owner's own bound token is still the owner.
    expect(roleOf(bound(OWNER, "o@example.com"), art(), access())).toBe("owner");
  });
});

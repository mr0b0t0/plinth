// policy.ts mayEmailInvitations (docs/spec.md "Invitation emails"): only when asked, only for the
// owner acting on their own artifact or share, only with a verified address, never while taken down.
import { describe, expect, it } from "vitest";
import { mayEmailInvitations, type Principal } from "../src/policy.ts";

const OWNER = "u_owner";
const user = (userId = OWNER): Principal => ({
  kind: "user",
  userId,
  email: `${userId}@example.org`,
  isAdmin: false,
});
const agentOf = (userId = OWNER): Principal => ({
  kind: "agent",
  userId,
  email: `${userId}@example.org`,
  connectionId: "c1",
  connectionLabel: "Work Claude",
  clientType: "claude",
  scopes: new Set(["artifacts:read", "artifacts:write"]),
  boundArtifactId: null,
});

const facts = (over: Partial<Parameters<typeof mayEmailInvitations>[0]> = {}) => ({
  notify: true,
  principal: user(),
  ownerId: OWNER,
  ownerVerified: true,
  takenDown: false,
  ...over,
});

describe("mayEmailInvitations", () => {
  it("allows the signed-in owner and the owner's own agent when asked", () => {
    expect(mayEmailInvitations(facts())).toEqual({ allow: true });
    expect(mayEmailInvitations(facts({ principal: agentOf() }))).toEqual({ allow: true });
  });

  it("never emails unless the request asked", () => {
    expect(mayEmailInvitations(facts({ notify: false }))).toEqual({
      allow: false,
      reason: "not_requested",
    });
    expect(mayEmailInvitations(facts({ notify: false, principal: agentOf() }))).toEqual({
      allow: false,
      reason: "not_requested",
    });
  });

  it("refuses anyone but the owner: another person, their agent, a viewer, anonymous, an admin", () => {
    const admin: Principal = { kind: "user", userId: "u_admin", email: "a@x", isAdmin: true };
    for (const principal of [
      user("u_other"),
      agentOf("u_other"),
      { kind: "viewer", email: "v@example.org" } as Principal,
      { kind: "anonymous" } as Principal,
      admin,
    ]) {
      expect(mayEmailInvitations(facts({ principal }))).toEqual({
        allow: false,
        reason: "not_owner",
      });
    }
  });

  it("needs a verified owner address, then a live artifact", () => {
    expect(mayEmailInvitations(facts({ ownerVerified: false }))).toEqual({
      allow: false,
      reason: "owner_unverified",
    });
    expect(mayEmailInvitations(facts({ takenDown: true }))).toEqual({
      allow: false,
      reason: "taken_down",
    });
    expect(mayEmailInvitations(facts({ ownerVerified: false, takenDown: true }))).toEqual({
      allow: false,
      reason: "owner_unverified",
    });
  });
});

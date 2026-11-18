// The policy for tokens limited to one artifact (issue #51): on that artifact only view and edit,
// each still needing the person's role and the token's scope; every other artifact is not_found for
// every action and every scope set (the binding is checked before the scope); takedown and delete
// still win; and the helpers outside decide.
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  boundArtifactOf,
  canActOnMention,
  decide,
  mayCreateArtifacts,
  type Principal,
  seesOwnerMetadata,
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
    // The owner's own manage on a taken-down artifact is still not the token's.
    expect(decide(boundAgent(), "manage", art({ takenDown: true }), access())).toMatchObject({
      allow: false,
      reason: "token_bound",
    });
    expect(decide(boundAgent(), "view", art({ deleted: true }), access())).toEqual({
      allow: false,
      reason: "not_found",
      role: null,
    });
  });

  it("the helpers: boundArtifactOf, mayCreateArtifacts, seesOwnerMetadata, canActOnMention", () => {
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
    const task = { targetConnection: "c-ci", targetClientType: null };
    expect(canActOnMention(boundAgent(ALL), task, OWNER)).toBe(false);
    expect(canActOnMention({ ...wide, connectionId: "c-ci" }, task, OWNER)).toBe(true);
  });
});

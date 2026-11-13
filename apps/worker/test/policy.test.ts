import { ROLES, VISIBILITIES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  canActOnMention,
  canMakePublic,
  decide,
  type Principal,
} from "../src/policy.ts";

const OWNER = "owner-id";
const owner: Principal = {
  kind: "user",
  userId: OWNER,
  email: "owner@example.com",
  isAdmin: false,
};
const stranger: Principal = {
  kind: "user",
  userId: "other",
  email: "other@example.com",
  isAdmin: false,
};
const anon: Principal = { kind: "anonymous" };
const viewerEmail: Principal = { kind: "viewer", email: "guest@example.com" };
const ownerAgent = (
  scopes = ["artifacts:read", "artifacts:write", "mentions"] as const,
): Principal => ({
  kind: "agent",
  userId: OWNER,
  email: "owner@example.com",
  connectionId: "c1",
  connectionLabel: "Work Claude",
  clientType: "claude",
  scopes: new Set(scopes),
});

const art = (
  visibility: ArtifactFacts["visibility"],
  extra: Partial<ArtifactFacts> = {},
): ArtifactFacts => ({
  ownerId: OWNER,
  visibility,
  hasPassword: visibility === "password",
  deleted: false,
  takenDown: false,
  ...extra,
});
const access = (extra: Partial<AccessFacts> = {}): AccessFacts => ({
  grantRole: null,
  passwordPassed: false,
  ...extra,
});

const ACTIONS: ArtifactAction[] = [
  "view",
  "comment",
  "mention",
  "edit",
  "restore",
  "manage",
  "delete",
  "report",
];

describe("policy: owner", () => {
  for (const v of VISIBILITIES) {
    it(`owner may do everything on a ${v} artifact`, () => {
      for (const a of ACTIONS)
        expect(decide(owner, a, art(v), access())).toMatchObject({ allow: true, role: "owner" });
    });
  }
});

describe("policy: every role x visibility", () => {
  const expected: Record<string, ArtifactAction[]> = {
    viewer: ["view", "report"],
    commenter: ["view", "report", "comment", "mention"],
    editor: ["view", "report", "comment", "mention", "edit", "restore"],
  };
  for (const role of ROLES) {
    for (const v of VISIBILITIES) {
      it(`${role} grant on ${v}`, () => {
        for (const a of ACTIONS) {
          const d = decide(stranger, a, art(v), access({ grantRole: role }));
          expect(d.allow, `${role}/${v}/${a}`).toBe(expected[role]?.includes(a));
        }
      });
    }
  }
});

describe("policy: no grant", () => {
  it("public and unlisted are viewable by anyone, but not commentable", () => {
    for (const v of ["public", "unlisted"] as const) {
      for (const p of [anon, stranger, viewerEmail]) {
        expect(decide(p, "view", art(v), access()).allow).toBe(true);
        expect(decide(p, "comment", art(v), access()).allow).toBe(false);
        expect(decide(p, "edit", art(v), access()).allow).toBe(false);
        expect(decide(p, "manage", art(v), access()).allow).toBe(false);
      }
    }
  });
  it("password needs the password pass", () => {
    expect(decide(anon, "view", art("password"), access())).toMatchObject({
      allow: false,
      reason: "password_required",
    });
    expect(decide(anon, "view", art("password"), access({ passwordPassed: true })).allow).toBe(
      true,
    );
    expect(decide(anon, "edit", art("password"), access({ passwordPassed: true })).allow).toBe(
      false,
    );
  });
  it("password visibility with no password set is closed", () => {
    expect(
      decide(
        anon,
        "view",
        art("password", { hasPassword: false }),
        access({ passwordPassed: true }),
      ).allow,
    ).toBe(false);
  });
  it("allowlist asks anonymous for an email and refuses unlisted emails", () => {
    expect(decide(anon, "view", art("allowlist"), access())).toMatchObject({
      reason: "email_required",
    });
    expect(decide(viewerEmail, "view", art("allowlist"), access())).toMatchObject({
      reason: "forbidden",
    });
    expect(
      decide(viewerEmail, "view", art("allowlist"), access({ grantRole: "viewer" })).allow,
    ).toBe(true);
  });
  it("deleted artifacts are not found for everyone, including the owner", () => {
    for (const a of ACTIONS)
      expect(decide(owner, a, art("unlisted", { deleted: true }), access())).toMatchObject({
        reason: "not_found",
      });
  });
  it("taken-down artifacts: owner may only manage or delete; admin may view", () => {
    const t = art("unlisted", { takenDown: true });
    expect(decide(owner, "view", t, access()).allow).toBe(false);
    expect(decide(owner, "delete", t, access()).allow).toBe(true);
    expect(decide(anon, "view", t, access())).toMatchObject({ reason: "taken_down" });
    const admin: Principal = { kind: "user", userId: "adm", email: "a@x.com", isAdmin: true };
    expect(decide(admin, "view", t, access({ isAdmin: true })).allow).toBe(true);
    expect(decide(admin, "edit", t, access({ isAdmin: true })).allow).toBe(false);
  });
});

describe("policy: agents", () => {
  it("act as the connected user", () => {
    for (const a of ACTIONS)
      expect(decide(ownerAgent(), a, art("allowlist"), access()).allow).toBe(true);
  });
  it("need the right scope", () => {
    const readOnly = ownerAgent(["artifacts:read"] as never);
    expect(decide(readOnly, "view", art("unlisted"), access()).allow).toBe(true);
    expect(decide(readOnly, "edit", art("unlisted"), access())).toMatchObject({
      allow: false,
      reason: "scope",
    });
  });
  it("cannot act on another user's artifact without a grant", () => {
    const other: Principal = {
      ...(ownerAgent() as Extract<Principal, { kind: "agent" }>),
      userId: "x",
      email: "x@x.com",
    };
    expect(decide(other, "edit", art("unlisted"), access()).allow).toBe(false);
    expect(decide(other, "view", art("allowlist"), access()).allow).toBe(false);
  });
});

describe("policy: mentions", () => {
  it("only the owner's matching connection may act", () => {
    const a = ownerAgent();
    expect(canActOnMention(a, { targetConnection: null, targetClientType: "claude" }, OWNER)).toBe(
      true,
    );
    expect(canActOnMention(a, { targetConnection: null, targetClientType: "codex" }, OWNER)).toBe(
      false,
    );
    expect(canActOnMention(a, { targetConnection: "c1", targetClientType: null }, OWNER)).toBe(
      true,
    );
    expect(canActOnMention(a, { targetConnection: "c2", targetClientType: null }, OWNER)).toBe(
      false,
    );
    expect(
      canActOnMention(a, { targetConnection: null, targetClientType: "claude" }, "someone-else"),
    ).toBe(false);
    expect(
      canActOnMention(owner, { targetConnection: null, targetClientType: "claude" }, OWNER),
    ).toBe(false);
    const noScope = ownerAgent(["artifacts:read", "artifacts:write"] as never);
    expect(
      canActOnMention(noScope, { targetConnection: null, targetClientType: "claude" }, OWNER),
    ).toBe(false);
  });
});

describe("policy: public visibility gate", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  it("needs the flag, a verified email and account age", () => {
    const base = {
      enabled: true,
      emailVerifiedAt: "2026-11-01T00:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      minAccountAgeHours: 72,
      now,
    };
    expect(canMakePublic(base)).toBe(true);
    expect(canMakePublic({ ...base, enabled: false })).toBe(false);
    expect(canMakePublic({ ...base, emailVerifiedAt: null })).toBe(false);
    expect(canMakePublic({ ...base, createdAt: "2026-11-12T12:00:00Z" })).toBe(false);
  });
});

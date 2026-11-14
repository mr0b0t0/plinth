import { ROLES, VISIBILITIES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  canActOnMention,
  canMakePublic,
  canModifyDoc,
  decide,
  type PageClaim,
  type Principal,
  pageDataAccess,
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

// ---------- shared data (docs/superpowers/specs/2026-11-14-shared-state-design.md section 5) ----------

const DATA_ACTIONS = ["data_read", "data_write", "data_clear"] as const;

describe("policy: shared data actions", () => {
  it("data_read is a read action; data_write and data_clear need the write scope", () => {
    const readOnly = ownerAgent(["artifacts:read"] as never);
    expect(decide(readOnly, "data_read", art("allowlist"), access()).allow).toBe(true);
    expect(decide(readOnly, "data_write", art("allowlist"), access())).toMatchObject({
      allow: false,
      reason: "scope",
    });
    expect(decide(readOnly, "data_clear", art("allowlist"), access())).toMatchObject({
      allow: false,
      reason: "scope",
    });
  });

  it("the owner may read, write and clear on every visibility", () => {
    for (const v of VISIBILITIES)
      for (const a of DATA_ACTIONS)
        expect(decide(owner, a, art(v), access()), `${v}/${a}`).toMatchObject({
          allow: true,
          role: "owner",
        });
  });

  it("editors read and write but never clear; viewers and commenters get nothing", () => {
    const expected: Record<string, readonly string[]> = {
      viewer: [],
      commenter: [],
      editor: ["data_read", "data_write"],
    };
    for (const role of ROLES)
      for (const v of VISIBILITIES)
        for (const a of DATA_ACTIONS) {
          const d = decide(stranger, a, art(v), access({ grantRole: role }));
          expect(d.allow, `${role}/${v}/${a}`).toBe(expected[role]?.includes(a));
          if (!d.allow) expect(d).toMatchObject({ reason: "forbidden", role });
        }
  });

  it("agents act as their user for read and write, but never clear", () => {
    const a = ownerAgent();
    expect(decide(a, "data_read", art("unlisted"), access())).toMatchObject({ allow: true });
    expect(decide(a, "data_write", art("unlisted"), access())).toMatchObject({ allow: true });
    expect(decide(a, "data_clear", art("unlisted"), access())).toMatchObject({
      allow: false,
      reason: "forbidden",
      role: "owner",
    });
    const editorAgent: Principal = {
      ...(ownerAgent() as Extract<Principal, { kind: "agent" }>),
      userId: "ed",
      email: "ed@example.com",
    };
    const ed = access({ grantRole: "editor" });
    expect(decide(editorAgent, "data_write", art("allowlist"), ed).allow).toBe(true);
    expect(decide(editorAgent, "data_clear", art("allowlist"), ed).allow).toBe(false);
    const commenterAgent = decide(
      editorAgent,
      "data_read",
      art("allowlist"),
      access({ grantRole: "commenter" }),
    );
    expect(commenterAgent).toMatchObject({ allow: false, reason: "forbidden" });
  });

  it("strangers, link viewers and admins get no data access", () => {
    const admin: Principal = { kind: "user", userId: "adm", email: "a@x.com", isAdmin: true };
    for (const v of VISIBILITIES)
      for (const a of DATA_ACTIONS) {
        expect(decide(anon, a, art(v), access({ passwordPassed: true }))).toMatchObject({
          allow: false,
          reason: "login_required",
          role: null,
        });
        for (const p of [stranger, viewerEmail])
          expect(decide(p, a, art(v), access())).toMatchObject({
            allow: false,
            reason: "forbidden",
            role: null,
          });
        expect(decide(admin, a, art(v), access({ isAdmin: true })).allow).toBe(false);
      }
  });

  it("takedown and deletion deny all three, owner included", () => {
    for (const a of DATA_ACTIONS) {
      expect(decide(owner, a, art("unlisted", { takenDown: true }), access())).toMatchObject({
        allow: false,
        reason: "taken_down",
      });
      expect(decide(owner, a, art("unlisted", { deleted: true }), access())).toMatchObject({
        allow: false,
        reason: "not_found",
      });
      expect(decide(ownerAgent(), a, art("unlisted", { takenDown: true }), access()).allow).toBe(
        false,
      );
    }
  });
});

describe("policy: pageDataAccess", () => {
  const claim: PageClaim = {
    email: "v@example.com",
    role: "viewer",
    viewerId: "u_0123456789abcdef01234567",
  };
  const caps = (data: boolean, viewer: boolean) => ({ data, viewer, shared: [] });
  it("full truth table", () => {
    const rows: [
      PageClaim | null,
      ReturnType<typeof caps> | null,
      boolean,
      [boolean, boolean, boolean],
    ][] = [];
    for (const c of [claim, null])
      for (const k of [
        null,
        caps(false, false),
        caps(false, true),
        caps(true, false),
        caps(true, true),
      ])
        for (const enabled of [true, false]) {
          const read = enabled && !!k?.data;
          const write = read && c !== null;
          const see = write && !!k?.viewer;
          rows.push([c, k, enabled, [read, write, see]]);
        }
    expect(rows).toHaveLength(20);
    for (const [c, k, enabled, [read, write, seeIdentity]] of rows)
      expect(pageDataAccess(c, k, enabled), JSON.stringify([c, k, enabled])).toEqual({
        read,
        write,
        seeIdentity,
      });
  });
  it("spot checks", () => {
    expect(pageDataAccess(claim, caps(true, true), true)).toEqual({
      read: true,
      write: true,
      seeIdentity: true,
    });
    expect(pageDataAccess(null, caps(true, true), true)).toEqual({
      read: true,
      write: false,
      seeIdentity: false,
    });
    expect(pageDataAccess(claim, caps(false, true), true)).toEqual({
      read: false,
      write: false,
      seeIdentity: false,
    });
    expect(pageDataAccess(claim, caps(true, true), false)).toEqual({
      read: false,
      write: false,
      seeIdentity: false,
    });
  });
});

describe("policy: canModifyDoc", () => {
  const ME = "u_aaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER = "u_bbbbbbbbbbbbbbbbbbbbbbbb";
  const writer = (role: PageClaim["role"]): PageClaim => ({
    email: `${role}@example.com`,
    role,
    viewerId: ME,
  });
  const ROLES_ALL: PageClaim["role"][] = ["owner", "editor", "commenter", "viewer"];
  const OK = { allow: true };
  const NO = { allow: false, reason: "forbidden" };

  it("rule 1: nobody creates another person's u_ doc, the owner included", () => {
    for (const r of ROLES_ALL)
      for (const shared of [true, false])
        expect(
          canModifyDoc(writer(r), { docId: OTHER, creatorEmail: null }, "create", shared),
        ).toEqual(NO);
  });

  it("rule 2: any other create is allowed", () => {
    for (const r of ROLES_ALL)
      for (const shared of [true, false]) {
        for (const docId of ["abc", ME])
          expect(canModifyDoc(writer(r), { docId, creatorEmail: null }, "create", shared)).toEqual(
            OK,
          );
      }
  });

  it("rule 3: owner and editor may update and delete anything (moderation)", () => {
    for (const r of ["owner", "editor"] as const)
      for (const op of ["update", "delete"] as const)
        for (const docId of ["abc", ME, OTHER])
          for (const shared of [true, false])
            expect(
              canModifyDoc(writer(r), { docId, creatorEmail: "x@example.com" }, op, shared),
            ).toEqual(OK);
  });

  it("rule 4: a personal doc only by its person, even in a shared collection", () => {
    for (const r of ["commenter", "viewer"] as const)
      for (const op of ["update", "delete"] as const)
        for (const shared of [true, false]) {
          const w = writer(r);
          expect(canModifyDoc(w, { docId: ME, creatorEmail: w.email }, op, shared)).toEqual(OK);
          expect(canModifyDoc(w, { docId: OTHER, creatorEmail: w.email }, op, shared)).toEqual(NO);
          expect(
            canModifyDoc(w, { docId: OTHER, creatorEmail: "x@example.com" }, op, shared),
          ).toEqual(NO);
        }
  });

  it("rule 5: other docs by their creator, or anyone in a shared collection", () => {
    for (const r of ["commenter", "viewer"] as const)
      for (const op of ["update", "delete"] as const) {
        const w = writer(r);
        expect(canModifyDoc(w, { docId: "abc", creatorEmail: w.email }, op, false)).toEqual(OK);
        expect(canModifyDoc(w, { docId: "abc", creatorEmail: "x@example.com" }, op, false)).toEqual(
          NO,
        );
        expect(canModifyDoc(w, { docId: "abc", creatorEmail: null }, op, false)).toEqual(NO);
        expect(canModifyDoc(w, { docId: "abc", creatorEmail: "x@example.com" }, op, true)).toEqual(
          OK,
        );
        expect(canModifyDoc(w, { docId: "abc", creatorEmail: null }, op, true)).toEqual(OK);
      }
  });

  it("an anonymous writer is read-only for every op", () => {
    for (const op of ["create", "update", "delete"] as const)
      for (const shared of [true, false])
        expect(canModifyDoc(null, { docId: "abc", creatorEmail: null }, op, shared)).toEqual({
          allow: false,
          reason: "read_only",
        });
  });
});

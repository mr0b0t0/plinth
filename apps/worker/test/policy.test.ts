import { type Capabilities, ROLES, VISIBILITIES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  type AccessFacts,
  type ArtifactAction,
  type ArtifactFacts,
  canActOnMention,
  canMakePublic,
  canModifyDoc,
  decide,
  mayBulkEditCategories,
  type PageClaim,
  type Principal,
  pageDataAccess,
  roomAccess,
  scopeFor,
  seesOwnerMetadata,
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
  boundArtifactId: null,
});

const art = (
  visibility: ArtifactFacts["visibility"],
  extra: Partial<ArtifactFacts> = {},
): ArtifactFacts => ({
  id: "art-1",
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
  "views",
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

describe("policy: views (open counts)", () => {
  const admin: Principal = { kind: "user", userId: "adm", email: "a@x.com", isAdmin: true };
  it("only the owner may read an artifact's counts, on every visibility", () => {
    for (const v of VISIBILITIES) {
      expect(decide(owner, "views", art(v), access())).toMatchObject({
        allow: true,
        role: "owner",
      });
      for (const role of ROLES) {
        expect(decide(stranger, "views", art(v), access({ grantRole: role })), role).toMatchObject({
          allow: false,
          reason: "forbidden",
          role,
        });
      }
      expect(decide(stranger, "views", art(v), access())).toMatchObject({ reason: "forbidden" });
      expect(decide(viewerEmail, "views", art(v), access({ grantRole: "viewer" }))).toMatchObject({
        reason: "forbidden",
      });
    }
  });
  it("asks anonymous visitors to sign in, even on a public artifact", () => {
    expect(decide(anon, "views", art("public"), access())).toMatchObject({
      allow: false,
      reason: "login_required",
    });
  });
  it("an admin without a role is denied", () => {
    expect(decide(admin, "views", art("public"), access({ isAdmin: true }))).toMatchObject({
      allow: false,
      reason: "forbidden",
    });
  });
  it("a takedown denies it, a deletion hides the artifact", () => {
    expect(decide(owner, "views", art("unlisted", { takenDown: true }), access())).toMatchObject({
      allow: false,
      reason: "taken_down",
    });
    expect(
      decide(admin, "views", art("unlisted", { takenDown: true }), access({ isAdmin: true })),
    ).toMatchObject({ allow: false, reason: "taken_down" });
    expect(decide(owner, "views", art("unlisted", { deleted: true }), access())).toMatchObject({
      allow: false,
      reason: "not_found",
    });
  });
  it("is a read action: the owner's agent needs only artifacts:read", () => {
    const readOnly = ownerAgent(["artifacts:read"] as never);
    expect(decide(readOnly, "views", art("allowlist"), access()).allow).toBe(true);
    const writeOnly = ownerAgent(["artifacts:write"] as never);
    expect(decide(writeOnly, "views", art("allowlist"), access())).toMatchObject({
      reason: "scope",
    });
  });
});

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
  const caps = (data: boolean, viewer: boolean): Capabilities => ({
    data,
    viewer,
    shared: [],
    room: false,
    roomOpen: [],
    comments: false,
    people: false,
    hold: false,
  });
  it("full truth table, written out", () => {
    const T = true;
    const F = false;
    const none = null;
    const off = caps(F, F);
    const viewerOnly = caps(F, T);
    const dataOnly = caps(T, F);
    const both = caps(T, T);
    // [claim, caps, enabled, read, write, seeIdentity]
    const rows: [
      PageClaim | null,
      ReturnType<typeof caps> | null,
      boolean,
      boolean,
      boolean,
      boolean,
    ][] = [
      [claim, none, T, F, F, F],
      [claim, none, F, F, F, F],
      [claim, off, T, F, F, F],
      [claim, off, F, F, F, F],
      [claim, viewerOnly, T, F, F, F],
      [claim, viewerOnly, F, F, F, F],
      [claim, dataOnly, T, T, T, F],
      [claim, dataOnly, F, F, F, F],
      [claim, both, T, T, T, T],
      [claim, both, F, F, F, F],
      [null, none, T, F, F, F],
      [null, none, F, F, F, F],
      [null, off, T, F, F, F],
      [null, off, F, F, F, F],
      [null, viewerOnly, T, F, F, F],
      [null, viewerOnly, F, F, F, F],
      [null, dataOnly, T, T, F, F],
      [null, dataOnly, F, F, F, F],
      [null, both, T, T, F, F],
      [null, both, F, F, F, F],
    ];
    expect(rows).toHaveLength(20);
    for (const [c, k, enabled, read, write, seeIdentity] of rows)
      expect(pageDataAccess(c, k, enabled, "html"), JSON.stringify([c, k, enabled])).toEqual({
        read,
        write,
        seeIdentity,
      });
    // Independent of the table: an anonymous reader, or a page without `viewer`, never sees
    // identities, whatever else is true.
    for (const k of [none, off, viewerOnly, dataOnly, both])
      for (const enabled of [T, F]) {
        expect(pageDataAccess(null, k, enabled, "html").seeIdentity).toBe(false);
        if (!k?.viewer) expect(pageDataAccess(claim, k, enabled, "html").seeIdentity).toBe(false);
      }
  });
  it("spot checks", () => {
    expect(pageDataAccess(claim, caps(true, true), true, "html")).toEqual({
      read: true,
      write: true,
      seeIdentity: true,
    });
    expect(pageDataAccess(null, caps(true, true), true, "html")).toEqual({
      read: true,
      write: false,
      seeIdentity: false,
    });
    expect(pageDataAccess(claim, caps(false, true), true, "html")).toEqual({
      read: false,
      write: false,
      seeIdentity: false,
    });
    expect(pageDataAccess(claim, caps(true, true), false, "html")).toEqual({
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

describe("policy: categories (owner-only metadata)", () => {
  it("seesOwnerMetadata is true for the owner only", () => {
    expect(seesOwnerMetadata(owner, "owner")).toBe(true);
    for (const r of [...ROLES, null] as const)
      expect(seesOwnerMetadata(owner, r), String(r)).toBe(false);
  });

  it("mayBulkEditCategories: a signed-in person only, never an agent, viewer or anonymous", () => {
    expect(mayBulkEditCategories(owner)).toBe(true);
    expect(mayBulkEditCategories({ ...owner, isAdmin: true })).toBe(true);
    expect(mayBulkEditCategories(ownerAgent())).toBe(false);
    expect(mayBulkEditCategories(viewerEmail)).toBe(false);
    expect(mayBulkEditCategories(anon)).toBe(false);
  });

  it("manage covers category, owner only", () => {
    // Setting one artifact's category is `manage`: the owner (taken down included) and the
    // owner's agent with artifacts:write; never a grant role, a stranger or an admin.
    for (const v of VISIBILITIES) {
      expect(decide(owner, "manage", art(v), access()).allow).toBe(true);
      expect(decide(ownerAgent(), "manage", art(v), access()).allow).toBe(true);
      for (const role of ROLES) {
        expect(decide(stranger, "manage", art(v), access({ grantRole: role })).allow).toBe(false);
      }
      expect(decide(stranger, "manage", art(v), access()).allow).toBe(false);
      const admin: Principal = { ...stranger, isAdmin: true };
      expect(decide(admin, "manage", art(v), access({ isAdmin: true })).allow).toBe(false);
    }
    expect(decide(owner, "manage", art("public", { takenDown: true }), access()).allow).toBe(true);
    expect(
      decide(ownerAgent(["artifacts:read"] as never), "manage", art("public"), access()).allow,
    ).toBe(false);
  });
});
describe("policy: live_edit (on-page doc drafts)", () => {
  const editorUser: Principal = {
    kind: "user",
    userId: "ed",
    email: "ed@example.com",
    isAdmin: false,
  };
  const editorViewer: Principal = { kind: "viewer", email: "ed@example.com" };
  const editorAgent: Principal = {
    ...(ownerAgent() as Extract<Principal, { kind: "agent" }>),
    userId: "ed",
    email: "ed@example.com",
  };

  it("signed-in owners and editors only, on every visibility", () => {
    for (const v of VISIBILITIES) {
      expect(decide(owner, "live_edit", art(v), access())).toEqual({ allow: true, role: "owner" });
      expect(decide(editorUser, "live_edit", art(v), access({ grantRole: "editor" }))).toEqual({
        allow: true,
        role: "editor",
      });
      for (const role of ["viewer", "commenter"] as const)
        expect(decide(editorUser, "live_edit", art(v), access({ grantRole: role }))).toEqual({
          allow: false,
          reason: "forbidden",
          role,
        });
    }
  });

  it("an editor confirmed by code must sign in; a commenter by code is forbidden", () => {
    expect(
      decide(editorViewer, "live_edit", art("allowlist"), access({ grantRole: "editor" })),
    ).toEqual({ allow: false, reason: "account_required", role: "editor" });
    expect(
      decide(editorViewer, "live_edit", art("allowlist"), access({ grantRole: "commenter" })),
    ).toEqual({ allow: false, reason: "forbidden", role: "commenter" });
  });

  it("agents never, even the owner's with artifacts:write", () => {
    expect(scopeFor("live_edit")).toBe("artifacts:write");
    expect(decide(ownerAgent(), "live_edit", art("unlisted"), access())).toEqual({
      allow: false,
      reason: "forbidden",
      role: "owner",
    });
    expect(
      decide(editorAgent, "live_edit", art("allowlist"), access({ grantRole: "editor" })),
    ).toEqual({ allow: false, reason: "forbidden", role: "editor" });
    expect(
      decide(ownerAgent(["artifacts:read"] as never), "live_edit", art("unlisted"), access()),
    ).toMatchObject({ allow: false, reason: "scope" });
  });

  it("strangers and link viewers are refused without a role (404 through denialError)", () => {
    for (const v of VISIBILITIES) {
      expect(decide(stranger, "live_edit", art(v), access({ passwordPassed: true }))).toEqual({
        allow: false,
        reason: "forbidden",
        role: null,
      });
      expect(decide(viewerEmail, "live_edit", art(v), access())).toEqual({
        allow: false,
        reason: "forbidden",
        role: null,
      });
      expect(decide(anon, "live_edit", art(v), access({ passwordPassed: true }))).toEqual({
        allow: false,
        reason: "login_required",
        role: null,
      });
    }
  });

  it("taken down and deleted deny everyone, owner included", () => {
    expect(
      decide(owner, "live_edit", art("unlisted", { takenDown: true }), access()),
    ).toMatchObject({
      allow: false,
      reason: "taken_down",
    });
    expect(decide(owner, "live_edit", art("unlisted", { deleted: true }), access())).toMatchObject({
      allow: false,
      reason: "not_found",
    });
    const admin: Principal = { kind: "user", userId: "adm", email: "a@x.com", isAdmin: true };
    expect(
      decide(admin, "live_edit", art("unlisted", { takenDown: true }), access({ isAdmin: true }))
        .allow,
    ).toBe(false);
  });
});

describe("policy: roomAccess", () => {
  const claimOf = (role: PageClaim["role"], account?: boolean): PageClaim => ({
    email: `${role}@example.com`,
    role,
    viewerId: "u_0123456789abcdef01234567",
    ...(account === undefined ? {} : { account }),
  });
  const capsOf = (extra: Partial<Capabilities> = {}): Capabilities => ({
    data: false,
    viewer: false,
    shared: [],
    room: true,
    roomOpen: [],
    comments: false,
    people: false,
    hold: false,
    ...extra,
  });
  const NONE = { join: false, emit: "none", openTopics: [], seeIdentity: false, doc: "none" };
  const html = { active: true, type: "html" as const };
  const doc = { active: true, type: "doc" as const };

  it("nothing while rooms are inactive, or without an identity claim", () => {
    for (const kind of ["page", "doc"] as const)
      for (const type of ["html", "doc"] as const) {
        expect(roomAccess(claimOf("owner", true), capsOf(), kind, { active: false, type })).toEqual(
          NONE,
        );
        expect(roomAccess(null, capsOf({ viewer: true }), kind, { active: true, type })).toEqual(
          NONE,
        );
      }
  });

  it("page: an HTML artifact that declares room; everyone identified joins", () => {
    expect(roomAccess(claimOf("viewer"), null, "page", html)).toEqual(NONE);
    expect(
      roomAccess(claimOf("viewer"), capsOf({ room: false, data: true }), "page", html),
    ).toEqual(NONE);
    // A doc never has a page room, whatever is stored.
    expect(roomAccess(claimOf("owner", true), capsOf(), "page", doc)).toEqual(NONE);
    // Owners and editors emit any topic, commenters the open ones, viewers never.
    const emit = { owner: "all", editor: "all", commenter: "open", viewer: "none" } as const;
    for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
      const a = roomAccess(claimOf(role), capsOf({ roomOpen: ["cursor"] }), "page", html);
      expect(a, role).toEqual({
        join: true,
        emit: emit[role],
        openTopics: ["cursor"],
        seeIdentity: false,
        doc: "none",
      });
    }
  });

  it("page: identities only with viewer; open topics are a copy", () => {
    const caps = capsOf({ viewer: true, roomOpen: ["*"] });
    const a = roomAccess(claimOf("commenter"), caps, "page", html);
    expect(a).toMatchObject({ seeIdentity: true, emit: "open", openTopics: ["*"] });
    a.openTopics.push("x");
    expect(caps.roomOpen).toEqual(["*"]);
    // `*` opens every topic to commenters, never to viewers.
    expect(roomAccess(claimOf("viewer"), caps, "page", html)).toMatchObject({
      join: true,
      seeIdentity: true,
      emit: "none",
    });
  });

  it("doc: owners and editors on a liveEdit type; signed in writes, by code watches", () => {
    for (const role of ["commenter", "viewer"] as const)
      expect(roomAccess(claimOf(role, true), null, "doc", doc), role).toEqual(NONE);
    expect(roomAccess(claimOf("owner", true), null, "doc", html)).toEqual(NONE);
    for (const role of ["owner", "editor"] as const) {
      const base = { join: true, emit: "none", openTopics: [], seeIdentity: true };
      expect(roomAccess(claimOf(role, true), null, "doc", doc), role).toEqual({
        ...base,
        doc: "write",
      });
      expect(roomAccess(claimOf(role, false), null, "doc", doc), role).toEqual({
        ...base,
        doc: "watch",
      });
      // A pass issued before the account flag existed watches until a reload.
      expect(roomAccess(claimOf(role), null, "doc", doc).doc, role).toBe("watch");
    }
    // A doc's room ignores what a version declares.
    expect(
      roomAccess(claimOf("editor", true), capsOf({ roomOpen: ["*"] }), "doc", doc),
    ).toMatchObject({
      emit: "none",
      openTopics: [],
    });
  });
});

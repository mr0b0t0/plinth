// Page requests in the policy module (docs/spec.md "Page requests"): who files, which rows a page
// sees, which replies reach it, and who sees a request's thread in the app. Pure truth tables, plus
// the service's per-row filters fed rows its SQL would never return.
import { type Capabilities, type EffectiveRole, readStoredCapabilities } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  callerEmails,
  canSeePageRequest,
  canSeeThread,
  decide,
  holdsMentionRight,
  type PageClaim,
  type Principal,
  pageRequestAccess,
  pageSeesAnswer,
  pageSeesRequest,
} from "../src/policy.ts";
import { answersOf, ownRequestsOf, type RequestRootRow } from "../src/services/pageRequests.ts";

const CAPS = readStoredCapabilities(
  '{"data":false,"viewer":false,"shared":[],"requests":true,"requestsTo":["claude"]}',
) as Capabilities;
const ROLES: EffectiveRole[] = ["owner", "editor", "commenter", "viewer"];
const claim = (role: EffectiveRole, email = "ann@example.com"): PageClaim => ({
  email,
  role,
  viewerId: "u_0123456789abcdef01234567",
});
const ON = { active: true, type: "html" as const, pass: "view" as const };

describe("policy: page requests", () => {
  it("holdsMentionRight agrees with decide(..., 'mention') for every role", () => {
    const facts = {
      id: "a1",
      ownerId: "owner-id",
      visibility: "allowlist" as const,
      hasPassword: false,
      deleted: false,
      takenDown: false,
    };
    for (const role of ROLES) {
      const p: Principal =
        role === "owner"
          ? { kind: "user", userId: "owner-id", email: "o@example.com", isAdmin: false }
          : { kind: "user", userId: "u2", email: "ann@example.com", isAdmin: false };
      const d = decide(p, "mention", facts, {
        grantRole: role === "owner" ? null : role,
        passwordPassed: false,
      });
      expect(holdsMentionRight(role), role).toBe(d.allow);
    }
    expect(holdsMentionRight(null)).toBe(false);
  });

  it("callerEmails: the principal's own, and a browser's confirmed viewer email, never an agent's", () => {
    const user: Principal = { kind: "user", userId: "u", email: "x@example.com", isAdmin: false };
    expect(callerEmails(user, "y@example.com")).toEqual(["x@example.com", "y@example.com"]);
    expect(callerEmails(user, "x@example.com")).toEqual(["x@example.com"]);
    expect(callerEmails(user, null)).toEqual(["x@example.com"]);
    expect(callerEmails({ kind: "viewer", email: "y@example.com" }, "y@example.com")).toEqual([
      "y@example.com",
    ]);
    expect(callerEmails({ kind: "anonymous" }, "y@example.com")).toEqual(["y@example.com"]);
    const ag: Principal = {
      kind: "agent",
      userId: "u",
      email: "x@example.com",
      connectionId: "c",
      connectionLabel: "bot",
      clientType: "claude",
      scopes: new Set(),
      boundArtifactId: null,
    };
    expect(callerEmails(ag, "y@example.com")).toEqual(["x@example.com"]);
  });

  it("pageRequestAccess: active, HTML, declared, a view pass with a claim; filing needs the mention right", () => {
    const none = { file: false, readOwn: false };
    expect(pageRequestAccess(claim("owner"), CAPS, { ...ON, active: false })).toEqual(none);
    expect(pageRequestAccess(claim("owner"), CAPS, { ...ON, type: "doc" })).toEqual(none);
    expect(pageRequestAccess(claim("owner"), CAPS, { ...ON, pass: "preview" })).toEqual(none);
    expect(pageRequestAccess(claim("owner"), CAPS, { ...ON, pass: "capture" })).toEqual(none);
    expect(pageRequestAccess(claim("owner"), { ...CAPS, requests: false }, ON)).toEqual(none);
    expect(pageRequestAccess(claim("owner"), null, ON)).toEqual(none);
    expect(pageRequestAccess(null, CAPS, ON)).toEqual(none);
    for (const role of ROLES) {
      expect(pageRequestAccess(claim(role), CAPS, ON), role).toEqual({
        file: role !== "viewer",
        readOwn: true,
      });
    }
  });

  it("pageSeesRequest: only a root page request on this artifact under the claim's email", () => {
    const access = { file: true, readOwn: true };
    const own = {
      artifactId: "a1",
      parentId: null,
      kind: "page_request" as const,
      authorEmail: "ann@example.com",
    };
    expect(pageSeesRequest(access, claim("commenter"), "a1", own)).toBe(true);
    expect(
      pageSeesRequest(access, claim("commenter"), "a1", { ...own, authorEmail: "b@x.io" }),
    ).toBe(false);
    expect(pageSeesRequest(access, claim("commenter"), "a1", { ...own, authorEmail: null })).toBe(
      false,
    );
    expect(pageSeesRequest(access, claim("commenter"), "a1", { ...own, artifactId: "a2" })).toBe(
      false,
    );
    expect(pageSeesRequest(access, claim("commenter"), "a1", { ...own, parentId: "r" })).toBe(
      false,
    );
    expect(pageSeesRequest(access, claim("commenter"), "a1", { ...own, kind: "comment" })).toBe(
      false,
    );
    expect(pageSeesRequest({ file: true, readOwn: false }, claim("commenter"), "a1", own)).toBe(
      false,
    );
    expect(pageSeesRequest(access, null, "a1", own)).toBe(false);
  });

  it("pageSeesAnswer: only the owner's agent connections", () => {
    expect(pageSeesAnswer("o", { authorConnection: "c1", authorUserId: "o" })).toBe(true);
    expect(pageSeesAnswer("o", { authorConnection: null, authorUserId: "o" })).toBe(false);
    expect(pageSeesAnswer("o", { authorConnection: "c2", authorUserId: "editor" })).toBe(false);
    expect(pageSeesAnswer("o", { authorConnection: null, authorUserId: null })).toBe(false);
    expect(pageSeesAnswer("o", { authorConnection: "c3", authorUserId: null })).toBe(false);
  });

  it("canSeePageRequest and canSeeThread: owner, editors and the requester under any held email", () => {
    const req = "y@example.com";
    expect(canSeePageRequest("owner", [], req)).toBe(true);
    expect(canSeePageRequest("editor", [], req)).toBe(true);
    expect(canSeePageRequest("commenter", ["x@example.com"], req)).toBe(false);
    expect(canSeePageRequest("commenter", ["x@example.com", req], req)).toBe(true);
    expect(canSeePageRequest("viewer", [req], req)).toBe(true);
    expect(canSeePageRequest(null, [], req)).toBe(false);
    expect(canSeePageRequest("commenter", [], null)).toBe(false);
    expect(canSeeThread(null, [], { kind: "comment", authorEmail: req })).toBe(true);
    expect(canSeeThread(null, [], { kind: "page_request", authorEmail: req })).toBe(false);
    expect(canSeeThread("viewer", [req], { kind: "page_request", authorEmail: req })).toBe(true);
  });
});

describe("services/pageRequests: the per-row filters have the final word", () => {
  const access = { file: true, readOwn: true };
  const c = claim("commenter");
  const row = (over: Partial<RequestRootRow>): RequestRootRow => ({
    id: "r1",
    artifactId: "a1",
    parentId: null,
    kind: "page_request",
    authorEmail: c.email,
    body: "b",
    requestData: null,
    versionNumber: 1,
    status: "open",
    createdAt: "2026-11-19T10:00:00.000Z",
    ...over,
  });

  it("ownRequestsOf drops rows the SQL never returns", () => {
    const rows = [
      row({ id: "other-person", authorEmail: "b@example.com" }),
      row({ id: "other-artifact", artifactId: "a2" }),
      row({ id: "a-reply", parentId: "r0" }),
      row({ id: "a-comment", kind: "comment" }),
    ];
    expect(ownRequestsOf(rows, access, c, "a1")).toEqual([]);
    expect(ownRequestsOf([row({})], access, c, "a1").map((r) => r.id)).toEqual(["r1"]);
    expect(ownRequestsOf([row({})], { file: false, readOwn: false }, c, "a1")).toEqual([]);
  });

  it("answersOf keeps only the owner's agents' replies, as { body, created_at }", () => {
    const at = (m: number) => `2026-11-19T10:0${m}:00.000Z`;
    const replies = [
      {
        parentId: "r1",
        body: "owner typed",
        createdAt: at(1),
        authorConnection: null,
        authorUserId: "o",
      },
      {
        parentId: "r1",
        body: "editor typed",
        createdAt: at(2),
        authorConnection: null,
        authorUserId: "e",
      },
      {
        parentId: "r1",
        body: "editor agent",
        createdAt: at(3),
        authorConnection: "ce",
        authorUserId: "e",
      },
      {
        parentId: "r1",
        body: "requester",
        createdAt: at(4),
        authorConnection: null,
        authorUserId: null,
      },
      {
        parentId: "r1",
        body: "admin token",
        createdAt: at(5),
        authorConnection: null,
        authorUserId: "o",
      },
      {
        parentId: "r1",
        body: "owner agent",
        createdAt: at(6),
        authorConnection: "co",
        authorUserId: "o",
      },
    ];
    expect(answersOf(replies, "o")).toEqual([{ body: "owner agent", created_at: at(6) }]);
    const many = Array.from({ length: 7 }, (_, i) => ({
      parentId: "r1",
      body: `a${i}`,
      createdAt: at(i),
      authorConnection: "co",
      authorUserId: "o",
    })).reverse();
    expect(answersOf(many, "o").map((a) => a.body)).toEqual(["a2", "a3", "a4", "a5", "a6"]);
  });
});

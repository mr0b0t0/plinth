// Who may hold a watch socket, and who gets data signals (policy.ts liveViewAccess): anyone the
// gate lets in, anonymous link viewers included, never an agent; data signals only on an HTML page
// whose current version declares `data`, while shared data is active.
import { type ArtifactType, type Capabilities, type EffectiveRole, ROLES } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { type Decision, liveViewAccess, liveViewPool, type Principal } from "../src/policy.ts";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  data: true,
  viewer: false,
  shared: [],
  room: false,
  roomOpen: [],
  people: false,
  comments: false,
  dictation: false,
  hold: false,
  files: false,
  requests: false,
  requestsTo: [],
  ...over,
});

const allow = (role: EffectiveRole | null): Decision => ({ allow: true, role });

const PRINCIPALS: Principal[] = [
  { kind: "anonymous" },
  { kind: "viewer", email: "v@example.com" },
  { kind: "user", userId: "u1", email: "u@example.com", isAdmin: false },
];

const AGENT: Principal = {
  kind: "agent",
  userId: "u1",
  email: "u@example.com",
  connectionId: "c1",
  connectionLabel: "Laptop",
  clientType: "claude",
  scopes: new Set(["artifacts:read", "artifacts:write"]),
  boundArtifactId: null,
};

const on = { active: true, sharedData: true, type: "html" as ArtifactType };

describe("policy: liveViewAccess", () => {
  it("everyone the view decision lets in may watch, with any role or none", () => {
    for (const p of PRINCIPALS) {
      for (const role of ["owner", ...ROLES, null] as (EffectiveRole | null)[]) {
        expect(liveViewAccess(p, allow(role), null, on).watch, `${p.kind} ${role}`).toBe(true);
      }
    }
  });

  it("nobody watches when the view is refused, or while live views are off", () => {
    const refused: Decision[] = [
      { allow: false, reason: "not_found", role: null },
      { allow: false, reason: "password_required", role: null },
      { allow: false, reason: "email_required", role: null },
      { allow: false, reason: "forbidden", role: null },
      { allow: false, reason: "taken_down", role: "owner" },
    ];
    for (const p of PRINCIPALS) {
      for (const d of refused) {
        expect(liveViewAccess(p, d, caps(), on), `${p.kind} ${d.allow || d.reason}`).toEqual({
          watch: false,
          data: false,
        });
      }
      expect(liveViewAccess(p, allow("owner"), caps(), { ...on, active: false })).toEqual({
        watch: false,
        data: false,
      });
    }
  });

  it("agents never watch, whatever their role and scopes", () => {
    expect(liveViewAccess(AGENT, allow("owner"), caps(), on)).toEqual({
      watch: false,
      data: false,
    });
    expect(
      liveViewAccess({ ...AGENT, boundArtifactId: "a1" }, allow("editor"), caps(), on),
    ).toEqual({ watch: false, data: false });
  });

  it("data signals: an HTML page that declares `data`, with shared data active", () => {
    const anon: Principal = { kind: "anonymous" };
    expect(liveViewAccess(anon, allow(null), caps(), on)).toEqual({ watch: true, data: true });
    expect(liveViewAccess(anon, allow(null), caps({ data: false, room: true }), on)).toEqual({
      watch: true,
      data: false,
    });
    expect(liveViewAccess(anon, allow(null), null, on)).toEqual({ watch: true, data: false });
    for (const type of ["doc", "slides", "design_system"] as ArtifactType[]) {
      expect(liveViewAccess(anon, allow(null), caps(), { ...on, type }).data, type).toBe(false);
    }
    expect(liveViewAccess(anon, allow(null), caps(), { ...on, sharedData: false })).toEqual({
      watch: true,
      data: false,
    });
  });
});

describe("policy: liveViewPool", () => {
  it("the owner and the people it is shared with are members; everyone else is open", () => {
    for (const role of ["owner", ...ROLES] as EffectiveRole[]) {
      expect(liveViewPool({ allow: true, role }), role).toBe("member");
    }
    expect(liveViewPool({ allow: true, role: null })).toBe("open");
  });
});

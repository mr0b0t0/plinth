// policy.ts for files people add to a page: pageFileAccess, canSendFilePart and canDeleteFile truth
// tables, the
// strict sandbox CSP for file responses, the FILES_* settings, and the identity claim with files
// as its only reader.
import type { Capabilities, EffectiveRole } from "@plinth/shared";
import { FILE_DEFAULTS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { filesActive, identityClaimsActive, parseConfig } from "../src/config.ts";
import { contentCsp, OPAQUE_SANDBOX } from "../src/content/csp.ts";
import { canDeleteFile, canSendFilePart, type PageClaim, pageFileAccess } from "../src/policy.ts";
import { config } from "./helpers.ts";
import { everyIdentityReaderOff } from "./identity-readers.ts";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  data: false,
  viewer: false,
  shared: [],
  room: false,
  roomOpen: [],
  people: false,
  comments: false,
  dictation: false,
  hold: false,
  files: true,
  ...over,
});

const claim = (role: EffectiveRole, email = `${role}@example.org`): PageClaim => ({
  email,
  role,
  viewerId: "u_0123456789abcdef01234567",
});

describe("pageFileAccess", () => {
  it("reads with any view pass once declared and on; uploads only when identified", () => {
    expect(pageFileAccess(null, caps(), true, "view")).toEqual({
      read: true,
      upload: false,
      seeIdentity: false,
    });
    for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
      expect(pageFileAccess(claim(role), caps(), true, "view"), role).toEqual({
        read: true,
        upload: true,
        seeIdentity: false,
      });
      expect(pageFileAccess(claim(role), caps({ viewer: true }), true, "view"), role).toEqual({
        read: true,
        upload: true,
        seeIdentity: true,
      });
    }
  });

  it("allows nothing while off, without the declaration, or with none", () => {
    const none = { read: false, upload: false, seeIdentity: false };
    expect(pageFileAccess(claim("owner"), caps(), false, "view")).toEqual(none);
    expect(
      pageFileAccess(claim("owner"), caps({ files: false, data: true }), true, "view"),
    ).toEqual(none);
    expect(pageFileAccess(claim("owner"), null, true, "view")).toEqual(none);
  });

  it("gives a thumbnail capture and an in-chat preview nothing, so no upload reaches a thumbnail", () => {
    const none = { read: false, upload: false, seeIdentity: false };
    for (const pass of ["capture", "preview"] as const) {
      expect(pageFileAccess(null, caps({ viewer: true }), true, pass), pass).toEqual(none);
    }
  });
});

describe("canSendFilePart", () => {
  const row = (state: "pending" | "ready" | "deleting", creatorEmail: string | null) => ({
    state,
    creatorEmail,
  });

  it("lets only the person who started an upload send its parts, while it is arriving", () => {
    const a = claim("viewer", "a@example.org");
    expect(canSendFilePart(a, row("pending", "a@example.org"))).toEqual({ allow: true });
    for (const state of ["ready", "deleting"] as const) {
      expect(canSendFilePart(a, row(state, "a@example.org")), state).toEqual({
        allow: false,
        reason: "not_found",
      });
    }
  });

  it("hides another person's upload, the owner's and editors' too, and refuses readers", () => {
    for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
      expect(canSendFilePart(claim(role), row("pending", "a@example.org")), role).toEqual({
        allow: false,
        reason: "not_found",
      });
    }
    // An erased person's upload has no uploader left.
    expect(canSendFilePart(claim("owner"), row("pending", null))).toEqual({
      allow: false,
      reason: "not_found",
    });
    expect(canSendFilePart(null, row("pending", "a@example.org"))).toEqual({
      allow: false,
      reason: "read_only",
    });
  });
});

describe("canDeleteFile", () => {
  const ready = (creatorEmail: string | null) => ({ state: "ready" as const, creatorEmail });
  const pending = (creatorEmail: string | null) => ({ state: "pending" as const, creatorEmail });

  it("lets the uploader delete or cancel their own, and owners and editors delete ready files", () => {
    const a = claim("commenter", "a@example.org");
    expect(canDeleteFile(a, ready("a@example.org"))).toEqual({ allow: true });
    expect(canDeleteFile(a, pending("a@example.org"))).toEqual({ allow: true });
    for (const role of ["owner", "editor"] as const) {
      expect(canDeleteFile(claim(role), ready("a@example.org")), role).toEqual({ allow: true });
      expect(canDeleteFile(claim(role), ready(null)), role).toEqual({ allow: true });
      // Another person's unfinished upload is theirs alone to cancel.
      expect(canDeleteFile(claim(role), pending("a@example.org")), role).toEqual({
        allow: false,
        reason: "forbidden",
      });
    }
  });

  it("refuses other commenters and viewers, and anonymous readers as read-only", () => {
    for (const role of ["commenter", "viewer"] as const) {
      expect(canDeleteFile(claim(role), ready("a@example.org")), role).toEqual({
        allow: false,
        reason: "forbidden",
      });
      expect(canDeleteFile(claim(role), ready(null)), role).toEqual({
        allow: false,
        reason: "forbidden",
      });
    }
    expect(canDeleteFile(null, ready("a@example.org"))).toEqual({
      allow: false,
      reason: "read_only",
    });
  });
});

describe("the strict sandbox CSP", () => {
  it("ends with a bare sandbox and keeps every other directive", () => {
    const c = config();
    const strict = contentCsp(c, { scripts: "none", sandbox: "strict" });
    expect(strict).toBe(`${contentCsp(c, { scripts: "none" })}; sandbox`);
    expect(strict).toContain("default-src 'none'");
    expect(strict).toContain("object-src 'none'");
    expect(strict).toContain(`frame-ancestors 'self' ${c.appOrigin}`);
    // Under opaque isolation it is still the bare sandbox, never the flags.
    const opaque = { ...c, contentIsolation: "opaque" as const };
    const o = contentCsp(opaque, { scripts: "none", sandbox: "strict" });
    expect(o.endsWith("; sandbox")).toBe(true);
    expect(o).not.toContain(OPAQUE_SANDBOX);
  });

  it("leaves every other CSP as it was", () => {
    const c = config();
    expect(contentCsp(c, { sandbox: true })).toContain(OPAQUE_SANDBOX);
    expect(contentCsp(c)).not.toContain("sandbox");
    expect(contentCsp({ ...c, contentIsolation: "opaque" })).toContain(OPAQUE_SANDBOX);
  });
});

const base: Record<string, unknown> = {
  ENVIRONMENT: "development",
  APP_HOST: "app.localhost:8787",
  CONTENT_HOST: "content.localhost:8787",
  PUBLIC_SCHEME: "http",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_SIGNING_KEY: "t".repeat(40),
};

describe("config: ALLOW_FILES and FILES_*", () => {
  it("ships off, with the defaults, and is in effect only under origin isolation", () => {
    const c = parseConfig(base);
    expect(c.allowFiles).toBe(false);
    expect(c.files).toEqual({
      maxFileBytes: FILE_DEFAULTS.maxFileBytes,
      maxFilesPerArtifact: FILE_DEFAULTS.maxFilesPerArtifact,
      maxBytesPerArtifact: FILE_DEFAULTS.maxBytesPerArtifact,
      maxBytesPerUploader: FILE_DEFAULTS.maxBytesPerUploader,
      maxBytesPerUser: FILE_DEFAULTS.maxBytesPerUser,
      uploadsPerUploaderPerHour: FILE_DEFAULTS.uploadsPerUploaderPerHour,
      uploadsPerArtifactPerHour: FILE_DEFAULTS.uploadsPerArtifactPerHour,
    });
    expect(filesActive(c)).toBe(false);
    expect(filesActive(parseConfig({ ...base, ALLOW_FILES: "true" }))).toBe(true);
    expect(
      filesActive(parseConfig({ ...base, ALLOW_FILES: "true", CONTENT_ISOLATION: "opaque" })),
    ).toBe(false);
  });

  it("checks the ranges and that each cap holds the one below it", () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ FILES_MAX_FILE_BYTES: "1000" }, /FILES_MAX_FILE_BYTES must be an integer from/],
      [{ FILES_MAX_FILE_BYTES: String(200 * 1024 * 1024) }, /FILES_MAX_FILE_BYTES/],
      [{ FILES_MAX_PER_ARTIFACT: "0" }, /FILES_MAX_PER_ARTIFACT/],
      [{ FILES_MAX_PER_ARTIFACT: "10001" }, /FILES_MAX_PER_ARTIFACT/],
      [{ FILES_MAX_BYTES_PER_ARTIFACT: String(1024 * 1024) }, /at least FILES_MAX_FILE_BYTES/],
      [
        { FILES_MAX_BYTES_PER_UPLOADER: String(512 * 1024 * 1024) },
        /FILES_MAX_BYTES_PER_UPLOADER must be from/,
      ],
      [{ FILES_MAX_BYTES_PER_USER: String(1024 * 1024) }, /at least FILES_MAX_BYTES_PER_ARTIFACT/],
      [{ FILES_UPLOADS_PER_UPLOADER_PER_HOUR: "0" }, /at least 1/],
      [{ FILES_UPLOADS_PER_ARTIFACT_PER_HOUR: "x" }, /at least 1/],
    ];
    for (const [vars, re] of bad) {
      expect(() => parseConfig({ ...base, ...vars }), JSON.stringify(vars)).toThrow(re);
    }
    const c = parseConfig({
      ...base,
      FILES_MAX_FILE_BYTES: String(2 * 1024 * 1024),
      FILES_MAX_BYTES_PER_ARTIFACT: String(4 * 1024 * 1024),
      FILES_MAX_BYTES_PER_UPLOADER: String(2 * 1024 * 1024),
      FILES_MAX_BYTES_PER_USER: String(8 * 1024 * 1024),
    });
    expect(c.files).toMatchObject({
      maxFileBytes: 2 * 1024 * 1024,
      maxBytesPerArtifact: 4 * 1024 * 1024,
      maxBytesPerUploader: 2 * 1024 * 1024,
      maxBytesPerUser: 8 * 1024 * 1024,
    });
  });

  it("seals the identity claim with files as the only reader", () => {
    const filesOnly = parseConfig({
      ...base,
      ...everyIdentityReaderOff().vars,
      ALLOW_FILES: "true",
    });
    expect(identityClaimsActive(filesOnly, {})).toBe(true);
    const none = parseConfig({ ...base, ...everyIdentityReaderOff().vars });
    expect(identityClaimsActive(none, {})).toBe(false);
    const opaque = parseConfig({
      ...base,
      ...everyIdentityReaderOff().vars,
      ALLOW_FILES: "true",
      CONTENT_ISOLATION: "opaque",
    });
    expect(identityClaimsActive(opaque, {})).toBe(false);
  });
});

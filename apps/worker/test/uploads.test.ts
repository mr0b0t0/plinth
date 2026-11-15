// Upload tickets (services/uploads.ts, api/uploads.ts): minting, the bundle route's placement and
// credentials, the receiving lease, single use, and the explicit Ctx. The version-writing
// functions come from services/stage.ts; until the server-core work lands them, redemption tests
// pass a stand-in (fixtures/bundles/fakeStage.ts) and the end-to-end tests at the bottom are todo.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  API,
  ARTIFACT_ID_RE,
  COOKIES,
  LIMITS,
  type StartUploadInput,
  type StartUploadResult,
  TTL,
  UPLOAD_TOKEN_PREFIX,
} from "@plinth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppEnv, base } from "../src/api/context.ts";
import { bundleHandler } from "../src/api/uploads.ts";
import { PLINTH_VERSION } from "../src/app/version.ts";
import { resolveBearer, TOKEN_PREFIX } from "../src/auth/principal.ts";
import { type Config, instanceLimits, parseConfig } from "../src/config.ts";
import { accessGrants, agentConnections, oauthGrants, sessions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken, newId, newToken } from "../src/lib/crypto.ts";
import { ApiError } from "../src/lib/errors.ts";
import { hit } from "../src/lib/ratelimit.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import { revokeToken } from "../src/oauth/service.ts";
import type { Principal } from "../src/policy.ts";
import {
  claimArtifactAttempts,
  clearClaimedAttempts,
  pruneUploadTickets,
} from "../src/services/attempts.ts";
import { revokeConnection } from "../src/services/connections.ts";
import type { Ctx } from "../src/services/context.ts";
import {
  type BundleEnv,
  curlCommand,
  isReleaseAtLeast,
  lostResponseNext,
  npxCommand,
  redeemBundle,
  type StageDeps,
  stageDeps,
  startUpload,
  type TicketRow,
  uploadStatus,
} from "../src/services/uploads.ts";
import { fakeStage, keysUnder } from "./fixtures/bundles/fakeStage.ts";
import * as real from "./fixtures/bundles/real.ts";
import {
  BLOCK,
  END,
  type EntrySpec,
  entry,
  filler,
  fromBase64,
  gzip,
  gzipStream,
  lazyStream,
  streamOf,
  tar,
  viteBuild,
} from "./fixtures/bundles/tar.ts";
import {
  APP,
  agent,
  BIG_BUNDLE_TIMEOUT_MS,
  browserSession,
  call,
  config,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  publish,
  tool,
  versionRow,
} from "./helpers.ts";

const SITE = [
  { name: "index.html", data: "<!doctype html><title>Bundled</title><p>hi</p>" },
  { name: "assets/app.js", data: "console.log(1)" },
];
const goodTar = () => tar(SITE);
const zip = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(1020)]);

type Agent = Awaited<ReturnType<typeof agent>>;

/** The Ctx a bearer request would get (real resolveBearer), for calling the service directly. */
async function ctxFor(token: string, cfg: Config = config()): Promise<Ctx> {
  const principal = (await resolveBearer(db(), cfg, token, () => undefined)) as Principal;
  expect(principal?.kind).toBe("agent");
  return {
    env,
    config: cfg,
    db: db(),
    principal,
    passwordPasses: new Map(),
    viewerEmail: null,
    ip: null,
    waitUntil: () => undefined,
  };
}

async function mint(
  a: Pick<Agent, "token">,
  input: StartUploadInput = {},
  deps: StageDeps = fakeStage().deps,
  cfg: Config = config(),
): Promise<StartUploadResult> {
  return startUpload(await ctxFor(a.token, cfg), input, deps);
}

async function mintError(
  a: Pick<Agent, "token">,
  input: StartUploadInput,
  deps: StageDeps = fakeStage().deps,
  cfg: Config = config(),
): Promise<ApiError> {
  try {
    await mint(a, input, deps, cfg);
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected start_upload to be refused");
}

const bundleEnv = (cfg: Config = config()): BundleEnv => ({
  env,
  config: cfg,
  db: db(),
  ip: null,
  waitUntil: () => undefined,
});

async function redeem(
  t: Pick<StartUploadResult, "upload_id" | "upload_token">,
  body: Uint8Array | ReadableStream<Uint8Array>,
  deps: StageDeps,
  cfg: Config = config(),
) {
  return redeemBundle(
    bundleEnv(cfg),
    {
      uploadId: t.upload_id,
      authorization: `Bearer ${t.upload_token}`,
      contentLength: body instanceof Uint8Array ? String(body.byteLength) : undefined,
      body: body instanceof Uint8Array ? streamOf(body) : body,
    },
    deps,
  );
}

async function redeemError(
  t: Pick<StartUploadResult, "upload_id" | "upload_token">,
  body: Uint8Array | ReadableStream<Uint8Array>,
  deps: StageDeps,
  cfg: Config = config(),
): Promise<ApiError> {
  try {
    await redeem(t, body, deps, cfg);
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the bundle to be refused");
}

async function ticket(id: string): Promise<TicketRow> {
  const row = await env.DB.prepare("SELECT * FROM upload_tickets WHERE id = ?1")
    .bind(id)
    .first<TicketRow>();
  if (!row) throw new Error(`no ticket ${id}`);
  return row;
}

async function setTicket(id: string, sql: string, ...values: unknown[]): Promise<void> {
  await env.DB.prepare(`UPDATE upload_tickets SET ${sql} WHERE id = ?1`)
    .bind(id, ...values)
    .run();
}

/** POST a bundle through the real Worker (optionally with extra env vars). */
async function postBundle(
  url: string,
  init: { token?: string; body?: BodyInit; headers?: Record<string, string> } = {},
  vars?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const req = new Request(url, { method: "POST", headers, body: init.body ?? goodTar() });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...vars } as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const details = (e: ApiError) => e.details as Record<string, any>;

/** An agent that owns one unlisted artifact at version 1. */
async function ownerWithArtifact() {
  const a = await agent();
  const pub = await publish(a.auth);
  expect(pub.res.status).toBe(201);
  return { a, id: pub.body.id as string, slug: pub.body.slug as string };
}

// ---------- minting ----------

describe("start_upload mints a single-use ticket", () => {
  it("for a new artifact: shape, hashed token, 30 minutes, curl command", async () => {
    const a = await agent();
    const before = Date.now();
    const r = await mint(a, { title: "Site" });
    expect(r.upload_id).toMatch(/^[a-z0-9]{20}$/);
    expect(r.upload_token).toMatch(new RegExp(`^${UPLOAD_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(r.upload_url).toBe(`http://app.localhost:8787/api/v1/uploads/${r.upload_id}/bundle`);
    expect(r.target).toEqual({
      mode: "publish",
      id: expect.stringMatching(ARTIFACT_ID_RE),
      type: "html",
    });
    const reserved = (r.target as { id: string }).id;
    // A lost answer is checked with the upload's status, then get_artifact on that id, before any retry.
    expect(r.next).toContain(`call get_artifact with id ${reserved}:`);
    expect(r.limits).toEqual(instanceLimits(config()));
    expect(r.content_isolation).toBe("origin");
    const ttl = Date.parse(r.expires_at) - before;
    expect(ttl).toBeGreaterThan(TTL.uploadTicketMs - 5000);
    expect(ttl).toBeLessThanOrEqual(TTL.uploadTicketMs + 1000);
    expect(r.next).toMatch(/Replace <folder> with the build folder/);
    expect(r.next).toMatch(/at least 10 minutes/);
    expect(r.next).not.toMatch(/visibility/);

    const row = await ticket(r.upload_id);
    expect(row).toMatchObject({
      token_hash: await hashToken(r.upload_token),
      user_id: a.user.id,
      credential: "connection",
      connection_id: a.connectionId,
      admin_token_hash: null,
      scopes: "artifacts:read artifacts:write mentions",
      mode: "publish",
      artifact_id: null,
      reserved_artifact_id: reserved,
      artifact_type: "html",
      title: "Site",
      base_version: null,
      state: "open",
      attempts: 0,
      receiving_until: null,
    });
    // Stored hashed only: the token itself is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(r.upload_token.slice(UPLOAD_TOKEN_PREFIX.length));
  });

  it("commands.curl gzips the tar and keeps the token out of curl's argv", () => {
    const token = `${UPLOAD_TOKEN_PREFIX}${"A".repeat(43)}`;
    const url = "https://plinth.example/api/v1/uploads/abcdefghij0123456789/bundle";
    const cmd = curlCommand(token, url);
    expect(cmd).toBe(
      `cd <folder> && COPYFILE_DISABLE=1 tar --exclude='*.map' -cf - . | gzip -c | ` +
        `curl -sS --fail-with-body --max-time 600 -A plinth-agent/1 ` +
        `-H @<(printf 'Authorization: Bearer %s' '${token}') ` +
        `-H 'Content-Type: application/gzip' --data-binary @- '${url}'`,
    );
    // The token appears once, inside the process substitution (printf is a shell builtin), and
    // never in the URL.
    expect(cmd.split(token)).toHaveLength(2);
    expect(cmd).toMatch(new RegExp(`@<\\(printf '[^']+' '${token}'\\)`));
    expect(url).not.toContain(token);
    expect(cmd).not.toMatch(/\btar -h|\s-h\s/);
    // Never `tar -z` to a pipe: bsdtar pads it past the gzip member.
    expect(cmd).not.toMatch(/tar [^|]*-[a-y]*z/);
  });

  it("offers commands.npx only on release versions from MIN_UPLOAD_CLI_VERSION", async () => {
    expect(isReleaseAtLeast("0.4.0", "0.4.0")).toBe(true);
    expect(isReleaseAtLeast("0.10.0", "0.4.0")).toBe(true);
    expect(isReleaseAtLeast("1.0.0", "0.4.0")).toBe(true);
    expect(isReleaseAtLeast("0.3.9", "0.4.0")).toBe(false);
    expect(isReleaseAtLeast("0.4.0-beta.1", "0.4.0")).toBe(false);
    expect(isReleaseAtLeast("0.0.0", "0.4.0")).toBe(false);
    const t = `${UPLOAD_TOKEN_PREFIX}${"b".repeat(43)}`;
    expect(npxCommand("0.3.0", t, "https://x/u")).toBeNull();
    expect(npxCommand("0.4.0", t, "https://x/u")).toBe(
      `PLINTH_UPLOAD_TOKEN='${t}' npx -y @mr0b0t0/plinth@0.4.0 upload <folder> --to 'https://x/u'`,
    );
    // This build's version (packages/cli) decides; a pre-0.4.0 build omits it.
    const r = await mint(await agent());
    expect("npx" in r.commands).toBe(isReleaseAtLeast(PLINTH_VERSION, "0.4.0"));
  });

  it("for an update: target, stated base, and the visibility it replaces", async () => {
    const { a, id, slug } = await ownerWithArtifact();
    const r = await mint(a, { id: slug, base_version: 1, note: "rebuild" });
    expect(r.target).toEqual({
      mode: "update",
      id,
      slug,
      type: "html",
      base_version: 1,
      visibility: "unlisted",
    });
    expect(r.next).toMatch(/replaces the live page at its current visibility \(unlisted\)/);
    expect(await ticket(r.upload_id)).toMatchObject({
      mode: "update",
      artifact_id: id,
      base_version: 1,
      note: "rebuild",
      title: null,
    });
  });

  it("refuses {id} without base_version (a stale read would overwrite), over REST and MCP", async () => {
    const { a, id } = await ownerWithArtifact();
    const e = await mintError(a, { id });
    expect(e.code).toBe("invalid_input");
    expect(details(e)).toMatchObject({
      field: "base_version",
      next: "Pass the version you read with get_artifact as base_version (list_versions gives the current number without the page's files)",
    });
    const res = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details.field).toBe("base_version");
    const c = await mcpClient(a.token);
    const viaMcp = await tool(c, "start_upload", { id });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.data.error.details.field).toBe("base_version");
  });

  it("a stale base is a conflict at mint, before any rate hit, and mints nothing", async () => {
    const { a, id } = await ownerWithArtifact();
    await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>v2</p>", base_version: 1 }),
    });
    const e = await mintError(a, { id, base_version: 1 });
    expect(e.code).toBe("conflict");
    expect(details(e).current_version).toBe(2);
    const rate = await env.DB.prepare("SELECT count(*) AS n FROM rate_limits WHERE key = ?1")
      .bind(`upload:${a.user.id}`)
      .first<{ n: number }>();
    expect(rate?.n).toBe(0);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM upload_tickets WHERE user_id = ?1")
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("refuses fields that belong to the other mode", async () => {
    const { a, id } = await ownerWithArtifact();
    expect(details(await mintError(a, { id, base_version: 1, title: "x" })).field).toBe("title");
    expect(details(await mintError(a, { id, base_version: 1, type: "doc" })).field).toBe("type");
    expect(details(await mintError(a, { base_version: 1 })).field).toBe("base_version");
    expect(details(await mintError(a, { note: "n" })).field).toBe("note");
  });

  it("needs artifacts:write and edit rights on the target", async () => {
    const ro = await agent({ scopes: "artifacts:read" });
    expect((await mintError(ro, {})).code).toBe("forbidden");
    const { id } = await ownerWithArtifact();
    const stranger = await agent();
    expect((await mintError(stranger, { id, base_version: 1 })).code).toMatch(
      /not_found|forbidden/,
    );
  });

  it("is limited to MAX_PUBLISHES_PER_HOUR tickets per user per hour", async () => {
    const cfg = parseConfig({ ...env, MAX_PUBLISHES_PER_HOUR: "2" } as never);
    const a = await agent();
    await mint(a, {}, undefined, cfg);
    await mint(a, {}, undefined, cfg);
    const e = await mintError(a, {}, undefined, cfg);
    expect(e.code).toBe("rate_limited");
    expect(details(e).retry_after).toBeGreaterThan(0);
  });

  it("says the classic-bundle rule under opaque isolation", async () => {
    const cfg = parseConfig({ ...env, CONTENT_ISOLATION: "opaque" } as never);
    const r = await mint(await agent(), {}, undefined, cfg);
    expect(r.content_isolation).toBe("opaque");
    expect(r.next).toMatch(/classic bundle/);
  });

  it("stores the ADMIN_TOKEN's hash for a single-user admin ticket", async () => {
    const admin = await createUser();
    const adminToken = "admin-token-for-upload-tests-0123456789abcdef";
    const cfg = parseConfig({
      ...env,
      SINGLE_USER_MODE: "true",
      ADMIN_EMAIL: admin.email,
      ADMIN_TOKEN: adminToken,
    } as never);
    const r = await mint({ token: adminToken }, {}, undefined, cfg);
    expect(await ticket(r.upload_id)).toMatchObject({
      credential: "admin",
      connection_id: null,
      admin_token_hash: await hashToken(adminToken),
      user_id: admin.id,
    });
  });

  it("POST /uploads refuses a session cookie with 401, with or without the CSRF header", async () => {
    const u = await createUser();
    const s = await browserSession(u.id);
    for (const headers of [{ Cookie: s.cookie }, s.headers]) {
      const res = await call("/api/v1/uploads", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect((await json(res)).error.message).toMatch(/bearer token/);
    }
  });
});

// ---------- the bundle route ----------

describe("the bundle route and the upload token", () => {
  it("the upload token is refused everywhere else: /mcp, /api/v1/me, /api/v1/artifacts", async () => {
    const t = await mint(await agent());
    const auth = { Authorization: `Bearer ${t.upload_token}` };
    const mcp = await call("/mcp", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    expect((await call("/api/v1/me", { headers: auth })).status).toBe(401);
    expect((await call("/api/v1/artifacts", { headers: auth })).status).toBe(401);
    const post = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", html: "<p>x</p>" }),
    });
    expect(post.status).toBe(401);
    const mintWithIt = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(mintWithIt.status).toBe(401);
  });

  it("sits before `authenticate`: it answers for its own token and refuses every other one", async () => {
    const a = await agent();
    const t = await mint(a);
    const unknown = `http://app.localhost:8787/api/v1/uploads/${"z".repeat(20)}/bundle`;
    // authenticate would answer 401 "Invalid, expired or revoked bearer token" for this token.
    const res = await postBundle(unknown, { token: t.upload_token });
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe("Upload not found");
    for (const init of [{ token: a.token }, {}, { headers: { Authorization: "Basic eA==" } }]) {
      const r = await postBundle(t.upload_url, init);
      expect(r.status).toBe(401);
      expect((await json(r)).error.message).toBe(
        "This endpoint takes the upload token from start_upload",
      );
    }
    expect((await ticket(t.upload_id)).attempts).toBe(0);
  });

  it("never reads cookies: a browser session alone gets 401, and cookies change no answer", async () => {
    const a = await agent();
    const t = await mint(a);
    const s = await browserSession(a.user.id);
    for (const headers of [{ Cookie: s.cookie }, s.headers]) {
      const res = await postBundle(t.upload_url, { headers });
      expect(res.status).toBe(401);
    }
    const withCookies = await postBundle(t.upload_url, {
      token: `${UPLOAD_TOKEN_PREFIX}${"c".repeat(43)}`,
      headers: s.headers,
    });
    const without = await postBundle(t.upload_url, {
      token: `${UPLOAD_TOKEN_PREFIX}${"c".repeat(43)}`,
    });
    expect(withCookies.status).toBe(404);
    expect(without.status).toBe(404);
    expect((await ticket(t.upload_id)).attempts).toBe(0);
  });

  it("sends no CORS headers, and a preflight gets none either", async () => {
    const t = await mint(await agent());
    const res = await postBundle(t.upload_url, {
      token: `${UPLOAD_TOKEN_PREFIX}${"x".repeat(43)}`,
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await call(t.upload_url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(pre.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("sits before the 40 MB JSON body limit, and refuses an oversized Content-Length first", async () => {
    const a = await agent();
    const t = await mint(a);
    // 41 MB: over the JSON limit, under the bundle limit. Reaching the ticket check proves the
    // JSON body limit never saw it.
    const big = new Uint8Array(41 * 1024 * 1024);
    const r1 = await postBundle(
      `http://app.localhost:8787/api/v1/uploads/${"q".repeat(20)}/bundle`,
      { token: t.upload_token, body: big, headers: { "Content-Length": String(big.byteLength) } },
    );
    expect(r1.status).toBe(404);
    // MAX_VERSION_BYTES=1 MB gives a 9 MB bundle cap; a 10 MB body is refused from its
    // Content-Length before the ticket is even looked up (no attempt counted).
    const vars = { MAX_VERSION_BYTES: String(1024 * 1024) };
    const r2 = await postBundle(
      t.upload_url,
      {
        token: t.upload_token,
        body: new Uint8Array(10 * 1024 * 1024),
        headers: { "Content-Length": String(10 * 1024 * 1024) },
      },
      vars,
    );
    expect(r2.status).toBe(413);
    const err = (await json(r2)).error;
    expect(err.code).toBe("payload_too_large");
    expect(err.details.limit_bytes).toBe(9 * 1024 * 1024);
    expect((await ticket(t.upload_id)).attempts).toBe(0);
  });

  it("the inline body-limit error says how to send a build instead", async () => {
    const a = await agent();
    const res = await call("/api/v1/artifacts", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: new Uint8Array(LIMITS.maxInlineRequestBytes + 10),
    });
    expect(res.status).toBe(413);
    const err = (await json(res)).error;
    expect(err.message).toBe(
      "Request body is over 40 MB. Inline assets travel as base64; send a build with start_upload or the CLI",
    );
    expect(err.details.next).toMatch(/start_upload/);
  });

  it("another user's ticket id, or the wrong token for an id, is a 404", async () => {
    const ta = await mint(await agent());
    const tb = await mint(await agent());
    const swapped = ta.upload_url.replace(ta.upload_id, tb.upload_id);
    const res = await postBundle(swapped, { token: ta.upload_token });
    expect(res.status).toBe(404);
    expect((await ticket(tb.upload_id)).attempts).toBe(0);
    const bad = await postBundle(ta.upload_url, {
      token: `${UPLOAD_TOKEN_PREFIX}${"w".repeat(43)}`,
    });
    expect(bad.status).toBe(404);
  });

  it("names why a ticket cannot take a bundle: expired, exhausted, running, used, dead", async () => {
    const a = await agent();
    const err = async (t: StartUploadResult) =>
      (await json(await postBundle(t.upload_url, { token: t.upload_token }))).error;

    const expired = await mint(a);
    await setTicket(
      expired.upload_id,
      "expires_at = ?2",
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(await err(expired)).toMatchObject({
      code: "invalid_input",
      details: { reason: "upload_expired", next: "Call start_upload again" },
    });

    const exhausted = await mint(a);
    await setTicket(exhausted.upload_id, "attempts = ?2", LIMITS.maxTicketAttempts);
    expect((await err(exhausted)).details.reason).toBe("upload_exhausted");

    // Another ticket of the same user is receiving: one receiving bundle per user.
    const busy = await mint(a);
    const other = await mint(a);
    await setTicket(busy.upload_id, "receiving_until = ?2, receiving_claim = 'c'", isoIn(60_000));
    const running = await err(other);
    expect(running).toMatchObject({ code: "conflict", details: { reason: "upload_running" } });
    expect(running.message).toBe("Another upload of yours is in progress; wait for it");
    // It says when the blocking lease ends at the latest, so a stuck lease is not a mystery.
    const lease = (await ticket(busy.upload_id)).receiving_until as string;
    expect(running.details).toMatchObject({ receiving_until: lease });
    expect(details(running).retry_after).toBeGreaterThan(0);
    expect(details(running).retry_after).toBeLessThanOrEqual(60);
    expect(details(running).next).toContain(lease);
    // The same ticket while it is receiving.
    expect((await err(busy)).details.reason).toBe("upload_running");
    await setTicket(busy.upload_id, "state = 'dead', receiving_until = NULL");

    const { id, slug } = await ownerWithArtifact();
    const used = await mint(a);
    await setTicket(
      used.upload_id,
      "state = 'used', result_artifact_id = ?2, result_version = 2, used_at = ?3",
      id,
      nowIso(),
    );
    expect(await err(used)).toMatchObject({
      code: "conflict",
      details: {
        reason: "upload_used",
        version: 2,
        url: `http://app.localhost:8787/a/${slug}`,
      },
    });

    const dead = await mint(a);
    await setTicket(dead.upload_id, "state = 'dead'");
    expect((await err(dead)).details.reason).toBe("upload_dead");
  });

  it("401 after the connection is revoked; the attempt counts and the lease is released", async () => {
    const a = await agent();
    const t = await mint(a);
    await revokeConnection(db(), a.user.id, a.connectionId);
    const res = await postBundle(t.upload_url, { token: t.upload_token });
    expect(res.status).toBe(401);
    expect(await ticket(t.upload_id)).toMatchObject({
      state: "open",
      attempts: 1,
      receiving_until: null,
      receiving_claim: null,
    });
  });

  it("an OAuth ticket dies with its grant: /oauth/revoke revokes the connection too", async () => {
    const user = await createUser();
    const connectionId = newId();
    const clientId = newId();
    const access = newToken(TOKEN_PREFIX.access);
    await env.DB.prepare(
      "INSERT INTO oauth_clients (id, client_name, redirect_uris, created_at) VALUES (?1, 'Claude', '[]', ?2)",
    )
      .bind(clientId, nowIso())
      .run();
    await db()
      .insert(agentConnections)
      .values({
        id: connectionId,
        userId: user.id,
        label: "Claude",
        clientType: "claude",
        kind: "oauth",
        scopes: "artifacts:read artifacts:write",
        oauthClientId: clientId,
        createdAt: nowIso(),
      })
      .run();
    await db()
      .insert(oauthGrants)
      .values({
        id: newId(),
        clientId,
        userId: user.id,
        connectionId,
        scope: "artifacts:read artifacts:write",
        accessTokenHash: await hashToken(access),
        accessExpiresAt: isoIn(3600_000),
        createdAt: nowIso(),
      })
      .run();
    const t = await mint({ token: access });
    expect((await ticket(t.upload_id)).connection_id).toBe(connectionId);
    await revokeToken(db(), new URLSearchParams({ token: access }));
    const res = await postBundle(t.upload_url, { token: t.upload_token });
    expect(res.status).toBe(401);
  });

  it("401 after ADMIN_TOKEN changes or single-user mode is turned off", async () => {
    const admin = await createUser();
    const adminToken = "admin-token-for-upload-tests-0123456789abcdef";
    const vars = { SINGLE_USER_MODE: "true", ADMIN_EMAIL: admin.email, ADMIN_TOKEN: adminToken };
    const cfg = parseConfig({ ...env, ...vars } as never);
    for (const changed of [
      { ...vars, ADMIN_TOKEN: "a-rotated-admin-token-0123456789abcdefghijkl" },
      { ...vars, SINGLE_USER_MODE: "false" },
      { ...vars, ADMIN_EMAIL: "someone-else@example.com" },
    ]) {
      const t = await mint({ token: adminToken }, {}, undefined, cfg);
      const res = await postBundle(t.upload_url, { token: t.upload_token }, changed);
      expect(res.status).toBe(401);
      expect((await json(res)).error.message).toMatch(/ADMIN_TOKEN that started this upload/);
    }
  });
});

// ---------- redeeming (stand-in stager) ----------

describe("redeeming a ticket", () => {
  it("publishes: streams every file to the stager, commits once with the ticket, 201", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, { title: "Site" }, deps);
    const { status, body } = await redeem(t, await gzip(goodTar()), deps);
    expect(status).toBe(201);
    expect(body.bundle).toEqual({ entries: 2, skipped: [], stripped_prefix: null });
    expect(body.version).toBe(1);
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]?.ticketId).toBe(t.upload_id);
    const prefix = log.commits[0]?.prefix as string;
    expect(log.added.get(prefix)).toEqual(["index.html", "assets/app.js"]);
    expect((await keysUnder(prefix)).sort()).toEqual([
      `${prefix}assets/app.js`,
      `${prefix}index.html`,
    ]);
    // The redemption target carries the ticket's type and title.
    expect(log.targets.at(-1)).toMatchObject({ mode: "publish", type: "html", title: "Site" });
    expect(log.publishRateCalls).toBe(1);
    expect(await ticket(t.upload_id)).toMatchObject({
      state: "used",
      attempts: 1,
      receiving_until: null,
      result_version: 1,
    });
    // Single use.
    const again = await redeemError(t, goodTar(), deps);
    expect(details(again).reason).toBe("upload_used");
    expect(log.commits).toHaveLength(1);
  });

  it("updates: 200, passes the stripped prefix to finish, keeps the stated base", async () => {
    const { a, id } = await ownerWithArtifact();
    const { deps, log } = fakeStage();
    const t = await mint(a, { id, base_version: 1, note: "build" }, deps);
    const { status, body } = await redeem(t, fromBase64(real.distTgz), deps);
    expect(status).toBe(200);
    expect(body.bundle.stripped_prefix).toBe("dist/");
    expect(body.bundle.skipped).toEqual(["dist/.DS_Store"]);
    expect(log.finished.at(-1)?.stripPrefix).toBe("dist/");
    expect(log.targets.at(-1)).toMatchObject({ mode: "update", baseVersion: 1, note: "build" });
  });

  it("a bundle after a concurrent update gets a conflict and the ticket dies", async () => {
    const { a, id } = await ownerWithArtifact();
    const { deps, log } = fakeStage();
    const t = await mint(a, { id, base_version: 1 }, deps);
    await call(`/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>someone else</p>", base_version: 1 }),
    });
    const e = await redeemError(t, goodTar(), deps);
    expect(e.code).toBe("conflict");
    expect(details(e)).toMatchObject({
      current_version: 2,
      next: "v2 is current; check what changed (get_artifact), then start_upload again with base_version 2",
    });
    expect(log.commits).toHaveLength(0);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "dead", receiving_until: null });
    expect(details(await redeemError(t, goodTar(), deps)).reason).toBe("upload_dead");
  });

  it("single winner: a lease that lapses mid-upload lets a second request commit; the first gets upload_used and leaves nothing", async () => {
    const a = await agent();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused!: () => void;
    const reachedPause = new Promise<void>((r) => {
      paused = r;
    });
    let first = true;
    const { deps, log } = fakeStage({
      async beforeAdd(path) {
        // Hold the first request after it staged index.html.
        if (first && path === "assets/app.js") {
          first = false;
          paused();
          await gate;
        }
      },
    });
    const t = await mint(a, {}, deps);
    const slow = redeemError(t, goodTar(), deps);
    await reachedPause;
    const slowPrefix = [...log.added.keys()][0] as string;
    expect(await keysUnder(slowPrefix)).toEqual([`${slowPrefix}index.html`]);
    // The slow request's lease lapses.
    await setTicket(t.upload_id, "receiving_until = ?2", new Date(Date.now() - 1000).toISOString());
    const fast = await redeem(t, goodTar(), deps);
    expect(fast.status).toBe(201);
    release();
    const e = await slow;
    expect(e.code).toBe("conflict");
    expect(details(e)).toMatchObject({ reason: "upload_used", version: 1 });
    expect(log.commits).toHaveLength(1);
    expect(await keysUnder(slowPrefix)).toEqual([]);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "used", attempts: 2 });
  });

  it("a conflict reported after the ticket was used never turns used into dead", async () => {
    const { a, id } = await ownerWithArtifact();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused!: () => void;
    const reachedPause = new Promise<void>((r) => {
      paused = r;
    });
    let first = true;
    const { deps, log } = fakeStage({
      conflictWhenUsed: true,
      async beforeCommit() {
        if (first) {
          first = false;
          paused();
          await gate;
        }
      },
    });
    const t = await mint(a, { id, base_version: 1 }, deps);
    const slow = redeemError(t, goodTar(), deps);
    await reachedPause;
    await setTicket(t.upload_id, "receiving_until = ?2", new Date(Date.now() - 1000).toISOString());
    expect((await redeem(t, goodTar(), deps)).status).toBe(200);
    release();
    const e = await slow;
    expect(details(e).reason).toBe("upload_used");
    expect(log.commits).toHaveLength(1);
    expect((await ticket(t.upload_id)).state).toBe("used");
  });

  it("concurrent bundles on one ticket: exactly one commits (one artifact in publish mode)", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps);
    const results = await Promise.allSettled([
      redeem(t, goodTar(), deps),
      redeem(t, goodTar(), deps),
      redeem(t, goodTar(), deps),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ApiError);
        expect(["upload_running", "upload_used"]).toContain(
          (r.reason as ApiError & { details: { reason: string } }).details.reason,
        );
      }
    }
    expect(log.commits).toHaveLength(1);
    expect(new Set(log.commits.map((c) => c.artifactId)).size).toBe(1);
  });

  it("a refused body leaves the ticket open for a retry, aborts the stager and frees the lease", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps);
    // A tar whose second file has a bad path: index.html is staged, then the whole bundle fails.
    const bad = tar([...SITE, { name: "/etc/passwd", data: "x" }]);
    const e = await redeemError(t, bad, deps);
    expect(e.code).toBe("invalid_input");
    const prefix = [...log.added.keys()][0] as string;
    expect(log.aborted).toContain(prefix);
    expect(await keysUnder(prefix)).toEqual([]);
    expect(await ticket(t.upload_id)).toMatchObject({
      state: "open",
      attempts: 1,
      receiving_until: null,
    });
    expect((await redeem(t, goodTar(), deps)).status).toBe(201);
  });

  it("at most 5 attempts: the 6th gets upload_exhausted", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps);
    for (let i = 0; i < LIMITS.maxTicketAttempts; i++) {
      expect((await redeemError(t, zip(), deps)).message).toMatch(/zip archive/);
    }
    const e = await redeemError(t, goodTar(), deps);
    expect(e.code).toBe("invalid_input");
    expect(details(e)).toMatchObject({ reason: "upload_exhausted" });
    expect(log.commits).toHaveLength(0);
    expect((await ticket(t.upload_id)).attempts).toBe(5);
  });

  it("bundle requests are limited to twice MAX_PUBLISHES_PER_HOUR per user", async () => {
    const cfg = parseConfig({ ...env, MAX_PUBLISHES_PER_HOUR: "1" } as never);
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps, cfg);
    await hit(env.DB, `bundle:${a.user.id}`, 2, 3600);
    await hit(env.DB, `bundle:${a.user.id}`, 2, 3600);
    const e = await redeemError(t, goodTar(), deps, cfg);
    expect(e.code).toBe("rate_limited");
    expect(details(e).retry_after).toBeGreaterThan(0);
    expect(log.commits).toHaveLength(0);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "open", receiving_until: null });
  });

  it("an editor removed before the bundle is refused; the ticket stays open", async () => {
    const { id } = await ownerWithArtifact();
    const editor = await agent();
    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const { deps, log } = fakeStage();
    const t = await mint(editor, { id, base_version: 1 }, deps);
    await db().delete(accessGrants).where(eq(accessGrants.email, editor.user.email)).run();
    const e = await redeemError(t, goodTar(), deps);
    expect(["forbidden", "not_found"]).toContain(e.code);
    expect(log.commits).toHaveLength(0);
    expect((await ticket(t.upload_id)).state).toBe("open");
  });

  it("rights are the minted scopes intersected with the connection's current ones", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps);
    await db()
      .update(agentConnections)
      .set({ scopes: "artifacts:read" })
      .where(eq(agentConnections.id, a.connectionId))
      .run();
    const e = await redeemError(t, goodTar(), deps);
    expect(e.code).toBe("forbidden");
    expect(log.commits).toHaveLength(0);
  });

  it("the explicit Ctx ignores session, viewer and password cookies", async () => {
    // The owner's own browser cookies ride along on the editor's bundle request; they must not
    // lend the request any rights or identity.
    const { a: owner, id } = await ownerWithArtifact();
    const editor = await agent();
    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const { deps, log } = fakeStage();
    const t = await mint(editor, { id, base_version: 1 }, deps);
    const ownerSession = await browserSession(owner.user.id);
    const viewerValue = newToken("v_");
    await db()
      .insert(sessions)
      .values({
        id: await hashToken(viewerValue),
        kind: "viewer",
        viewerEmail: "viewer@example.com",
        expiresAt: isoIn(3600_000),
        createdAt: nowIso(),
      })
      .run();
    const cookie = `${ownerSession.cookie}; ${COOKIES.viewer}=${viewerValue}; ${COOKIES.passwordPassPrefix}${id}=junk`;

    const app = new Hono<AppEnv>();
    app.onError((err, c) =>
      err instanceof ApiError
        ? c.json(err.toBody(), err.status as 400)
        : c.json({ e: String(err) }, 500),
    );
    app.use("*", base);
    app.post(`/api/v1${API.uploadBundle}`, bundleHandler(deps));
    const send = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(t.upload_url, {
          method: "POST",
          headers: { Authorization: `Bearer ${t.upload_token}`, Cookie: cookie },
          body: goodTar(),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    // The editor loses the role: the owner's session cookie on the request does not help.
    await db().delete(accessGrants).where(eq(accessGrants.email, editor.user.email)).run();
    const refused = await send();
    expect([403, 404]).toContain(refused.status);
    for (const ctx of log.ctxs) {
      expect(ctx.principal).toMatchObject({
        kind: "agent",
        userId: editor.user.id,
        connectionId: editor.connectionId,
      });
      expect(ctx.viewerEmail).toBeNull();
      expect(ctx.passwordPasses.size).toBe(0);
    }

    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(log.ctxs.length).toBeGreaterThan(2);
    for (const ctx of log.ctxs) {
      expect(ctx.principal).toMatchObject({ userId: editor.user.id });
      expect(ctx.viewerEmail).toBeNull();
    }
  });

  it("an admin ticket redeems as the admin principal while single-user mode holds", async () => {
    const admin = await createUser();
    const adminToken = "admin-token-for-upload-tests-0123456789abcdef";
    const cfg = parseConfig({
      ...env,
      SINGLE_USER_MODE: "true",
      ADMIN_EMAIL: admin.email,
      ADMIN_TOKEN: adminToken,
    } as never);
    const { deps, log } = fakeStage();
    const t = await mint({ token: adminToken }, {}, deps, cfg);
    expect((await redeem(t, goodTar(), deps, cfg)).status).toBe(201);
    expect(log.ctxs.at(-1)?.principal).toMatchObject({
      kind: "agent",
      userId: admin.id,
      connectionId: null,
      connectionLabel: "Admin token",
    });
  });

  it("refuses a request without a body, keeping the ticket", async () => {
    const a = await agent();
    const { deps } = fakeStage();
    const t = await mint(a, {}, deps);
    const e = await redeemBundle(
      bundleEnv(),
      {
        uploadId: t.upload_id,
        authorization: `Bearer ${t.upload_token}`,
        contentLength: undefined,
        body: null,
      },
      deps,
    ).catch((x) => x as ApiError);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("invalid_input");
    expect((await ticket(t.upload_id)).state).toBe("open");
  });

  it("streams a 50 MB, 511-file bundle within the memory bounds (stand-in stager)", async () => {
    const a = await agent();
    const { deps, log } = fakeStage();
    const t = await mint(a, {}, deps);
    const files = viteBuild(511);
    const per = Math.floor((50 * 1024 * 1024 - 2048) / 510) - 512;
    const body = gzipStream(
      lazyStream(async function* () {
        yield entry(files[0] as EntrySpec);
        for (let i = 1; i < files.length; i++) {
          yield entry({ name: (files[i] as EntrySpec).name, data: filler(per, i) });
        }
        yield END;
      }),
    );
    const { status, body: result } = await redeem(t, body, deps);
    expect(status).toBe(201);
    expect(result.bundle.entries).toBe(511);
    expect(result.stored.bytes).toBeGreaterThan(49 * 1024 * 1024);
    expect(log.commits).toHaveLength(1);
  }, 120_000);
});

// ---------- end to end with the real stager ----------

describe("end to end with the real stager", () => {
  it("MCP start_upload {} then the curl bundle of a 420-file Vite build: 201 and the content host serves every file", {
    timeout: BIG_BUNDLE_TIMEOUT_MS,
  }, async () => {
    const a = await agent();
    const c = await mcpClient(a.token);
    const r = await tool<StartUploadResult>(c, "start_upload", {});
    expect(r.isError).toBe(false);
    const files = viteBuild(420, { dir: "." });
    const res = await postBundle(r.data.upload_url, {
      token: r.data.upload_token,
      body: await gzip(tar(files)),
      headers: { "Content-Type": "application/gzip" },
    });
    expect(res.status).toBe(201);
    const out = await json(res);
    expect(out.bundle.entries).toBe(420);
    expect(out.stored.files).toBe(420);
    const entered = await enterContent(out.slug, { headers: a.auth });
    for (const f of files) {
      const path = f.name.replace(/^\.\//, "");
      const page = await call(`${contentOrigin(out.id)}/${path}`, {
        headers: { Cookie: entered.cookie ?? "" },
      });
      expect(page.status, path).toBe(200);
      expect(await page.text()).toBe(String(f.data));
    }
  });

  it("a bundle update that changes one file writes exactly 2 objects (the file and the source)", async () => {
    const a = await agent();
    const c = await mcpClient(a.token);
    const files = viteBuild(30);
    const t1 = await tool<StartUploadResult>(c, "start_upload", {});
    const first = await json(
      await postBundle(t1.data.upload_url, { token: t1.data.upload_token, body: tar(files) }),
    );
    const before = new Set(
      (await env.FILES.list({ prefix: `artifacts/${first.id}/` })).objects.map((o) => o.key),
    );
    const changed = files.map((f, i) => (i === 5 ? { ...f, data: "changed" } : f));
    const t2 = await tool<StartUploadResult>(c, "start_upload", {
      id: first.id,
      base_version: 1,
    });
    const second = await json(
      await postBundle(t2.data.upload_url, { token: t2.data.upload_token, body: tar(changed) }),
    );
    expect(second.stored).toMatchObject({ written: 2, reused: 28 });
    const after = (await env.FILES.list({ prefix: `artifacts/${first.id}/` })).objects.map(
      (o) => o.key,
    );
    expect(after.filter((k) => !before.has(k))).toHaveLength(2);
  });

  it("publish mode, lease lapsed mid-upload: both requests reach commitStaged, the ticket guard lets exactly one artifact in", async () => {
    // The receiving lease keeps a second request out while the first is live, so a plain
    // Promise.all never makes two requests commit. Instead hold the first request mid-stream,
    // let its lease lapse, commit a second bundle, then release the first: it reaches the real
    // commit batch with the ticket already used, and the batch's ticket guard must refuse the
    // artifact INSERT.
    const a = await agent();
    const t = await mint(a);
    const keys = async () =>
      new Set((await env.FILES.list({ prefix: "artifacts/" })).objects.map((o) => o.key));
    const before = await keys();
    const bytes = goodTar();
    const head = BLOCK * 2; // index.html's header and its first data block
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused!: () => void;
    const reachedPause = new Promise<void>((r) => {
      paused = r;
    });
    const slowBody = lazyStream(async function* () {
      yield bytes.slice(0, head);
      paused();
      await gate;
      yield bytes.slice(head);
    });
    const slow = postBundle(t.upload_url, { token: t.upload_token, body: slowBody });
    await reachedPause;
    // The first request holds the receiving lease; the ticket itself stays open until a commit.
    const held = await ticket(t.upload_id);
    expect(held).toMatchObject({ state: "open", attempts: 1 });
    expect(held?.receiving_until).not.toBeNull();
    await setTicket(t.upload_id, "receiving_until = ?2", new Date(Date.now() - 1000).toISOString());
    const fast = await postBundle(t.upload_url, { token: t.upload_token });
    expect(fast.status).toBe(201);
    const won = await json(fast);
    release();
    const lost = await slow;
    expect(lost.status).toBe(409);
    expect((await json(lost)).error.details).toMatchObject({ reason: "upload_used", id: won.id });

    const n = await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE owner_id = ?1")
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "used", attempts: 2 });
    // Nothing of the loser's attempt is left: every new object belongs to the winner's artifact.
    const added = [...(await keys())].filter((k) => !before.has(k));
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((k) => !k.startsWith(`artifacts/${won.id}/`))).toEqual([]);
    const attempts = new Set(
      added.map((k) => /^artifacts\/[^/]+\/v\d+\.[^/]+\//.exec(k)?.[0]).filter(Boolean),
    );
    expect(attempts.size).toBeLessThanOrEqual(1);
  });

  it("a doc bundle goes through resolveSource and checkAsset: images only, index.html refused", async () => {
    const a = await agent();
    const ok = await mint(a, { type: "doc" });
    const res = await postBundle(ok.upload_url, {
      token: ok.upload_token,
      body: tar([
        { name: "content.md", data: "# Notes\n\n![x](img/a.png)" },
        { name: "img/a.png", data: "png" },
      ]),
    });
    expect(res.status).toBe(201);
    for (const extra of [
      { name: "index.html", data: "<p>x</p>" },
      { name: "app.js", data: "x" },
    ]) {
      const t = await mint(a, { type: "doc" });
      const r = await postBundle(t.upload_url, {
        token: t.upload_token,
        body: tar([{ name: "content.md", data: "# Notes" }, extra]),
      });
      expect(r.status).toBe(400);
    }
  });

  it("a bundled page that declares shared data stores its capabilities", async () => {
    const a = await agent();
    const t = await mint(a);
    const res = await postBundle(t.upload_url, {
      token: t.upload_token,
      body: tar([
        {
          name: "index.html",
          data: '<!doctype html><meta name="plinth-capabilities" content="data viewer"><title>Poll</title>',
        },
      ]),
    });
    const out = await json(res);
    const row = await env.DB.prepare(
      "SELECT capabilities FROM versions WHERE artifact_id = ?1 AND number = 1",
    )
      .bind(out.id)
      .first<{ capabilities: string | null }>();
    expect(row?.capabilities).not.toBeNull();
  });

  it("REST POST /uploads mints a ticket (201) that the bundle redeems", async () => {
    const a = await agent();
    const res = await call("/api/v1/uploads", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From REST" }),
    });
    expect(res.status).toBe(201);
    const t = (await json(res)) as StartUploadResult;
    const b = await postBundle(t.upload_url, { token: t.upload_token });
    expect(b.status).toBe(201);
    expect((await json(b)).bundle.entries).toBe(2);
  });

  it("a 50 MB, 511-file bundle passes through the real stager in the Workers pool", {
    timeout: BIG_BUNDLE_TIMEOUT_MS,
  }, async () => {
    const a = await agent();
    const t = await mint(a);
    const per = Math.floor((50 * 1024 * 1024 - 2048) / 510) - 512;
    const body = gzipStream(
      lazyStream(async function* () {
        yield entry({ name: "index.html", data: "<!doctype html><title>big</title>" });
        for (let i = 1; i < 511; i++)
          yield entry({ name: `assets/c${i}.js`, data: filler(per, i) });
        yield END;
      }),
    );
    const res = await postBundle(t.upload_url, { token: t.upload_token, body });
    expect(res.status).toBe(201);
  });

  it("holds at most max(in-flight budget, one file) of file bytes at once while R2 is slow", async () => {
    // workerd exposes no heap figures and enforces no isolate limit in the pool, so the bound is
    // checked structurally: every file's bytes are counted from the moment they exist (the
    // reserve before the reader allocates them, then add) until their R2 put settles. Without
    // the reserve, the reader allocates the next 25 MB file while the last one is still in flight.
    const a = await agent();
    const t = await mint(a, {}, stageDeps);
    const files = env.FILES;
    let inflight = 0;
    let atReserve = 0;
    let atAdd = 0;
    const slow = new Proxy(files, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, value: Uint8Array, o?: R2PutOptions) => {
            const n = value.byteLength;
            inflight += n;
            try {
              await new Promise((ok) => setTimeout(ok, 150));
              return await target.put(key, value, o);
            } finally {
              inflight -= n;
            }
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const deps: StageDeps = {
      ...stageDeps,
      openStager: async (ctx, target) => {
        const s = await stageDeps.openStager({ ...ctx, env: { ...ctx.env, FILES: slow } }, target);
        return {
          prefix: s.prefix,
          reserve: async (size) => {
            await s.reserve(size);
            atReserve = Math.max(atReserve, inflight + size);
          },
          add: async (path, bytes) => {
            atAdd = Math.max(atAdd, inflight + bytes.byteLength);
            await s.add(path, bytes);
          },
          addRef: (p, h) => s.addRef(p, h),
          finish: (o) => s.finish(o),
          abort: () => s.abort(),
        };
      },
    };
    const big = LIMITS.maxBundleFileBytes - 4096;
    const body = gzipStream(
      lazyStream(async function* () {
        yield entry({ name: "index.html", data: "<!doctype html><title>big</title>" });
        yield entry({ name: "a.wasm", data: filler(big, 1) });
        yield entry({ name: "b.wasm", data: filler(big, 2) });
        for (let i = 0; i < 4; i++)
          yield entry({ name: `c${i}.js`, data: filler(3 * 1024 * 1024, 10 + i) });
        yield END;
      }),
    );
    const cfg = parseConfig({ ...env, MAX_VERSION_BYTES: String(64 * 1024 * 1024) } as never);
    const { status } = await redeem(t, body, deps, cfg);
    expect(status).toBe(201);
    const bound = Math.max(LIMITS.bundleInFlightBytes, LIMITS.maxBundleFileBytes);
    expect(atAdd).toBeLessThanOrEqual(bound);
    expect(atReserve).toBeGreaterThan(0);
    expect(atReserve).toBeLessThanOrEqual(bound);
    expect(inflight).toBe(0);
  }, 120_000);
});

// ---------- an abandoned or slow attempt ----------

describe("an abandoned, slow or over-quota bundle leaves nothing behind", () => {
  /** A body that sends `parts`, then stalls until `fail` is called. */
  function stallingBody(parts: Uint8Array[]) {
    let fail!: (e: unknown) => void;
    const stalled = new Promise<never>((_, reject) => {
      fail = reject;
    });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i < parts.length) c.enqueue(parts[i++] as Uint8Array);
        else await stalled;
      },
    });
    return { body, fail: (e: unknown) => fail(e) };
  }

  async function newKeys(id: string): Promise<string[]> {
    const v1 = (await versionRow(id, 1))?.r2Prefix as string;
    return (await keysUnder(`artifacts/${id}/`)).filter((k) => !k.startsWith(v1));
  }

  it("a client disconnect deletes the attempt's files and frees the lease through waitUntil", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const s = stallingBody([
      entry({ name: "index.html", data: "<!doctype html><title>x</title>" }),
      entry({ name: "a.js", data: filler(100_000, 1) }),
      entry({ name: "b.js", data: filler(100_000, 2) }),
    ]);
    const ac = new AbortController();
    const waits: Promise<unknown>[] = [];
    const pending = redeemBundle(
      { ...bundleEnv(), waitUntil: (p) => void waits.push(p) },
      {
        uploadId: t.upload_id,
        authorization: `Bearer ${t.upload_token}`,
        contentLength: undefined,
        body: s.body,
        signal: ac.signal,
      },
      stageDeps,
    ).catch((e: unknown) => e);
    // The two assets reach R2 while the body is still arriving.
    for (let i = 0; i < 200 && (await newKeys(id)).length < 2; i++) {
      await new Promise((ok) => setTimeout(ok, 10));
    }
    expect(await newKeys(id)).toHaveLength(2);
    expect((await ticket(t.upload_id)).receiving_until).not.toBeNull();
    // The client goes away; the handler is still waiting on the body. The cleanup is handed to
    // waitUntil at once, without waiting for the read to fail.
    ac.abort();
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(await newKeys(id)).toEqual([]);
    expect((await ticket(t.upload_id)).receiving_until).toBeNull();
    s.fail(new Error("connection lost"));
    const e = (await pending) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(await newKeys(id)).toEqual([]);
    const row = await ticket(t.upload_id);
    expect(row).toMatchObject({ state: "open", attempts: 1, receiving_until: null });
  });

  it("refuses a bundle that is still arriving when its receiving lease ends", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const parts = [
      entry({ name: "a.js", data: filler(50_000, 1) }),
      entry({ name: "index.html", data: "<!doctype html><title>x</title>" }),
      END,
    ];
    let i = 0;
    const realNow = Date.now;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        // The rest of the bundle arrives 11 minutes after the lease was taken.
        if (i === 1) Date.now = () => realNow() + TTL.uploadReceivingMs + 60_000;
        if (i < parts.length) c.enqueue(parts[i++] as Uint8Array);
        else c.close();
      },
    });
    let e: ApiError;
    try {
      e = (await redeem(t, body, stageDeps).catch((x: unknown) => x)) as ApiError;
    } finally {
      Date.now = realNow;
    }
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("invalid_input");
    expect(details(e).reason).toBe("upload_too_slow");
    expect(await newKeys(id)).toEqual([]);
    expect((await versionRow(id, 2)) ?? null).toBeNull();
    expect(await ticket(t.upload_id)).toMatchObject({ state: "open", receiving_until: null });
  });

  /** stageDeps whose stager writes through `files` (a proxy over the real bucket). */
  function depsWithFiles(files: R2Bucket): StageDeps {
    return {
      ...stageDeps,
      openStager: (ctx, target, opts) =>
        stageDeps.openStager({ ...ctx, env: { ...ctx.env, FILES: files } }, target, opts),
    };
  }

  /** A proxy over env.FILES that calls `onPut` before a put whose key matches `match`. */
  function filesWith(match: (key: string) => boolean, onPut: () => Promise<void> | void) {
    const files = env.FILES;
    return new Proxy(files, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, value: Uint8Array, o?: R2PutOptions) => {
            if (match(key)) await onPut();
            return target.put(key, value, o);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it.each([
    ["held while the abort runs", "held"],
    ["aborting inside the put call", "inside"],
  ] as const)(
    "a disconnect while finish writes the source never commits (%s): no version, no files, the ticket stays open",
    async (_label, how) => {
      const { a, id } = await ownerWithArtifact();
      const t = await mint(a, { id, base_version: 1 }, stageDeps);
      const v1 = (await versionRow(id, 1))?.r2Prefix as string;
      const ac = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((ok) => {
        release = ok;
      });
      let reached!: () => void;
      const atSource = new Promise<void>((ok) => {
        reached = ok;
      });
      // The source is held until finish, so its put is always finish's last write.
      const files = filesWith(
        (key) => key.endsWith("/index.html") && !key.startsWith(v1),
        async () => {
          reached();
          if (how === "inside") {
            ac.abort();
            await new Promise((ok) => setTimeout(ok, 50));
          } else await gate;
        },
      );
      const waits: Promise<unknown>[] = [];
      const pending = redeemBundle(
        { ...bundleEnv(), waitUntil: (p) => void waits.push(p) },
        {
          uploadId: t.upload_id,
          authorization: `Bearer ${t.upload_token}`,
          contentLength: undefined,
          body: streamOf(
            tar([
              {
                name: "index.html",
                data: "<!doctype html><title>x</title><script src=a.js></script>",
              },
              { name: "a.js", data: filler(10_000, 1) },
            ]),
          ),
          signal: ac.signal,
        },
        depsWithFiles(files),
      ).catch((e: unknown) => e);
      await atSource;
      if (how === "held") {
        ac.abort();
        release();
      }
      const e = (await pending) as ApiError;
      await Promise.all(waits);
      expect(e).toBeInstanceOf(ApiError);
      expect((await versionRow(id, 2)) ?? null).toBeNull();
      const art = await env.DB.prepare("SELECT current_version AS cur FROM artifacts WHERE id = ?1")
        .bind(id)
        .first<{ cur: number }>();
      expect(art?.cur).toBe(1);
      expect(await newKeys(id)).toEqual([]);
      expect(await ticket(t.upload_id)).toMatchObject({ state: "open", receiving_until: null });
    },
  );

  it("a disconnect once the commit has begun leaves its files alone: the version serves whole", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const ac = new AbortController();
    const waits: Promise<unknown>[] = [];
    const deps: StageDeps = {
      ...stageDeps,
      commitStaged: async (ctx, target, staged, o) => {
        // The client goes away after the batch has been sent.
        const done = stageDeps.commitStaged(ctx, target, staged, o);
        ac.abort();
        return done;
      },
    };
    const res = await redeemBundle(
      { ...bundleEnv(), waitUntil: (p) => void waits.push(p) },
      {
        uploadId: t.upload_id,
        authorization: `Bearer ${t.upload_token}`,
        contentLength: undefined,
        body: streamOf(
          tar([
            { name: "index.html", data: "<!doctype html><title>x</title>" },
            { name: "a.js", data: filler(10_000, 2) },
          ]),
        ),
        signal: ac.signal,
      },
      deps,
    );
    await Promise.all(waits);
    expect(res).toMatchObject({ status: 200, body: { version: 2 } });
    const v2 = (await versionRow(id, 2))?.r2Prefix as string;
    expect((await keysUnder(v2)).sort()).toEqual([`${v2}a.js`, `${v2}index.html`]);
    expect((await ticket(t.upload_id)).state).toBe("used");
  });

  it("a connection revoked while its bundle streams stops the commit: 401, nothing committed", async () => {
    for (const when of ["while streaming", "just before the batch"] as const) {
      const { a, id } = await ownerWithArtifact();
      const t = await mint(a, { id, base_version: 1 }, stageDeps);
      let resume!: () => void;
      const resumed = new Promise<void>((ok) => {
        resume = ok;
      });
      let stalled!: () => void;
      const atStall = new Promise<void>((ok) => {
        stalled = ok;
      });
      const parts = [
        entry({ name: "index.html", data: "<!doctype html><title>x</title>" }),
        entry({ name: "a.js", data: filler(10_000, 3) }),
        END,
      ];
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i === 2 && when === "while streaming") {
            stalled();
            await resumed;
          }
          if (i < parts.length) c.enqueue(parts[i++] as Uint8Array);
          else c.close();
        },
      });
      const deps: StageDeps = {
        ...stageDeps,
        commitStaged: async (ctx, target, staged, o) => {
          // Past every check in the handler: only the batch's guard is left.
          if (when === "just before the batch") {
            await revokeConnection(db(), a.user.id, a.connectionId);
          }
          return stageDeps.commitStaged(ctx, target, staged, o);
        },
      };
      const pending = redeem(t, body, deps).catch((e: unknown) => e);
      if (when === "while streaming") {
        await atStall;
        await revokeConnection(db(), a.user.id, a.connectionId);
        resume();
      }
      const e = (await pending) as ApiError;
      expect(e, when).toBeInstanceOf(ApiError);
      expect(e.code, when).toBe("unauthorized");
      expect((await versionRow(id, 2)) ?? null, when).toBeNull();
      expect(await newKeys(id), when).toEqual([]);
      expect((await ticket(t.upload_id)).state, when).toBe("open");
    }
  });

  it("a takedown while the bundle commits is reported as one, not as someone else's publish", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const deps: StageDeps = {
      ...stageDeps,
      commitStaged: async (ctx, target, staged, o) => {
        // The files are put and the attempt's row exists: the takedown claims it (decideReport).
        const now = Date.now();
        const results = await env.DB.batch([
          env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2").bind(
            new Date(now).toISOString(),
            id,
          ),
          claimArtifactAttempts(env.DB, id, now),
        ]);
        expect(results[1]?.results).toHaveLength(1);
        await clearClaimedAttempts(env, results[1]);
        return stageDeps.commitStaged(ctx, target, staged, o);
      },
    };
    const e = await redeemError(
      t,
      tar([
        { name: "index.html", data: "<!doctype html><title>x</title>" },
        { name: "a.js", data: filler(10_000, 4) },
      ]),
      deps,
    );
    expect(e).toMatchObject({ code: "forbidden", details: { reason: "taken_down" } });
    expect((await versionRow(id, 2)) ?? null).toBeNull();
    // The ticket ends with the takedown as its reason, never as someone else's version.
    expect(await ticket(t.upload_id)).toMatchObject({ state: "dead", dead_reason: "taken_down" });
    const status = await uploadStatus(bundleEnv(), {
      uploadId: t.upload_id,
      authorization: `Bearer ${t.upload_token}`,
    });
    expect(status.state).toBe("taken_down");
    expect(status.next).not.toMatch(/Someone published|send the bundle again/i);
  });

  it("an editor removed while the bundle streams is refused before the commit", async () => {
    const { id } = await ownerWithArtifact();
    const editor = await agent();
    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const t = await mint(editor, { id, base_version: 1 }, stageDeps);
    let resume!: () => void;
    const resumed = new Promise<void>((ok) => {
      resume = ok;
    });
    let stalled!: () => void;
    const atStall = new Promise<void>((ok) => {
      stalled = ok;
    });
    const parts = [entry({ name: "index.html", data: "<!doctype html><title>x</title>" }), END];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i === 1) {
          stalled();
          await resumed;
        }
        if (i < parts.length) c.enqueue(parts[i++] as Uint8Array);
        else c.close();
      },
    });
    const pending = redeem(t, body, stageDeps).catch((e: unknown) => e);
    await atStall;
    await db().delete(accessGrants).where(eq(accessGrants.email, editor.user.email)).run();
    resume();
    const e = (await pending) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(["forbidden", "not_found"]).toContain(e.code);
    expect((await versionRow(id, 2)) ?? null).toBeNull();
    expect(await newKeys(id)).toEqual([]);
  });

  it("an editor removed while finish writes the held source is refused before the commit", async () => {
    const { id } = await ownerWithArtifact();
    const editor = await agent();
    await db()
      .insert(accessGrants)
      .values({ artifactId: id, email: editor.user.email, role: "editor", createdAt: nowIso() })
      .run();
    const t = await mint(editor, { id, base_version: 1 }, stageDeps);
    const v1 = (await versionRow(id, 1))?.r2Prefix as string;
    // The source is held until finish; its put is the last write before the commit.
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, value: Uint8Array, o?: R2PutOptions) => {
            if (key.endsWith("/index.html") && !key.startsWith(v1)) {
              await db()
                .delete(accessGrants)
                .where(eq(accessGrants.email, editor.user.email))
                .run();
            }
            return target.put(key, value, o);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const deps: StageDeps = {
      ...stageDeps,
      openStager: (ctx, target, opts) =>
        stageDeps.openStager({ ...ctx, env: { ...ctx.env, FILES: files } }, target, opts),
    };
    const body = tar([
      { name: "index.html", data: "<!doctype html><title>x</title><script src=a.js></script>" },
      { name: "a.js", data: filler(20_000, 7) },
    ]);
    const e = (await redeem(t, streamOf(body), deps).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(["forbidden", "not_found"]).toContain(e.code);
    expect((await versionRow(id, 2)) ?? null).toBeNull();
    expect(await newKeys(id)).toEqual([]);
  });

  it("a sender that declares a file and goes quiet is cut off at the deadline, with no more data", {
    timeout: BIG_BUNDLE_TIMEOUT_MS,
  }, async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const big = LIMITS.maxBundleFileBytes;
    const head = entry({ name: "a.wasm", data: new Uint8Array(big) }).subarray(0, 2 * BLOCK);
    const parts = [entry({ name: "index.html", data: "<!doctype html><title>x</title>" }), head];
    let i = 0;
    let cancelled = false;
    let quiet!: () => void;
    const wentQuiet = new Promise<void>((ok) => {
      quiet = ok;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          if (i < parts.length) {
            c.enqueue(parts[i++] as Uint8Array);
            return;
          }
          quiet();
          await new Promise<never>(() => {});
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const realNow = Date.now;
    let settled = false;
    const pending = redeem(t, body, stageDeps)
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    let e: ApiError;
    try {
      await wentQuiet;
      await new Promise((ok) => setTimeout(ok, 50));
      expect(settled).toBe(false);
      Date.now = () => realNow() + TTL.uploadReceivingMs + 60_000;
      e = (await pending) as ApiError;
    } finally {
      Date.now = realNow;
    }
    expect(e).toBeInstanceOf(ApiError);
    expect(details(e).reason).toBe("upload_too_slow");
    expect(cancelled).toBe(true);
    expect(await newKeys(id)).toEqual([]);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "open", receiving_until: null });
  });

  it("a top-directory source past the source limit is not held in memory: it goes out at once and is refused at finish", async () => {
    const a = await agent();
    const t = await mint(a, {}, stageDeps);
    const puts: string[] = [];
    let pendingAtWasm = null as string[] | null;
    const files = env.FILES;
    const spy = new Proxy(files, {
      get(target, prop) {
        if (prop === "put") {
          return (key: string, value: Uint8Array, o?: R2PutOptions) => {
            if (key.endsWith("dist/a.wasm")) pendingAtWasm = [...puts];
            puts.push(key);
            return target.put(key, value, o);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const bigHtml = `<!doctype html><title>big</title>${"x".repeat(6 * 1024 * 1024)}`;
    const e = await redeemError(
      t,
      tar([
        { name: "dist/index.html", data: bigHtml },
        { name: "dist/a.wasm", data: filler(100_000, 4) },
      ]),
      depsWithFiles(spy),
    );
    expect(e.code).toBe("payload_too_large");
    expect(e.message).toBe("HTML is over 5 MB");
    // dist/index.html was put before the next file arrived, not held until finish.
    expect((pendingAtWasm ?? []).some((k) => k.endsWith("dist/index.html"))).toBe(true);

    // The same file beside a root index.html is an ordinary asset (no strip).
    const t2 = await mint(a, {}, stageDeps);
    const ok = await redeem(
      t2,
      tar([
        { name: "dist/index.html", data: bigHtml },
        { name: "index.html", data: "<!doctype html><title>root</title>" },
      ]),
      stageDeps,
    );
    expect(ok.status).toBe(201);
  });

  it("an account at its storage quota stages nothing; below it, puts stop at the room left", async () => {
    const { a, id } = await ownerWithArtifact();
    const used = (await env.DB.prepare(
      `SELECT coalesce(sum(coalesce(stored_bytes, size_bytes)), 0) AS n FROM versions v
         JOIN artifacts x ON x.id = v.artifact_id WHERE x.owner_id = (SELECT owner_id FROM artifacts WHERE id = ?1)`,
    )
      .bind(id)
      .first<{ n: number }>()) as { n: number };
    const full = parseConfig({ ...env, MAX_STORAGE_BYTES_PER_USER: String(used.n) } as never);
    const t1 = await mint(a, { id, base_version: 1 }, stageDeps, full);
    const reads: number[] = [];
    let n = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          reads.push(n++);
          c.enqueue(goodTar());
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const e1 = await redeemError(t1, body, stageDeps, full);
    expect(e1.code).toBe("quota_exceeded");
    expect(reads).toEqual([]);
    expect(await newKeys(id)).toEqual([]);

    const room = parseConfig({
      ...env,
      MAX_STORAGE_BYTES_PER_USER: String(used.n + 150_000),
    } as never);
    const t2 = await mint(a, { id, base_version: 1 }, stageDeps, room);
    const e2 = await redeemError(
      t2,
      tar([
        { name: "a.js", data: filler(100_000, 1) },
        { name: "b.js", data: filler(100_000, 2) },
        { name: "c.js", data: filler(100_000, 3) },
        { name: "index.html", data: "<!doctype html><title>x</title>" },
      ]),
      stageDeps,
      room,
    );
    expect(e2.code).toBe("quota_exceeded");
    expect(details(e2).adding_bytes).toBe(200_000);
    expect(await newKeys(id)).toEqual([]);
    expect((await ticket(t2.upload_id)).state).toBe("open");
  });
});

// ---------- a lost response, then a retry ----------

describe("a lost response, then a retry", () => {
  const SITE2 = [
    { name: "index.html", data: "<!doctype html><title>Bundled</title><p>second</p>" },
    { name: "assets/app.js", data: "console.log(2)" },
  ];

  /** What a retry must leave alone: the artifact row, its versions and its stored objects. */
  async function snapshot(id: string) {
    const art = await env.DB.prepare(
      "SELECT current_version AS cur, updated_at AS updated FROM artifacts WHERE id = ?1",
    )
      .bind(id)
      .first<{ cur: number; updated: string }>();
    const versions = await env.DB.prepare(
      "SELECT number, r2_prefix AS prefix FROM versions WHERE artifact_id = ?1 ORDER BY number",
    )
      .bind(id)
      .all<{ number: number; prefix: string }>();
    return { art, versions: versions.results, keys: (await keysUnder(`artifacts/${id}/`)).sort() };
  }

  /** A response the client never read: drop its body unread. */
  async function lose(res: Response): Promise<void> {
    await res.body?.cancel();
  }

  it("a body that ends mid-file (the client went away while sending) commits nothing", async () => {
    // The guarantee the docs give: a disconnect before the whole tar arrived can never commit,
    // because the tar is incomplete. No request.signal is involved here.
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const before = await snapshot(id);
    const full = tar(SITE2);
    const res = await postBundle(t.upload_url, {
      token: t.upload_token,
      body: full.slice(0, BLOCK * 2 + 100),
    });
    expect(res.status).toBe(400);
    await lose(res);
    expect(await snapshot(id)).toEqual(before);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "open", attempts: 1 });
  });

  it("commit lands, response lost: start_upload with the old base and a second ticket's bundle get the conflict; no v3", async () => {
    const { a, id } = await ownerWithArtifact();
    const c = await mcpClient(a.token);
    const t1 = await tool<StartUploadResult>(c, "start_upload", { id, base_version: 1 });
    // A second ticket for the same base, minted before the first commits (an agent that asked twice).
    const t2 = await tool<StartUploadResult>(c, "start_upload", { id, base_version: 1 });
    expect(t1.isError || t2.isError).toBe(false);
    const res = await postBundle(t1.data.upload_url, {
      token: t1.data.upload_token,
      body: tar(SITE2),
    });
    expect(res.status).toBe(200);
    await lose(res);
    const after = await snapshot(id);
    expect(after.art?.cur).toBe(2);

    // The agent checks first: get_artifact shows the version the lost request committed.
    const got = await tool(c, "get_artifact", { id });
    expect(got.data.version).toBe(2);
    // Retrying blindly against the old base is refused at mint, before anything is staged.
    const again = await tool(c, "start_upload", { id, base_version: 1 });
    expect(again.isError).toBe(true);
    expect(again.data.error).toMatchObject({ code: "conflict", details: { current_version: 2 } });
    // The ticket minted before the commit gets the usual conflict on its bundle, and dies.
    const late = await postBundle(t2.data.upload_url, {
      token: t2.data.upload_token,
      body: tar(SITE2),
    });
    expect(late.status).toBe(409);
    expect((await json(late)).error.details).toMatchObject({
      reason: "conflict",
      current_version: 2,
    });
    expect((await ticket(t2.data.upload_id)).state).toBe("dead");

    expect(await snapshot(id)).toEqual(after);
    expect(await versionRow(id, 3)).toBeFalsy();
  });

  it("the same ticket's bundle sent again after its commit answers upload_used and commits nothing", async () => {
    const { a, id, slug } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const first = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE2) });
    expect(first.status).toBe(200);
    await lose(first);
    const after = await snapshot(id);
    const used = await ticket(t.upload_id);
    expect(used).toMatchObject({ state: "used", result_artifact_id: id, result_version: 2 });

    // Re-running the same commands.curl: refused before any byte is staged.
    const again = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE2) });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details).toMatchObject({
      reason: "upload_used",
      id,
      version: 2,
      url: `${config().appOrigin}/a/${slug}`,
    });
    expect(await snapshot(id)).toEqual(after);
    expect(await ticket(t.upload_id)).toMatchObject({ state: "used", attempts: used.attempts });
    expect(await versionRow(id, 3)).toBeFalsy();
  });

  it("publish mode: start_upload names the artifact it creates; a lost response then a retry with the same ticket makes no second artifact", async () => {
    const a = await agent();
    const c = await mcpClient(a.token);
    const t = await tool<StartUploadResult>(c, "start_upload", { title: "Lost answer" });
    expect(t.isError).toBe(false);
    expect(t.data.target.mode).toBe("publish");
    const reserved = (t.data.target as { id: string }).id;
    expect(reserved).toMatch(ARTIFACT_ID_RE);
    // Before the bundle, nothing has that id.
    const none = await tool(c, "get_artifact", { id: reserved });
    expect(none.isError).toBe(true);
    expect(none.data.error.code).toBe("not_found");

    const res = await postBundle(t.data.upload_url, {
      token: t.data.upload_token,
      body: tar(SITE),
    });
    expect(res.status).toBe(201);
    await lose(res);
    const got = await tool(c, "get_artifact", { id: reserved });
    expect(got.isError).toBe(false);
    expect(got.data).toMatchObject({ id: reserved, version: 1 });
    const after = await snapshot(reserved);

    const again = await postBundle(t.data.upload_url, {
      token: t.data.upload_token,
      body: tar(SITE),
    });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details).toMatchObject({
      reason: "upload_used",
      id: reserved,
      version: 1,
    });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE owner_id = ?1")
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(await snapshot(reserved)).toEqual(after);
    expect(await ticket(t.data.upload_id)).toMatchObject({
      state: "used",
      result_artifact_id: reserved,
    });
  });

  it("GET /uploads/:id tells the token's holder whether the upload committed, and nothing more", async () => {
    const { a, id, slug } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    const statusUrl = t.upload_url.replace(/\/bundle$/, "");
    const status = (token?: string, url = statusUrl) =>
      call(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

    const open = await status(t.upload_token);
    expect(open.status).toBe(200);
    expect(await json(open)).toEqual({
      upload_id: t.upload_id,
      state: "open",
      mode: "update",
      id,
      version: null,
      url: null,
      expires_at: t.expires_at,
      receiving_until: null,
      next: expect.any(String),
    });
    // Only the upload token: no token, the agent's own bearer, or another ticket's token.
    expect((await status()).status).toBe(401);
    expect((await status(a.token)).status).toBe(401);
    const other = await mint(a, { id, base_version: 1 }, stageDeps);
    expect((await status(other.upload_token)).status).toBe(404);
    // It reads, never counts an attempt.
    expect((await ticket(t.upload_id)).attempts).toBe(0);

    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE2) });
    expect(res.status).toBe(200);
    await lose(res);
    const done = await json(await status(t.upload_token));
    expect(done).toMatchObject({
      state: "used",
      mode: "update",
      id,
      version: 2,
      url: `${config().appOrigin}/a/${slug}`,
    });
    // The other ticket, minted on the old base, can no longer commit: the status says so.
    const late = await postBundle(other.upload_url, {
      token: other.upload_token,
      body: tar(SITE2),
    });
    expect(late.status).toBe(409);
    const otherStatus = await status(other.upload_token, other.upload_url.replace(/\/bundle$/, ""));
    expect((await json(otherStatus)).state).toBe("dead");
  });

  it("once GET /uploads/:id says open after a lease ran out, that request's commit is refused", async () => {
    const a = await agent();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused!: () => void;
    const reachedPause = new Promise<void>((r) => {
      paused = r;
    });
    // The whole body was read and the last deadline check passed; the commit has not been
    // applied yet when the lease runs out.
    const deps: StageDeps = {
      ...stageDeps,
      async commitStaged(...args) {
        paused();
        await gate;
        return stageDeps.commitStaged(...args);
      },
    };
    const t = await mint(a, { title: "Lease" }, deps);
    const statusUrl = t.upload_url.replace(/\/bundle$/, "");
    const read = async () =>
      json(await call(statusUrl, { headers: { Authorization: `Bearer ${t.upload_token}` } }));
    const slow = redeemError(t, tar(SITE), deps);
    await reachedPause;
    expect((await read()).state).toBe("receiving");
    await setTicket(t.upload_id, "receiving_until = ?2", new Date(Date.now() - 1000).toISOString());
    // A client that lost its answer reads the status now and is told nothing was published.
    expect(await read()).toMatchObject({ state: "open", version: null });
    release();
    const e = await slow;
    expect(details(e)).toMatchObject({ reason: "upload_too_slow" });
    expect(await read()).toMatchObject({ state: "open", version: null });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE owner_id = ?1")
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("the lost-answer hint asks the upload first, and never takes a new version as proof", () => {
    const update = lostResponseNext("x".repeat(20), 3);
    // The upload's own status tells this upload's commit apart from a collaborator's version.
    expect(update).toMatch(/GET the upload_url without \/bundle/);
    expect(update).toMatch(/dead: someone else published first and this change was not saved/);
    expect(update).toMatch(/with the same base_version 3/);
    // Without it: v4 may be a collaborator's, and anything past v4 certainly includes theirs.
    expect(update).toMatch(/version 4 may be a collaborator's/);
    expect(update).toMatch(/past 4/);
    const pub = lostResponseNext("y".repeat(20), null);
    expect(pub).toMatch(/GET the upload_url without \/bundle/);
    expect(pub).toMatch(/not_found/);
  });

  it("GET /uploads/:id reports a publish-mode ticket's reserved id, then the version it made", async () => {
    const a = await agent();
    const t = await mint(a, { title: "Status" }, stageDeps);
    const reserved = (t.target as { id: string }).id;
    const statusUrl = t.upload_url.replace(/\/bundle$/, "");
    const read = async () =>
      json(await call(statusUrl, { headers: { Authorization: `Bearer ${t.upload_token}` } }));
    expect(await read()).toMatchObject({ state: "open", mode: "publish", id: reserved });
    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(res.status).toBe(201);
    expect((await json(res)).id).toBe(reserved);
    expect(await read()).toMatchObject({ state: "used", id: reserved, version: 1 });
  });
});

// ---------- reserved ids, minting limits, the status window, failure reasons ----------

/** An agent whose account may hold `limit` artifacts. */
async function limitedAgent(limit: number) {
  const a = await agent();
  await env.DB.prepare("UPDATE users SET artifact_limit = ?1 WHERE id = ?2")
    .bind(limit, a.user.id)
    .run();
  return a;
}

/** Fill a rate-limit bucket for the current hour window. */
async function fillBucket(key: string, count: number): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
     ON CONFLICT (key, window_start) DO UPDATE SET count = ?3`,
  )
    .bind(key, nowS - (nowS % 3600), count)
    .run();
}

const statusUrlOf = (t: Pick<StartUploadResult, "upload_url">) =>
  t.upload_url.replace(/\/bundle$/, "");
const readStatus = (url: string, token?: string) =>
  call(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("reserved artifact ids", () => {
  it("a live publish ticket counts toward the artifact limit: minting past it is refused, with next", async () => {
    const a = await limitedAgent(2);
    expect((await publish(a.auth)).res.status).toBe(201);
    const t = await mint(a, { title: "One" }, stageDeps);
    const e = await mintError(a, { title: "Two" }, stageDeps);
    expect(e.code).toBe("quota_exceeded");
    expect(e.message).toMatch(/Artifact limit reached \(2\)/);
    expect(e.message).toMatch(/1 upload/);
    expect(details(e)).toMatchObject({
      limit: 2,
      artifacts: 1,
      reserved_uploads: 1,
      reserved_until: t.expires_at,
    });
    expect(details(e).next).toMatch(/expire/);
    // An inline publish is held to the same count while the reservation lasts.
    const inline = await publish(a.auth);
    expect(inline.res.status).toBe(403);
    expect(inline.body.error.details).toMatchObject({ reserved_uploads: 1 });
    // The ticket's own bundle still commits: its reservation never counts against itself.
    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(res.status).toBe(201);
    expect((await json(res)).id).toBe((t.target as { id: string }).id);
    // At the limit, with no reservation left: the plain artifact-limit error.
    const full = await mintError(a, {}, stageDeps);
    expect(full.code).toBe("quota_exceeded");
    expect(details(full).reserved_uploads).toBeUndefined();
  });

  it("two live reservations for one free slot do not lock each other out: the first bundle commits", async () => {
    // Two mints racing at limit - 1 can both pass the pre-check; set that state up directly.
    const a = await limitedAgent(2);
    expect((await publish(a.auth)).res.status).toBe(201);
    const t1 = await mint(a, { title: "A" }, stageDeps);
    await env.DB.prepare("UPDATE users SET artifact_limit = 3 WHERE id = ?1").bind(a.user.id).run();
    const t2 = await mint(a, { title: "B" }, stageDeps);
    await env.DB.prepare("UPDATE users SET artifact_limit = 2 WHERE id = ?1").bind(a.user.id).run();
    // A bundle is held back by the artifact count only, never by another ticket's reservation.
    const first = await postBundle(t1.upload_url, { token: t1.upload_token, body: tar(SITE) });
    expect(first.status).toBe(201);
    expect((await json(first)).id).toBe((t1.target as { id: string }).id);
    // The account is now full: the other bundle gets the plain artifact-limit error.
    const second = await postBundle(t2.upload_url, { token: t2.upload_token, body: tar(SITE) });
    expect(second.status).toBe(403);
    const err = (await json(second)).error;
    expect(err.code).toBe("quota_exceeded");
    expect(err.details.reserved_uploads).toBeUndefined();
  });

  it("concurrent mints for one free slot: one of the two bundles commits", async () => {
    const a = await limitedAgent(2);
    expect((await publish(a.auth)).res.status).toBe(201);
    const minted = await Promise.allSettled([
      mint(a, { title: "A" }, stageDeps),
      mint(a, { title: "B" }, stageDeps),
    ]);
    const tickets = minted.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(tickets.length).toBeGreaterThan(0);
    const statuses: number[] = [];
    for (const t of tickets) {
      statuses.push(
        (await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) })).status,
      );
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  });

  it("a ticket whose connection was revoked holds no slot", async () => {
    const a = await limitedAgent(3);
    expect((await publish(a.auth)).res.status).toBe(201);
    const other = await createToken(a.user.id, { label: "Leaked" });
    await mint(other, {}, stageDeps);
    await mint(other, {}, stageDeps);
    expect((await mintError(a, {}, stageDeps)).code).toBe("quota_exceeded");
    await revokeConnection(db(), a.user.id, other.connectionId);
    // The revoked connection's tickets can never commit, so they no longer count.
    await mint(a, {}, stageDeps);
    expect((await publish(a.auth)).res.status).toBe(201);
  });

  it("an admin ticket stops counting once ADMIN_TOKEN is rotated", async () => {
    const admin = await createUser();
    await env.DB.prepare("UPDATE users SET artifact_limit = 1 WHERE id = ?1").bind(admin.id).run();
    const vars = {
      SINGLE_USER_MODE: "true",
      ADMIN_EMAIL: admin.email,
      ADMIN_TOKEN: "admin-token-for-upload-tests-0123456789abcdef",
    };
    const cfg = parseConfig({ ...env, ...vars } as never);
    await mint({ token: vars.ADMIN_TOKEN }, {}, stageDeps, cfg);
    expect((await mintError({ token: vars.ADMIN_TOKEN }, {}, stageDeps, cfg)).code).toBe(
      "quota_exceeded",
    );
    const rotated = "a-rotated-admin-token-0123456789abcdefghijkl";
    const cfg2 = parseConfig({ ...env, ...vars, ADMIN_TOKEN: rotated } as never);
    await mint({ token: rotated }, {}, stageDeps, cfg2);
  });

  it("an update ticket reserves nothing", async () => {
    const a = await limitedAgent(2);
    const pub = await publish(a.auth);
    await mint(a, { id: pub.body.id, base_version: 1 }, stageDeps);
    await mint(a, { id: pub.body.id, base_version: 1 }, stageDeps);
    expect((await publish(a.auth)).res.status).toBe(201);
  });

  it("an expired ticket releases its id: it no longer counts and never becomes an artifact", async () => {
    const a = await limitedAgent(1);
    const t = await mint(a, {}, stageDeps);
    const reserved = (t.target as { id: string }).id;
    expect((await mintError(a, {}, stageDeps)).code).toBe("quota_exceeded");
    await setTicket(t.upload_id, "expires_at = ?2", agoIso(1000));
    // Released: a new ticket fits.
    const t2 = await mint(a, {}, stageDeps);
    // The expired ticket's bundle is refused, and the id it held is no artifact.
    const late = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(late.status).toBe(400);
    expect((await json(late)).error.details.reason).toBe("upload_expired");
    expect((await call(`/api/v1/artifacts/${reserved}`, { headers: a.auth })).status).toBe(404);
    // Exhausted and dead tickets hold nothing either.
    await setTicket(t2.upload_id, "attempts = ?2", LIMITS.maxTicketAttempts);
    const t3 = await mint(a, {}, stageDeps);
    await setTicket(t3.upload_id, "state = 'dead', dead_reason = 'conflict'");
    await mint(a, {}, stageDeps);
  });

  it("nobody else can publish to a reserved id: no other user, connection, ticket or inline publish", async () => {
    const a = await agent();
    const t = await mint(a, { title: "Mine" }, stageDeps);
    const reserved = (t.target as { id: string }).id;
    expect(reserved).toMatch(ARTIFACT_ID_RE);
    const put = (auth: Record<string, string>) =>
      call(`/api/v1/artifacts/${reserved}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<!doctype html><title>x</title>", base_version: 1 }),
      });
    // Another user: an update by that id, inline or with a ticket, finds nothing.
    const b = await agent();
    expect((await put(b.auth)).status).toBe(404);
    expect((await mintError(b, { id: reserved, base_version: 1 }, stageDeps)).code).toBe(
      "not_found",
    );
    // The same user from another connection: there is no artifact to update before the commit.
    const other = await createToken(a.user.id);
    expect((await put({ Authorization: `Bearer ${other.token}` })).status).toBe(404);
    expect(
      (await mintError({ token: other.token }, { id: reserved, base_version: 1 }, stageDeps)).code,
    ).toBe("not_found");
    // A client cannot choose a new artifact's id: an id in a publish body is ignored.
    const pub = await publish(a.auth, { id: reserved });
    expect(pub.res.status).toBe(201);
    expect(pub.body.id).not.toBe(reserved);
    // Two tickets never hold the same id.
    const row = await ticket(t.upload_id);
    await expect(
      env.DB.prepare(
        `INSERT INTO upload_tickets (id, token_hash, user_id, credential, connection_id, scopes, mode,
           artifact_type, state, created_at, expires_at, reserved_artifact_id)
         VALUES (?1, ?2, ?3, 'connection', ?4, 'artifacts:write', 'publish', 'html', 'open', ?5, ?6, ?7)`,
      )
        .bind(newId(), newId(), row.user_id, row.connection_id, nowIso(), isoIn(60_000), reserved)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    // Only the ticket's own bundle creates it.
    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(res.status).toBe(201);
    expect((await json(res)).id).toBe(reserved);
    // Still not another user's: it is a's artifact now.
    expect((await put(b.auth)).status).toBe(404);
  });
});

describe("minting limits", () => {
  it("start_upload and POST /uploads share the mint limit, and minting spends no publish", async () => {
    const a = await agent();
    const limit = config().maxPublishesPerHour;
    await fillBucket(`upload:${a.user.id}`, limit);
    const e = await mintError(a, {}, stageDeps);
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe(`Upload limit reached (${limit} per hour)`);
    const rest = await call(`/api/v1${API.uploads}`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(rest.status).toBe(429);
    expect((await json(rest)).error.message).toBe(`Upload limit reached (${limit} per hour)`);
    // The publish limit is separate: an inline publish still goes through.
    expect((await publish(a.auth)).res.status).toBe(201);
  });

  it("a bundle counts toward the publish limit: a full publish bucket refuses it, the ticket stays open", async () => {
    const a = await agent();
    const t = await mint(a, {}, stageDeps);
    await fillBucket(`publish:${a.user.id}`, config().maxPublishesPerHour);
    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(res.status).toBe(429);
    expect((await ticket(t.upload_id)).state).toBe("open");
  });
});

describe("GET /uploads/:id", () => {
  it("reads the token only from the Authorization header: ?token= gets the same 401 as no token", async () => {
    const a = await agent();
    const t = await mint(a, {}, stageDeps);
    const url = statusUrlOf(t);
    const none = await readStatus(url);
    const query = await readStatus(`${url}?token=${encodeURIComponent(t.upload_token)}`);
    const missing = await readStatus(
      `${APP}/api/v1/uploads/${"z".repeat(20)}?token=${encodeURIComponent(t.upload_token)}`,
    );
    expect(none.status).toBe(401);
    expect(query.status).toBe(401);
    expect(missing.status).toBe(401);
    const body = await none.text();
    expect(await query.text()).toBe(body);
    expect(await missing.text()).toBe(body);
    // A wrong header with the right token in the query: the 404 of any wrong token.
    const wrong = await readStatus(
      `${url}?token=${encodeURIComponent(t.upload_token)}`,
      `${UPLOAD_TOKEN_PREFIX}${"w".repeat(43)}`,
    );
    expect(wrong.status).toBe(404);
    expect((await ticket(t.upload_id)).attempts).toBe(0);
  });

  it("a missing ticket, a wrong token and another ticket's token get the same 404", async () => {
    const a = await agent();
    const t = await mint(a, {}, stageDeps);
    const other = await mint(await agent(), {}, stageDeps);
    const url = statusUrlOf(t);
    const answers = [
      await readStatus(url, `${UPLOAD_TOKEN_PREFIX}${"w".repeat(43)}`),
      await readStatus(url, other.upload_token),
      await readStatus(`${APP}/api/v1/uploads/${"z".repeat(20)}`, t.upload_token),
      await readStatus(`${APP}/api/v1/uploads/${other.upload_id}`, t.upload_token),
    ];
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(t.upload_id);
    expect(bodies[0]).not.toContain(other.upload_id);
  });

  it("answers state, the artifact id, version, url and the ticket's times, never content", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1, note: "a private note" }, stageDeps);
    const page = "<!doctype html><title>Secret page title</title><p>secret body text</p>";
    const res = await postBundle(t.upload_url, {
      token: t.upload_token,
      body: tar([{ name: "index.html", data: page }]),
    });
    expect(res.status).toBe(200);
    const text = await (await readStatus(statusUrlOf(t), t.upload_token)).text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(
      [
        "expires_at",
        "id",
        "mode",
        "next",
        "receiving_until",
        "state",
        "upload_id",
        "url",
        "version",
      ].sort(),
    );
    for (const secret of [
      "Secret page title",
      "secret body text",
      "a private note",
      "index.html",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it(`stays readable for TTL.uploadStatusMs (${TTL.uploadStatusMs / 3_600_000} h) after expiry, then answers 404 like a missing one`, async () => {
    const a = await agent();
    const used = await mint(a, {}, stageDeps);
    const res = await postBundle(used.upload_url, { token: used.upload_token, body: tar(SITE) });
    expect(res.status).toBe(201);
    const unused = await mint(a, {}, stageDeps);
    // A commit near the deadline: the TTL has passed by a few minutes when the client asks.
    await setTicket(used.upload_id, "expires_at = ?2", agoIso(5 * 60_000));
    await setTicket(unused.upload_id, "expires_at = ?2", agoIso(5 * 60_000));
    expect(await json(await readStatus(statusUrlOf(used), used.upload_token))).toMatchObject({
      state: "used",
      version: 1,
      url: expect.stringContaining("/a/"),
    });
    expect((await json(await readStatus(statusUrlOf(unused), unused.upload_token))).state).toBe(
      "expired",
    );
    // Just inside the window, still readable.
    await setTicket(used.upload_id, "expires_at = ?2", agoIso(TTL.uploadStatusMs - 60_000));
    expect((await readStatus(statusUrlOf(used), used.upload_token)).status).toBe(200);
    // Past it, the same 404 as a ticket that never existed, row or no row.
    await setTicket(used.upload_id, "expires_at = ?2", agoIso(TTL.uploadStatusMs + 60_000));
    await setTicket(unused.upload_id, "expires_at = ?2", agoIso(TTL.uploadStatusMs + 60_000));
    const gone = await readStatus(statusUrlOf(used), used.upload_token);
    const gone2 = await readStatus(statusUrlOf(unused), unused.upload_token);
    const never = await readStatus(`${APP}/api/v1/uploads/${"z".repeat(20)}`, used.upload_token);
    expect([gone.status, gone2.status]).toEqual([404, 404]);
    const neverText = await never.text();
    expect(await gone.text()).toBe(neverText);
    expect(await gone2.text()).toBe(neverText);
  });
});

describe("cleaning up upload tickets", () => {
  it("pruneUploadTickets deletes a ticket only once the status window after its expiry has passed", async () => {
    const a = await agent();
    const fresh = await mint(a, {}, stageDeps);
    const recent = await mint(a, {}, stageDeps);
    const old = await mint(a, {}, stageDeps);
    const oldUsed = await mint(a, {}, stageDeps);
    await setTicket(recent.upload_id, "expires_at = ?2", agoIso(5 * 60_000));
    await setTicket(old.upload_id, "expires_at = ?2", agoIso(TTL.uploadStatusMs + 60_000));
    await setTicket(
      oldUsed.upload_id,
      "state = 'used', used_at = ?2, expires_at = ?2",
      agoIso(TTL.uploadStatusMs + 60_000),
    );
    expect(await pruneUploadTickets(env.DB, Date.now())).toBeGreaterThanOrEqual(2);
    const left = async (id: string) =>
      (await env.DB.prepare("SELECT 1 AS one FROM upload_tickets WHERE id = ?1")
        .bind(id)
        .first()) !== null;
    expect(await left(fresh.upload_id)).toBe(true);
    expect(await left(recent.upload_id)).toBe(true);
    expect(await left(old.upload_id)).toBe(false);
    expect(await left(oldUsed.upload_id)).toBe(false);
  });

  it("the hourly scheduled run prunes them too", async () => {
    const a = await agent();
    const old = await mint(a, {}, stageDeps);
    await setTicket(old.upload_id, "expires_at = ?2", agoIso(TTL.uploadStatusMs + 60_000));
    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {} } as ScheduledController,
      env as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare("SELECT 1 AS one FROM upload_tickets WHERE id = ?1")
      .bind(old.upload_id)
      .first();
    expect(row).toBeNull();
  });
});

describe("why a bundle failed, as the ticket and its status keep it", () => {
  it("only a version conflict ends the ticket: attempt_expired and other reasons keep their own reason and next", async () => {
    const a = await agent();
    for (const reason of ["attempt_expired", "something_else"]) {
      const deps: StageDeps = {
        ...stageDeps,
        commitStaged: async () => {
          throw new ApiError("conflict", "Not this time", {
            reason,
            next: `own next for ${reason}`,
          });
        },
      };
      const t = await mint(a, {}, deps);
      const e = await redeemError(t, tar(SITE), deps);
      expect(e.code).toBe("conflict");
      expect(details(e)).toMatchObject({ reason, next: `own next for ${reason}` });
      const row = await ticket(t.upload_id);
      expect(row.state).toBe("open");
      expect(row.dead_reason).toBeNull();
    }
    // A conflict without a reason (or with reason "conflict") is a version conflict: the ticket dies.
    for (const reason of [undefined, "conflict"]) {
      const deps: StageDeps = {
        ...stageDeps,
        commitStaged: async () => {
          throw new ApiError("conflict", "Version 1 is not current; current is 2", {
            current_version: 2,
            ...(reason ? { reason } : {}),
          });
        },
      };
      const t = await mint(a, {}, deps);
      const e = await redeemError(t, tar(SITE), deps);
      expect(details(e)).toMatchObject({ reason: "conflict", current_version: 2 });
      expect(await ticket(t.upload_id)).toMatchObject({ state: "dead", dead_reason: "conflict" });
    }
  });

  it("after a takedown the status says taken_down and never to send the bundle again", async () => {
    const { a, id } = await ownerWithArtifact();
    const t = await mint(a, { id, base_version: 1 }, stageDeps);
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(nowIso(), id)
      .run();
    // Before any attempt: the status already reads the artifact's takedown.
    const before = await json(await readStatus(statusUrlOf(t), t.upload_token));
    expect(before.state).toBe("taken_down");
    const res = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(res.status).toBe(403);
    expect((await json(res)).error.details.reason).toBe("taken_down");
    expect(await ticket(t.upload_id)).toMatchObject({ state: "dead", dead_reason: "taken_down" });
    // Restored or not, the ticket stays ended by the takedown, and says so.
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = NULL WHERE id = ?1").bind(id).run();
    const after = await json(await readStatus(statusUrlOf(t), t.upload_token));
    expect(after.state).toBe("taken_down");
    expect(after.version).toBeNull();
    expect(after.next).toMatch(/taken down/);
    expect(after.next).not.toMatch(/send the bundle again|Someone published/i);
    const again = await postBundle(t.upload_url, { token: t.upload_token, body: tar(SITE) });
    expect(again.status).toBe(403);
    const err = (await json(again)).error;
    expect(err.details.reason).toBe("taken_down");
    expect(err.details.next).not.toMatch(/send the bundle again/i);
  });
});

// ---------- E.2: the upload token is never logged and never in a URL ----------

describe("the upload token is never logged and never in a URL", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function brokenD1(): D1Database {
    const fail = () => {
      throw new Error("D1_ERROR: simulated failure");
    };
    return { prepare: fail, batch: fail, exec: fail, dump: fail, withSession: fail } as never;
  }

  /** Every URL inside a JSON value's strings. */
  function urlsIn(value: unknown): string[] {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") out.push(...(v.match(/https?:\/\/[^\s'"<>)]+/g) ?? []));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(value);
    return out;
  }

  it("a full MCP start_upload and bundle redeem, a status read and failures log no token", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(
          args
            .map((x) =>
              x instanceof Error ? `${x.message}\n${x.stack}` : (JSON.stringify(x) ?? String(x)),
            )
            .join(" "),
        );
      });
      spies.push(spy);
    }
    const a = await agent();
    const c = await mcpClient(a.token);
    const minted = await tool<StartUploadResult>(c, "start_upload", { title: "Never logged" });
    expect(minted.isError).toBe(false);
    const t = minted.data;
    const authorization = `Bearer ${t.upload_token}`;
    const res = await postBundle(t.upload_url, {
      token: t.upload_token,
      body: await gzip(tar(viteBuild(12))),
      headers: { "Content-Type": "application/gzip" },
    });
    expect(res.status).toBe(201);
    const result = await json(res);
    const statusUrl = t.upload_url.replace(/\/bundle$/, "");
    const status = await json(await call(statusUrl, { headers: { Authorization: authorization } }));
    expect(status.state).toBe("used");
    const used = await json(await postBundle(t.upload_url, { token: t.upload_token }));
    expect(used.error.details.reason).toBe("upload_used");
    // REST mint too, and the bundle and status routes on a failing database (the Worker logs
    // the unhandled error: the positive control that the spy sees the Worker's output).
    const rest = await json(
      await call("/api/v1/uploads", {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    const broken = { DB: brokenD1() };
    for (const req of [
      new Request(rest.upload_url, {
        method: "POST",
        headers: { Authorization: `Bearer ${rest.upload_token}` },
        body: goodTar(),
      }),
      new Request(rest.upload_url.replace(/\/bundle$/, ""), {
        headers: { Authorization: `Bearer ${rest.upload_token}` },
      }),
    ]) {
      const ctx = createExecutionContext();
      const r = await worker.fetch(req, { ...env, ...broken } as never, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(500);
      await r.body?.cancel();
    }
    expect(lines.some((l) => l.includes("simulated failure"))).toBe(true);

    const log = lines.join("\n");
    for (const tok of [t.upload_token, rest.upload_token]) {
      const secret = tok.slice(UPLOAD_TOKEN_PREFIX.length);
      expect(secret.length).toBe(43);
      expect(log).not.toContain(tok);
      expect(log).not.toContain(secret);
      expect(log).not.toContain(`Bearer ${tok}`);
    }
    expect(log).not.toContain(UPLOAD_TOKEN_PREFIX);

    // No URL the server returns carries the token. commands.curl has it only inside the header
    // it writes through printf; with that taken out, the token is gone from the command.
    for (const [tok, body] of [
      [t.upload_token, [t, result, status, used]],
      [rest.upload_token, [rest]],
    ] as const) {
      const secret = tok.slice(UPLOAD_TOKEN_PREFIX.length);
      for (const u of urlsIn(body)) expect(u).not.toContain(secret);
    }
    for (const r of [t, rest]) {
      const header = `-H @<(printf 'Authorization: Bearer %s' '${r.upload_token}')`;
      expect(r.commands.curl).toContain(header);
      expect(r.commands.curl.replace(header, "")).not.toContain(
        r.upload_token.slice(UPLOAD_TOKEN_PREFIX.length),
      );
      expect(r.next).not.toContain(r.upload_token.slice(UPLOAD_TOKEN_PREFIX.length));
    }
  });
});

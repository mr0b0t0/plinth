// Upload tickets (services/uploads.ts, api/uploads.ts): minting, the bundle route's placement and
// credentials, the receiving lease, single use, and the explicit Ctx. The version-writing
// functions come from services/stage.ts; until the server-core work lands them, redemption tests
// pass a stand-in (fixtures/bundles/fakeStage.ts) and the end-to-end tests at the bottom are todo.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  API,
  COOKIES,
  LIMITS,
  type StartUploadInput,
  type StartUploadResult,
  TTL,
  UPLOAD_TOKEN_PREFIX,
} from "@plinth/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
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
import { revokeConnection } from "../src/services/connections.ts";
import type { Ctx } from "../src/services/context.ts";
import {
  type BundleEnv,
  curlCommand,
  isReleaseAtLeast,
  npxCommand,
  redeemBundle,
  type StageDeps,
  startUpload,
  type TicketRow,
} from "../src/services/uploads.ts";
import { fakeStage, keysUnder } from "./fixtures/bundles/fakeStage.ts";
import * as real from "./fixtures/bundles/real.ts";
import {
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
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  createUser,
  db,
  enterContent,
  json,
  mcpClient,
  publish,
  tool,
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
    expect(r.target).toEqual({ mode: "publish", type: "html" });
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
      `cd <folder> && tar -czf - . | curl -sS --fail-with-body --max-time 600 -A plinth-agent/1 ` +
        `-H @<(printf 'Authorization: Bearer %s' '${token}') ` +
        `-H 'Content-Type: application/gzip' --data-binary @- '${url}'`,
    );
    // The token appears once, inside the process substitution (printf is a shell builtin), and
    // never in the URL.
    expect(cmd.split(token)).toHaveLength(2);
    expect(cmd).toMatch(new RegExp(`@<\\(printf '[^']+' '${token}'\\)`));
    expect(url).not.toContain(token);
    expect(cmd).not.toMatch(/\btar -h|\s-h\s/);
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
      next: "Pass the version you read with get_artifact as base_version",
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

// These run once services/stage.ts is implemented (the server-core workstream). Until then they
// are todo; flip STAGER_LANDED to run them.
const STAGER_LANDED = false;
const e2e = STAGER_LANDED ? it : (name: string, _fn: () => Promise<void>) => it.todo(name);

describe("end to end with the real stager", () => {
  e2e(
    "MCP start_upload {} then the curl bundle of a 420-file Vite build: 201 and the content host serves every file",
    async () => {
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
    },
  );

  e2e(
    "a bundle update that changes one file writes exactly 2 objects (the file and the source)",
    async () => {
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
    },
  );

  e2e("concurrent bundles in publish mode create exactly one artifact", async () => {
    const a = await agent();
    const t = await mint(a);
    const results = await Promise.all(
      [0, 1, 2].map(() => postBundle(t.upload_url, { token: t.upload_token })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE owner_id = ?1")
      .bind(a.user.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  e2e(
    "a doc bundle goes through resolveSource and checkAsset: images only, index.html refused",
    async () => {
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
    },
  );

  e2e("a bundled page that declares shared data stores its capabilities", async () => {
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

  e2e("REST POST /uploads mints a ticket (201) that the bundle redeems", async () => {
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

  e2e("a 50 MB, 511-file bundle passes through the real stager in the Workers pool", async () => {
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
});

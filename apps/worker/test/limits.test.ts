// Storage cap, atomic artifact quota, stale mention claims, and the public-visibility gate.
import { env } from "cloudflare:workers";
import { DEFAULTS, LIMITS } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mentionTasks, users } from "../src/db/schema.ts";
import type { Principal } from "../src/policy.ts";
import { publishArtifact, setVisibility } from "../src/services/artifacts.ts";
import type { Ctx } from "../src/services/context.ts";
import { claimMention } from "../src/services/mentions.ts";
import {
  agent,
  call,
  config,
  createUser,
  db,
  fetchWith,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";

function ctxFor(principal: Principal, overrides: Partial<ReturnType<typeof config>> = {}): Ctx {
  return {
    env: env as unknown as Ctx["env"],
    config: { ...config(), ...overrides },
    db: db(),
    principal,
    passwordPasses: new Map(),
    ip: null,
    waitUntil: () => undefined,
  };
}

const userPrincipal = (u: { id: string; email: string }): Principal => ({
  kind: "user",
  userId: u.id,
  email: u.email,
  isAdmin: false,
});

describe("limits", () => {
  it("caps stored bytes per account across all versions", async () => {
    const u = await createUser();
    const ctx = ctxFor(userPrincipal(u), { maxStorageBytesPerUser: 2_000 });
    await publishArtifact(ctx, { title: "a", html: "x".repeat(1_500), visibility: "unlisted" });
    await expect(
      publishArtifact(ctx, { title: "b", html: "y".repeat(1_000), visibility: "unlisted" }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("parallel publishes cannot overshoot the artifact limit", async () => {
    const a = await agent();
    await db().update(users).set({ artifactLimit: 2 }).where(eq(users.id, a.user.id)).run();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => publish(a.auth, { title: `p${i}` })),
    );
    expect(results.filter((r) => r.res.status === 201).length).toBeLessThanOrEqual(2);
    const me = await json(await call("/api/v1/me", { headers: a.auth }));
    expect(me.artifact_count).toBeLessThanOrEqual(2);
  });

  it("MAX_ARTIFACTS_PER_USER sets the default limit", async () => {
    const u = await createUser();
    const ctx = ctxFor(userPrincipal(u), { maxArtifactsPerUser: 1 });
    await publishArtifact(ctx, { title: "one", html: "<p>1</p>", visibility: "unlisted" });
    await expect(
      publishArtifact(ctx, { title: "two", html: "<p>2</p>", visibility: "unlisted" }),
    ).rejects.toMatchObject({ code: "quota_exceeded", details: { limit: 1 } });
  });

  it("public visibility: allowed for a verified, old-enough account; refused for a new one", async () => {
    const old = await createUser();
    const long = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    await db()
      .update(users)
      .set({ createdAt: long, emailVerifiedAt: long })
      .where(eq(users.id, old.id))
      .run();
    const on = { allowPublicVisibility: true, publicMinAccountAgeHours: 72 };
    const ok = await publishArtifact(ctxFor(userPrincipal(old), on), {
      title: "public",
      html: "<p>p</p>",
      visibility: "public",
    });
    expect(ok.visibility).toBe("public");

    const young = await createUser();
    await expect(
      publishArtifact(ctxFor(userPrincipal(young), on), {
        title: "x",
        html: "<p>x</p>",
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const unl = await publishArtifact(ctxFor(userPrincipal(young), on), {
      title: "y",
      html: "<p>y</p>",
      visibility: "unlisted",
    });
    await expect(
      setVisibility(ctxFor(userPrincipal(young), on), { id: unl.id, visibility: "public" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a claim nobody finished becomes claimable again after the timeout", async () => {
    const owner = await agent({ clientType: "claude", label: "First" });
    const { body: p } = await publish(owner.auth);
    const s = await call(`/api/v1/artifacts/${p.id}/comments`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "note" }),
    });
    expect(s.status).toBe(201);
    // Agent-authored comments never create tasks, so insert one directly.
    const comment = await json(s);
    const taskId = `task${Date.now()}`;
    await db()
      .insert(mentionTasks)
      .values({
        id: taskId,
        commentId: comment.id,
        artifactId: p.id,
        targetClientType: "claude",
        targetLabel: "@claude",
        state: "claimed",
        claimedBy: owner.connectionId,
        claimedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      })
      .run();
    const principal: Principal = {
      kind: "agent",
      userId: owner.user.id,
      email: owner.user.email,
      connectionId: owner.connectionId,
      connectionLabel: "First",
      clientType: "claude",
      scopes: new Set(["artifacts:read", "artifacts:write", "mentions"]),
    };
    const claimed = await claimMention(ctxFor(principal), taskId);
    expect(claimed.state).toBe("claimed");
    // A fresh claim is not stealable.
    await expect(claimMention(ctxFor(principal), taskId)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

const MB = 1024 * 1024;
const files = (n: number, size = 1) =>
  Array.from({ length: n }, (_, i) => ({ path: `f/${i}.txt`, content: `${i}`.padEnd(size, "x") }));

describe("per-version limits (MAX_ASSETS_PER_VERSION, MAX_VERSION_BYTES)", () => {
  it("default instance: 511 assets pass and 512 fail, over REST, as an ApiError with next", async () => {
    expect(config().maxAssetsPerVersion).toBe(DEFAULTS.maxAssetsPerVersion);
    const a = await agent();
    const ok = await publish(a.auth, { assets: files(511) });
    expect(ok.res.status).toBe(201);
    expect(ok.body.stored).toMatchObject({ files: 512, written: 512 });
    const over = await publish(a.auth, { assets: files(512) });
    expect(over.res.status).toBe(413);
    expect(over.body.error).toMatchObject({
      code: "payload_too_large",
      message: "512 asset files; this instance allows 511 per version",
      details: { limit: 511, count: 512 },
    });
    expect(over.body.error.details.next).toMatch(/start_upload/);
    expect(over.body.error.details.next).toMatch(/source maps/);
    // An update is held to the same limit.
    const up = await call(`/api/v1/artifacts/${ok.body.id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>2</p>", assets: files(512) }),
    });
    expect(up.status).toBe(413);
  });

  it("default instance: 511 pass and 512 fail over MCP, as the same error", async () => {
    const a = await agent();
    const client = await mcpClient(a.token);
    const ok = await tool(client, "publish_artifact", {
      title: "many",
      html: "<p>x</p>",
      assets: files(511),
    });
    expect(ok.isError).toBe(false);
    const over = await tool(client, "publish_artifact", {
      title: "too many",
      html: "<p>x</p>",
      assets: files(512),
    });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("512 asset files; this instance allows 511 per version");
    expect(over.text).toContain("start_upload");
    await client.close();
  });

  it("zod keeps only the ceiling", async () => {
    const a = await agent();
    const r = await publish(a.auth, { assets: files(LIMITS.maxAssetsCeiling + 1) });
    expect(r.res.status).toBe(400);
  });

  it("a version over MAX_VERSION_BYTES names its largest files and what to do", async () => {
    const a = await agent();
    const res = await fetchWith({ MAX_VERSION_BYTES: String(1 * MB) }, "/api/v1/artifacts", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "big",
        html: "<p>x</p>",
        assets: [
          { path: "a.bin.txt", content: "a".repeat(600 * 1024) },
          { path: "b.txt", content: "b".repeat(500 * 1024) },
          { path: "c.txt", content: "c" },
        ],
      }),
    });
    expect(res.status).toBe(413);
    const { error } = await json(res);
    expect(error.message).toMatch(/^Version is over 1 MB in total \(1\.1 MB\)$/);
    expect(error.details.limit_bytes).toBe(MB);
    expect(error.details.largest[0]).toEqual({ path: "a.bin.txt", size_bytes: 600 * 1024 });
    expect(error.details.largest.length).toBeLessThanOrEqual(5);
    expect(error.details.next).toBeTruthy();
  });

  it("reused files count toward the version size (it is what a viewer loads)", async () => {
    const a = await agent();
    const vars = { MAX_VERSION_BYTES: String(1 * MB) };
    const pub = await fetchWith(vars, "/api/v1/artifacts", {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "near",
        html: "<p>x</p>",
        assets: [{ path: "a.txt", content: "a".repeat(700 * 1024) }],
      }),
    });
    expect(pub.status).toBe(201);
    const { id } = await json(pub);
    const up = await fetchWith(vars, `/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        html: "<p>2</p>",
        assets: [{ path: "b.txt", content: "b".repeat(400 * 1024) }],
      }),
    });
    expect(up.status).toBe(200);
    const carried = await fetchWith(vars, `/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>3</p>" }),
    });
    expect(carried.status).toBe(200);
    const both = await fetchWith(vars, `/api/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        html: "<p>4</p>",
        assets: [
          { path: "a.txt", content: "a".repeat(700 * 1024) },
          { path: "b.txt", content: "b".repeat(400 * 1024) },
        ],
      }),
    });
    expect(both.status).toBe(413);
  });

  it("HTML over its limit says to move inline scripts and data into files", async () => {
    const a = await agent();
    const big = await publish(a.auth, { html: "x".repeat(LIMITS.maxHtmlBytes + 1) });
    expect(big.res.status).toBe(413);
    expect(big.body.error.details).toMatchObject({
      limit_bytes: LIMITS.maxHtmlBytes,
      next: "Move inline scripts and data into asset files",
    });
  });

  it("the storage error carries adding_bytes and next", async () => {
    const u = await createUser();
    const ctx = ctxFor(userPrincipal(u), { maxStorageBytesPerUser: 1_000 });
    await expect(
      publishArtifact(ctx, { title: "b", html: "y".repeat(1_200), visibility: "unlisted" }),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      details: { limit_bytes: 1_000, used_bytes: 0, adding_bytes: 1_200 },
    });
  });
});

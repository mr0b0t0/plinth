// Storage cap, atomic artifact quota, stale mention claims, and the public-visibility gate.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mentionTasks, users } from "../src/db/schema.ts";
import type { Principal } from "../src/policy.ts";
import { publishArtifact, setVisibility } from "../src/services/artifacts.ts";
import type { Ctx } from "../src/services/context.ts";
import { claimMention } from "../src/services/mentions.ts";
import { agent, call, config, createUser, db, json, publish } from "./helpers.ts";

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

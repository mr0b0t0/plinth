// Migration 0012_bound_tokens: agent_connections.artifact_id is set only on personal access tokens
// (the CHECK), and goes with the artifact row when it is erased (ON DELETE CASCADE, never SET NULL).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/crypto.ts";
import { agent, publish } from "./helpers.ts";

const NOW = "2026-11-19T00:00:00.000Z";

function insertConnection(userId: string, kind: "token" | "oauth", artifactId: string | null) {
  const id = newId();
  return {
    id,
    run: () =>
      env.DB.prepare(
        `INSERT INTO agent_connections (id, user_id, label, client_type, kind, token_hash, scopes,
           created_at, artifact_id)
         VALUES (?1, ?2, 'x', 'other', ?3, ?4, 'artifacts:read', ?5, ?6)`,
      )
        .bind(id, userId, kind, kind === "token" ? `hash-${id}` : null, NOW, artifactId)
        .run(),
  };
}

describe("0012_bound_tokens", () => {
  it("refuses an artifact on an OAuth connection, and accepts it on a token", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    await expect(insertConnection(a.user.id, "oauth", body.id).run()).rejects.toThrow(/CHECK/);
    await insertConnection(a.user.id, "oauth", null).run();
    await insertConnection(a.user.id, "token", body.id).run();
  });

  it("refuses an artifact that does not exist", async () => {
    const a = await agent();
    await expect(
      insertConnection(a.user.id, "token", "nosuchartifact000000").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("removes the bound token when the artifact row is erased, and keeps account-wide ones", async () => {
    const a = await agent();
    const { body } = await publish(a.auth);
    const bound = insertConnection(a.user.id, "token", body.id);
    await bound.run();
    await env.DB.prepare("DELETE FROM artifacts WHERE id = ?1").bind(body.id).run();
    const left = await env.DB.prepare("SELECT id FROM agent_connections WHERE id IN (?1, ?2)")
      .bind(bound.id, a.connectionId)
      .all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([a.connectionId]);
  });

  it("indexes bound rows only", async () => {
    const idx = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agent_connections_artifact'",
    ).first<{ sql: string }>();
    expect(idx?.sql).toMatch(/WHERE artifact_id IS NOT NULL/);
  });
});

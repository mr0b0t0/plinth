// Several vendors' agents on one artifact (docs/agents.md "Several agents on one artifact"): the
// routing the guide promises. `@claude` reaches every Claude-type connection of the owner and the
// first claim wins; `@<handle>` reaches one connection by its label's handle; agent names win over
// a label with the same handle; agent-written comments never create tasks; collaborators' own
// connections are never targets; history names the connection that published each version.
import type { Role } from "@plinth/shared";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessGrants, mentionTasks } from "../src/db/schema.ts";
import { nowIso } from "../src/lib/time.ts";
import {
  agent,
  browserSession,
  call,
  createToken,
  createUser,
  db,
  json,
  mcpClient,
  publish,
  tool,
} from "./helpers.ts";

async function grant(artifactId: string, email: string, role: Role) {
  await db().insert(accessGrants).values({ artifactId, email, role, createdAt: nowIso() }).run();
}

async function postComment(
  headers: Record<string, string>,
  ref: string,
  body: Record<string, unknown>,
) {
  const res = await call(`/api/v1/artifacts/${ref}/comments`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}

async function tasksOf(commentId: string) {
  return db()
    .select()
    .from(mentionTasks)
    .where(eq(mentionTasks.commentId, commentId))
    .orderBy(asc(mentionTasks.targetLabel))
    .all();
}

async function targets(token: string): Promise<string[]> {
  const res = await call("/api/v1/mentions", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await json(res)).items.map((t: { target: string }) => t.target).sort();
}

/**
 * An owner with an allowlist artifact and four connections: two of client type Claude ("Work
 * Claude" and "Claude Code"), one of type Other labelled "Gemini", and one of type Other labelled
 * "Claude" (its handle is an agent name). A commenter is on the artifact.
 */
async function team() {
  const owner = await agent({ label: "Work Claude", clientType: "claude" });
  const claudeCode = await createToken(owner.user.id, {
    label: "Claude Code",
    clientType: "claude",
  });
  const gemini = await createToken(owner.user.id, { label: "Gemini", clientType: "other" });
  const namedClaude = await createToken(owner.user.id, { label: "Claude", clientType: "other" });
  const { body: artifact } = await publish(owner.auth, {
    title: "Plan",
    html: "<!doctype html><h1>Plan</h1>",
    visibility: "allowlist",
  });
  const commenter = await createUser();
  await grant(artifact.id, commenter.email, "commenter");
  const commenterHeaders = (await browserSession(commenter.id)).headers;
  return { owner, claudeCode, gemini, namedClaude, artifact, commenterHeaders };
}

describe("several agents on one artifact", () => {
  it("one comment, two targets: every Claude connection sees @claude, only Gemini sees @gemini", async () => {
    const { owner, claudeCode, gemini, namedClaude, artifact, commenterHeaders } = await team();
    const c = await postComment(commenterHeaders, artifact.slug, {
      body: "@claude build the chart; @gemini please check the copy",
    });
    expect((await tasksOf(c.id)).map((t) => [t.targetLabel, t.targetClientType])).toEqual([
      ["@claude", "claude"],
      ["@gemini", null],
    ]);

    expect(await targets(owner.token)).toEqual(["@claude"]);
    expect(await targets(claudeCode.token)).toEqual(["@claude"]);
    expect(await targets(gemini.token)).toEqual(["@gemini"]);
    // A label whose handle is an agent name is never reached as a label: @claude means the type.
    expect(await targets(namedClaude.token)).toEqual([]);

    // Both Claude connections share the one @claude task: the first claim wins.
    const [claudeTask] = (await tasksOf(c.id)).filter((t) => t.targetLabel === "@claude");
    const first = await mcpClient(claudeCode.token);
    const second = await mcpClient(owner.token);
    const won = await tool(first, "claim_mention", { task_id: claudeTask?.id });
    expect(won.isError, won.text).toBe(false);
    expect(won.data).toMatchObject({ state: "claimed", claimed_by: claudeCode.connectionId });
    const lost = await tool(second, "claim_mention", { task_id: claudeTask?.id });
    expect(lost.isError).toBe(true);
    expect(lost.data.error.code).toBe("conflict");
  });

  it("a label with spaces is reached by its handle", async () => {
    const { claudeCode, owner, artifact, commenterHeaders } = await team();
    const c = await postComment(commenterHeaders, artifact.slug, {
      body: "@claude-code only you, please",
    });
    const [task] = await tasksOf(c.id);
    expect(task).toMatchObject({
      targetLabel: "@claude-code",
      targetConnection: claudeCode.connectionId,
      targetClientType: null,
    });
    expect(await targets(claudeCode.token)).toEqual(["@claude-code"]);
    expect(await targets(owner.token)).toEqual([]);
  });

  it("an agent's reply never hands work to another agent", async () => {
    const { gemini, claudeCode, artifact, commenterHeaders } = await team();
    const c = await postComment(commenterHeaders, artifact.slug, { body: "@gemini check this" });
    const g = await mcpClient(gemini.token);
    const reply = await tool(g, "reply_comment", {
      comment_id: c.id,
      body: "Checked. @claude please redo the chart, @claude-code too.",
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data.mentions).toEqual([]);
    expect(reply.data.author).toMatchObject({
      label: "Gemini",
      connection_id: gemini.connectionId,
    });
    expect(await tasksOf(reply.data.id)).toEqual([]);
    expect(await targets(claudeCode.token)).toEqual([]);
  });

  it("an editor's own agent works on the artifact but is never a mention target", async () => {
    const { owner, artifact, commenterHeaders } = await team();
    const editor = await agent({ label: "Gemini", clientType: "claude" });
    await grant(artifact.id, editor.user.email, "editor");
    await postComment(commenterHeaders, artifact.slug, { body: "@claude and @gemini, look" });
    expect(await targets(editor.token)).toEqual([]);

    // Both publish: history names each connection.
    const mine = await mcpClient(owner.token);
    const theirs = await mcpClient(editor.token);
    const v2 = await tool(theirs, "update_artifact", {
      id: artifact.id,
      html: "<!doctype html><h1>Plan v2</h1>",
      base_version: 1,
      note: "Editor's agent: new heading",
    });
    expect(v2.isError, v2.text).toBe(false);
    const stale = await tool(mine, "update_artifact", {
      id: artifact.id,
      html: "<!doctype html><h1>Plan (owner)</h1>",
      base_version: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe("conflict");
    const v3 = await tool(mine, "update_artifact", {
      id: artifact.id,
      html: "<!doctype html><h1>Plan v3</h1>",
      base_version: 2,
      note: "Owner's agent: on top of v2",
    });
    expect(v3.isError, v3.text).toBe(false);
    const versions = await tool(mine, "list_versions", { id: artifact.id });
    expect(
      versions.data.items.map((v: { number: number; author: { kind: string; label: string } }) => [
        v.number,
        v.author.kind,
        v.author.label,
      ]),
    ).toEqual([
      [3, "connection", "Work Claude"],
      [2, "connection", "Gemini"],
      [1, "connection", "Work Claude"],
    ]);
  });
});

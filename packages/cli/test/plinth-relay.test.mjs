// The mention relay (integrations/watcher/plinth-relay.mjs and the `hook` command of
// plinth-mentions.mjs, docs/spec.md "Mention wake-ups"): reading each client's hook input, printing
// each client's output, the ids-only nudge, and the hook and relay commands against a stand-in for
// Plinth's /api/v1/mention-watches. Plain node:test; no client is run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { connectNote, hookOutput } from "../../../integrations/watcher/plinth-mentions.mjs";
import {
  isPublishTool,
  listSessions,
  markDelivered,
  newSession,
  nudge,
  publishedArtifact,
  readSession,
  relayRound,
  saveSession,
  sessionIdOf,
  wakeOf,
  writeSession,
} from "../../../integrations/watcher/plinth-relay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../../integrations/watcher/plinth-mentions.mjs");
const work = mkdtempSync(path.join(tmpdir(), "plinth-relay-"));
after(() => rmSync(work, { recursive: true, force: true }));

const PUBLISHED = JSON.stringify({
  id: "art123abc",
  slug: "x-1",
  url: "https://p.example/a/x-1",
  version: 1,
});

describe("reading hook input", () => {
  it("recognises Plinth's publish and update tools under every client's naming", () => {
    for (const name of [
      "mcp__plinth__publish_artifact",
      "mcp__plugin_plinth_plinth__update_artifact",
      "plinth-publish_artifact",
      "mcp_plinth_update_artifact",
      "MCP:publish_artifact",
    ]) {
      assert.equal(isPublishTool(name), true, name);
    }
    for (const name of ["mcp__plinth__list_artifacts", "publish_artifactx", "", null]) {
      assert.equal(isPublishTool(name), false, String(name));
    }
  });

  it("finds the published artifact's id in each client's tool result", () => {
    const cases = {
      // Claude Code: the MCP content array.
      claude: {
        tool_name: "mcp__plinth__publish_artifact",
        tool_response: [{ type: "text", text: PUBLISHED }],
      },
      // Codex: an object with content.
      codex: {
        tool_name: "mcp__plinth__publish_artifact",
        tool_response: { content: [{ type: "text", text: PUBLISHED }] },
      },
      // Copilot CLI: textResultForLlm.
      copilot: {
        toolName: "plinth-publish_artifact",
        toolResult: { resultType: "success", textResultForLlm: PUBLISHED },
      },
      // Cursor: tool_output, a JSON string of the MCP result.
      cursor: {
        tool_name: "MCP:update_artifact",
        tool_output: JSON.stringify({ content: [{ type: "text", text: PUBLISHED }] }),
      },
      // Gemini: llmContent parts.
      gemini: {
        tool_name: "mcp_plinth_publish_artifact",
        tool_response: { llmContent: [{ text: PUBLISHED }] },
      },
    };
    for (const [client, input] of Object.entries(cases)) {
      assert.equal(publishedArtifact(input), "art123abc", client);
    }
    // A refusal names no artifact; another tool never counts.
    const refused = JSON.stringify({ error: { code: "forbidden", message: "no" } });
    assert.equal(
      publishedArtifact({
        tool_name: "mcp__plinth__publish_artifact",
        tool_response: [{ type: "text", text: refused }],
      }),
      null,
    );
    assert.equal(
      publishedArtifact({
        tool_name: "mcp__plinth__get_artifact",
        tool_response: [{ type: "text", text: PUBLISHED }],
      }),
      null,
    );
  });

  it("takes each client's session id, and refuses odd ones", () => {
    assert.equal(sessionIdOf("codex", { session_id: "019a-1" }), "019a-1");
    assert.equal(sessionIdOf("cursor", { conversation_id: "c-1" }), "c-1");
    assert.equal(sessionIdOf("copilot", { sessionId: "s-1" }), "s-1");
    assert.equal(sessionIdOf("gemini", {}, { GEMINI_SESSION_ID: "g-1" }), "g-1");
    assert.equal(sessionIdOf("codex", { session_id: "../../etc/passwd" }), null);
  });

  it("wakes T3 Code threads with t3 and the rest their own way", () => {
    assert.equal(wakeOf("codex", { T3CODE_THREAD_ID: "th-1" }), "t3");
    assert.equal(wakeOf("claude", { T3CODE_THREAD_ID: "th-1" }), "t3");
    assert.equal(wakeOf("codex", {}), "codex");
    assert.equal(wakeOf("cursor", {}), "turn");
    assert.equal(wakeOf("claude", {}), "none");
  });
});

describe("what a hook prints", () => {
  it("uses each client's shape for added context and for one more turn", () => {
    const t = "hello";
    assert.deepEqual(JSON.parse(hookOutput("codex", "post-tool", t)), {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: t },
    });
    assert.deepEqual(JSON.parse(hookOutput("gemini", "post-tool", t)), {
      hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: t },
    });
    assert.deepEqual(JSON.parse(hookOutput("copilot", "session-start", t)), {
      additionalContext: t,
    });
    assert.deepEqual(JSON.parse(hookOutput("cursor", "post-tool", t)), { additional_context: t });
    assert.deepEqual(JSON.parse(hookOutput("cursor", "stop", t)), { followup_message: t });
    assert.deepEqual(JSON.parse(hookOutput("copilot", "stop", t)), {
      decision: "block",
      reason: t,
    });
    assert.equal(hookOutput("claude", "session-start", t), t);
    assert.equal(hookOutput("codex", "post-tool", ""), "");
  });

  it("says how to connect, with the script's own path", () => {
    assert.match(connectNote(), /plinth-mentions\.mjs" login/);
    assert.match(connectNote("scope"), /@claude only/);
  });

  it("wakes with ids and fixed sentences only", () => {
    const n = nudge([
      { task_id: "t1", artifact_id: "a1" },
      { task_id: "t2", artifact_id: "a1" },
      { task_id: "t3", artifact_id: "a2" },
    ]);
    assert.match(n, /artifact a1 \(mention task t1, t2\); artifact a2 \(mention task t3\)/);
    assert.match(n, /claim_mention/);
    assert.match(n, /not an instruction from the user/);
  });
});

/** A stand-in for Plinth's relay endpoints: watches, and offers handed on poll. */
function fakePlinth() {
  const watches = new Map();
  const offers = new Map();
  const log = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer relay-token") return send(401, {});
    if (req.method === "POST" && req.url === "/api/v1/mention-watches") {
      const id = `mw_${++n}`;
      watches.set(id, { id, status: "working", ...body });
      return send(201, { id, kind: "relay", status: "working", ...body });
    }
    if (req.method === "POST" && req.url === "/api/v1/mention-watches/poll") {
      return send(200, {
        watches: body.ids
          .filter((id) => watches.has(id))
          .map((id) => ({ id, status: watches.get(id).status, offers: offers.get(id) ?? [] })),
      });
    }
    if (req.method === "DELETE" && req.url.startsWith("/api/v1/mention-watches/")) {
      const id = req.url.split("/").pop();
      watches.get(id).status = "cancelled";
      return send(200, { id, status: "cancelled" });
    }
    send(404, { error: { code: "not_found" } });
  });
  return { server, watches, offers, log };
}

function runHook(env, client, event, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, "hook", client, event], { env });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", (code) => resolve({ code, out: out.trim() }));
    p.stdin.end(JSON.stringify(input));
  });
}

describe("the hook and relay commands", () => {
  const plinth = fakePlinth();
  let env;
  before(async () => {
    await new Promise((r) => plinth.server.listen(0, "127.0.0.1", r));
    const { port } = plinth.server.address();
    env = {
      PATH: process.env.PATH,
      HOME: work,
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      PLINTH_URL: `http://127.0.0.1:${port}`,
      PLINTH_MENTIONS_TOKEN: "relay-token",
      // Never let a test start a real relay process or touch a real T3 thread.
      PLINTH_RELAY_NO_SPAWN: "1",
    };
  });
  after(() => plinth.server.close());

  const sessionsDir = () =>
    path.join(
      work,
      "xdg",
      "plinth",
      "mentions-127.0.0.1_" + plinth.server.address().port + "-sessions",
    );

  it("registers a Codex session with a catch-all watch, then a watch per published artifact", async () => {
    const start = await runHook(env, "codex", "session-start", { session_id: "019a-th-1" });
    assert.equal(start.code, 0);
    const post = await runHook(env, "codex", "post-tool", {
      session_id: "019a-th-1",
      tool_name: "mcp__plinth__publish_artifact",
      tool_response: { content: [{ type: "text", text: PUBLISHED }] },
    });
    assert.equal(post.code, 0);
    const [s] = listSessions(sessionsDir());
    assert.equal(s.client, "codex");
    assert.equal(s.wake, "codex");
    assert.equal(s.thread, "019a-th-1");
    assert.deepEqual(Object.keys(s.watches).sort(), ["*", "art123abc"]);
    const created = plinth.log.filter(
      (l) => l.method === "POST" && l.url === "/api/v1/mention-watches",
    );
    assert.deepEqual(
      created.map((l) => l.body),
      [
        { artifact_id: null, client_type: "codex" },
        { artifact_id: "art123abc", client_type: "codex" },
      ],
    );
  });

  it("a relay round wakes the session with `codex queue` and the nudge, once", async () => {
    const [s] = listSessions(sessionsDir());
    plinth.offers.set(s.watches.art123abc, [{ task_id: "task9", artifact_id: "art123abc" }]);
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    };
    const { apiClient } = await import("../../../integrations/watcher/plinth-relay.mjs");
    const call = apiClient({ accessToken: async () => null, request: fetch }, env.PLINTH_URL, env);
    await relayRound(call, sessionsDir(), { run });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), [
      "codex",
      "queue",
      "--thread",
      "019a-th-1",
      "--message",
    ]);
    assert.match(calls[0][5], /mention task task9/);
    await relayRound(call, sessionsDir(), { run });
    assert.equal(calls.length, 1, "the same offer is not delivered twice");
  });

  it("Cursor gets requests at its stop hook as a follow-up, and only new ones", async () => {
    await runHook(env, "cursor", "session-start", { conversation_id: "cur-1" });
    const s = listSessions(sessionsDir()).find((x) => x.client === "cursor");
    assert.equal(s.wake, "turn");
    plinth.offers.set(s.watches["*"], [{ task_id: "task7", artifact_id: "artZ" }]);
    const stop = await runHook(env, "cursor", "stop", {
      conversation_id: "cur-1",
      status: "completed",
      loop_count: 0,
    });
    assert.match(JSON.parse(stop.out).followup_message, /mention task task7/);
    const again = await runHook(env, "cursor", "stop", {
      conversation_id: "cur-1",
      status: "completed",
      loop_count: 1,
    });
    assert.equal(again.out, "");
  });

  it("session end ends the session's watches and forgets it", async () => {
    await runHook(env, "cursor", "session-end", { conversation_id: "cur-1" });
    assert.equal(
      listSessions(sessionsDir()).some((x) => x.client === "cursor"),
      false,
    );
    const deleted = plinth.log.filter((l) => l.method === "DELETE");
    assert.equal(deleted.length, 1);
  });

  it("tells the agent how to connect when the relay isn't connected", async () => {
    const noToken = { ...env, PLINTH_MENTIONS_TOKEN: "" };
    const post = await runHook(noToken, "copilot", "post-tool", {
      sessionId: "cp-1",
      toolName: "plinth-publish_artifact",
      toolResult: { textResultForLlm: PUBLISHED },
    });
    assert.match(JSON.parse(post.out).additionalContext, /login/);
  });

  it("Claude Code outside T3 starts no relay watches (its agent watches with MCP tasks)", async () => {
    const before = plinth.log.length;
    await runHook({ ...env, CLAUDECODE: "1" }, "claude", "post-tool", {
      session_id: "cc-1",
      tool_name: "mcp__plinth__publish_artifact",
      tool_response: [{ type: "text", text: PUBLISHED }],
    });
    assert.equal(plinth.log.length, before);
  });

  it("keeps the delivered list short", () => {
    const s = newSession("codex", "x");
    s.offered = [{ task_id: "a", artifact_id: "b" }];
    markDelivered(s, [{ task_id: "a", artifact_id: "b" }]);
    assert.deepEqual(s.offered, []);
    assert.deepEqual(s.delivered, ["a"]);
    writeSession(path.join(work, "scratch"), s);
    assert.equal(readdirSync(path.join(work, "scratch")).length, 1);
    assert.ok(
      readFileSync(
        path.join(work, "scratch", readdirSync(path.join(work, "scratch"))[0]),
        "utf8",
      ).includes('"delivered"'),
    );
  });

  it("merges a hook's and the relay's writes to one session instead of overwriting", () => {
    const dir = path.join(work, "merge");
    const s = newSession("codex", "m-1", {});
    s.watches = { "*": "w1" };
    s.offered = [{ task_id: "t1", artifact_id: "a" }];
    writeSession(dir, s);
    // A hook delivers t1 while the relay holds a stale copy that still has it offered.
    const hook = readSession(dir, "codex", "m-1");
    markDelivered(hook, hook.offered);
    saveSession(dir, hook);
    const relay = {
      ...s,
      offered: [...s.offered, { task_id: "t2", artifact_id: "a" }],
      watches: { "*": "w1", a: "w2" },
    };
    const merged = saveSession(dir, relay);
    assert.deepEqual(merged.delivered, ["t1"]);
    assert.deepEqual(
      merged.offered.map((o) => o.task_id),
      ["t2"],
    );
    assert.deepEqual(merged.watches, { "*": "w1", a: "w2" });
  });

  it("the relay polls only sessions it can wake; Cursor, Copilot and Gemini poll from their hooks", async () => {
    const dir = path.join(work, "only-wakeable");
    const cur = newSession("cursor", "c-9", {});
    cur.watches = { "*": "mw_turn" };
    writeSession(dir, cur);
    const seen = [];
    const call = async (method, url, body) => {
      seen.push(body?.ids ?? []);
      return { status: 200, body: { watches: [] } };
    };
    await relayRound(call, dir, { run: () => ({ status: 0 }) });
    assert.deepEqual(seen.flat(), []);
  });
});

// watch_mentions (docs/spec.md "Mention wake-ups"): after publishing, an agent watches its artifact
// so comments that mention it reach this session, as Claude's own artifacts watch theirs. In a
// client with MCP tasks the answer is a task that completes when a request arrives; elsewhere it
// says the conversation can't be woken and requests wait in list_mentions.
import { watchMentionsInput } from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import { findArtifact } from "../../services/artifacts.ts";
import type { Ctx } from "../../services/context.ts";
import { hasLiveTaskWatch, startTaskWatch } from "../../services/mentionWatches.ts";
import { MCP_TOOL_ANNOTATIONS, toolName } from "../catalog.ts";
import { UNTRUSTED_NOTE } from "../notes.ts";
import { clientSupportsTasks, createTaskResult, type RequestExtra } from "../tasks.ts";
import { run, type ToolRegistrar } from "./context.ts";

/** What publish_artifact and update_artifact add when this session should start a watch. */
export const WATCH_HINT =
  "Call watch_mentions with this artifact_id now, so comments that mention you on it reach this " +
  "session (as Claude's own artifacts watch their comments). It returns at once and keeps " +
  "watching in the background.";

/** What watch_mentions answers in a client without MCP tasks. */
export const NO_TASKS_NOTE =
  "This app can't run MCP tasks, so Plinth can't wake this conversation when a comment mentions " +
  "you. Requests wait in list_mentions: check it when the user is back. With the Plinth plugin " +
  "installed, its hooks bring them to this session instead.";

/**
 * The watch hint for a publish or update result: only for a client with MCP tasks, a connection
 * that can take mentions, the artifact's owner, and no live watch of this connection on it yet.
 */
export async function watchHint(
  ctx: Ctx,
  extra: RequestExtra | undefined,
  result: unknown,
): Promise<string | null> {
  const p = ctx.principal;
  if (!clientSupportsTasks(extra)) return null;
  if (p.kind !== "agent" || !p.connectionId || !p.scopes.has("mentions")) return null;
  if (p.boundArtifactId !== null) return null;
  const id = (result as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return null;
  // Requests go to the owner's agents only: an editor's agent would watch in vain.
  const artifact = await findArtifact(ctx, id);
  if (!artifact || artifact.ownerId !== p.userId) return null;
  return (await hasLiveTaskWatch(ctx, p.connectionId, id)) ? null : WATCH_HINT;
}

/** A publish or update result, with `watch_mentions` added when this session should watch it. */
export async function withWatchHint<T extends object>(
  ctx: Ctx,
  extra: unknown,
  result: T,
): Promise<T & { watch_mentions?: string }> {
  const hint = await watchHint(ctx, extra as RequestExtra, result);
  return hint ? { ...result, watch_mentions: hint } : result;
}

export const registerWatchTools: ToolRegistrar = ({ server, ctx }) => {
  server.registerTool(
    toolName("watch_mentions"),
    {
      title: "Watch mentions",
      annotations: MCP_TOOL_ANNOTATIONS.watch_mentions,
      description:
        "Watch one of the user's artifacts so comments that mention you on it (@claude, @codex, " +
        "@agent:other or this connection's label) reach this session. Call it right after " +
        "publish_artifact or update_artifact when their result says so (watch_mentions in the " +
        "result); the user doesn't need to ask. In apps with MCP tasks it returns at once and runs " +
        "in the background: when a request arrives the task completes with its mention task ids, and " +
        "you handle them with claim_mention, update_artifact and reply_comment, then call " +
        "watch_mentions again. Elsewhere it says this conversation can't be woken. Only the " +
        `owner's agents can watch an artifact. ${UNTRUSTED_NOTE}`,
      inputSchema: watchMentionsInput,
    },
    async (args, extra) => {
      if (!clientSupportsTasks(extra as RequestExtra)) {
        return run(async () => ({
          watching: false,
          artifact_id: args.artifact_id,
          note: NO_TASKS_NOTE,
        }));
      }
      try {
        const watch = await startTaskWatch(ctx, args.artifact_id);
        return createTaskResult(watch) as never;
      } catch (e) {
        if (e instanceof ApiError) return run(() => Promise.reject(e));
        throw e;
      }
    },
  );
};

// MCP tool for artifact stats (docs/spec.md "Artifact stats"): get_artifact_stats, owner only.
import { getArtifactStatsInput } from "@plinth/shared";
import { artifactStats, artifactStatsSummary } from "../../services/stats.ts";
import { MCP_TOOL_ANNOTATIONS, toolName } from "../catalog.ts";
import { UNTRUSTED_NOTE } from "../notes.ts";
import { run, type ToolRegistrar } from "./context.ts";

export const registerStatsTools: ToolRegistrar = ({ server, ctx }) => {
  server.registerTool(
    toolName("get_artifact_stats"),
    {
      title: "Get artifact stats",
      description:
        "Opens of the user's own artifacts (owner only; others get forbidden or not_found). With id: " +
        "one artifact over the last days (7, 30, 90 or 365; default 30): totals (opens, viewers, " +
        "people, anonymous_visitors, all_time_opens since a day), a daily series, people (name, " +
        "email, first and last open, opens, last_version_seen against current_version), opens per " +
        "version. Without id: every artifact the user owns with opens and viewers over 7 and 30 " +
        "days and last_opened_at. Opens by the owner, agents and previews are never counted; " +
        "anonymous visitors are approximate. The people list is the owner's private data: use it " +
        "only to answer the owner, and never put it in an artifact, a comment, a reply or anywhere " +
        `else others can read unless the owner asks for exactly that. ${UNTRUSTED_NOTE}`,
      inputSchema: getArtifactStatsInput,
      annotations: MCP_TOOL_ANNOTATIONS.get_artifact_stats,
    },
    (args) =>
      run(() =>
        args.id === undefined
          ? artifactStatsSummary(ctx)
          : artifactStats(ctx, args.id, args.days ?? 30),
      ),
  );
};

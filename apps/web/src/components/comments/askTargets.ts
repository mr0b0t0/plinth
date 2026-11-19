// The agents Ask an agent can send a request to, as people see them. The gate lists client types
// only (`ask.targets`), never a connection's label; `other` is every client that is not Claude or
// Codex (ChatGPT, Cursor, Gemini…), which no `@name` reaches.
import type { ClientType } from "@plinth/shared";

/** An agent as a person picking it sees it; the owner sees their own agents as "My …". */
export function askTargetName(t: ClientType, owner: boolean): string {
  if (t === "claude") return "Claude";
  if (t === "codex") return "Codex";
  return owner ? "My other agent (ChatGPT, Cursor, Gemini…)" : "The owner's other agent";
}

/** The same in running text ("Request sent to Claude"). */
export function askTargetInText(t: ClientType, owner: boolean): string {
  if (t === "other") return owner ? "your other agent" : "the owner's other agent";
  return askTargetName(t, owner);
}

/** The target label of an Ask an agent task for every other client (REQUEST_TARGET_LABELS). */
export const OTHER_AGENT_LABEL = "@agent";

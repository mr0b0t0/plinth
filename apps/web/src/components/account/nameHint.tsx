// The hint under a connection's name field (rename, new token, consent): one line, with one mention
// sentence at most.
import type { ReactNode } from "react";
import { type MentionReach, mentionReachText, mentionReachWarns } from "./format.ts";

/**
 * The usual line plus how a comment mentions the connection. When no mention can reach it by this
 * name, the warning alone, in the warning colour, so it does not read as fine print.
 */
export function nameHint(usual: string | null, reach: MentionReach | null): ReactNode {
  const text = reach ? mentionReachText(reach) : null;
  if (reach && text && mentionReachWarns(reach)) {
    return <span className="pl-acct-warn">{text}</span>;
  }
  return [usual, text].filter(Boolean).join(" ") || undefined;
}

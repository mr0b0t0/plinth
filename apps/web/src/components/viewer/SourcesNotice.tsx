// One line under the viewer bar for an artifact with data sources (docs/spec.md "Live data from the
// owner's agents"): where the page's figures come from and how old they are, counted by the server
// from the stamps it stored, and how many were last changed by a person or by an agent without a
// source. The page draws its own badges, which its code can fake; this line is app chrome the frame
// cannot touch, so it is the one that counts. React text only: labels and connectors are untrusted.
// For the owner, a second line when a source waits for their confirmation, with a Review button.
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import type { ViewSource } from "@plinth/shared";
import { relativeTime } from "../history/format.ts";

const figures = (n: number) => `${n} ${n === 1 ? "figure" : "figures"}`;

/** "A", "A and B", "A, B and C". */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The sentence for a gate's sources, or null when there are none. `now` for the ages. */
export function sourcesNoticeText(
  sources: readonly ViewSource[] | undefined,
  now: number = Date.now(),
): string | null {
  if (!sources || sources.length === 0) return null;
  const parts: string[] = [];
  // One entry per group of stamps, each with its own count and age: a source's current stamps,
  // then those it wrote under an earlier label or connector, named as their stamps say.
  const groups: { connector: string; fetched: number; at: string | null }[] = [];
  for (const s of sources) {
    if (s.fetched > 0)
      groups.push({ connector: s.connector, fetched: s.fetched, at: s.last_fetched_at });
    for (const e of s.earlier ?? []) {
      if (e.fetched > 0)
        groups.push({ connector: e.connector, fetched: e.fetched, at: e.last_fetched_at });
    }
  }
  const named = new Set(groups.map((g) => g.connector));
  const empty = sources.filter((s) => s.fetched === 0 && !named.has(s.connector));
  if (groups.length > 0) {
    const each = groups.map((g) => {
      const age = g.at ? `, fetched ${relativeTime(g.at, now)}` : "";
      return `${g.connector} (${figures(g.fetched)}${age})`;
    });
    parts.push(`Figures from ${joinAnd(each)} were written by an agent of the owner.`);
  }
  if (empty.length > 0) {
    const names = joinAnd([...new Set(empty.map((s) => s.connector))]);
    parts.push(
      groups.length > 0
        ? `None are stored as fetched from ${names}.`
        : `This page says its figures come from ${names}, but none are stored as fetched: what it shows comes from the page itself.`,
    );
  }
  // Unstamped documents are counted per collection, once, however many sources name it.
  const seen = new Set<string>();
  let byPerson = 0;
  let byAgent = 0;
  for (const s of sources) {
    if (seen.has(s.collection)) continue;
    seen.add(s.collection);
    byPerson += s.by_person;
    byAgent += s.by_agent;
  }
  const were = (n: number) => `${n} ${n === 1 ? "was" : "were"}`;
  if (byPerson > 0 && byAgent > 0) {
    parts.push(
      `${were(byPerson)} last changed by a person and ${byAgent} by an agent without a source, not fetched.`,
    );
  } else if (byPerson > 0) {
    parts.push(`${were(byPerson)} last changed by a person, not fetched.`);
  } else if (byAgent > 0) {
    parts.push(`${were(byAgent)} last changed by an agent without a source, not fetched.`);
  }
  return parts.join(" ");
}

/** The owner's line: how many sources wait for their confirmation, or null. */
export function sourcesReviewText(sources: readonly ViewSource[] | undefined): string | null {
  const n = (sources ?? []).filter((s) => s.status === "awaiting_confirmation").length;
  if (n === 0) return null;
  return n === 1
    ? "1 data source is waiting for you to confirm it."
    : `${n} data sources are waiting for you to confirm them.`;
}

export function SourcesNotice({
  sources,
  isOwner,
  onReview,
}: {
  sources: readonly ViewSource[] | undefined;
  isOwner: boolean;
  onReview: () => void;
}) {
  const text = sourcesNoticeText(sources);
  const review = isOwner ? sourcesReviewText(sources) : null;
  if (!text && !review) return null;
  return (
    <>
      {text && (
        <p className="pl-viewer__notice pl-viewer__data pl-viewer__sources" role="note">
          <PlugsConnectedIcon size={14} aria-hidden="true" className="pl-viewer__data-icon" />
          <span>{text}</span>
        </p>
      )}
      {review && (
        <p className="pl-viewer__notice pl-viewer__notice--update">
          <span>{review}</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="pl-viewer__notice-action" onClick={onReview}>
            Review
          </button>
        </p>
      )}
    </>
  );
}

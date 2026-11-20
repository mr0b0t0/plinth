// The signed-in person's connected agents, for the sidebar. Loaded when a signed-in page mounts
// and kept between pages, so navigating does not make the list flicker. Failures keep the last
// list (or none): the sidebar is a shortcut, the Connections page is the source of truth. A token
// limited to one artifact (a CI pipeline) is not an agent, so the sidebar leaves it out, and the
// Connections page lists it with the personal access tokens.
import { API, type ConnectionInfo, type Paged } from "@plinth/shared";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";

let agents: ConnectionInfo[] | null = null;
/** An active connection that is not limited to one artifact. */
export const isAgent = (c: ConnectionInfo) => !c.revoked_at && !c.artifact;
let forUser: string | null = null;
const listeners = new Set<() => void>();

function set(next: ConnectionInfo[] | null) {
  agents = next;
  for (const l of listeners) l();
}

async function load(userId: string, signal: AbortSignal): Promise<void> {
  try {
    const res = await api<Paged<ConnectionInfo>>(API.connections, { signal });
    if (signal.aborted) return;
    forUser = userId;
    set(res.items.filter(isAgent));
  } catch {
    // keep what we had
  }
}

/**
 * The Connections page already loads (and polls) the full list: it hands it over here, so the
 * sidebar follows renames, revokes and new agents without a second request.
 */
export function publishAgents(userId: string, items: ConnectionInfo[]): void {
  forUser = userId;
  set(items.filter(isAgent));
}

/**
 * Active connections of `userId` (null while unknown or signed out). Refreshes on mount unless
 * `fetchList` is false (the page publishes the list itself).
 */
export function useAgents(
  userId: string | null | undefined,
  fetchList = true,
): ConnectionInfo[] | null {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => agents,
    () => null,
  );
  useEffect(() => {
    if (!userId || !fetchList) return;
    if (forUser !== userId) set(null);
    const ctrl = new AbortController();
    void load(userId, ctrl.signal);
    return () => ctrl.abort();
  }, [userId, fetchList]);
  return userId && forUser === userId ? list : null;
}

/** Two letters for an agent's square mark: "Work Claude" -> "WC", "codex" -> "Co". */
export function agentInitials(label: string): string {
  const words = label
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const w = words[0] ?? "";
    return (w.charAt(0).toUpperCase() + w.charAt(1).toLowerCase()).trim() || "?";
  }
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

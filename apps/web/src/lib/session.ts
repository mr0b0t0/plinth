// The signed-in user and instance config, loaded once and shared.
import type { AppConfig, Me } from "@plinth/shared";
import { useEffect, useSyncExternalStore } from "react";
import { ApiRequestError, api } from "./api.ts";

interface SessionState {
  loading: boolean;
  me: Me | null;
  config: AppConfig | null;
}

let state: SessionState = { loading: true, me: null, config: null };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<SessionState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export async function refreshSession(): Promise<void> {
  const config = state.config ?? (await api<AppConfig>("/config"));
  let me: Me | null = null;
  try {
    me = await api<Me>("/me");
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.status === 401)) throw e;
  }
  set({ loading: false, me, config });
}

export function useSession(): SessionState & { refresh: () => Promise<void> } {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!started) {
      started = true;
      refreshSession().catch(() => set({ loading: false }));
    }
  }, []);
  return { ...s, refresh: refreshSession };
}

// Loads the viewer gate for one artifact. Each "ok" gate carries a one-time enter URL, so a new
// gate is fetched whenever the frame must (re)load: a different version, review mode on or off.
import type { ViewGate } from "@plinth/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { type GateQuery, gatePath } from "./gate.ts";

export type GateState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "gate"; gate: ViewGate };

export function useGate(ref: string, query: GateQuery) {
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const path = gatePath("view", ref, query);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a fresh gate
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => (s.kind === "gate" && s.gate.status === "ok" ? s : { kind: "loading" }));
    api<ViewGate>(path, { signal: ctrl.signal })
      .then((gate) => setState({ kind: "gate", gate }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not load this artifact.",
        });
      });
    return () => ctrl.abort();
  }, [path, nonce]);

  /** Fetch a fresh gate (and with it a fresh enter URL). */
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** Use a gate returned by a password or code step. */
  const setGate = useCallback((gate: ViewGate) => setState({ kind: "gate", gate }), []);

  return { state, reload, setGate };
}

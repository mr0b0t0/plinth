// Data loading for the history pages: a small fetch hook over api(), plus the endpoints we call.
import {
  API,
  type ArtifactDetail,
  type Paged,
  route,
  type VersionInfo,
  type ViewGate,
} from "@plinth/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";

export interface Loaded<T> {
  data: T | undefined;
  error: ApiRequestError | undefined;
  loading: boolean;
  /** Fetch again; keeps the old data on screen until the new data arrives. */
  reload: () => void;
}

function toApiError(e: unknown): ApiRequestError {
  if (e instanceof ApiRequestError) return e;
  return new ApiRequestError(0, "internal", e instanceof Error ? e.message : "Network error");
}

/** GET `path` (relative to /api/v1) whenever it changes. `null` skips the request. */
export function useApiGet<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error?: ApiRequestError;
    loading: boolean;
  }>({ path, loading: path !== null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const ctrl = new AbortController();
    setState((s) => ({ path, data: s.path === path ? s.data : undefined, loading: true }));
    // `tick` re-runs this effect for reload().
    void tick;
    api<T>(path, { signal: ctrl.signal }).then(
      (data) => setState({ path, data, loading: false }),
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ path, error: toApiError(e), loading: false });
      },
    );
    return () => ctrl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = state.path === path;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: path !== null && (!current || state.loading),
    reload,
  };
}

export const artifactApiPath = (ref: string) => route(API.artifact, { ref });
export const versionsApiPath = (ref: string) => route(API.versions, { ref });
export const versionApiPath = (ref: string, n: number) => route(API.version, { ref, n });

export const useArtifact = (slug: string) => useApiGet<ArtifactDetail>(artifactApiPath(slug));
export const useVersions = (slug: string | null) =>
  useApiGet<Paged<VersionInfo>>(slug === null ? null : versionsApiPath(slug));
export const useVersion = (slug: string, n: number | null) =>
  useApiGet<ArtifactDetail>(n === null ? null : versionApiPath(slug, n));

/** A fresh viewer gate for one version (each enter_url works once). */
export function fetchGate(slug: string, n: number, signal?: AbortSignal): Promise<ViewGate> {
  return api<ViewGate>(`${route(API.view, { ref: slug })}?version=${n}`, { signal });
}

export async function restoreVersion(slug: string, n: number, baseVersion: number) {
  return api<{ version: number }>(route(API.restore, { ref: slug, n }), {
    method: "POST",
    body: { base_version: baseVersion },
  });
}

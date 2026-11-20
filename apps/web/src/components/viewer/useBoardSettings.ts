// A whiteboard's settings as a form holds them (docs/spec.md "Whiteboards"): it reads the current
// version, and `save` publishes the chosen settings as the next version with that version as
// `base_version`. When someone published a newer version meanwhile, the save is refused (409
// `conflict` naming that version, with no `reason`): the form then reads that version, shows its
// settings, says so, and calls `onNewer` so the page around it can show that version too. Nothing
// is saved until the person saves again. Any other refusal, every other 409 included, shows the
// server's message and keeps the choice. Used by the board's Settings dialog (editors) and the
// Board section of the artifact's settings page (owners); the API checks the role on every call.
import {
  API,
  type ArtifactDetail,
  type BoardSettings,
  type PublishResult,
  parseBoardSettings,
  route,
  sourceOf,
} from "@plinth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { useToast } from "../ui/index.ts";
import { conflictNotice, newerVersion, settingsBody, settingsChanged } from "./boardSettings.ts";

export interface LoadedBoardSettings {
  version: number;
  settings: BoardSettings;
}

export type BoardSettingsLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; loaded: LoadedBoardSettings };

const message = (e: unknown, fallback: string) =>
  e instanceof ApiRequestError ? e.message : fallback;

export function useBoardSettings(
  artifactId: string,
  /** After a refused save read a newer version (its number), so the page can show it too. */
  onNewer?: (version: number) => void,
) {
  const toast = useToast();
  const [state, setState] = useState<BoardSettingsLoad>({ kind: "loading" });
  const [chosen, setChosen] = useState<BoardSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const newer = useRef(onNewer);
  newer.current = onNewer;
  // Whether the form is mounted, so a read or save that resolves after it closes changes nothing.
  // The effect sets it on every mount, not only the ref's first value: StrictMode (`pnpm dev`)
  // runs the cleanup and then the effect again, and a ref left false would drop every result.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Read the current version's settings. Resolves to what it read, or null on failure. */
  const load = useCallback(async (): Promise<LoadedBoardSettings | null> => {
    try {
      const detail = await api<ArtifactDetail>(route(API.artifact, { ref: artifactId }));
      const loaded = {
        version: detail.version,
        settings: parseBoardSettings(sourceOf(detail).text),
      };
      if (!alive.current) return null;
      setState({ kind: "ready", loaded });
      setChosen(loaded.settings);
      return loaded;
    } catch (e) {
      if (alive.current) {
        setState({ kind: "error", message: message(e, "Could not reach Plinth. Try again.") });
      }
      return null;
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loaded = state.kind === "ready" ? state.loaded : null;
  const changed = loaded !== null && chosen !== null && settingsChanged(loaded.settings, chosen);

  /** Save the chosen settings. Resolves to the new version, or null when nothing was saved. */
  const save = async (): Promise<number | null> => {
    if (!loaded || !chosen || !changed || saving) return null;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<PublishResult>(route(API.artifact, { ref: artifactId }), {
        method: "PUT",
        body: settingsBody(loaded.settings, chosen, loaded.version),
      });
      if (!alive.current) return null;
      setState({ kind: "ready", loaded: { version: result.version, settings: chosen } });
      toast.success(`Saved as v${result.version}`);
      return result.version;
    } catch (err) {
      if (!alive.current) return null;
      if (err instanceof ApiRequestError && newerVersion(err, loaded.version) !== null) {
        // A newer version exists: show its settings and save nothing until the person confirms.
        const now = await load();
        if (now) {
          setNotice(conflictNotice(now.version));
          newer.current?.(now.version);
        }
      } else {
        // Any other refusal, every other 409 included (one with a `reason`, or one that names no
        // newer version, such as "Another version is being written"): say why and keep the
        // person's choice for another try, against the same version.
        setError(message(err, "Could not save. Try again."));
      }
      return null;
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return {
    state,
    chosen,
    notice,
    error,
    saving,
    changed,
    save,
    /** Change one or both settings in the form (nothing is saved yet). */
    set: (patch: Partial<BoardSettings>) => setChosen((c) => (c ? { ...c, ...patch } : c)),
    /** Read again after a failed read. */
    retry: () => {
      setState({ kind: "loading" });
      void load();
    },
  };
}

export type BoardSettingsForm = ReturnType<typeof useBoardSettings>;

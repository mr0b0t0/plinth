// Board settings for a whiteboard (docs/spec.md "Whiteboards"): the background and who may change
// the board from its page, as two groups of radio buttons. It reads the current version, and Save
// publishes the settings as the next version with that version as `base_version`. When someone
// published a newer version meanwhile, the save is refused (409 `conflict` naming that version, with
// no `reason`): the dialog then shows that version's settings, says so, and saves nothing until the
// person saves again. Any other refusal, every other 409 included, shows the server's message and
// keeps the choice. Owners and editors
// open it from the board's ⋯ menu; the API checks the role again on every call.
import {
  API,
  type ArtifactDetail,
  type BoardBackground,
  type BoardEditMode,
  type BoardSettings,
  type PublishResult,
  parseBoardSettings,
  route,
  sourceOf,
} from "@plinth/shared";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { ChoiceList } from "../account/ChoiceList.tsx";
import { Button, Dialog, Spinner, useToast } from "../ui/index.ts";
import {
  BACKGROUND_CHOICES,
  conflictNotice,
  EDIT_CHOICES,
  newerVersion,
  settingsBody,
  settingsChanged,
} from "./boardSettings.ts";
import "../account/account.css";

export interface BoardSettingsDialogProps {
  /** The artifact's id. */
  artifactId: string;
  onClose: () => void;
  /** After a version with the new settings was published. */
  onSaved: (version: number) => void;
}

interface Loaded {
  version: number;
  settings: BoardSettings;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; loaded: Loaded };

const message = (e: unknown, fallback: string) =>
  e instanceof ApiRequestError ? e.message : fallback;

export function BoardSettingsDialog({ artifactId, onClose, onSaved }: BoardSettingsDialogProps) {
  const toast = useToast();
  const formId = useId();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [chosen, setChosen] = useState<BoardSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Whether the dialog is mounted, so a read or save that resolves after it closes changes nothing.
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
  const load = useCallback(async (): Promise<Loaded | null> => {
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

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!loaded || !chosen || !changed || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<PublishResult>(route(API.artifact, { ref: artifactId }), {
        method: "PUT",
        body: settingsBody(loaded.settings, chosen, loaded.version),
      });
      if (!alive.current) return;
      toast.success(`Saved as v${result.version}`);
      onSaved(result.version);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiRequestError && newerVersion(err, loaded.version) !== null) {
        // A newer version exists: show its settings and save nothing until the person confirms.
        const now = await load();
        if (now) setNotice(conflictNotice(now.version));
      } else {
        // Any other refusal, every other 409 included (one with a `reason`, or one that names no
        // newer version, such as "Another version is being written"): say why and keep the
        // person's choice for another try, against the same version.
        setError(message(err, "Could not save. Try again."));
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const set = (patch: Partial<BoardSettings>) => setChosen((c) => (c ? { ...c, ...patch } : c));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Board settings"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={saving}
            disabled={!changed}
          >
            Save
          </Button>
        </>
      }
    >
      {state.kind === "loading" && <Spinner label="Loading the board settings" />}
      {state.kind === "error" && (
        <div className="pl-board-settings__error" role="alert">
          <p>{state.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setState({ kind: "loading" });
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {loaded && chosen && (
        <form id={formId} onSubmit={(e) => void save(e)} noValidate className="pl-board-settings">
          {notice && (
            <p className="pl-board-settings__notice" role="status">
              {notice}
            </p>
          )}
          <ChoiceList<BoardBackground>
            legend="Background"
            name="board-background"
            choices={[...BACKGROUND_CHOICES]}
            value={chosen.background}
            onChange={(background) => set({ background })}
          />
          <ChoiceList<BoardEditMode>
            legend="Who can change the board"
            name="board-edit"
            choices={[...EDIT_CHOICES]}
            value={chosen.edit}
            onChange={(edit) => set({ edit })}
          />
          {error && (
            <p className="pl-board-settings__error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

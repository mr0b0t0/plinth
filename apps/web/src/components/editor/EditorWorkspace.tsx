// The editor itself: Monaco on the left, the live preview on the right, save with an optional
// note, and conflict handling. Loaded lazily by pages/Editor.tsx (it pulls in Monaco).
//
// What is edited comes from the artifact's type (TYPE_REGISTRY): an HTML page's index.html, or a
// doc's content.md in Markdown. A typed artifact's preview is the same shell the content host
// serves, built around the draft, so the preview runs the real renderer.
//
// Saves always send base_version. A save against a stale version is refused by the Worker (409)
// and this view shows the published version next to the draft; it never merges or overwrites on
// its own. Saving on top of the newer version needs an explicit confirmation.
import {
  ArrowsClockwiseIcon,
  CodeIcon,
  ColumnsIcon,
  EyeIcon,
  FloppyDiskIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import {
  API,
  type AppConfig,
  type ArtifactDetail,
  type ArtifactTypeDef,
  LIMITS,
  type Paged,
  type PublishResult,
  route,
  sourceOf,
  typedShellHtml,
  type VersionInfo,
} from "@plinth/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiRequestError, api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  SegmentedControl,
  Tooltip,
  useToast,
} from "../ui/index.ts";
import { CodeDiff, CodeEditor } from "./CodeEditor.tsx";
import { type ConflictInfo, ConflictView } from "./ConflictView.tsx";
import { clearAllDrafts, clearDraft, saveDraft } from "./draft.ts";
import type { EditorInitial, VersionText } from "./initial.ts";
import { PreviewFrame } from "./PreviewFrame.tsx";
import { utf8Bytes } from "./previewProtocol.ts";
import { SplitPane, type SplitView } from "./SplitPane.tsx";
import { sourceProblems } from "./sourceChecks.ts";
import { useLastValid } from "./useLastValid.ts";
import "./editor.css";

/** Keep the draft in sessionStorage this long after the last change. */
const DRAFT_DEBOUNCE_MS = 300;

type Mode = "edit" | "conflict" | "reapply";

export interface EditorWorkspaceProps {
  artifact: ArtifactDetail;
  config: AppConfig;
  initial: EditorInitial;
  /** False while the screen is too narrow and the workspace is hidden. */
  active: boolean;
}

/** The model file name for the draft: draft.html, draft.md. */
export function draftModelName(def: ArtifactTypeDef): string {
  const ext = def.sourcePath.slice(def.sourcePath.lastIndexOf(".") + 1);
  return `draft.${ext}`;
}

/** The type's editor settings. The editor page mounts the workspace only for a type that has them. */
function editorOf(def: ArtifactTypeDef): NonNullable<ArtifactTypeDef["editor"]> {
  if (!def.editor) throw new Error(`Type ${def.id} has no source editor`);
  return def.editor;
}

/** A size in whole megabytes for messages ("1 MB", "5 MB"). */
const megabytes = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/**
 * What the preview frame renders: the draft itself for an HTML page; for a typed artifact the
 * shell page the content host serves, with the draft as its content. `base` puts the renderer URLs
 * under the artifact root in the path fallback, where the loader lives at /__content/<id>/.
 */
export function previewDocument(
  def: ArtifactTypeDef,
  o: { id: string; title: string; text: string; config: AppConfig },
): string {
  if (!def.renderer) return o.text;
  return typedShellHtml(def, {
    title: o.title,
    text: o.text,
    base: o.config.content_path_fallback ? `/__content/${o.id}` : "",
    appOrigin: o.config.app_origin,
    // A deck's preview shows every slide stacked, so the author sees the whole deck.
    ...(def.present ? { view: "overview" as const } : {}),
  });
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Monaco's "Tab moves focus" toggle (WCAG 2.1.2: Tab must not trap keyboard users). */
const TAB_FOCUS_KEYS =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "Control+Shift+M"
    : "Control+M";

export default function EditorWorkspace({
  artifact,
  config,
  initial,
  active,
}: EditorWorkspaceProps) {
  const toast = useToast();
  const id = artifact.id;
  const { def } = sourceOf(artifact);
  const editor = editorOf(def);
  const label = def.sourceLabel;
  // The pane header starts with a capital, as "HTML" and "Markdown" do ("Design system JSON").
  const paneLabel = label.charAt(0).toUpperCase() + label.slice(1);
  const artifactPath = `/a/${encodeURIComponent(artifact.slug)}`;
  const codePaneId = useId();
  const tabHintId = useId();

  const [html, setHtml] = useState(initial.html);
  const [note, setNote] = useState(initial.note);
  const [base, setBase] = useState<VersionText>(initial.base);
  const [view, setView] = useState<SplitView>("split");
  const [mode, setMode] = useState<Mode>("edit");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  /** A newer version than the base is known to exist (draft restored or conflict dismissed). */
  const [newer, setNewer] = useState<number | null>(
    initial.base.version < initial.latest.version ? initial.latest.version : null,
  );
  /** The draft kept for reference while reapplying it on top of the latest version. */
  const [reference, setReference] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const dirty = html !== base.html;
  // UTF-8 bytes, as the Worker counts them.
  const tooLarge = useMemo(() => utf8Bytes(html) > def.maxSourceBytes, [html, def]);
  // A typed format's own problems (a design system's JSON): Save waits until there are none.
  const problems = useMemo(() => sourceProblems(def.id, html), [def, html]);
  const invalid = problems.length > 0;
  // While the draft has problems (listed above the editor), the preview keeps the last draft that
  // had none instead of repeating them; it stays blank until one does.
  const shown = useLastValid(html, !invalid);
  const preview = useMemo(
    () =>
      shown === null
        ? ""
        : previewDocument(def, { id, title: artifact.title, text: shown, config }),
    [def, id, artifact.title, shown, config],
  );

  // Refs for handlers that must see the newest values (keyboard shortcut, async saves).
  const latest = useRef({ html, note, base, mode, dirty, active, tooLarge, invalid });
  latest.current = { html, note, base, mode, dirty, active, tooLarge, invalid };
  const savingRef = useRef(false);

  // Keep the draft in this tab so a reload does not lose it.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (html !== base.html || note.trim() !== "") saveDraft(id, base.version, html, note);
      else clearDraft(id, base.version);
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [id, html, note, base]);

  // Warn before the tab closes or reloads with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /** Load the newer version and show it next to the draft. */
  const openConflict = useCallback(
    async (current: number | null, from: number): Promise<boolean> => {
      try {
        const detail = await api<ArtifactDetail>(
          current ? route(API.version, { ref: id, n: current }) : route(API.artifact, { ref: id }),
        );
        let author: string | null = null;
        let createdAt: string | null = null;
        try {
          const { items } = await api<Paged<VersionInfo>>(route(API.versions, { ref: id }));
          const v = items.find((i) => i.number === detail.version);
          author = v?.author.label ?? null;
          createdAt = v?.created_at ?? null;
        } catch {
          // The author line is optional.
        }
        setConflict({
          current: detail.version,
          currentHtml: sourceOf(detail).text,
          author,
          createdAt,
          base: from,
        });
        setNewer(detail.version);
        setMode("conflict");
        return true;
      } catch {
        toast.error(
          "A newer version could not be loaded",
          "Nothing was saved. Your draft is kept in this tab; try again.",
        );
        return false;
      }
    },
    [id, toast],
  );

  const save = useCallback(
    async (baseVersion?: number) => {
      if (savingRef.current) return;
      const { html: draft, note: draftNote, base: b } = latest.current;
      const from = baseVersion ?? b.version;
      const trimmed = draftNote.trim();
      savingRef.current = true;
      setSaving(true);
      try {
        const result = await api<PublishResult>(route(API.artifact, { ref: id }), {
          method: "PUT",
          body: { [def.sourceField]: draft, note: trimmed || undefined, base_version: from },
        });
        clearAllDrafts(id);
        setBase({ version: result.version, html: draft });
        setNote((n) => (n.trim() === trimmed ? "" : n));
        setConflict(null);
        setNewer(null);
        setReference(null);
        setMode("edit");
        toast.success(`Saved as v${result.version}`);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 409) {
          const details = e.details as { current_version?: unknown } | undefined;
          const current =
            typeof details?.current_version === "number" ? details.current_version : null;
          await openConflict(current, from);
        } else if (e instanceof ApiRequestError && e.status === 401) {
          toast.error(
            "You are signed out",
            "Sign in again in another tab, then save. Your draft is kept in this tab.",
          );
        } else if (e instanceof ApiRequestError && e.status === 403) {
          toast.error("You can no longer edit this artifact", e.message);
        } else {
          toast.error("Could not save", e instanceof Error ? e.message : undefined);
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [id, def, openConflict, toast],
  );

  // Cmd+S / Ctrl+S saves, anywhere on the page (captured before Monaco sees it).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s")
        return;
      if (!latest.current.active) return;
      e.preventDefault();
      const s = latest.current;
      if (s.mode === "conflict") {
        toast.toast({
          title: "Choose how to resolve the conflict first",
          description: "Saving now would be refused again.",
          tone: "warning",
        });
        return;
      }
      if (s.tooLarge) {
        // The Save button is disabled and the banner says why; the Worker would refuse it.
        toast.toast({
          title: "Too large to save",
          description: `The ${label} is larger than ${megabytes(def.maxSourceBytes)}. Shorten it to save.`,
          tone: "warning",
        });
        return;
      }
      if (s.invalid) {
        toast.toast({ title: `Fix the ${label} first`, tone: "warning" });
        return;
      }
      if (s.dirty) void save();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [save, toast, label, def]);

  // Offer to throw away a draft restored from this tab.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (!initial.restored || restoredOnce.current) return;
    restoredOnce.current = true;
    const behind = initial.base.version < initial.latest.version;
    toast.toast({
      title: "Restored your unsaved draft",
      description: behind
        ? `It is based on v${initial.base.version}; v${initial.latest.version} is now current. Saving will show the differences first.`
        : "It was kept in this tab since your last visit.",
      duration: 10_000,
      action: {
        label: "Discard draft",
        onClick: () => {
          clearAllDrafts(id);
          setBase(initial.latest);
          setHtml(initial.latest.html);
          setNote("");
          setNewer(null);
          setConflict(null);
          setReference(null);
          setMode("edit");
        },
      },
    });
  }, [id, initial, toast]);

  const onCopyDraft = () => {
    const text = latest.current.html;
    const done = () =>
      toast.success("Draft copied", "Your draft is on the clipboard and still in the editor.");
    const failed = () =>
      toast.error("Could not copy", "The browser blocked the clipboard. Your draft is still here.");
    try {
      navigator.clipboard.writeText(text).then(done, failed);
    } catch {
      failed();
    }
    setMode("edit");
  };

  const onLoadLatest = () => {
    if (!conflict) return;
    setReference(latest.current.html);
    setBase({ version: conflict.current, html: conflict.currentHtml });
    setHtml(conflict.currentHtml);
    setNewer(null);
    setConflict(null);
    setMode("reapply");
    setView("code");
  };

  const cancel = () => {
    if (dirty) setLeaving(true);
    else navigate(artifactPath);
  };

  const shortcut = isMac() ? "⌘S" : "Ctrl+S";
  const canSave = dirty && mode !== "conflict" && !tooLarge && !invalid;

  return (
    <div className="pl-editor" hidden={!active}>
      <header className="pl-editor__bar">
        <div className="pl-editor__heading">
          <div className="pl-editor__meta">
            <Badge tone="strong">Editing v{base.version}</Badge>
            <span className="pl-editor__status" aria-live="polite">
              {dirty ? (
                <Badge tone="warning">Unsaved changes</Badge>
              ) : (
                <span className="pl-editor__clean">No unsaved changes</span>
              )}
            </span>
          </div>
        </div>
        <div className="pl-editor__tools">
          <SegmentedControl
            label="Layout"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "split", label: "Split", icon: ColumnsIcon },
              { value: "code", label: "Code", icon: CodeIcon },
              { value: "preview", label: "Preview", icon: EyeIcon },
            ]}
          />
          <Input
            className="pl-editor__note"
            label="What changed? (optional)"
            hideLabel
            placeholder="What changed? (optional)"
            value={note}
            maxLength={LIMITS.maxNoteLength}
            onChange={(e) => setNote(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Tooltip content={`Save a new version (${shortcut})`} placement="bottom">
            <Button
              variant="primary"
              icon={FloppyDiskIcon}
              loading={saving}
              disabled={!canSave}
              onClick={() => void save()}
              aria-keyshortcuts="Meta+S Control+S"
            >
              Save
            </Button>
          </Tooltip>
        </div>
      </header>

      {tooLarge && def.renderer && (
        <div className="pl-editor__notice" role="status">
          <InfoIcon aria-hidden="true" />
          <p>
            The {label} is larger than {megabytes(def.maxSourceBytes)}, the most a {def.id} can
            hold, so it cannot be saved. Shorten it to save.
          </p>
        </div>
      )}
      {invalid && (
        <div
          className="pl-editor__notice pl-editor__problems"
          role="status"
          aria-live="polite"
          aria-label={`Fix the ${label} to save`}
        >
          <InfoIcon aria-hidden="true" />
          <ul>
            {problems.slice(0, 5).map((p) => (
              <li key={`${p.path} ${p.message}`}>
                <code>{p.path || "(root)"}</code> {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {mode === "edit" && newer !== null && (
        <div className="pl-editor__notice" role="status">
          <InfoIcon aria-hidden="true" />
          <p>
            v{newer} is newer than v{base.version}, the version you are editing. Saving will show
            the differences first and will not overwrite v{newer}.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void openConflict(conflict?.current ?? newer, base.version)}
          >
            Compare with v{newer}
          </Button>
        </div>
      )}
      {mode === "edit" && reference !== null && (
        <div className="pl-editor__notice" role="status">
          <InfoIcon aria-hidden="true" />
          <p>Your earlier draft is kept for reference until you save.</p>
          <Button
            variant="secondary"
            size="sm"
            icon={ArrowsClockwiseIcon}
            onClick={() => {
              setMode("reapply");
              setView("code");
            }}
          >
            Compare with my draft
          </Button>
        </div>
      )}
      {mode === "reapply" && reference !== null && (
        <div className="pl-editor__notice" role="status">
          <InfoIcon aria-hidden="true" />
          <p>
            Reapplying your draft on top of v{base.version}. Left: your draft, read only. Right: v
            {base.version}, where you edit. Copy what you need across, then save.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setMode("edit")}>
            Close comparison
          </Button>
        </div>
      )}

      <div className="pl-editor__body">
        {mode === "conflict" && conflict && (
          <ConflictView
            conflict={conflict}
            draft={html}
            artifactId={id}
            saving={saving}
            onCopyDraft={onCopyDraft}
            onLoadLatest={onLoadLatest}
            onSaveOnTop={() => void save(conflict.current)}
            language={editor.language}
            sourceLabel={label}
          />
        )}
        <div className="pl-editor__work" hidden={mode === "conflict"}>
          <SplitPane
            view={view}
            label="Resize code and preview"
            startId={codePaneId}
            start={
              <div className="pl-editor-pane">
                <div className="pl-editor-pane__tools">
                  <span className="pl-editor-pane__label">{paneLabel}</span>
                  <span className="pl-editor-pane__hint type-caption text-faint" id={tabHintId}>
                    Tab indents. {TAB_FOCUS_KEYS} makes Tab move focus instead.
                  </span>
                </div>
                <div className="pl-editor-pane__body">
                  {mode === "reapply" && reference !== null ? (
                    <CodeDiff
                      original={reference}
                      modified={html}
                      originalLabel="Your earlier draft (read only)"
                      modifiedLabel={`${label} of ${artifact.title}, based on v${base.version}`}
                      onModifiedChange={setHtml}
                      path={`inmemory://plinth/${id}/reapply`}
                      language={editor.language}
                      wordWrap={editor.wordWrap}
                    />
                  ) : (
                    <CodeEditor
                      value={html}
                      onChange={setHtml}
                      ariaLabel={`${label} of ${artifact.title}. Tab indents; press ${TAB_FOCUS_KEYS} to make Tab move focus.`}
                      path={`inmemory://plinth/${id}/${draftModelName(def)}`}
                      language={editor.language}
                      wordWrap={editor.wordWrap}
                    />
                  )}
                </div>
              </div>
            }
            end={
              <PreviewFrame
                artifactId={id}
                title={artifact.title}
                html={preview}
                config={config}
                tooLargeText={
                  def.renderer
                    ? `Too large to preview. The page built from this ${label} is over ${megabytes(LIMITS.maxHtmlBytes)}, the most the preview can show; saving still works while the ${label} is under ${megabytes(def.maxSourceBytes)}.`
                    : undefined
                }
              />
            }
          />
        </div>
      </div>

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={() => {
          clearAllDrafts(id);
          setLeaving(false);
          setHtml(base.html);
          navigate(artifactPath);
        }}
        title="Discard your changes?"
        description="Your changes have not been saved as a version. Leaving now throws the draft away."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
      />
    </div>
  );
}

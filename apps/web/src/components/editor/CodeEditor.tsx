// Monaco editors (single and diff), themed from the design tokens. This module pulls in Monaco, so
// it is only ever reached through a lazy import.
import { DiffEditor, Editor, type MonacoDiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../lib/theme.ts";
import { Spinner } from "../ui/index.ts";
import { monaco } from "./monaco.ts";
import { buildMonacoTheme, MONACO_THEME_NAMES, readThemeTokens } from "./theme.ts";

/** Define (or redefine) the Monaco theme for the app's current mode and return its name. */
function useMonacoTheme(): string {
  const [mode] = useTheme();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const tokens = readThemeTokens((name) => style.getPropertyValue(name));
    const name = MONACO_THEME_NAMES[mode];
    monaco.editor.defineTheme(name, buildMonacoTheme(mode, tokens));
    monaco.editor.setTheme(name);
    return name;
  }, [mode]);
}

/** Type settings from the tokens: the mono family and the small text size, in pixels. */
function useTypeSettings(): { fontFamily: string; fontSize: number; lineHeight: number } {
  return useMemo(() => {
    const root = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(root.fontSize) || 16;
    const size = Number.parseFloat(root.getPropertyValue("--text-sm")) * rem || rem * 0.8125;
    const leading = Number.parseFloat(root.getPropertyValue("--leading-normal")) || 1.55;
    return {
      fontFamily: root.getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: Math.round(size),
      lineHeight: Math.round(size * leading),
    };
  }, []);
}

const loading = <Spinner label="Loading the editor" />;

const BASE_OPTIONS = {
  minimap: { enabled: false },
  wordWrap: "on" as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  renderLineHighlight: "line" as const,
  fixedOverflowWidgets: true,
  padding: { top: 12, bottom: 12 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  accessibilitySupport: "auto" as const,
  // Tag and attribute completion from the HTML language service, but no suggestions made of
  // words already in the document, and nothing accepted by typing an ordinary character: prose
  // inside an artifact should come out exactly as typed.
  wordBasedSuggestions: "off" as const,
  acceptSuggestionOnCommitCharacter: false,
};

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the text area. */
  ariaLabel: string;
  /** Model URI, so undo history belongs to one artifact. */
  path: string;
}

export function CodeEditor({ value, onChange, ariaLabel, path }: CodeEditorProps) {
  const theme = useMonacoTheme();
  const type = useTypeSettings();
  const options = useMemo(() => ({ ...BASE_OPTIONS, ...type, ariaLabel }), [type, ariaLabel]);
  return (
    <Editor
      className="pl-code-editor"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      defaultLanguage="html"
      path={path}
      theme={theme}
      loading={loading}
      options={options}
    />
  );
}

let diffInstances = 0;

export interface CodeDiffProps {
  /** Left side, never editable. */
  original: string;
  /** Right side. */
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  /** When set, the right side is editable and reports changes here. */
  onModifiedChange?: (value: string) => void;
  /** Model URI prefix; the two sides get "/original" and "/modified". */
  path: string;
}

export function CodeDiff({
  original,
  modified,
  originalLabel,
  modifiedLabel,
  onModifiedChange,
  path,
}: CodeDiffProps) {
  const theme = useMonacoTheme();
  const type = useTypeSettings();
  const editable = Boolean(onModifiedChange);
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      ...type,
      readOnly: !editable,
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      originalAriaLabel: originalLabel,
      modifiedAriaLabel: modifiedLabel,
    }),
    [type, editable, originalLabel, modifiedLabel],
  );
  // Fresh model URIs per mount: models of an unmounted diff are disposed a moment later.
  const [instance] = useState(() => ++diffInstances);
  const changeRef = useRef(onModifiedChange);
  changeRef.current = onModifiedChange;
  const subscription = useRef<{ dispose(): void } | null>(null);
  useEffect(() => () => subscription.current?.dispose(), []);
  const onMount = (ed: MonacoDiffEditor) => {
    const modifiedEditor = ed.getModifiedEditor();
    subscription.current?.dispose();
    subscription.current = modifiedEditor.onDidChangeModelContent(() => {
      changeRef.current?.(modifiedEditor.getValue());
    });
    // @monaco-editor/react disposes the models before the diff editor on unmount, which Monaco
    // reports as an error. Keep them (keepCurrent*Model) and dispose them once the editor is gone.
    const models = ed.getModel();
    ed.onDidDispose(() => {
      window.setTimeout(() => {
        models?.original.dispose();
        models?.modified.dispose();
      }, 0);
    });
  };
  return (
    <DiffEditor
      className="pl-code-editor"
      original={original}
      modified={modified}
      language="html"
      originalModelPath={`${path}/${instance}/original`}
      modifiedModelPath={`${path}/${instance}/modified`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      theme={theme}
      loading={loading}
      options={options}
      onMount={onMount}
    />
  );
}

// Monaco, bundled with the app. The app CSP (script-src 'self') forbids loading it from a CDN, so
// @monaco-editor/react's loader is pointed at this local copy, and the workers are Vite `?worker`
// chunks served from the app's own origin (worker-src 'self' blob:).
//
// Only what the editor needs is registered: the editor features, the HTML, CSS and JavaScript
// grammars (HTML embeds the other two), the HTML language service (completion, hover,
// formatting), which runs in the html worker, and the Markdown grammar for docs (a tokenizer
// only: it needs no worker). CSS and TypeScript workers are never requested because the editor
// only ever holds HTML and Markdown models.
//
// The languages are the type registry's (EditorLanguage): a type with a new language adds its
// register imports below and its row in LANGUAGE_WORKERS, which the compiler asks for.
import { loader } from "@monaco-editor/react";
import type { EditorLanguage } from "@plinth/shared";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/features/html/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";

/** The language worker each editor language needs, by Monaco's worker labels (null: none). */
const LANGUAGE_WORKERS: {
  readonly [L in EditorLanguage]: { labels: readonly string[]; create: () => Worker } | null;
} = {
  html: { labels: ["html", "handlebars", "razor"], create: () => new HtmlWorker() },
  markdown: null,
};

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    for (const w of Object.values(LANGUAGE_WORKERS)) {
      if (w?.labels.includes(label)) return w.create();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

export { monaco };
export type Monaco = typeof monaco;

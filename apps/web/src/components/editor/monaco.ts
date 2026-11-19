// Monaco, bundled with the app. The app CSP (script-src 'self') forbids loading it from a CDN, so
// @monaco-editor/react's loader is pointed at this local copy, and the workers are Vite `?worker`
// chunks served from the app's own origin (worker-src 'self' blob:).
//
// Only what the editor needs is registered: the editor features, the HTML, CSS and JavaScript
// grammars (HTML embeds the other two), the HTML language service (completion, hover,
// formatting), which runs in the html worker, the Markdown grammar for docs (a tokenizer
// only: it needs no worker), and the JSON language service for design systems (system.json),
// which runs in the json worker and checks the source against the format's JSON Schema, and plain
// text for sheets (sheet.jsonl: JSON lines, which the JSON service would read as one document and
// flag; the editor checks it with the sheet parser instead, sourceChecks.ts). CSS and
// TypeScript workers are never requested because the editor only ever holds HTML, Markdown and
// JSON models.
//
// The languages are the type registry's (EditorLanguage): a type with a new language adds its
// register imports below and its row in LANGUAGE_WORKERS, which the compiler asks for.
import { loader } from "@monaco-editor/react";
import { designSystemJsonSchema, type EditorLanguage } from "@plinth/shared";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/features/html/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";

/** The language worker each editor language needs, by Monaco's worker labels (null: none). */
const LANGUAGE_WORKERS: {
  readonly [L in EditorLanguage]: { labels: readonly string[]; create: () => Worker } | null;
} = {
  html: { labels: ["html", "handlebars", "razor"], create: () => new HtmlWorker() },
  markdown: null,
  json: { labels: ["json"], create: () => new JsonWorker() },
  plaintext: null,
};

/** Where the editor keeps a design system's draft (EditorWorkspace draftModelName). */
export const DESIGN_SYSTEM_MODEL_GLOB = "draft.json";

// A design system's draft is checked against the format's JSON Schema as the author types. The
// schema is inline: the JSON worker never fetches one (enableSchemaRequest stays off).
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  trailingCommas: "error",
  enableSchemaRequest: false,
  schemas: [
    {
      uri: "inmemory://plinth/schemas/design-system.json",
      fileMatch: [DESIGN_SYSTEM_MODEL_GLOB],
      schema: designSystemJsonSchema,
    },
  ],
});

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

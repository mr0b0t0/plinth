// Artifact types. A type is a fixed Plinth renderer plus a content format: an artifact made from a
// type stores a content file (a doc stores content.md) instead of hand-written HTML, and the
// content host serves a fixed shell page that loads the renderer from the artifact's own origin
// under /__plinth/types/<id>/. This one table drives validation, storage paths, wire fields,
// serving, the shell, the editor, the diff label and the dashboard badge. Adding a type (deck,
// sheet) is an ARTIFACT_TYPES entry, a registry row and a renderer directory; no wire change.
import { LIMITS } from "./constants.ts";
import { escapeHtml } from "./markdown.ts";

export const ARTIFACT_TYPES = ["html", "doc"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactTypeDef {
  id: ArtifactType;
  /** Human name, e.g. "Document". */
  label: string;
  /** Dashboard badge, or null for none (plain HTML pages). */
  badge: string | null;
  /** The version file that holds the source. Always one of reservedPaths. */
  sourcePath: string;
  /** The wire field (MCP and REST) that carries the source. */
  sourceField: "html" | "content";
  /** What the source is called in the editor, diffs and conflict messages. */
  sourceLabel: string;
  /** Content-Type of the stored source file. */
  contentType: string;
  maxSourceBytes: number;
  /** Paths an asset may not use. */
  reservedPaths: readonly string[];
  /** Allowed asset content types, or null for any. */
  assetTypes: RegExp | null;
  /** Renderer files under /__plinth/types/<id>/, or null for a type served as-is. */
  renderer: { script: string; style: string } | null;
  editor: { language: "html" | "markdown"; wordWrap: "on" | "off" };
}

export const TYPE_REGISTRY: Record<ArtifactType, ArtifactTypeDef> = {
  html: {
    id: "html",
    label: "HTML page",
    badge: null,
    sourcePath: "index.html",
    sourceField: "html",
    sourceLabel: "HTML",
    contentType: "text/html; charset=utf-8",
    maxSourceBytes: LIMITS.maxHtmlBytes,
    reservedPaths: ["index.html"],
    assetTypes: null,
    renderer: null,
    editor: { language: "html", wordWrap: "off" },
  },
  doc: {
    id: "doc",
    label: "Document",
    badge: "Doc",
    sourcePath: "content.md",
    sourceField: "content",
    sourceLabel: "Markdown",
    contentType: "text/markdown; charset=utf-8",
    maxSourceBytes: LIMITS.maxDocBytes,
    reservedPaths: ["index.html", "content.md"],
    assetTypes: /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/,
    renderer: { script: "doc.js", style: "doc.css" },
    editor: { language: "markdown", wordWrap: "on" },
  },
};

/** The registry row for a type id, or null for an unknown value (prototype keys included). */
export function typeDef(t: string): ArtifactTypeDef | null {
  return Object.hasOwn(TYPE_REGISTRY, t) ? TYPE_REGISTRY[t as ArtifactType] : null;
}

/** The source field of an artifact detail: html for a page, content for every typed artifact. */
export type ArtifactSource =
  | { type: "html"; html: string }
  | { type: Exclude<ArtifactType, "html">; content: string };

/** The registry row and source text of an artifact detail, whatever its type. */
export function sourceOf(d: ArtifactSource): { def: ArtifactTypeDef; text: string } {
  return d.type === "html"
    ? { def: TYPE_REGISTRY.html, text: d.html }
    : { def: TYPE_REGISTRY[d.type], text: d.content };
}

/** Version of the JSON payload a shell embeds. A breaking content-format change bumps it. */
export const TYPED_PAYLOAD_VERSION = 1;

/** The JSON a typed shell embeds in #__plinth-content for its renderer. */
export interface TypedPayload {
  v: typeof TYPED_PAYLOAD_VERSION;
  type: ArtifactType;
  path: string;
  app_origin: string;
  text: string;
}

const SCRIPT_UNSAFE: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * JSON safe to place inside a <script type="application/json"> block: `<`, `>`, `&`, U+2028 and
 * U+2029 become \uXXXX escapes, so `</script>` or `<!--` in the value cannot end the block. These
 * characters only occur inside JSON strings, where the escapes decode to the same text.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => SCRIPT_UNSAFE[c] ?? c);
}

/**
 * The page that hosts a typed artifact. Pure; used by the Worker (serve) and the editor (preview).
 * `base` is "" at the artifact root or "/__content/<id>" in the path fallback, so renderer URLs
 * resolve from the artifact root at any document path. Throws for a type without a renderer.
 */
export function typedShellHtml(
  def: ArtifactTypeDef,
  o: { title: string; text: string; base: string; appOrigin: string },
): string {
  if (!def.renderer) throw new Error(`Type ${def.id} has no renderer`);
  const dir = `${o.base}/__plinth/types/${def.id}`;
  const payload: TypedPayload = {
    v: TYPED_PAYLOAD_VERSION,
    type: def.id,
    path: def.sourcePath,
    app_origin: o.appOrigin,
    text: o.text,
  };
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<title>${escapeHtml(o.title)}</title>\n` +
    `<link rel="stylesheet" href="${escapeHtml(`${dir}/${def.renderer.style}`)}">\n` +
    "</head><body>\n" +
    `<main id="__plinth-${def.id}" class="plinth-${def.id}" tabindex="-1"></main>\n` +
    `<script type="application/json" id="__plinth-content">${jsonForScript(payload)}</script>\n` +
    `<script src="${escapeHtml(`${dir}/${def.renderer.script}`)}"></script>\n` +
    "</body></html>"
  );
}

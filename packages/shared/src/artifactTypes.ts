// Artifact types. A type is a fixed Plinth renderer plus a content format: an artifact made from a
// type stores a content file (a doc stores content.md) instead of hand-written HTML, and the
// content host serves a fixed shell page that loads the renderer from the artifact's own origin
// under /__plinth/types/<id>/. This one table drives validation, storage paths, wire fields,
// serving, the shell, the editor, the diff label and the dashboard badge.
//
// Each type is its own module, artifactTypes/<id>.ts. Adding a type is that module,
// one line in ARTIFACT_TYPES, one line in TYPE_REGISTRY, its Worker hooks
// (apps/worker/src/services/artifactTypes/<id>.ts) and, for a type with a renderer, a renderer
// directory (apps/web/src/renderers/<id>/main.ts); no wire change.
import { design } from "./artifactTypes/design.ts";
import { designSystem } from "./artifactTypes/design_system.ts";
import { doc } from "./artifactTypes/doc.ts";
import { html } from "./artifactTypes/html.ts";
import { sheet } from "./artifactTypes/sheet.ts";
import { slides } from "./artifactTypes/slides.ts";
import { whiteboard } from "./artifactTypes/whiteboard.ts";
import { escapeHtml } from "./markdown.ts";
import { isHtmlDeckIndex } from "./slidesHtml.ts";

/** Every type, in registry order. */
// biome-ignore format: one type per line, so each type adds its own line
export const ARTIFACT_TYPES = [
  "html",
  "doc",
  "slides",
  "design_system",
  "design",
  "sheet",
  "whiteboard",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The languages the source editor holds. The web app has a Monaco setup for each one. */
export type EditorLanguage = "html" | "markdown" | "json";

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
  /**
   * A second source file a version may hold instead of sourcePath, in another format: an HTML
   * deck's deck.json beside a Markdown deck's slides.md (docs/spec.md "Slides"). Its text is a JSON
   * object, which is how a sent source says it is this one (sourcePathForText); a stored version
   * says it by the file it holds (versionSourcePath). The source field carries either. Absent: the
   * type has one source file. Both paths are among reservedPaths.
   */
  altSource?: { path: string; contentType: string; label: string };
  /** Paths an asset may not use. */
  reservedPaths: readonly string[];
  /** Allowed asset content types, or null for any. */
  assetTypes: RegExp | null;
  /**
   * Renderer files under /__plinth/types/<id>/, or null for a type served as-is. `frame` names a
   * fixed Plinth page the renderer frames, at /__plinth/frames/<id>/ (a design's board loader,
   * content/boardLoader.ts; a deck's embed loader, content/embedLoader.ts): the content host
   * serves it only behind the content pass, never from the web build.
   */
  renderer: RendererFiles | null;
  /**
   * The source editor's settings, or null for a type people never see the source of (a sheet or a design):
   * the app then offers no Edit and no source diff, and agents change it.
   */
  editor: { language: EditorLanguage; wordWrap: "on" | "off" } | null;
  /**
   * How people change it in the app. "live": owners and editors edit it on its rendered page, live
   * with each other (#36; isLiveType). Only types whose page is Plinth's own renderer: page scripts
   * in an HTML artifact could forge edits. "ask": people ask an agent in a comment, or use the
   * source editor; its page has no editor of its own. "board": the page is always live through shared data (a
   * whiteboard), and its settings are an app dialog.
   */
  edit: "live" | "ask" | "board";
  /**
   * "New" on the dashboard offers this type blank (docs/spec.md "New and Import"): the label in the
   * menu, and the title and starter content of the placeholder v1 it publishes before the page
   * opens in edit mode. Absent: only agents create it (HTML pages and designs always). Only a live
   * type has one, since a blank artifact is useful only where people can fill it on the page.
   */
  create?: CreateRow;
  /**
   * What agent-facing texts call one artifact of the type ("this deck", "a sheet, deck or design
   * system"), when it is not its badge in lower case. Absent: the badge (or the label).
   */
  noun?: string;
  /**
   * The viewer offers Present and Presenter view, and review mode and the editor preview show
   * every page stacked (payload `view: "overview"`). Absent means false.
   */
  present?: boolean;
  /**
   * The type's page shows author HTML only in nested frames with an opaque origin in every
   * isolation mode (a design's artboards). Its files are then served with
   * Cross-Origin-Resource-Policy: cross-origin, the publish scan reads its references as opaque
   * isolation would, and the content host serves its renderer.frame. Absent means false.
   */
  opaqueFrames?: boolean;
  /**
   * Owners and editors may lead identified viewers through the deck over the room's own `slides`
   * channel (follow the presenter): the shell's payload gets `follow`. Only types whose page is
   * Plinth's own renderer, whose frame can be trusted to send only slide numbers. Absent means
   * false.
   */
  follow?: boolean;
  /**
   * Files the viewer can download, each built inside the frame by the renderer from what it shows
   * (a deck's .pptx). Absent means none. Print and PDF are not listed: every renderer prints.
   */
  fileExports?: readonly FileExport[];
  /**
   * Where versions.capabilities comes from for a type with a renderer: "fixed", derived by the
   * server from the version's source (a whiteboard's settings), never declared by a page. Absent
   * for every other type: an HTML page declares its own (pageDataOf), a doc or a deck has none.
   * Policy fails closed on fixed capabilities (policy.ts pageWriteFloor).
   */
  pageData?: "fixed";
  /** False: the type takes no files besides its source. Absent means it takes assets. */
  assets?: false;
  /** False: no bundle upload (start_upload); the source goes inline. Absent means allowed. */
  upload?: false;
  /**
   * "settings": a version holds only the artifact's settings, not what people see on it (a
   * whiteboard, whose board is shared data), so the history offers "Restore settings" and says a
   * restore leaves the rest as it is. Absent: a version holds the whole artifact.
   */
  versions?: "settings";
}

/**
 * Where a type's versions.capabilities comes from: "declared" by the page itself (an HTML page,
 * served as-is), "fixed" by the server (pageData), or "none".
 */
export function pageDataOf(def: ArtifactTypeDef): "declared" | "fixed" | "none" {
  if (def.renderer === null) return "declared";
  return def.pageData === "fixed" ? "fixed" : "none";
}

/**
 * Whether the type's page uses the page runtime's shared data and `page` room with its version's
 * capabilities: a page that declares them, or a type whose capabilities are fixed. False for an
 * unknown type.
 */
export function hasPageCapabilities(def: ArtifactTypeDef | null): boolean {
  return def !== null && pageDataOf(def) !== "none";
}

/** What "New" publishes for a type people start in the app (ArtifactTypeDef.create). */
export interface CreateRow {
  /** The menu item ("Document"). */
  label: string;
  /** The new artifact's title ("Untitled document"). */
  title: string;
  /** v1's source, which the type's publish hook accepts as it is (a version is never empty). */
  content: string;
}

/**
 * The types "New" offers blank, in registry order: every type with a create row that people edit on
 * the page. Whether this instance offers them at all (inline editing on, the type available) is the
 * caller's to check.
 */
export function creatableTypes(): (ArtifactTypeDef & { create: CreateRow })[] {
  return ARTIFACT_TYPES.map((t): ArtifactTypeDef => TYPE_REGISTRY[t]).filter(
    (d): d is ArtifactTypeDef & { create: CreateRow } => d.create !== undefined && isLiveType(d),
  );
}

/** A file a renderer builds in the frame for the viewer to download. */
export type FileExport = "pptx";

/** A renderer's files: one script and one style, plus scripts it loads only when needed. */
export interface RendererFiles {
  script: string;
  style: string;
  /** A fixed Plinth page the renderer frames (see ArtifactTypeDef.renderer). */
  frame?: string;
  /**
   * Scripts the renderer adds to its own page only when someone uses a feature that needs them
   * (a deck's .pptx writer), so the first view never downloads them. Each is built from `entry`
   * (a file in the renderer's directory) as its own IIFE with no exports and no globals, and
   * served at /__plinth/types/<id>/<file> under the same guard as the script.
   */
  lazy?: readonly { file: string; entry: string }[];
  /**
   * The shell loads the page runtime (/__plinth/runtime.js) right before the renderer: a type whose
   * page uses shared data and the live room (pageData "fixed").
   */
  runtime?: true;
}

/** A type module's row: an ArtifactTypeDef whose id is that module's own type. */
export type TypeModule<K extends ArtifactType> = ArtifactTypeDef & { readonly id: K };

/** Every type's row, keyed by its id, in ARTIFACT_TYPES order. One type per line. */
export const TYPE_REGISTRY: { readonly [K in ArtifactType]: TypeModule<K> } = {
  html,
  doc,
  slides,
  design_system: designSystem,
  design,
  sheet,
  whiteboard,
};

/**
 * The files a type's renderer is made of (its script, its style and its lazy scripts), each with
 * the only Content-Type it may be served as.
 * The web build emits exactly these (apps/web/build/renderers.ts) and the content host serves
 * only these (content/typed.ts serveRendererFile). Empty for a type without a renderer.
 */
export function rendererFiles(
  def: ArtifactTypeDef,
): readonly { name: string; contentType: "text/javascript" | "text/css" }[] {
  if (!def.renderer) return [];
  return [
    { name: def.renderer.script, contentType: "text/javascript" },
    { name: def.renderer.style, contentType: "text/css" },
    ...(def.renderer.lazy ?? []).map((l) => ({
      name: l.file,
      contentType: "text/javascript" as const,
    })),
  ];
}

/** Where the web build puts renderer files, and where the Worker reads them from ASSETS. */
export const RENDERERS_DIR = "__plinth-renderers";

/** Whether people edit the type on its page (its registry row has `edit: "live"`). */
export function isLiveType(def: Pick<ArtifactTypeDef, "edit"> | null | undefined): boolean {
  return def?.edit === "live";
}

/**
 * Whether people edit a version stored with this source file on its page: a live type's own
 * format only. An HTML deck (a deck whose source is its altSource, deck.json) is changed by
 * agents, as before decks were edited on the page.
 */
export function isLiveSource(
  def: Pick<ArtifactTypeDef, "edit" | "altSource"> | null | undefined,
  sourcePath: string,
): boolean {
  return isLiveType(def) && sourcePath !== def?.altSource?.path;
}

/**
 * A whole HTML document sent where Markdown or another typed format belongs. The publish hooks of
 * the typed types refuse a source that matches it, and the live rules (liveTypes.ts) refuse a page
 * edit whose result would, so a draft is always one a Publish can save. (`[ ]` is one space, so the
 * renderer bundles that carry this rule hold no "<!doctype html" text of their own.)
 */
export const HTML_DOCUMENT_RE = /^\s*(<!doctype[ ]html|<html[\s>])/i;

/**
 * Where a sent source is stored: the type's altSource when it has one and the text is a JSON object
 * (an HTML deck's deck.json), else its sourcePath.
 */
export function sourcePathForText(def: ArtifactTypeDef, text: string | Uint8Array): string {
  if (!def.altSource) return def.sourcePath;
  let head: string;
  if (typeof text === "string") head = text.slice(0, 64);
  else {
    // The first bytes as ASCII, a UTF-8 byte order mark skipped: all isHtmlDeckIndex looks at.
    let k = text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf ? 3 : 0;
    head = "";
    for (; k < text.length && head.length < 64; k++) head += String.fromCharCode(text[k] as number);
  }
  return isHtmlDeckIndex(head) ? def.altSource.path : def.sourcePath;
}

/**
 * The source file of a stored version, from the paths it holds: the type's altSource when the
 * version holds that file and not sourcePath, else sourcePath.
 */
export function versionSourcePath(
  def: ArtifactTypeDef,
  paths: { has(path: string): boolean } | readonly { path: string }[],
): string {
  if (!def.altSource) return def.sourcePath;
  const has = (p: string) =>
    "has" in paths && typeof paths.has === "function"
      ? paths.has(p)
      : (paths as readonly { path: string }[]).some((e) => e.path === p);
  return !has(def.sourcePath) && has(def.altSource.path) ? def.altSource.path : def.sourcePath;
}

/** The stored Content-Type and the name of a type's source file at `path`. */
export function sourceFileOf(
  def: ArtifactTypeDef,
  path: string,
): { contentType: string; label: string } {
  return def.altSource && path === def.altSource.path
    ? { contentType: def.altSource.contentType, label: def.altSource.label }
    : { contentType: def.contentType, label: def.sourceLabel };
}

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
  /**
   * Set only for an owner or editor on the current version while rooms are active: the renderer
   * connects the doc socket (#36). Absent otherwise, so every other shell is unchanged.
   */
  live?: "room";
  /**
   * Set for a type with `present` in review mode (?plinth-review) and the editor preview: the
   * renderer shows every slide stacked. Absent otherwise, so every other shell is unchanged.
   */
  view?: "overview";
  /**
   * The version number this shell shows, set only for a type with opaque frames (a design): its
   * boards load their files from /__plinth/v/<version>/, never from the current version, which a
   * later publish replaces. Absent otherwise, so every other shell is unchanged.
   */
  version?: number;
  /**
   * Set only for a type with `follow`, for an identified viewer on the current version while rooms
   * and following are active: the renderer opens the `slides` socket, as a presenter (`present`,
   * owners and editors) or to follow one (`watch`). Absent otherwise, so every other shell is
   * unchanged.
   */
  follow?: "present" | "watch";
  /**
   * An HTML deck's deck.css and slide files (slides/<id>.html), by path, set only when `path` is
   * the type's altSource (deck.json, whose text is `text`). Absent otherwise, so every other shell
   * is unchanged.
   */
  files?: Record<string, string>;
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
 * The script policy of every typed shell: only the renderer, from the artifact's own origin. The
 * content host sends it in the shell's CSP header (contentCsp with scripts: "self"), and the shell
 * repeats it in a <meta http-equiv> CSP as the first element of <head>. A meta policy is enforced
 * on top of the header and also binds a document written with document.write, so the editor
 * preview (the preview loader writes this shell into a page served with the default content CSP)
 * runs under the same script restriction as the published page.
 */
export const TYPED_SHELL_SCRIPT_SRC = "script-src 'self'";

/**
 * The page that hosts a typed artifact. Pure; used by the Worker (serve) and the editor (preview).
 * `base` is "" at the artifact root or "/__content/<id>" in the path fallback, so renderer URLs
 * resolve from the artifact root at any document path. Throws for a type without a renderer.
 */
export function typedShellHtml(
  def: ArtifactTypeDef,
  o: {
    title: string;
    text: string;
    base: string;
    appOrigin: string;
    live?: "room";
    view?: "overview";
    version?: number;
    follow?: "present" | "watch";
    /** The stored source's path, when it is the type's altSource (an HTML deck's deck.json). */
    path?: string;
    /** An HTML deck's other text files, by path (TypedPayload.files). */
    files?: Record<string, string>;
  },
): string {
  if (!def.renderer) throw new Error(`Type ${def.id} has no renderer`);
  const dir = `${o.base}/__plinth/types/${def.id}`;
  const alt = def.altSource && o.path === def.altSource.path;
  const payload: TypedPayload = {
    v: TYPED_PAYLOAD_VERSION,
    type: def.id,
    path: alt && def.altSource ? def.altSource.path : def.sourcePath,
    app_origin: o.appOrigin,
    text: o.text,
    ...(o.live ? { live: o.live } : {}),
    ...(o.view ? { view: o.view } : {}),
    ...(o.version !== undefined ? { version: o.version } : {}),
    ...(o.follow ? { follow: o.follow } : {}),
    ...(alt && o.files ? { files: o.files } : {}),
  };
  // The page runtime, right before the renderer, for a type whose page uses it (renderer.runtime).
  const runtime = def.renderer.runtime
    ? `<script src="${escapeHtml(`${o.base}/__plinth/runtime.js`)}"></script>\n`
    : "";
  return (
    '<!doctype html><html lang="en"><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${TYPED_SHELL_SCRIPT_SRC}">` +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<title>${escapeHtml(o.title)}</title>\n` +
    `<link rel="stylesheet" href="${escapeHtml(`${dir}/${def.renderer.style}`)}">\n` +
    "</head><body>\n" +
    `<main id="__plinth-${def.id}" class="plinth-${def.id}" tabindex="-1"></main>\n` +
    `<script type="application/json" id="__plinth-content">${jsonForScript(payload)}</script>\n` +
    runtime +
    `<script src="${escapeHtml(`${dir}/${def.renderer.script}`)}"></script>\n` +
    "</body></html>"
  );
}

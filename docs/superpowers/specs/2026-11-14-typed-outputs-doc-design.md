# Typed outputs, slice 1: the `doc` type

Date: 2026-11-14. Status: design for issue #2 ("Typed outputs: decks, docs and sheets"), scope set
by the lead (first type `doc`; decks and sheets later). Every product choice below is recorded as
a **Review** row in DECISIONS.md when it is implemented.

## Intent

docs/spec.md (Typed outputs, roadmap item 9): "a type is a renderer page plus a content format, and
an artifact made from a type stores content files instead of hand-written HTML". This slice ships
the first type, a Markdown document, and a type registry that decks and sheets join later without
rework. An agent that writes a memo, plan, spec or notes sends Markdown; Plinth turns it into a
finished, readable, printable page.

## Goals

1. `publish_artifact` / `update_artifact` (MCP and REST) accept `type: "doc"` and `content`
   (Markdown). HTML artifacts and existing clients are unchanged.
2. A good doc: comfortable reading typography, headings with anchors, tables, code blocks, images
   from the artifact's own files, light and dark, phone width, a print stylesheet that makes
   browser Print to PDF look right.
3. Markdown renders safely: no raw HTML, dangerous URLs dropped, links open in a new tab.
4. Versions, `base_version`, conflicts and restore work as for HTML. The editor edits Markdown with
   a live preview; history diffs `content.md`; the dashboard shows the type.
5. The skill teaches agents when to pick a doc over hand-written HTML.

## Non-goals (this slice)

- Decks and sheets (the registry is ready for them).
- .docx, .pptx or server-side PDF export. Browser Print to PDF only.
- Converting an artifact between html and doc.
- Syntax highlighting, math, Mermaid, footnotes, task lists, table of contents, front matter.
- A "New doc" button in the web app; image upload in the web editor.
- Raw HTML inside Markdown, in any form.

## Anti-goals

- Loosening the content CSP or the CDN allowlist, or adding a CDN or font host for the renderer.
- Rendering user Markdown on the app host, or putting renderer code there.
- Per-artifact server code. The shell is a fixed Plinth template; the renderer is fixed Plinth JS.

## Designs considered

Three designs were written independently and scored (1 = weak, 5 = strong).

| Design | Safety | Simplicity | Fit with code | Agent experience | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1. Render at version creation: the Worker runs markdown-it on publish and stores the result as the version's `index.html` | 4 | 5 | 4 | 4 | Not chosen. It contradicts the lead's scope decision (a fixed renderer served from `/__plinth/`), adds Worker CPU at publish time (a 1 MB doc can exceed the free tier's 10 ms), doubles storage, and freezes renderer bugs into immutable versions |
| 2. Agent experience first: serve-time shell, renderer bundle, type stored per version so an update can switch types, strict CSP for the shell | 5 | 3 | 4 | 5 | Grafted from: the strict shell CSP, fix-it errors, the HTML-in-`content` check, synchronous render, the skill text |
| 3. Registry-driven app: serve-time shell with embedded content, renderer bundle from the web build, type fixed per artifact, DOM allowlist pass, SPA-fallback guard | 5 | 4 | 5 | 4 | **Base** |

Contradictions, resolved:

- **When to render.** Design 1 renders at publish; 2 and 3 at view time in the browser. Chosen: view
  time, as the lead decided. No Worker CPU beyond embedding, renderer fixes reach old versions, and
  a version stores only what the author wrote. Design 1's real strength (no client JS on the page)
  is matched by the strict shell CSP and the sanitizer pass.
- **Type per artifact or per version.** Design 2 stores it per version so an update can switch. Chosen:
  per artifact, fixed at publish (designs 1 and 3). Simpler (no list join, no cross-type diffs or
  conflicts), and a switch is a rare request an agent can meet with a new artifact after asking.
- **Inline content only under opaque, or always.** Chosen: always (2 and 3). One code path, no
  fetch, no loading state, no failure when the content cookie expires mid-load, and the editor
  preview is byte-for-byte the published shell. Satisfies the lead's opaque requirement as a special
  case.
- **CSP for the shell.** Design 3 keeps `contentCsp`; Design 2 narrows it. Chosen: narrower
  (`script-src 'self'`, no `unsafe-inline`/`unsafe-eval`/CDN). Strictly tighter, so no rule is
  weakened; injected inline script or handlers cannot run even if the sanitizer fails.
- **`get_artifact` shape.** Design 3 returns `html: null`; 1 and 2 omit `html`. Chosen: omit `html`
  for a doc and return `content` plus `source_path`. Cleaner union type, fewer tokens, nothing
  tempts an agent to send `html` to a doc.
- **Renderer build.** Design 2 chains a second `vite build`; Design 3 uses a plugin that runs a nested
  library build. Chosen: the plugin, because `vite build --watch` (`pnpm dev`) empties `dist` and
  would wipe a separately built bundle, and the renderer must never share chunks with the SPA.
- **Renderer files on the app host.** Chosen: 404 there (Design 3). The renderer is only ever needed on
  content origins.
- **Draft storage field.** Design 3 renames `html` to `text`. Chosen: keep the stored shape. Drafts are
  keyed by artifact id and the type never changes, so no migration of open tabs is needed.

## Design

### Type registry (`packages/shared/src/artifactTypes.ts`)

One table drives validation, storage paths, wire fields, serving, the shell, the editor, the diff
label and the dashboard badge.

```ts
export const ARTIFACT_TYPES = ["html", "doc"] as const;   // later: "deck", "sheet"
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactTypeDef {
  id: ArtifactType;
  label: string;            // "HTML page" | "Document"
  badge: string | null;     // null | "Doc"  (dashboard)
  sourcePath: string;       // "index.html" | "content.md"   (later slides.md, sheet.csv)
  sourceField: "html" | "content";
  sourceLabel: string;      // "HTML" | "Markdown"
  contentType: string;      // "text/html; charset=utf-8" | "text/markdown; charset=utf-8"
  maxSourceBytes: number;   // LIMITS.maxHtmlBytes (5 MB) | LIMITS.maxDocBytes (1 MB)
  reservedPaths: readonly string[];          // ["index.html"] | ["index.html", "content.md"]
  assetTypes: RegExp | null;                 // null = any | /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/
  renderer: null | { script: string; style: string };  // null | { "doc.js", "doc.css" }
  editor: { language: "html" | "markdown"; wordWrap: "on" | "off" };
}
export const TYPE_REGISTRY: Record<ArtifactType, ArtifactTypeDef>;
export function typeDef(t: string): ArtifactTypeDef | null;  // null for an unknown value

/** The page that hosts a typed artifact. Pure; used by the Worker (serve) and the editor (preview). */
export function typedShellHtml(def: ArtifactTypeDef, o: {
  title: string; text: string; base: string /* "" or "/__content/<id>" */; appOrigin: string;
}): string;
export function jsonForScript(value: unknown): string; // JSON.stringify, then < > & U+2028 U+2029 as \uXXXX
```

`LIMITS.maxDocBytes = 1 * MB` and `RENDERER_MESSAGE_SOURCE = "plinth-renderer"` go in
`constants.ts`.

Adding a deck later: an `ARTIFACT_TYPES` entry, a registry row, a renderer directory under
`apps/web/src/renderers/deck/`, a skill section. No migration, no service, protocol or wire change.
A breaking content-format change gets a payload `v` bump or a new type id.

### The shell

```html
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{escapeHtml(title)}</title>
<link rel="stylesheet" href="{base}/__plinth/types/doc/doc.css">
</head><body>
<main id="__plinth-doc" class="plinth-doc" tabindex="-1"></main>
<script type="application/json" id="__plinth-content">{payload}</script>
<script src="{base}/__plinth/types/doc/doc.js"></script>
</body></html>
```

- `payload = jsonForScript({ v: 1, type: "doc", path: "content.md", app_origin, text })`. Escaping
  `<` and `>` means `</script>` or `<!--` in the Markdown cannot leave the data block.
- The ids start with `__`, which the heading slugger never produces, so headings cannot clobber them.
- Renderer URLs are absolute from the artifact root via `base`, so they work at `/`, at
  `/__plinth/v/<n>/` and in the path fallback. Relative image paths resolve against the document,
  so a version URL shows that version's images.
- The renderer script runs synchronously at the end of `<body>`, so the comments bridge (which waits
  for DOMContentLoaded) sees the rendered DOM and pins work on docs.

### Data model

`migrations/0004_typed_artifacts.sql`:

```sql
-- Typed artifacts (docs/spec.md, Typed outputs). 'html': index.html is the hand-written page.
-- 'doc': content.md is Markdown, served inside Plinth's fixed renderer. Fixed at publish.
-- No CHECK constraint: SQLite cannot change one in place, and deck or sheet must not need a table
-- rebuild. The Worker validates the value against the type registry.
ALTER TABLE artifacts ADD COLUMN type TEXT NOT NULL DEFAULT 'html';
```

- Drizzle: `type: text("type").$type<ArtifactType>().notNull().default("html")`.
- `versions` and the R2 layout are unchanged. A doc version's manifest lists `content.md` and its
  images, and no `index.html` (the shell is virtual). Quota counts `content.md` like `index.html`.
- Restore copies the old version's files as today; nothing type-specific.

### Wire shapes (`packages/shared/src/schemas.ts`, `types.ts`)

Schemas stay flat `z.object`s (MCP input schemas must be a top-level object; openapi `fromZod`
keeps working). Cross-field rules live in one service function so MCP and REST give identical
errors.

- `publishArtifactInput`: `type: z.enum(ARTIFACT_TYPES).default("html")`, `html` becomes optional,
  `content: z.string().min(1).optional()`. Rest unchanged.
- `updateArtifactInput`: `html` optional, `content` optional. No `type`: it is fixed.
- `ArtifactSummary.type`, `PublishResult.type`, `ViewArtifact.type`.
- `ArtifactDetail = ArtifactSummary & { version; assets; source_path } & ({ type: "html"; html } |
  { type: "doc"; content })`. HTML artifacts return what they return today plus `type` and
  `source_path: "index.html"`. `assets` never lists a reserved path.
- `sourceOf(detail) -> { def, text }` in shared, used by every web caller that read `.html`.

Service rules (`apps/worker/src/services/artifactTypes.ts`, `resolveSource`), all `invalid_input`
with `details: { type, field }` unless noted:

| Call | Result |
| --- | --- |
| publish with `html`, no `type` | html artifact, exactly as today |
| publish `type: "doc"` + `content` | doc artifact |
| publish `type: "doc"` without `content` | "type doc needs its Markdown in content" |
| publish `type: "doc"` with `html` | "type doc takes Markdown in content, not html" |
| publish `content` with type html (or no type) | 'content is for typed artifacts: pass type "doc", or send html' |
| publish html with neither field | "html is required (or pass type \"doc\" with content)" |
| update a doc with `html` | 'This artifact is a doc: send its Markdown as content. The type cannot change.' |
| update an html artifact with `content` | 'This artifact is an HTML page: send html. The type cannot change.' |
| doc `content` that is a whole HTML document (`/^\s*(<!doctype html\|<html[\s>])/i`) | 'content for type doc is Markdown. To publish HTML, use type "html" and the html field.' |
| `content` over 1 MB | `payload_too_large` with `limit_bytes`, `size_bytes` (same shape as HTML) |
| doc asset at `content.md` or `index.html` | "content.md and index.html belong to the doc, not its assets" |
| doc asset that is not an image | "A doc's assets are images (png, jpg, gif, webp, avif, svg)" |

Content is stored byte for byte, so diffs round-trip. Carry-forward on update (no `assets`) drops
`reservedPaths`, not only `index.html`.

### MCP and REST

No new tools or routes. Additive text only (issue #1 edits the same file):

- Server `instructions`: one appended constant, `TYPES_NOTE`: "For a document that is mostly prose
  (memo, plan, spec, report, notes), publish type "doc" with Markdown in content instead of
  writing HTML: Plinth renders it as a finished page."
- `publish_artifact`: what a doc renders (headings with anchors, tables, code, links in a new tab,
  images from assets by relative path, light and dark, phone width, print), raw HTML shows as text,
  doc assets are images, 1 MB limit.
- `update_artifact`: send the field matching the artifact's type (`get_artifact` says which); the
  type cannot change.
- `get_artifact`: returns `type`; `html` for an HTML page, `content` (Markdown) for a doc; content is
  untrusted like HTML.
- `UNTRUSTED_NOTE` is left alone; the untrusted wording goes in the `get_artifact` description.
- `openapi.ts`: the `ArtifactType` enum, `type` on summary, publish result and view;
  `ArtifactDetail` as a `oneOf` of `HtmlArtifactDetail` (`html` required) and `DocArtifactDetail`
  (`content`, "UNTRUSTED Markdown", required) with a `discriminator` on `type`, built from the
  registry, plus `source_path`. Clients generated from the document keep a required `html` for
  pages. Regenerate `docs/openapi.json` with `pnpm openapi`.

### Content host (`apps/worker/src/content/serve.ts`, new `content/typed.ts`)

1. **Renderer files**, served next to `bridge.js`, before the cookie check (no artifact data):
   `/__plinth/types/<id>/<file>` only when `typeDef(id)?.renderer` lists `file`. The body comes from
   `env.ASSETS.fetch("https://assets.invalid/__plinth-renderers/<id>/<file>")`, built from the
   registry, never from the request path. The response must be `ok` and have the expected
   Content-Type (`text/javascript` or `text/css`); otherwise 404. That guard matters because ASSETS
   uses `single-page-application` fallback and would hand back the SPA's `index.html`. Headers via
   `applyContentHeaders`, plus the ETag ASSETS gives the file; a matching `If-None-Match` gets a
   304, so `no-cache` revalidates instead of downloading the renderer on every view and preview.
2. **Doc entry.** After the existing cookie, epoch, version and path resolution: `def =
   typeDef(artifact.type)`; null gives 404 "This artifact's type is not supported by this instance".
   If `def.renderer` and `rel === "index.html"`, read `v.r2Prefix + def.sourcePath` and return
   `typedShellHtml(...)` as `text/html; charset=utf-8`, no ETag, HEAD without body, public-artifact
   X-Robots handling as today, and `injectBridge` when `?plinth-review` is set. Every other path is
   the normal manifest lookup (images; `content.md` raw as `text/markdown` with nosniff).
3. **CSP.** `contentCsp(config, { scripts: "self" })` for the shell only: `script-src 'self'` and
   nothing else in that directive; every other directive identical, including `OPAQUE_SANDBOX`.
   The shell repeats `script-src 'self'` in a `<meta http-equiv="Content-Security-Policy">` as the
   first element of `<head>`, so the editor preview (written into the loader page, which is served
   with the default content CSP) runs under the same script policy. A doc's other files
   (`content.md`, images) get `contentCsp(config, { scripts: "none" })`, so an SVG image opened as
   a document runs no script. Renderer files and errors keep `contentCsp(config)` unchanged.
4. **App host.** `apps/worker/src/app/spa.ts` returns 404 for `/__plinth-renderers/*`.

Opaque isolation needs nothing extra: the content is in the shell, the renderer and stylesheet are
cookie-less subresources with CORP `cross-origin`, images carry the partitioned content cookie as
today, and the CSP `sandbox` applies to the shell.

### The renderer (`apps/web/src/renderers/doc/`)

- `markdown.ts`: markdown-it **15.0.3** (exact pin; ships its own types; released 2026-10-16, so it
  meets the week-old rule. If its plugin API differs from what is below, fall back to 14.3.3 with
  `@types/markdown-it` 14.2.0), `{ html: false, linkify: true, typographer: false, breaks: false }`.
  Tables and strikethrough are built in; no plugins.
  - **No raw HTML.** `html: false` escapes every tag, so `<script>`, `<iframe>`, `<img onerror>`
    and comments show as text.
  - **URL allowlist** (replaces `validateLink`, checked on the normalized URL, lowercased, with
    control characters and whitespace stripped; any control character in the destination rejects
    it). Links: `http:`, `https:`, `mailto:`, `#fragment`, scheme-less relative paths (not `//`, no
    backslash). Images: scheme-less relative paths and `data:image/(png|jpeg|gif|webp|avif);base64,`.
    A rejected link renders as its text.
  - **External images** (`http(s)`, which the CSP would block) render as a link labelled with the
    alt text plus "↗", opening in a new tab.
  - **Links** get `target="_blank" rel="noopener noreferrer nofollow"`, except `#` links.
  - **Headings** h1 to h4 get slug ids (lowercase Unicode letters and digits, `-` runs, fallback
    `section`, duplicates `-1`, `-2`) and a trailing `<a class="plinth-doc__anchor" href="#id"
    aria-label="Link to this section">#</a>`.
  - **Tables** wrapped in `<div class="plinth-doc__table" role="region" tabindex="0">` so they scroll
    sideways on phones; alignment becomes a class (`plinth-doc__align-center`), not a style.
  - **Code** fences render `<pre tabindex="0"><code class="language-x">`, no highlighting.
- `sanitize.ts`: a second pass over the parsed output (in a `<template>`) before insertion. Tags:
  `p h1-h6 a strong em del code pre blockquote ul ol li hr br table thead tbody tr th td img div
  span`. Attributes: `id`, `class` (prefixes `plinth-doc__` and `language-` only), `href`, `target`,
  `rel`, `src`, `alt`, `title`, `start` on `ol`, `aria-label`, `role`, `tabindex`, `loading`,
  `decoding`. No `style`, no handlers; `href`/`src` re-checked by the URL rule.
- `main.ts` (IIFE entry): reads `#__plinth-content` (`JSON.parse`, `v === 1`, `type === "doc"`),
  renders into `#__plinth-doc`, sets `data-ready` on `<html>` (e2e), shows "This document could not
  be shown" on a bad payload. Print: Ctrl/Cmd+P inside the frame calls `window.print()` (the frame,
  not the app page), and a message `{ source: "plinth-renderer", v: 1, type: "print" }` is acted on
  only if `event.source === window.parent && event.origin === payload.app_origin`. It reads no
  globals by name, so DOM clobbering by heading ids does nothing. Both frame sandboxes already
  include `allow-modals`.
- `doc.css`: system font stacks (no web fonts); about 68ch measure, 1.0625rem/1.65; clear heading
  scale; blockquote, hr, code, `pre { overflow-x: auto }`, tables with header background and
  `tabular-nums`, `img { max-width: 100%; height: auto }`; tokens on `:root` redefined under
  `prefers-color-scheme: dark`, explicit `body` background; 16px gutter and no horizontal page scroll
  at 360px; `@media print`: white background, black text, anchors hidden, ` (url)` after external
  links, `pre { white-space: pre-wrap }`, `break-inside: avoid` on `pre`, `table`, `img`,
  `blockquote`, `break-after: avoid` on headings, `@page { margin: 18mm 16mm }`.
- **Build:** `apps/web/build/renderers.ts`, a Vite plugin in `vite.config.ts` that, for each registry
  type with a renderer, runs a nested library build (IIFE, minified, dependencies inlined) and emits
  `__plinth-renderers/<id>/<id>.js` and `.css` into the main bundle's output. It runs on every build
  including watch, and renderer code never shares chunks with the SPA. Turbo already makes worker
  tests and e2e depend on `@plinth/web#build`, and the CLI copies `apps/web/dist` wholesale.
- **Edit mode (added later, #36).** Owners and editors can now edit a doc on its rendered page.
  View mode is unchanged; the renderer adds `blocks.ts` (the same Markdown rendered block by block,
  each block through the same sanitizer, line ranges in a `WeakMap`), `live.ts` (the doc socket to
  the artifact's room) and `edit.ts` (a `<textarea>` per opened block), and the protocol above gains
  `edit`, `collect`, `live`, `save` and `draft` messages, still version 1. See `docs/spec.md`
  ("Editing") and the 2026-11-18 rows in `DECISIONS.md`.

### Web app

- `CodeEditor` / `CodeDiff`: `language` and `wordWrap` props from `def.editor`; HTML-only setup
  applies to html only. `monaco.ts` registers the Markdown grammar (no worker needed).
- `EditorWorkspace`: Monaco model path `.../draft.<ext>` from `def.sourcePath`; size check against
  `def.maxSourceBytes`; save body `{ [def.sourceField]: text, note, base_version }`; pane and
  conflict labels from `def.sourceLabel`; the preview passes `typedShellHtml(def, { title, text,
  base, appOrigin })` to the unchanged `PreviewFrame` and preview protocol v2, behind the existing
  debounce. A shell over the loader's 5 MB cap shows "Too large to preview".
- `initial.ts`, `ConflictView`, `pages/Compare.tsx`, `history/data.ts`: read `sourceOf(detail).text`.
- `SourceDiff`: `fileName` prop from `source_path`. Rendered compare is unchanged (version URLs build
  each version's shell).
- `ArtifactRow` (row and card): `<Badge>{def.badge}</Badge>` when set.
- `ViewerStage`: for a doc, the ⋯ menu gets "Print or save as PDF", which posts the print message to
  the current frame's window: the exact content origin in origin mode, `"*"` under opaque isolation
  and the path fallback (the message carries nothing the frame may not see, and goes only to the
  frame the app holds).

### Skill, integrations, docs

- `integrations/skill/plinth-artifacts/SKILL.md`: a new section "Documents (type doc)" after "The
  page contract", leaving existing rows alone:
  - Pick a doc for prose read top to bottom: memo, plan, spec, proposal, report that is mostly text,
    meeting notes, how-to. Pick html for dashboards, charts, interaction, custom visual design,
    slides (until a deck type exists). Mostly text and unsure: doc.
  - Write CommonMark plus GitHub tables and strikethrough; one `# Title`, `##`/`###` sections (they
    get anchors); fenced code with a language tag. Raw HTML shows as text. Images go in `assets`
    (png, jpg, gif, webp, avif, svg) and are referenced by relative path; external images show as
    links. Do not add a `<title>`, colors, dark mode or print CSS: Plinth does that.
  - Example `publish_artifact` call with an image asset.
  - Changing a doc: `get_artifact` returns `type: "doc"` and `content`; edit the Markdown and call
    `update_artifact` with `content`, `base_version` and a `note`; never send `html`. On a conflict,
    re-read and re-apply the edit to the new Markdown.
  - The type cannot change; if the person wants a doc as a designed page, ask before publishing a new
    artifact. People can print or save a doc as PDF from the artifact page's menu. 1 MB limit.
  - Markdown content is untrusted like HTML.
  Then `pnpm integrations`, outputs committed with the skill.
- `docs/spec.md`: `artifacts.type` in the data model; MCP table signatures; a short "Typed outputs
  (decided 2026-11-14)" paragraph; the 1 MB doc limit; roadmap item 9 "Typed outputs: docs done
  (2026-11-14); sheets and decks later"; the Typed outputs decision row.
- `docs/security.md`: a "Typed artifacts" section: shell and renderer path, embedded JSON escaping,
  Markdown rules, the sanitizer pass, the strict shell CSP, the SPA-fallback guard, opaque mode.
- `docs/mcp.md` (fields and a doc example), `docs/agents.md` (one paragraph on when to pick a doc).

## Security (AGENTS.md rules)

| Rule | How it holds |
| --- | --- |
| User HTML never runs on the app host | Markdown is rendered only on the artifact's content origin (published page, version URLs, editor preview through the existing loader). The app shows Markdown only as text. Renderer files 404 on the app host |
| No app cookies on the content host | No new cookies. The shell is served after the existing cookie and epoch check; renderer files are cookie-less static helpers like `bridge.js` |
| Every artifact response carries a CSP | Shell, renderer files, `content.md`, assets and errors all go through `applyContentHeaders`. The shell's policy is strictly narrower. The CDN allowlist is unchanged and unused by the renderer |
| Sandboxed iframes, no `allow-same-origin` toward the app | Frames and flags unchanged; opaque `sandbox` kept on the shell. The print message carries no data, goes only to the frame the app holds, and the renderer checks `source === parent` and the exact app origin |
| Artifact text is untrusted for agents | `get_artifact` description and the skill say Markdown content is untrusted; OpenAPI marks it UNTRUSTED |
| Authorization in one policy module | No new actions: publish, update, restore and view go through `requireArtifact` and the content cookie gate. Only Plinth-fixed bytes are served before the cookie check |
| Tokens and secrets | Untouched. The shell embeds only the public app origin |
| Path traversal | `sourcePath` and renderer file names are registry constants; `ASSET_PATH_RE` unchanged; reserved paths refused for doc assets |

Defense in depth if the Markdown rules have a bug: `html: false`, the URL allowlist, the DOM
allowlist pass, the strict shell CSP, and finally the per-artifact origin, which is exactly where
any editor of an HTML artifact already stands. Invariants hold: versions immutable (the content),
restore publishes old files as the next version, `base_version` conflicts unchanged, no
per-artifact server code.

## Decisions (each becomes a DECISIONS.md row marked **Review**)

1. The first typed output is `doc` (Markdown). Registry in `packages/shared/src/artifactTypes.ts`;
   `artifacts.type` (default `html`, no CHECK) fixed at publish; no conversion between types.
2. Docs render in the browser from a fixed Plinth renderer at `/__plinth/types/doc/` on the
   artifact's origin, not at publish time. Old versions render with the current renderer: the
   content is immutable, the presentation is not.
3. The content is embedded in the shell as escaped JSON in every isolation mode, not only opaque.
4. The doc shell gets `script-src 'self'` (stricter than the artifact default).
5. Markdown dialect: markdown-it 15.0.3, `html: false`, CommonMark plus GFM tables, strikethrough and
   linkify; links http, https, mailto, `#` and relative; images relative or `data:image` raster;
   external images become links; links open in a new tab; h1 to h4 get anchors; a DOM allowlist
   pass after rendering. No highlighting, math, footnotes, task lists or front matter.
6. Limits: 1 MB of Markdown; a doc's assets are images only; `content.md` and `index.html` reserved.
7. Wire format: `type` (default html) and `content` on publish, `content` on update; reads return
   `type`, `source_path` and `content` (no `html`) for a doc; mismatches are refused with fix-it
   messages.
8. The renderer is built by a Vite plugin in the web build into `dist/__plinth-renderers/`, served
   on content hosts from ASSETS with a Content-Type guard, 404 on the app host.
9. Print: "Print or save as PDF" in the artifact page menu plus Ctrl/Cmd+P inside the frame, with a
   print stylesheet. No .docx, .pptx or server-side PDF.
10. Typography: system font stacks, no web fonts; the shell says `lang="en"` (no per-doc language yet).

## Tests

- **Shared:** registry consistency (unique ids and source paths, each `sourcePath` in its own
  `reservedPaths`, html has no renderer); `jsonForScript` round-trips and never emits `<`, `>`,
  U+2028/2029; `typedShellHtml` escapes the title and prefixes `base`; `resolveSource` cases if
  placed in shared, otherwise in the worker.
- **Renderer (happy-dom):** an XSS corpus (raw `<script>`, `<img onerror>`, `[x](javascript:...)`,
  `JaVaScRiPt:`, entity- and tab-obfuscated schemes, `vbscript:`, `data:text/html`, `file:`, `//host`,
  autolinks, reference links, payloads in table cells and image alts, `data:image/svg+xml`); for
  each, walk the output DOM and assert only allowlisted tags and attributes and URLs. Features:
  unique heading ids and anchors, link target/rel (not on `#`), wrapped tables with alignment
  classes, escaped code with a safe language class, linkify, relative and `data:image/png` images
  kept, an `https` image becomes a link. Print: ignores a wrong source, wrong origin or malformed
  message. A 1 MB mixed document renders in well under a second.
- **Worker:** publish a doc over REST and MCP (manifest `content.md` plus images, no `index.html`;
  `type` on summary, detail and list); HTML publish without `type` is unchanged; every row of the
  rules table; update with `content` and `base_version`, stale base gives 409 with
  `current_version`; carry-forward keeps images; restore v1 to v3. Content host with a cookie: `/`
  returns the shell with the strict CSP, embedded payload, escaped title; Markdown containing
  `</script><script>` yields exactly two `<script` tags; `/__plinth/v/1/` serves v1; `/content.md`
  is `text/markdown`; `?plinth-review=1` injects the bridge. Without a cookie: renderer files return
  JS/CSS with content headers; unknown files and types 404; a forced SPA-fallback response is
  refused. App host: `/__plinth-renderers/doc/doc.js` is 404. Opaque: the shell carries the sandbox;
  the path fallback prefixes renderer URLs. An unknown `artifacts.type` returns 404. Existing rows
  read as `html`. `openapi.test.ts` stays current.
- **Web:** a doc opens in the Markdown language with an `.md` model path; save sends `content`, never
  `html`; the preview receives a shell containing the draft; `SourceDiff` labels `content.md`;
  `ArtifactRow` shows the Doc badge only for docs; `ViewerStage` shows Print only for docs and posts
  only to the frame window with the right target origin.
- **E2E** (`e2e/tests/typed-doc.spec.ts`, `PLINTH_E2E_PORT=8831`, opaque server on port + 100): an
  agent publishes a doc over MCP with headings, a table, code, an image asset, a `javascript:` link
  and a raw `<script>` that would set `window.__pwned`; the frame shows the h1 with id and anchor,
  the table, a loaded image, no `__pwned`, no dialog, no `javascript:` href, external links with
  `target=_blank`, and no request to another host. Dark scheme gives a dark background; 360px has no
  horizontal scroll; print media hides anchors; the menu's Print calls the frame's (stubbed) print.
  Editor: type Markdown into Monaco with the per-key delay, the preview updates, save gives v2,
  compare shows the `content.md` diff and both rendered versions, restore v1 gives v3. Conflict: an
  MCP update while the editor is open, then save, shows the conflict view. `opaque.spec.ts` gets a
  case: a doc renders, its image loads, the editor preview works.

## Risks

- Merge friction with issue #1 in `server.ts`, `serve.ts`, SKILL.md, docs/spec.md and DECISIONS.md.
  Edits are additive constants, two small hooks into `content/typed.ts`, and new sections.
- Migration 0004 assumes issue #1 takes 0003; D1 applies migrations by name, so a gap is fine.
- The nested Vite build adds build complexity and must keep working in watch mode and in the CLI
  bundle. Worker tests must fail loudly if the renderer files are missing.
- Print from a sandboxed cross-origin frame differs between browsers (Safari especially); e2e can
  stub `print` but not check PDF output.
- Comment pins on docs depend on the DOM the renderer builds; a renderer change can orphan pins.
- A pathological doc of mostly `<` grows up to 6x when escaped and can exceed the 5 MB preview cap;
  saving still works.
- MCP clients see `html` as optional in the tool schema; the service enforces it with a clear message.

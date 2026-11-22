// The slides type, in two formats. A Markdown deck: slides.md (a line --- between slides,
// packages/shared/src/slides.ts) plus image assets, which owners and editors edit on its page
// (slide text, speaker notes and the deck's settings), live with each other (#36; the slides
// rules in liveTypes.ts). An HTML deck (Claude's slide format, packages/shared/src/slidesHtml.ts):
// deck.json (the source), deck.css and slides/<id>.html, plus images and fonts, which people never
// see the source of and agents change. Both are shown as a deck by Plinth's slides renderer
// (apps/web/src/renderers/slides/), with paging, Present, a presenter view, print to PDF, a .pptx
// download and, where live rooms run, following the presenter.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";
import { HTML_DECK_INDEX, SLIDE_EMBED_FILE } from "../slidesHtml.ts";

export const slides: TypeModule<"slides"> = {
  id: "slides",
  label: "Slides",
  badge: "Slides",
  sourcePath: "slides.md",
  sourceField: "content",
  sourceLabel: "Markdown",
  contentType: "text/markdown; charset=utf-8",
  maxSourceBytes: LIMITS.maxSlidesBytes,
  altSource: {
    path: HTML_DECK_INDEX,
    contentType: "application/json; charset=utf-8",
    label: "deck index (deck.json)",
  },
  reservedPaths: ["index.html", "slides.md", HTML_DECK_INDEX],
  // Images for both formats; an HTML deck's slides, deck.css, fonts and a design system's JSON too.
  // Which file a format may hold where is the version's check (slidesHtml.ts deckFileProblem).
  assetTypes:
    /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|text\/html|text\/css|application\/json|font\/(woff2|woff|ttf|otf))(;|$)/,
  renderer: {
    script: "slides.js",
    style: "slides.css",
    // The .pptx writer (PptxGenJS), loaded only when someone downloads the deck as .pptx.
    lazy: [{ file: "slides-pptx.js", entry: "pptx.ts" }],
    // An HTML deck's live embeds (<x-embed>) run in nested frames of this fixed loader
    // (content/embedLoader.ts), with an opaque origin and no network.
    frame: SLIDE_EMBED_FILE,
  },
  editor: { language: "markdown", wordWrap: "on" },
  edit: "live",
  // "New" on the dashboard: v1 is this one slide, and the page opens in edit mode on its title.
  create: { label: "Slide deck", title: "Untitled deck", content: "# Untitled deck\n" },
  // What the agent-facing texts call one ("People are editing this deck on its page").
  noun: "deck",
  present: true,
  // Owners and editors lead identified viewers over the room's `slides` channel (rooms/slides.ts).
  follow: true,
  fileExports: ["pptx"],
};

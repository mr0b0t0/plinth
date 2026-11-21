// The slides type's Worker hooks, for both formats (docs/spec.md "Slides").
//
// A Markdown deck: slides.md, never a whole HTML document, split into slides by the shared parser
// (packages/shared/src/slides.ts); at least one slide and at most LIMITS.maxSlides. Its title is
// the first "# " heading and its assets are images. Publish warnings name the deck's problems (an
// ignored setting, an empty or a dense slide) and the images its Markdown references that the
// version does not hold.
//
// An HTML deck (Claude's slide format, packages/shared/src/slidesHtml.ts): deck.json is the
// source, with deck.css and slides/<id>.html among the version's files. The source check reads the
// index alone; the version check (validateVersion) reads every slide file, refuses what the
// renderer may not show (script, handlers, frames, URLs, Claude's caps) with each problem's file
// and line, and lists what shows differently as publish warnings. Its title is deck.json's title.
//
// Neither format declares capabilities or has a room, so nothing happens after a commit.
import {
  deckFileProblem,
  deckImagePaths,
  HTML_DECK_CSS,
  HTML_DECK_INDEX,
  htmlDeckIssueSummary,
  htmlDeckTitle,
  isHtmlDeckIndex,
  LIMITS,
  type PublishWarning,
  parseDeck,
  parseHtmlDeck,
  slideIdOfPath,
} from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import { echo } from "../publishCheck.ts";
import { docHooks, markdownTitle } from "./doc.ts";

/** The deck's own problems and its missing images, as publish warnings on slides.md. */
export function deckWarnings(
  file: string,
  text: string,
  manifestPaths: ReadonlySet<string>,
): PublishWarning[] {
  const out: PublishWarning[] = parseDeck(text).problems.map((p) => ({
    code: p.code,
    file,
    // The parser already escapes the deck text it quotes; echo() keeps every warning that quotes
    // a caller's file on the same rule.
    message: echo(p.message),
  }));
  for (const path of deckImagePaths(text)) {
    if (manifestPaths.has(path)) continue;
    out.push({
      code: "missing_file",
      file,
      ref: echo(path),
      message: `The deck shows ${echo(path)}, which is not in this version: add it to assets (images only) or fix the path`,
    });
  }
  return out;
}

/** Whether a version path is one of an HTML deck's text files the version check reads. */
export function isDeckTextFile(path: string): boolean {
  return path === HTML_DECK_CSS || slideIdOfPath(path) !== null;
}

export const slidesHooks: TypeHooks = {
  title: (text) => (isHtmlDeckIndex(text) ? htmlDeckTitle(text) : markdownTitle(text)),
  capabilities: () => null,
  validate(def, text) {
    if (isHtmlDeckIndex(text)) {
      // The index alone here; its slides are files of the version, read by validateVersion.
      const r = parseHtmlDeck({ index: text, css: null, slides: new Map() });
      const bad = r.ok
        ? []
        : r.errors.filter((e) => e.file === HTML_DECK_INDEX && !e.message.includes("no slides"));
      if (bad.length > 0) {
        throw new ApiError("invalid_input", echo(htmlDeckIssueSummary(bad)), {
          type: def.id,
          field: "content",
          issues: bad.map((e) => ({ ...e, message: echo(e.message) })),
        });
      }
      return;
    }
    // A whole HTML document is refused as for a doc.
    docHooks.validate?.(def, text);
    const count = parseDeck(text).slides.length;
    if (count === 0) {
      throw new ApiError(
        "invalid_input",
        "The deck has no slides: write Markdown, with a line --- between slides",
        { type: def.id, field: "content" },
      );
    }
    if (count > LIMITS.maxSlides) {
      throw new ApiError(
        "invalid_input",
        `A deck holds at most ${LIMITS.maxSlides} slides; this one has ${count}. Split it into two decks`,
        { type: def.id, field: "content", slides: count, max_slides: LIMITS.maxSlides },
      );
    }
  },
  assetRule:
    "A deck's assets are images (png, jpg, gif, webp, avif, svg); an HTML deck's also slides/<id>.html, deck.css and fonts (woff2, woff, ttf, otf)",
  sourceWarnings: (def, text, manifestPaths) =>
    isHtmlDeckIndex(text) ? [] : deckWarnings(def.sourcePath, text, manifestPaths),
  keepsText: isDeckTextFile,
  async validateVersion(v) {
    const html = v.sourcePath === HTML_DECK_INDEX;
    // Which files each format may hold where (a Markdown deck: images only, as before).
    const misplaced: string[] = [];
    for (const f of v.files) {
      if (f.path === v.sourcePath) continue;
      const problem = deckFileProblem(html ? "html" : "markdown", f.path, f.contentType);
      if (problem) misplaced.push(echo(problem));
    }
    if (misplaced.length > 0) {
      throw new ApiError("invalid_input", misplaced[0] as string, {
        type: "slides",
        field: "assets",
        issues: misplaced.slice(0, 50).map((message) => ({ message })),
      });
    }
    if (!html) return [];
    const slides = new Map<string, string>();
    let css: string | null = null;
    for (const f of v.files) {
      if (!isDeckTextFile(f.path)) continue;
      const text = await v.read(f.path);
      if (text === null) throw new ApiError("internal", `Stored ${f.path} is missing`);
      if (f.path === HTML_DECK_CSS) css = text;
      else slides.set(f.path, text);
    }
    const r = parseHtmlDeck({
      index: v.text,
      css,
      slides,
      paths: new Set(v.files.map((f) => f.path)),
    });
    if (!r.ok) {
      throw new ApiError("invalid_input", echo(htmlDeckIssueSummary(r.errors)), {
        type: "slides",
        field: "content",
        issues: r.errors.map((e) => ({ ...e, message: echo(e.message) })),
        next: 'Fix each file and line in issues and publish again; see the plinth-artifacts skill, "Slides"',
      });
    }
    return r.warnings.map((w) => ({
      code: w.code,
      file: w.file,
      ...(w.ref !== undefined ? { ref: echo(w.ref) } : {}),
      message: echo(
        w.line !== undefined && !w.message.includes("line ")
          ? `Line ${w.line}: ${w.message}`
          : w.message,
      ),
    }));
  },
};

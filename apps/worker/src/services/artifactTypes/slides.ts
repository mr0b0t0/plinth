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
// Neither format declares capabilities. A new version of a Markdown deck people are editing on
// its page freezes their live draft for review (rooms/doc.ts): it is never merged, and the agent
// is told so once, with nothing to do. An HTML deck has no live draft.
import {
  deckFileProblem,
  deckImagePaths,
  HTML_DECK_CSS,
  HTML_DECK_INDEX,
  HTML_DECK_LIMITS,
  htmlDeckIssueSummary,
  htmlDeckTitle,
  isHtmlDeckIndex,
  LIMITS,
  type PublishWarning,
  parseDeck,
  parseHtmlDeck,
  SLIDE_ID_RE,
  slideIdOfPath,
  utf8Bytes,
} from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks, VersionCheck } from "../artifactTypes.ts";
import { echo } from "../publishCheck.ts";
import { docHooks, markdownTitle } from "./doc.ts";
import { liveAfterCommit } from "./live.ts";

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

/** deck.json's order, or null when it has none (or is not a JSON object with a list there). */
function indexOrder(text: string): string[] | null {
  try {
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (typeof raw !== "object" || raw === null || !("order" in raw)) return null;
    const order = (raw as { order: unknown }).order;
    if (!Array.isArray(order)) return null;
    return order.filter((id): id is string => typeof id === "string" && SLIDE_ID_RE.test(id));
  } catch {
    return null;
  }
}

/** Whether a version path is one of an HTML deck's text files the version check reads. */
export function isDeckTextFile(path: string): boolean {
  return path === HTML_DECK_CSS || slideIdOfPath(path) !== null;
}

/**
 * Whether a source is an HTML deck's deck.json: the file it is stored as when known (a stored
 * version's format is its file, so a Markdown deck that starts with "{" stays one), else its text.
 */
function isHtmlSource(text: string, sourcePath?: string): boolean {
  return sourcePath !== undefined ? sourcePath === HTML_DECK_INDEX : isHtmlDeckIndex(text);
}

/** Refuses an HTML deck whose text files break the byte caps, from their sizes alone. */
function checkDeckSizes(v: VersionCheck): void {
  const L = HTML_DECK_LIMITS;
  let total = utf8Bytes(v.text);
  const refuse = (file: string, message: string) => {
    throw new ApiError("invalid_input", `${file} ${message}`, {
      type: "slides",
      field: "content",
      issues: [{ file, message }],
    });
  };
  for (const f of v.files) {
    if (!isDeckTextFile(f.path)) continue;
    const cap = f.path === HTML_DECK_CSS ? L.maxCssBytes : L.maxSlideBytes;
    if (f.size > cap) {
      refuse(
        f.path,
        `is over ${cap / 1024} KB${f.path === HTML_DECK_CSS ? "" : ": split the slide"}`,
      );
    }
    total += f.size;
  }
  if (total > L.maxDeckBytes) {
    refuse(
      HTML_DECK_INDEX,
      `the deck's files hold ${Math.ceil(total / 1024 / 1024)} MB of text; a deck may hold at most ${L.maxDeckBytes / 1024 / 1024} MB: split it`,
    );
  }
}

export const slidesHooks: TypeHooks = {
  title: (text, sourcePath) =>
    isHtmlSource(text, sourcePath) ? htmlDeckTitle(text) : markdownTitle(text),
  capabilities: () => null,
  validate(def, text, sourcePath) {
    if (isHtmlSource(text, sourcePath)) {
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
  sourceWarnings: (def, text, manifestPaths, sourcePath) =>
    isHtmlSource(text, sourcePath) ? [] : deckWarnings(def.sourcePath, text, manifestPaths),
  keepsText: isDeckTextFile,
  afterCommit: liveAfterCommit("deck"),
  carries: (sourcePath, path, contentType) =>
    deckFileProblem(sourcePath === HTML_DECK_INDEX ? "html" : "markdown", path, contentType) ===
    null,
  /**
   * An HTML deck's update that sends assets carries every file of the current version the list
   * leaves out, as if sent as {path, sha256} (Claude keeps a file until it is deleted), except a
   * slide the new order no longer names: leaving it out of order is how a slide is removed. So an
   * agent sends only what changed, and a design system's tokens.json, its CSS and an image no slide
   * uses yet stay. A Markdown deck: nothing (its assets are the list sent).
   */
  async impliedFiles(u) {
    if (u.sourcePath !== HTML_DECK_INDEX) return [];
    // Only a slide the new order leaves out goes; without an order every slide file shows.
    const order = indexOrder(u.text);
    const listed = order === null ? null : new Set(order);
    return [...u.current.keys()].filter((p) => {
      if (u.sent.has(p)) return false;
      const id = slideIdOfPath(p);
      return id === null || listed === null || listed.has(id);
    });
  },
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
    // Sizes first: a file past its cap is refused before any is read.
    checkDeckSizes(v);
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

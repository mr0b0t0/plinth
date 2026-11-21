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
  deckCssFiles,
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

/** At most this many R2 reads at once while working out what an update carries. */
const PARALLEL_READS = 6;

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
  /**
   * An HTML deck's update that sends assets carries, from the current version, every file the new
   * deck needs that the list leaves out, as if sent as {path, sha256}: the slides its order names
   * (every slide file when it has no order), deck.css, and the images, fonts and CSS files those
   * name. So an agent sends only what changed, as on Claude; a slide the new order drops, or a file
   * nothing names, is left out. A Markdown deck: nothing (its assets are the list sent).
   */
  carries: (sourcePath, path, contentType) =>
    deckFileProblem(sourcePath === HTML_DECK_INDEX ? "html" : "markdown", path, contentType) ===
    null,
  async impliedFiles(u) {
    if (u.sourcePath !== HTML_DECK_INDEX) return [];
    const order = indexOrder(u.text);
    const has = (p: string) => u.sent.has(p) || u.current.has(p);
    const want = new Set<string>();
    if (has(HTML_DECK_CSS)) want.add(HTML_DECK_CSS);
    const slidePaths =
      order === null
        ? [...new Set([...u.sent.keys(), ...u.current.keys()])].filter(
            (p) => slideIdOfPath(p) !== null,
          )
        : order.map((id) => `slides/${id}.html`).filter(has);
    for (const p of slidePaths) want.add(p);
    // The texts, to find what they name; a file past its cap is not read (the check refuses it).
    const texts = new Map<string, string>();
    const toRead = [...want].filter((p) => {
      const size = u.sent.get(p)?.size ?? u.current.get(p)?.size ?? 0;
      return (
        size <=
        (p === HTML_DECK_CSS ? HTML_DECK_LIMITS.maxCssBytes : HTML_DECK_LIMITS.maxSlideBytes)
      );
    });
    let next = 0;
    const worker = async () => {
      while (next < toRead.length) {
        const p = toRead[next++] as string;
        const t = await u.read(p);
        if (t !== null) texts.set(p, t);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, toRead.length) }, worker));
    const slides = new Map([...texts].filter(([p]) => p !== HTML_DECK_CSS));
    const r = parseHtmlDeck({ index: u.text, css: texts.get(HTML_DECK_CSS) ?? null, slides });
    if (r.ok) {
      for (const f of r.deck.faces) if (f.src) want.add(f.src);
      for (const ref of deckCssFiles(r.deck.css)) want.add(ref);
      for (const s of r.deck.slides) for (const p of [...s.images, ...s.cssRefs]) want.add(p);
    }
    return [...want].filter((p) => !u.sent.has(p) && u.current.has(p));
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

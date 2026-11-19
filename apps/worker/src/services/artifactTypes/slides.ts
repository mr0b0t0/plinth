// The slides type's Worker hooks: Markdown, never a whole HTML document, split into slides by the
// shared parser (packages/shared/src/slides.ts); at least one slide and at most LIMITS.maxSlides.
// Its title is the first "# " heading, it declares no capabilities and its assets are images.
// Publish warnings name the deck's problems (an ignored setting, an empty or a dense slide) and
// the images its Markdown references that the version does not hold. A deck has no room, so
// nothing happens after a commit.
import { deckImagePaths, LIMITS, type PublishWarning, parseDeck } from "@plinth/shared";
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

export const slidesHooks: TypeHooks = {
  title: markdownTitle,
  capabilities: () => null,
  validate(def, text) {
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
  assetRule: "A deck's assets are images (png, jpg, gif, webp, avif, svg)",
  sourceWarnings: (def, text, manifestPaths) => deckWarnings(def.sourcePath, text, manifestPaths),
};

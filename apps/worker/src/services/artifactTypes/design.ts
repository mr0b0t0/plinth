// The design type's Worker hooks: its source is design.html, shared <head> tags then artboards
// (packages/shared/src/design.ts), refused with the first problem (and how many more) and every
// problem with its line in details.issues. Its title is the shared section's <title>, else the
// first artboard's name; it declares no capabilities. Assets are images, CSS, JS and mp4/webm
// video: artboards have an opaque origin, so font files and data files, which they could only
// load with CORS (never sent by the content host), are refused with what to do instead.
import { designIssueSummary, parseDesign } from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import { htmlTitle } from "./html.ts";

/** The shared section's <title>, else the first artboard's name, or null. */
export function designTitle(text: string): string | null {
  const r = parseDesign(text);
  if (!r.ok) return null;
  return htmlTitle(r.design.shared) ?? r.design.boards[0]?.name ?? null;
}

const FONT_RE = /^(font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/;
const DATA_RE =
  /^(application\/(json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml)|text\/(plain|csv|xml|markdown|tab-separated-values))(;|$)/;

export const DESIGN_FONT_RULE =
  "Artboards cannot load font files from the artifact: each artboard has an opaque origin and font loads need CORS, which Plinth never sends. Use Google Fonts or a data: URL in @font-face.";
export const DESIGN_DATA_RULE = "Artboards cannot fetch files: put data inline in a <script>.";

export const designHooks: TypeHooks = {
  title: designTitle,
  capabilities: () => null,
  validate(def, text) {
    const r = parseDesign(text);
    if (r.ok) return;
    throw new ApiError("invalid_input", designIssueSummary(r.issues), {
      type: def.id,
      field: "content",
      issues: r.issues,
    });
  },
  assetRule:
    "A design's assets are images (png, jpg, gif, webp, avif, svg), CSS, JS and mp4/webm video.",
  assetRefusal(_path, contentType) {
    const t = contentType.toLowerCase();
    if (FONT_RE.test(t)) return DESIGN_FONT_RULE;
    if (DATA_RE.test(t)) return DESIGN_DATA_RULE;
    return null;
  },
};

// The design_system type's Worker hooks: its source is one JSON file in format
// plinth.design-system/1 (shared designSystem.ts), refused with every problem and its path when it
// does not parse; its title is the design system's name; it declares no capabilities; assets are
// images and fonts. Non-fatal problems (markup previews never run, a font file the version lacks,
// no dark theme) become publish warnings.
import { LIMITS, type PublishWarning, parseDesignSystem } from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks } from "../artifactTypes.ts";

/** The design system's name, or null when the JSON has none. */
function designSystemTitle(text: string): string | null {
  try {
    const v = JSON.parse(text) as { name?: unknown };
    if (typeof v?.name === "string" && v.name.trim()) {
      return v.name.trim().slice(0, LIMITS.maxTitleLength);
    }
  } catch {
    // Refused by validate; a title is never needed for a source that does not parse.
  }
  return null;
}

export const designSystemHooks: TypeHooks = {
  title: designSystemTitle,
  capabilities: () => null,
  validate(def, text) {
    const r = parseDesignSystem(text);
    if (r.ok) return;
    throw new ApiError(
      "invalid_input",
      `${def.sourcePath} is not a valid design system (${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}): ` +
        r.errors
          .slice(0, 3)
          .map((e) => `${e.path || "(root)"} ${e.message}`)
          .join("; "),
      {
        type: def.id,
        field: "content",
        errors: r.errors,
        next: 'Fix each path in errors and publish again; see the plinth-artifacts skill, "Design systems"',
      },
    );
  },
  assetRule:
    "A design system's assets are images (png, jpg, gif, webp, avif, svg) and fonts (woff2, woff, ttf, otf)",
  async publishWarnings(_ctx, v) {
    const r = parseDesignSystem(v.text);
    if (!r.ok) return [];
    const out: PublishWarning[] = r.warnings.map((w) => ({
      code: w.code,
      file: v.def.sourcePath,
      path: w.path,
      message: w.message,
    }));
    for (const [i, f] of r.value.fonts.entries()) {
      if (f.src && !v.paths.has(f.src)) {
        out.push({
          code: "ds_missing_font",
          file: v.def.sourcePath,
          path: `fonts[${i}].src`,
          ref: f.src,
          message: `${f.src} is not among this version's assets: send the font file, or use a Google Fonts URL`,
        });
      }
    }
    // Uncapped: the stager caps them with the publish's own (at most 50, then "and N more").
    return out;
  },
};

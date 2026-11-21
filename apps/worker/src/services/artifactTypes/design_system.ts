// The design_system type's Worker hooks: its source is one JSON file in format
// plinth.design-system/1 (shared designSystem.ts), refused with every problem and its path when it
// does not parse; its title is the design system's name; it declares no capabilities; assets are
// images and fonts. Non-fatal problems (markup previews never run, a font file the version lacks,
// no dark theme, a CSS block's url() naming a file the version lacks) become publish warnings.
import {
  cssUrlArgs,
  designSystemGeneratedFile,
  isDsGeneratedFile,
  isPlainRelativeUrl,
  LIMITS,
  type PublishWarning,
  parseDesignSystem,
} from "@plinth/shared";
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
  // tokens.css, fonts.css, components.css and tokens.json, generated from the version's
  // system.json for copy_files (shared designSystemFiles.ts). Its assets are images and fonts only,
  // so no stored file has these names.
  copySource(text, path, ref) {
    if (!isDsGeneratedFile(path)) return null;
    const r = parseDesignSystem(text);
    if (!r.ok) return null;
    const file = designSystemGeneratedFile(r.value, path, ref);
    return file && { bytes: new TextEncoder().encode(file.text), contentType: file.contentType };
  },
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
    // The CSS blocks' url() references, checked as a CSS file's are. The parser already refused
    // every url() that is not a relative path, a #fragment or a raster data: image, so another
    // host never gets here; a relative path to a file this version lacks is a missing_file.
    const blocks: [string, string | null][] = [
      ["css", r.value.css],
      ...r.value.components.map((c, i): [string, string | null] => [`components[${i}].css`, c.css]),
    ];
    for (const [path, css] of blocks) {
      const seen = new Set<string>();
      for (const ref of (css && cssUrlArgs(css)) || []) {
        if (!isPlainRelativeUrl(ref) || seen.has(ref)) continue;
        seen.add(ref);
        const file = (ref.split(/[?#]/)[0] ?? "")
          .split("/")
          .filter((s) => s !== ".")
          .join("/");
        if (file === "" || v.paths.has(file)) continue;
        out.push({
          code: "missing_file",
          file: v.def.sourcePath,
          path,
          ref,
          message: `${ref} is not in this version (looked for ${file})`,
        });
      }
    }
    // Uncapped: the stager caps them with the publish's own (at most 50, then "and N more").
    return out;
  },
};

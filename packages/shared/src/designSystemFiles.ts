// The files a design system offers to other artifacts (docs/spec.md "Design systems", Installing a
// design system). Besides system.json and its own images and fonts, every version serves four
// files generated from system.json, which copy_files can copy like stored ones:
//
//   tokens.css      the tokens as CSS custom properties, light and dark (get_design_system's css)
//   fonts.css       @font-face rules for the design system's own font files, by relative path
//   components.css  the shared CSS and every component's own (get_design_system's component_css)
//   tokens.json     the tokens resolved to values, in format plinth.design-system-tokens/1
//
// A design system's assets are images and fonts only, so no stored file can take these names.
// Installing copies them, with the font and image files they name, to the same relative paths
// under `ds/<prefix>/` in the other artifact, so every relative url() in them still resolves.
import {
  cssUrlArgs,
  type DesignSystem,
  designSystemComponentCss,
  designSystemCss,
  designSystemFontFaces,
  designSystemFontLinks,
  isPlainRelativeUrl,
} from "./designSystem.ts";
import type { DesignSystemInstall } from "./types.ts";

/** tokens.json's format. */
export const DESIGN_SYSTEM_TOKENS_FORMAT = "plinth.design-system-tokens/1";

/** Where an installed design system's files land in another artifact: `ds/<prefix>/`. */
export const DS_INSTALL_DIR = "ds";

/** The files every design system version serves, generated from its system.json. */
export const DS_GENERATED_FILES = [
  "tokens.css",
  "fonts.css",
  "components.css",
  "tokens.json",
] as const;
export type DsGeneratedFile = (typeof DS_GENERATED_FILES)[number];

export function isDsGeneratedFile(path: string): path is DsGeneratedFile {
  return (DS_GENERATED_FILES as readonly string[]).includes(path);
}

/** Which design system version a generated file comes from. */
export interface DsFileRef {
  id: string;
  version: number;
}

const CSS = "text/css; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

/** The first line of a generated CSS file. Ids and numbers only: names are untrusted text. */
function header(ref: DsFileRef, what: string): string {
  return `/* Plinth design system ${ref.id} v${ref.version}: ${what}. Generated from system.json. */`;
}

/** The resolved tokens, as tokens.json holds them. */
function tokensJson(ds: DesignSystem, ref: DsFileRef): string {
  return `${JSON.stringify(
    {
      format: DESIGN_SYSTEM_TOKENS_FORMAT,
      design_system: { id: ref.id, version: ref.version },
      name: ds.name,
      prefix: ds.prefix,
      font_links: designSystemFontLinks(ds),
      fonts: ds.fonts.map((f) => ({
        family: f.family,
        source: f.source,
        ...(f.href ? { href: f.href } : {}),
        ...(f.src ? { file: f.src } : {}),
        ...(f.weight ? { weight: f.weight } : {}),
        ...(f.style ? { style: f.style } : {}),
      })),
      tokens: ds.tokens.map((t) => ({
        path: t.path,
        css_var: t.cssVar,
        type: t.type,
        value: t.value,
        dark: t.dark,
        alias_of: t.aliasOf,
        description: t.description,
        deprecated: t.deprecated,
      })),
    },
    null,
    2,
  )}\n`;
}

/** One generated file of a parsed design system, or null for any other path. */
export function designSystemGeneratedFile(
  ds: DesignSystem,
  path: string,
  ref: DsFileRef,
): { text: string; contentType: string } | null {
  switch (path) {
    case "tokens.css":
      return { text: `${header(ref, "tokens")}\n${designSystemCss(ds)}\n`, contentType: CSS };
    case "fonts.css": {
      const faces = designSystemFontFaces(ds);
      return {
        text: `${header(ref, "font files")}\n${faces ? `${faces}\n` : ""}`,
        contentType: CSS,
      };
    }
    case "components.css": {
      const css = designSystemComponentCss(ds);
      return { text: `${header(ref, "components")}\n${css ? `${css}\n` : ""}`, contentType: CSS };
    }
    case "tokens.json":
      return { text: tokensJson(ds, ref), contentType: JSON_TYPE };
    default:
      return null;
  }
}

/** A url() in a CSS block as the file path it names (no query or fragment, no "./"), or null. */
function fileOfUrl(ref: string): string | null {
  if (!isPlainRelativeUrl(ref)) return null;
  const file = (ref.split(/[?#]/)[0] ?? "")
    .split("/")
    .filter((s) => s !== ".")
    .join("/");
  return file === "" ? null : file;
}

/** The files of the version that the CSS blocks name by url(), in order, without repeats. */
function cssFiles(ds: DesignSystem, paths: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const css of [ds.css, ...ds.components.map((c) => c.css)]) {
    for (const ref of (css && cssUrlArgs(css)) || []) {
      const file = fileOfUrl(ref);
      if (file && paths.has(file)) out.add(file);
    }
  }
  return [...out];
}

/** Every path copy_files can take from a design system version: its source, generated, stored. */
export function designSystemFilePaths(sourcePath: string, stored: readonly string[]): string[] {
  return [sourcePath, ...DS_GENERATED_FILES, ...stored.filter((p) => p !== sourcePath)];
}

/**
 * The copy_files entries that install a design system version into another artifact under
 * `ds/<prefix>/`: tokens.css and tokens.json always, fonts.css with the font files it names when
 * the system has its own font files, components.css when it has CSS, and every stored file a CSS
 * block names. `paths` are the version's stored files. The stylesheets come in the order to link
 * them.
 */
export function designSystemInstall(
  ds: DesignSystem,
  ref: DsFileRef,
  paths: ReadonlySet<string>,
): DesignSystemInstall {
  const folder = `${DS_INSTALL_DIR}/${ds.prefix}`;
  const fontFiles = [
    ...new Set(ds.fonts.flatMap((f) => (f.src && paths.has(f.src) ? [f.src] : []))),
  ];
  const hasCss = !!ds.css || ds.components.some((c) => !!c.css);
  const generated: DsGeneratedFile[] = [
    ...(fontFiles.length ? (["fonts.css"] as const) : []),
    "tokens.css",
    ...(hasCss ? (["components.css"] as const) : []),
    "tokens.json",
  ];
  const stored = [...new Set([...fontFiles, ...(hasCss ? cssFiles(ds, paths) : [])])];
  const entry = (path: string) => ({
    artifact: ref.id,
    path,
    to: `${folder}/${path}`,
    version: ref.version,
  });
  return {
    folder,
    copy_files: [...generated, ...stored].map(entry),
    stylesheets: generated.filter((p) => p.endsWith(".css")).map((p) => `${folder}/${p}`),
  };
}

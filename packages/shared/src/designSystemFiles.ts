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
// under `ds/<folder>/` in the other artifact, so every relative url() in them still resolves. The
// folder is the design system's prefix (a name made from its title when it kept the default
// prefix), and the entries are only those the target artifact's type takes.
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
  /** The version's stored files: fonts.css declares only the font files among them. */
  stored?: ReadonlySet<string>,
): { text: string; contentType: string } | null {
  switch (path) {
    case "tokens.css":
      return { text: `${header(ref, "tokens")}\n${designSystemCss(ds)}\n`, contentType: CSS };
    case "fonts.css": {
      // Only the font files the version stores: a face for a missing file would load nothing.
      const faces = designSystemFontFaces({
        fonts: stored ? ds.fonts.filter((f) => !f.src || stored.has(f.src)) : ds.fonts,
      });
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

/** A folder name under `ds/`: lowercase letters, digits, `_` and `-`, starting with one of the first two. */
export const DS_FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** "Brand 2.0" -> "brand-2-0": lowercase, each run of other characters one "-", at most 64. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** The parser's prefix when system.json names none: as a folder it would give `ds/ds/`. */
const DEFAULT_PREFIX = "ds";

/**
 * The folder a design system installs into by default: its prefix, or, for one that kept the
 * default prefix, a name made from its title ("design-system" when that leaves nothing).
 */
export function designSystemFolder(ds: Pick<DesignSystem, "prefix">, title: string): string {
  if (ds.prefix !== DEFAULT_PREFIX) return ds.prefix;
  const slug = slugOf(title);
  return slug && DS_FOLDER_RE.test(slug) && slug !== DEFAULT_PREFIX ? slug : "design-system";
}

/** A deck's `faces` key for a family: lowercased, spaces as "-". */
function faceKey(family: string): string {
  return family.toLowerCase().replace(/\s+/g, "-");
}

export interface DesignSystemInstallOptions {
  /** The design system's title (the record's title, and the folder of a default-prefix system). */
  title: string;
  /** Another folder name than the default (DS_FOLDER_RE), when two systems would share one. */
  folder?: string;
  /** Whether the target artifact's type takes a file at this path (its asset rules). */
  accepts?: (path: string) => boolean;
  /** The record's copiedAt (now, RFC 3339). */
  now: string;
}

/**
 * How to install a design system version into another artifact under `ds/<folder>/`: the
 * copy_files entries (only those the target type takes: fonts.css with the font files when the
 * system stores its own and the target takes them, tokens.css, components.css when it has CSS,
 * tokens.json, and every stored file a CSS block names), the stylesheets to link in order, a
 * deck's `faces` (Google faces by link, installed font files by their path) and the record a
 * deck's or canvas's `designSystems` list keeps. `paths` are the version's stored files.
 */
export function designSystemInstall(
  ds: DesignSystem,
  ref: DsFileRef,
  paths: ReadonlySet<string>,
  opts: DesignSystemInstallOptions,
): DesignSystemInstall {
  const accepts = opts.accepts ?? (() => true);
  const namespace =
    opts.folder && DS_FOLDER_RE.test(opts.folder)
      ? opts.folder
      : designSystemFolder(ds, opts.title);
  const folder = `${DS_INSTALL_DIR}/${namespace}`;
  const fontFiles = [
    ...new Set(ds.fonts.flatMap((f) => (f.src && paths.has(f.src) ? [f.src] : []))),
  ].filter(accepts);
  const hasCss = !!ds.css || ds.components.some((c) => !!c.css);
  const generated = (
    [
      ...(fontFiles.length ? (["fonts.css"] as const) : []),
      "tokens.css",
      ...(hasCss ? (["components.css"] as const) : []),
      "tokens.json",
    ] as DsGeneratedFile[]
  ).filter(accepts);
  const stored = [
    ...new Set([...fontFiles, ...(hasCss ? cssFiles(ds, paths).filter(accepts) : [])]),
  ];
  const entry = (path: string) => ({
    artifact: ref.id,
    path,
    to: `${folder}/${path}`,
    version: ref.version,
  });
  const installed = new Set(fontFiles);
  const faces: DesignSystemInstall["faces"] = {};
  for (const f of ds.fonts) {
    const key = faceKey(f.family);
    if (faces[key]) continue;
    if (f.href) faces[key] = { family: f.family, href: f.href };
    else if (f.src && installed.has(f.src)) {
      faces[key] = {
        family: f.family,
        src: `${folder}/${f.src}`,
        ...(f.weight ? { weight: f.weight } : {}),
        ...(f.style ? { style: f.style } : {}),
      };
    }
  }
  return {
    folder,
    copy_files: [...generated, ...stored].map(entry),
    stylesheets: generated.filter((p) => p.endsWith(".css")).map((p) => `${folder}/${p}`),
    faces,
    record: {
      title: opts.title,
      namespace,
      artifact: ref.id,
      version: ref.version,
      copiedAt: opts.now,
    },
  };
}

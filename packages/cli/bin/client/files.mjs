// The build folder a client command publishes: walked without following links, with the same path
// rules the server applies, checked against the instance's limits before anything is sent.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliError, formatBytes } from "./http.mjs";
import { ASSET_PATH_RE, DEFAULTS, LIMITS } from "./vendor/constants.mjs";

/** The source file of each artifact type, at the top of the folder (the first one found wins). */
export const SOURCE_FILES = {
  html: "index.html",
  doc: "content.md",
  slides: "slides.md",
  design: "design.html",
  sheet: "sheet.jsonl",
  design_system: "system.json",
};

/** One file a publish imports as a sheet (the server converts it): its content_format by extension. */
export const IMPORT_FORMATS = { ".csv": "csv", ".xlsx": "xlsx" };

/** The field a type's source goes in on PUT /artifacts: html for a page, content for every typed one. */
export const sourceField = (type) => (type === "html" ? "html" : "content");

/** The most bytes a type's source may hold: the instance's limit, or the type's fixed limit. */
export function sourceMaxBytes(type, limits) {
  if (type === "doc") return limits.max_doc_bytes;
  if (type === "slides") return LIMITS.maxSlidesBytes;
  if (type === "design") return LIMITS.maxDesignBytes;
  if (type === "sheet") return limits.max_sheet_bytes ?? LIMITS.maxSheetBytes;
  if (type === "design_system") return LIMITS.maxDesignSystemBytes;
  return limits.max_html_bytes;
}

/** A name the server would accept for this path, or null when there is no obvious one. */
export function suggestPath(rel) {
  const clean = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const segs = rel.split("/").map((seg) => {
    const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(seg);
    return clean(m[1]) + (m[2] ?? "");
  });
  if (segs[0] === "__plinth") segs[0] = "plinth";
  const out = segs.filter(Boolean).join("/");
  return out && out !== rel && ASSET_PATH_RE.test(out) ? out : null;
}

/**
 * Walk `dir`. Symlinks and special files are refused (each named); dotfiles and folders are
 * skipped, and *.map unless includeMaps. Returns { files: [{path, abs, size}], skipped, refused }.
 */
export function walk(dir, { includeMaps = false } = {}) {
  const files = [];
  const skipped = [];
  const refused = [];
  const visit = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      throw new CliError(`Could not read ${abs}: ${e.message}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (ent.name.startsWith(".")) {
        skipped.push(childRel);
        continue;
      }
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        refused.push({ path: childRel, reason: "is a symbolic link" });
      } else if (st.isDirectory()) {
        visit(childAbs, childRel);
      } else if (!st.isFile()) {
        refused.push({ path: childRel, reason: "is not a regular file" });
      } else if (!includeMaps && ent.name.endsWith(".map")) {
        skipped.push(childRel);
      } else {
        files.push({ path: childRel, abs: childAbs, size: st.size });
      }
    }
  };
  visit(path.resolve(dir), "");
  return { files, skipped, refused };
}

/** Paths the server would refuse, each with a reason and, where there is one, a new name. */
export function badPaths(files) {
  const out = [];
  for (const f of files) {
    if (f.path.length > LIMITS.maxAssetPathLength) {
      out.push({ path: f.path, reason: `is longer than ${LIMITS.maxAssetPathLength} characters` });
    } else if (!ASSET_PATH_RE.test(f.path)) {
      const s = suggestPath(f.path);
      out.push({
        path: f.path,
        reason: f.path.startsWith("__plinth/")
          ? "is under __plinth/, which Plinth reserves"
          : "has characters other than letters, digits, '.', '_', '-' and '/'",
        ...(s ? { suggestion: s } : {}),
      });
    }
  }
  return out;
}

/** The limits to check against: the instance's (GET /config), else this package's defaults. */
export function defaultLimits() {
  return {
    max_html_bytes: LIMITS.maxHtmlBytes,
    max_doc_bytes: LIMITS.maxDocBytes,
    max_version_bytes: DEFAULTS.maxVersionBytes,
    max_assets_per_version: DEFAULTS.maxAssetsPerVersion,
    max_asset_path_length: LIMITS.maxAssetPathLength,
    max_request_bytes: LIMITS.maxInlineRequestBytes,
    max_bundle_bytes: DEFAULTS.maxVersionBytes + LIMITS.bundleOverheadBytes,
    max_bundle_file_bytes: LIMITS.maxBundleFileBytes,
    max_sheet_bytes: LIMITS.maxSheetBytes,
    max_sheet_rows: LIMITS.maxSheetRows,
    max_sheet_columns: LIMITS.maxSheetColumns,
  };
}

/**
 * Check a folder against the limits before sending it: the asset count, the source's size, each
 * file and the total. Throws CliError listing what to change.
 */
export function checkLimits(files, sourcePath, type, limits) {
  const problems = [];
  const assets = files.filter((f) => f.path !== sourcePath);
  if (assets.length > limits.max_assets_per_version) {
    const maps = assets.some((f) => f.path.endsWith(".map"));
    problems.push(
      `${assets.length} asset files; this instance allows ${limits.max_assets_per_version} per version. ` +
        (maps ? "Leave out source maps (drop --include-maps). " : "") +
        "Leave out files the page does not load. Never merge chunks to fit. " +
        "The instance operator can raise MAX_ASSETS_PER_VERSION (up to 900).",
    );
  }
  const source = files.find((f) => f.path === sourcePath);
  const sourceMax = sourceMaxBytes(type, limits);
  if (source && source.size > sourceMax) {
    problems.push(
      `${sourcePath} is ${formatBytes(source.size)}; the limit is ${formatBytes(sourceMax)}. Move inline scripts and data into asset files.`,
    );
  }
  for (const f of assets) {
    if (f.size > limits.max_bundle_file_bytes) {
      problems.push(
        `${f.path} is ${formatBytes(f.size)}; one file may be at most ${formatBytes(limits.max_bundle_file_bytes)}. Split or compress it.`,
      );
    }
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > limits.max_version_bytes) {
    const largest = [...files]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
      .map((f) => `    ${f.path} (${formatBytes(f.size)})`);
    problems.push(
      `The folder is ${formatBytes(total)} in total; this instance allows ${formatBytes(limits.max_version_bytes)} per version. Largest files:\n${largest.join("\n")}`,
    );
  }
  if (problems.length) throw new CliError(problems.join("\n"));
  return { total, assets: assets.length };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Add `sha256` to every file (each read once, then released). */
export function hashFiles(files) {
  for (const f of files) f.sha256 = sha256(readFileSync(f.abs));
  return files;
}

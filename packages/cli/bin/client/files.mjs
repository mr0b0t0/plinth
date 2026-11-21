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

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nfc = (v) => (typeof v === "string" ? v.normalize("NFC") : v);

/**
 * A sheet file's text in the canonical spelling the server stores (serializeSheet in
 * packages/shared/src/sheet/format.ts, restated here because the client has no dependencies): the
 * header's keys in a fixed order, a column's type "text" when absent, names and options in NFC, no
 * freeze of 0 columns, one JSON.stringify per row with trailing empty cells trimmed, no final
 * newline. It does not check the sheet (the server does): null when the text is not JSON lines
 * with a header object and array rows, which the server refuses anyway. A test pins it to the
 * shared serializer.
 */
export function canonicalSheet(text) {
  const body = text.replace(/^﻿/, "");
  const lines = (body.endsWith("\n") ? body.slice(0, -1) : body)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  let raw;
  try {
    raw = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.columns)) return null;
  const columns = [];
  for (const c of raw.columns) {
    if (!isPlainObject(c)) return null;
    const col = { name: nfc(c.name), type: c.type === undefined ? "text" : c.type };
    if (c.width !== undefined) col.width = c.width;
    if (c.format !== undefined) {
      if (!isPlainObject(c.format)) return null;
      const f = { style: c.format.style };
      if (c.format.currency !== undefined) f.currency = c.format.currency;
      if (c.format.decimals !== undefined) f.decimals = c.format.decimals;
      if (c.format.grouping !== undefined) f.grouping = c.format.grouping;
      col.format = f;
    }
    if (c.options !== undefined) {
      if (!Array.isArray(c.options)) return null;
      col.options = c.options.map(nfc);
    }
    if (c.colors !== undefined) {
      if (!isPlainObject(c.colors) || !col.options) return null;
      // In the order of the options, each key in NFC.
      const given = new Map(Object.entries(c.colors).map(([k, v]) => [nfc(k), v]));
      const colors = {};
      let any = false;
      for (const o of col.options) {
        if (!given.has(o)) continue;
        Object.defineProperty(colors, o, {
          value: given.get(o),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        any = true;
      }
      if (any) col.colors = colors;
    }
    if (Array.isArray(c.highlight) && c.highlight.length > 0) {
      col.highlight = c.highlight.map((r) => {
        if (!isPlainObject(r)) return r;
        const rule = { when: r.when };
        if (r.value !== undefined) rule.value = nfc(r.value);
        if (r.to !== undefined) rule.to = r.to;
        rule.color = r.color;
        return rule;
      });
    }
    columns.push(col);
  }
  const header = { plinth: "sheet", v: 1, columns };
  if (isPlainObject(raw.freeze) && raw.freeze.cols > 0) header.freeze = { cols: raw.freeze.cols };
  const out = [JSON.stringify(header)];
  for (const line of lines.slice(1)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(row)) return null;
    // A row may end with its style object, written last after the trimmed cells.
    const meta = row.length > 0 && isPlainObject(row[row.length - 1]) ? row.pop() : undefined;
    let end = row.length;
    while (end > 0 && (row[end - 1] === null || row[end - 1] === undefined)) end--;
    const cells = row.slice(0, end).map((c) => (c === undefined ? null : c));
    const style = meta === undefined ? null : canonicalRowStyle(meta);
    if (style === undefined) cells.push(meta);
    if (style) cells.push({ style });
    out.push(JSON.stringify(cells));
  }
  return out.join("\n");
}

const STYLE_KEYS = ["bold", "italic", "fill", "align", "wrap", "border"];
const BORDER_SIDES = ["top", "right", "bottom", "left"];

const letterIndex = (s) => {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** A row's styles in their canonical spelling (columns in order, keys in order); null when they set nothing, undefined when the object is not a style (the server refuses it). */
function canonicalRowStyle(meta) {
  if (!isPlainObject(meta.style)) return undefined;
  const letters = Object.keys(meta.style)
    .filter((k) => /^[A-Z]{1,3}$/.test(k))
    .sort((a, b) => letterIndex(a) - letterIndex(b));
  const out = {};
  let any = false;
  for (const letter of letters) {
    const s = meta.style[letter];
    if (!isPlainObject(s)) continue;
    const st = {};
    for (const k of STYLE_KEYS) {
      if (s[k] === undefined) continue;
      st[k] =
        k === "border" && Array.isArray(s[k]) ? BORDER_SIDES.filter((x) => s[k].includes(x)) : s[k];
    }
    if (Object.keys(st).length === 0) continue;
    out[letter] = st;
    any = true;
  }
  return any ? out : null;
}

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

// Reading an .xlsx file for an import: its ZIP container, the few SpreadsheetML parts a first
// worksheet needs (workbook, relationships, shared strings, styles, the sheet) and a small XML
// scanner. Bounded: the file is at most LIMITS.maxSheetImportBytes, the parts read are inflated
// up to LIMITS.maxSheetImportInflatedBytes in all, a small slice at a time (a ZIP bomb stops
// there), encrypted and ZIP64 archives are refused, and the XML scanner, linear in its input,
// refuses a DOCTYPE and expands only the five named entities and numeric character references.
// Rows, columns and cells are counted as they are read, so a small file cannot build a table the
// sheet limits would refuse. Nothing in the file is ever run: formulas are kept
// only when they parse as sheet formulas (the allowlist), otherwise their cached value is used.
// No replace with a callback runs on text of unbounded length: it keeps every match.
import { Inflate } from "fflate";
import { LIMITS } from "../constants.ts";
import {
  canonicalStyle,
  SHEET_BORDER_SIDES,
  type SheetBorderSide,
  type SheetCellStyle,
  type SheetColor,
} from "./format.ts";
import { XLFN_FUNCTIONS } from "./formula/arity.ts";
import { parseFormula } from "./formula/parser.ts";
import { nearestSheetColor } from "./looks.ts";
import { platform } from "./platform.ts";

export class SheetImportError extends Error {}

// ---------- ZIP ----------

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  flags: number;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16)) +
    (b[o + 3] as number) * 0x1000000
  );
}

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetImportError("This is not an .xlsx file (no ZIP directory)");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) {
    throw new SheetImportError("ZIP64 .xlsx files are not supported");
  }
  const out = new Map<string, ZipEntry>();
  const names = new platform.TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) {
      throw new SheetImportError("The .xlsx file's ZIP directory is damaged");
    }
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compressed = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = names.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { name, method, compressed, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Compressed bytes fed to the inflater at a time. One push inflates all it is given before it
// hands anything back, and DEFLATE expands at most 1,032 times, so a slice this size gives at most
// about 2 MB per step: the inflated cap is checked every 2 MB, never after a whole part.
const INFLATE_SLICE = 2 * 1024;

/**
 * Inflates raw DEFLATE `data` a slice at a time, calling `onChunk` with each piece as it comes. A
 * throw from `onChunk` stops it there: a ZIP bomb is refused after the cap, not after it inflates.
 */
export function inflateInSlices(data: Uint8Array, onChunk: (chunk: Uint8Array) => void): void {
  const inf = new Inflate((chunk) => onChunk(chunk));
  if (data.length === 0) inf.push(data, true);
  for (let o = 0; o < data.length; o += INFLATE_SLICE) {
    const end = Math.min(data.length, o + INFLATE_SLICE);
    inf.push(data.subarray(o, end), end === data.length);
  }
}

class Reader {
  private inflated = 0;
  private readonly entries: Map<string, ZipEntry>;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.entries = zipEntries(bytes);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** A part's text, or null when the archive does not hold it. */
  text(name: string): string | null {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.flags & 1) throw new SheetImportError("Encrypted .xlsx files are not supported");
    const b = this.bytes;
    const lo = e.offset;
    if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) {
      throw new SheetImportError(`The .xlsx part ${name} is damaged`);
    }
    const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    const data = b.subarray(start, start + e.compressed);
    if (data.length !== e.compressed)
      throw new SheetImportError(`The .xlsx part ${name} is cut short`);
    const cap = LIMITS.maxSheetImportInflatedBytes;
    // Each inflated chunk is decoded as it arrives and let go, so a large part is held once as
    // text, not also as its chunks and a joined copy of them.
    const decoder = new platform.TextDecoder();
    const pieces: string[] = [];
    if (e.method === 0) {
      this.count(data.length, cap);
      pieces.push(decoder.decode(data, { stream: true }));
    } else if (e.method === 8) {
      try {
        inflateInSlices(data, (chunk) => {
          this.count(chunk.length, cap);
          pieces.push(decoder.decode(chunk, { stream: true }));
        });
      } catch (err) {
        if (err instanceof SheetImportError) throw err;
        throw new SheetImportError(`The .xlsx part ${name} could not be decompressed`);
      }
    } else {
      throw new SheetImportError(
        `The .xlsx part ${name} uses a compression this import does not read`,
      );
    }
    pieces.push(decoder.decode());
    return pieces.join("");
  }

  private count(n: number, cap: number): void {
    this.inflated += n;
    if (this.inflated > cap) {
      throw new SheetImportError(
        `The .xlsx file expands to more than ${Math.round(cap / (1024 * 1024))} MB; save a smaller sheet`,
      );
    }
  }
}

// ---------- XML ----------

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(s: string): void;
}

/** What `&name;` stands for: one of the five named entities or a character reference. */
function entity(name: string): string | null {
  switch (name) {
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "amp":
      return "&";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }
  let cp = Number.NaN;
  if (/^#x[0-9A-Fa-f]{1,6}$/.test(name)) cp = Number.parseInt(name.slice(2), 16);
  else if (/^#\d{1,7}$/.test(name)) cp = Number(name.slice(1));
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
}

// The longest entity name is 8 characters (#x10FFFF), so a ; is looked for no further than this.
const ENTITY_SPAN = 10;

/**
 * Text with the five named entities and character references expanded; nothing else. A loop,
 * not a replace with a callback: memory stays near the text's own size however many entities it
 * holds (a replace kept every match, and 23 MB of "&amp;" ran a heap of 512 MB out).
 */
export function xmlDecode(s: string): string {
  let amp = s.indexOf("&");
  if (amp < 0) return s;
  let done = "";
  const parts: string[] = [];
  let last = 0;
  while (amp >= 0) {
    let semi = -1;
    for (let i = amp + 1; i < s.length && i <= amp + ENTITY_SPAN; i++) {
      if (s[i] === ";") {
        semi = i;
        break;
      }
    }
    const rep = semi < 0 ? null : entity(s.slice(amp + 1, semi));
    if (rep === null) {
      amp = s.indexOf("&", amp + 1);
      continue;
    }
    parts.push(s.slice(last, amp), rep);
    last = semi + 1;
    if (parts.length >= 4096) {
      done += parts.join("");
      parts.length = 0;
    }
    amp = s.indexOf("&", last);
  }
  return done + parts.join("") + s.slice(last);
}

// One tag, matched against exactly the text from its < to its closing > (found first, outside
// quotes), so the pattern never scans past the tag: the scan stays linear in the part's length.
const TAG = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/;
const NAME_START = /^[A-Za-z_]$/;
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const local = (name: string) => name.slice(name.indexOf(":") + 1);

function notWellFormed(): never {
  throw new SheetImportError("The .xlsx file's XML is damaged");
}

/** The index just past `close`, searched from `from`; refuses XML that never closes it. */
function closeAt(xml: string, close: string, from: number): number {
  const i = xml.indexOf(close, from);
  if (i < 0) notWellFormed();
  return i + close.length;
}

/** The index just past the > that ends the tag opening at `from`, outside quoted values. */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  return notWellFormed();
}

/**
 * Scan XML, calling the handler with local names (prefixes dropped). Refuses a DOCTYPE, and XML
 * whose tag, comment, CDATA section or processing instruction never ends. Every construct is
 * found with indexOf or one pass to its end, and the next search starts after it, so the work is
 * linear in the length of the XML whatever it holds.
 */
export function scanXml(xml: string, h: XmlHandler): void {
  let last = 0;
  let pos = xml.indexOf("<");
  while (pos >= 0) {
    const next = xml[pos + 1] ?? "";
    let end: number;
    let cdata: string | null = null;
    let tag: RegExpExecArray | null = null;
    if (next === "?") end = closeAt(xml, "?>", pos + 2);
    else if (xml.startsWith("<!--", pos)) end = closeAt(xml, "-->", pos + 4);
    else if (xml.startsWith("<![CDATA[", pos)) {
      end = closeAt(xml, "]]>", pos + 9);
      cdata = xml.slice(pos + 9, end - 3);
    } else if (next === "!") {
      throw new SheetImportError("The .xlsx file holds a DOCTYPE, which this import refuses");
    } else if (next === "/" || NAME_START.test(next)) {
      end = tagEnd(xml, pos);
      tag = TAG.exec(xml.slice(pos, end));
      if (!tag) notWellFormed();
    } else {
      // A < that starts no markup stays text, as before.
      pos = xml.indexOf("<", pos + 1);
      continue;
    }
    if (pos > last) h.text(xmlDecode(xml.slice(last, pos)));
    last = end;
    pos = xml.indexOf("<", end);
    if (cdata !== null) h.text(cdata);
    if (!tag) continue;
    const name = local(tag[2] as string);
    if (tag[1] === "/") {
      h.close(name);
      continue;
    }
    const attrs: Record<string, string> = Object.create(null);
    if (tag[3]) {
      ATTR.lastIndex = 0;
      for (let a = ATTR.exec(tag[3]); a; a = ATTR.exec(tag[3])) {
        attrs[local(a[1] as string)] = xmlDecode(a[2] ?? a[3] ?? "");
      }
    }
    h.open(name, attrs, tag[4] === "/");
    if (tag[4] === "/") h.close(name);
  }
  if (last < xml.length) h.text(xmlDecode(xml.slice(last)));
}

const HEX4 = /^[0-9A-Fa-f]{4}$/;

/**
 * Excel's _xHHHH_ escapes in strings (control characters it cannot write as XML). A loop, as in
 * xmlDecode: a replace with a callback kept every match, and 22 MB of "_x0041_" ran a heap of
 * 512 MB out.
 */
export function unescapeExcel(s: string): string {
  let at = s.indexOf("_x");
  if (at < 0) return s;
  let done = "";
  const parts: string[] = [];
  let last = 0;
  while (at >= 0) {
    const hex = s.slice(at + 2, at + 6);
    if (s[at + 6] !== "_" || !HEX4.test(hex)) {
      at = s.indexOf("_x", at + 1);
      continue;
    }
    parts.push(s.slice(last, at), String.fromCharCode(Number.parseInt(hex, 16)));
    last = at + 7;
    if (parts.length >= 4096) {
      done += parts.join("");
      parts.length = 0;
    }
    at = s.indexOf("_x", last);
  }
  return done + parts.join("") + s.slice(last);
}

// ---------- SpreadsheetML ----------

/** A cell as the import reads it, before column types are decided. */
export type RawCell =
  | null
  | { t: "s"; v: string }
  | { t: "n"; v: number; style: number }
  | { t: "b"; v: boolean }
  | { t: "e"; v: string }
  /** A formula the import keeps: it parses as a sheet formula, `_xlfn.` prefixes dropped. */
  | { t: "f"; f: string; cached: RawCell };

export interface RawSheet {
  /** Rows by A1 row number - 1, each by column index. */
  rows: RawCell[][];
  /** Widths in pixels by column index. */
  widths: Map<number, number>;
  freezeCols: number;
  /** cellXfs index to number format code (or a built-in id as "#<id>"). */
  styles: string[];
  /** cellXfs index to the sheet style it maps to, or null. */
  looks: (SheetCellStyle | null)[];
  /** The cellXfs index of each data cell with a value, by A1 row number - 1, then column. */
  cellLooks: (number[] | undefined)[];
  /** The workbook's other sheets, which are not imported: their names (at most 20) and count. */
  otherSheets: { names: string[]; count: number };
  /** Data cells (below row 1) whose formula was dropped for its cached value. */
  formulasAsValues: number;
}

/** The sheet names RawSheet.otherSheets lists, at most; the rest are only counted. */
export const MAX_OTHER_SHEET_NAMES = 20;

/** Excel's longest sheet name: a name read from a file is cut to it. */
const MAX_SHEET_NAME_CHARS = 31;

/** A sheet name as it may be shown: no control or format (bidi) characters, at most 31 long. */
function sheetName(raw: string): string {
  return [
    ...raw
      .slice(0, MAX_SHEET_NAME_CHARS * 4)
      .replace(/[\p{Cc}\p{Cf}]+/gu, "")
      .trim(),
  ]
    .slice(0, MAX_SHEET_NAME_CHARS)
    .join("");
}

interface WorkbookSheets {
  /** The first worksheet's part. */
  path: string;
  others: { names: string[]; count: number };
}

/**
 * The first worksheet's part, and the workbook's other sheets (the import reads only the first),
 * named in workbook order.
 */
function workbookSheets(r: Reader): WorkbookSheets {
  const wb = r.text("xl/workbook.xml");
  const rels = r.text("xl/_rels/workbook.xml.rels");
  let rid: string | null = null;
  let seen = 0;
  const names: string[] = [];
  if (wb) {
    scanXml(wb, {
      open(name, a) {
        if (name !== "sheet") return;
        seen++;
        if (seen === 1) rid = a.id ?? null;
        else if (names.length < MAX_OTHER_SHEET_NAMES) names.push(sheetName(a.name ?? ""));
      },
      close() {},
      text() {},
    });
  }
  const others = { names, count: Math.max(0, seen - 1) };
  let target: string | null = null;
  if (rels && rid) {
    scanXml(rels, {
      open(name, a) {
        if (name === "Relationship" && a.Id === rid) target = a.Target ?? null;
      },
      close() {},
      text() {},
    });
  }
  if (target) {
    const t = target as string;
    const path = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
    const clean = path
      .split("/")
      .reduce<string[]>((acc, seg) => {
        if (seg === "..") acc.pop();
        else if (seg !== "." && seg !== "") acc.push(seg);
        return acc;
      }, [])
      .join("/");
    if (r.has(clean)) return { path: clean, others };
  }
  if (r.has("xl/worksheets/sheet1.xml")) return { path: "xl/worksheets/sheet1.xml", others };
  throw new SheetImportError("The .xlsx file has no worksheet");
}

/** A column name is read from this many characters of its header cell, and keeps at most 100. */
export const COLUMN_NAME_SOURCE_CHARS = 1_000;

/**
 * The characters of a cell's text or a shared string an import keeps (28,007). Text this long is
 * still longer than a cell holds once its _xHHHH_ escapes (7 characters for 1) are expanded, so
 * a data cell of it is refused, and a header cell's name comes from its first 1,000 characters:
 * what follows changes nothing, so it is not kept. A number, a boolean, an error code or a shared
 * string index is read from these characters too; no spreadsheet app writes one this long.
 */
export const MAX_FIELD_CHARS =
  7 * (Math.max(LIMITS.maxSheetCellChars, COLUMN_NAME_SOURCE_CHARS) + 1);

/** keptFormula never keeps a source this long, so `<f>` text is kept up to it: no more matters. */
export const MAX_FORMULA_FIELD_CHARS = LIMITS.maxSheetFormulaChars * 4;

/**
 * The text of one field (a cell's `<f>`, `<v>` or inline `<t>`, a shared string's `<t>` runs),
 * gathered from its text events up to `max` characters and joined once. Any tag inside the text
 * ends one event and starts the next, so a small file can split one field into millions of
 * events: appending each with += built a rope of a node per event (about 20 bytes per character
 * of the file, which ran a 192 MB heap out on 24 MB of "a<x/>"), and nothing bounded its length.
 */
export class FieldText {
  private readonly parts: string[] = [];
  private kept = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(s: string): void {
    const room = this.max - this.kept;
    if (room <= 0 || s === "") return;
    const part = s.length > room ? s.slice(0, room) : s;
    this.parts.push(part);
    this.kept += part.length;
  }

  /** The characters kept: the field's length, or `max` when it is at least that long. */
  get length(): number {
    return this.kept;
  }

  /** How many pieces are kept (at most `max`, one per text event that added characters). */
  get pieces(): number {
    return this.parts.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

function sharedStrings(r: Reader): string[] {
  const xml = r.text("xl/sharedStrings.xml");
  const out: string[] = [];
  if (!xml) return out;
  let cur: FieldText | null = null;
  let inT = false;
  let skip = 0;
  scanXml(xml, {
    open(name) {
      if (name === "si") cur = new FieldText(MAX_FIELD_CHARS);
      else if (name === "t") inT = true;
      else if (name === "rPh" || name === "phoneticPr") skip++;
    },
    close(name) {
      if (name === "si" && cur !== null) {
        out.push(unescapeExcel(cur.text()));
        cur = null;
      } else if (name === "t") inT = false;
      else if (name === "rPh" || name === "phoneticPr") skip--;
    },
    text(s) {
      if (cur !== null && inT && skip === 0) cur.add(s);
    },
  });
  return out;
}

const MAX_FORMAT_CODE = 255;
/** At most this many fonts, fills, borders and cell formats are read from styles.xml. */
const MAX_STYLE_ENTRIES = 4_096;

/** The on/off of a font's <b/> or <i/>: on unless val says 0 or false. */
const flagOn = (a: Record<string, string>) => a.val !== "0" && a.val !== "false";

/**
 * Each cell format (cellXfs) of styles.xml: its number format code (or a built-in id as "#<id>")
 * and the sheet style it maps to (bold and italic from its font, a solid fill's colour matched to
 * the nearest sheet colour, the horizontal alignment, wrapping, and the sides that have a border),
 * or null when it sets none of those. Theme and indexed colours, which need the theme to read, are
 * left out.
 */
function styleFormats(r: Reader): { codes: string[]; looks: (SheetCellStyle | null)[] } {
  const xml = r.text("xl/styles.xml");
  if (!xml) return { codes: [], looks: [] };
  const custom = new Map<number, string>();
  const codes: string[] = [];
  const looks: (SheetCellStyle | null)[] = [];
  const fonts: { bold: boolean; italic: boolean }[] = [];
  const fills: (SheetColor | null)[] = [];
  const borders: SheetBorderSide[][] = [];
  let section: "fonts" | "fills" | "borders" | "cellXfs" | null = null;
  let fill: { solid: boolean; color: SheetColor | null } | null = null;
  let border: SheetBorderSide[] | null = null;
  let xf: SheetCellStyle | null = null;
  scanXml(xml, {
    open(name, a) {
      // A code longer than Excel's own limit of 255 characters is read as General.
      if (name === "numFmt" && a.numFmtId !== undefined) {
        const code = a.formatCode ?? "";
        custom.set(Number(a.numFmtId), code.length > MAX_FORMAT_CODE ? "" : code);
        return;
      }
      if (name === "fonts" || name === "fills" || name === "borders" || name === "cellXfs") {
        section = name;
        return;
      }
      if (section === "fonts") {
        if (name === "font" && fonts.length < MAX_STYLE_ENTRIES)
          fonts.push({ bold: false, italic: false });
        const f = fonts[fonts.length - 1];
        if (f && name === "b") f.bold = flagOn(a);
        if (f && name === "i") f.italic = flagOn(a);
      } else if (section === "fills") {
        if (name === "fill") fill = { solid: false, color: null };
        else if (fill && name === "patternFill") fill.solid = a.patternType === "solid";
        else if (fill && name === "fgColor" && a.rgb) fill.color = nearestSheetColor(a.rgb);
      } else if (section === "borders") {
        if (name === "border") border = [];
        else if (
          border &&
          (SHEET_BORDER_SIDES as readonly string[]).includes(name) &&
          a.style !== undefined &&
          a.style !== "none"
        ) {
          border.push(name as SheetBorderSide);
        }
      } else if (section === "cellXfs") {
        if (name === "xf") {
          if (codes.length >= MAX_STYLE_ENTRIES) return;
          const id = Number(a.numFmtId ?? "0");
          codes.push(custom.get(id) ?? `#${id}`);
          const font = fonts[Number(a.fontId ?? "0")];
          const color = fills[Number(a.fillId ?? "0")] ?? null;
          const sides = borders[Number(a.borderId ?? "0")] ?? [];
          xf = {};
          if (font?.bold) xf.bold = true;
          if (font?.italic) xf.italic = true;
          if (color) xf.fill = color;
          if (sides.length > 0) xf.border = SHEET_BORDER_SIDES.filter((s) => sides.includes(s));
          looks.push(null);
        } else if (xf && name === "alignment") {
          const h = a.horizontal;
          if (h === "left" || h === "center" || h === "right") xf.align = h;
          if (a.wrapText === "1" || a.wrapText === "true") xf.wrap = true;
        }
      }
    },
    close(name) {
      if (name === section) section = null;
      else if (name === "fill" && fill) {
        if (fills.length < MAX_STYLE_ENTRIES) fills.push(fill.solid ? fill.color : null);
        fill = null;
      } else if (name === "border" && border) {
        if (borders.length < MAX_STYLE_ENTRIES) borders.push(border);
        border = null;
      } else if (name === "xf" && xf) {
        const canon = canonicalStyle(xf);
        looks[looks.length - 1] = Object.keys(canon).length > 0 ? canon : null;
        xf = null;
      }
    },
    text() {},
  });
  return { codes, looks };
}

const CELL_REF = /^([A-Z]{1,3})(\d+)$/;

function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Refuses a worksheet row number (1 is the header) that a sheet cannot hold. */
function checkRow(rowNum: number): void {
  if (!Number.isInteger(rowNum) || rowNum < 1)
    throw new SheetImportError("The worksheet has a bad row number");
  if (rowNum > LIMITS.maxSheetRows + 1) {
    throw new SheetImportError(
      `A sheet holds at most ${LIMITS.maxSheetRows} rows under its header`,
    );
  }
}

/**
 * The formula an import keeps for an .xlsx cell's `<f>` text, or null when its cached value is used
 * instead: it must parse as a sheet formula (the function allowlist) once the `_xlfn.` prefixes of
 * functions sheets know are dropped. A source too long to be a sheet formula even without its
 * prefixes (each adds 6 characters to a name and "(" of at least 2) is never rewritten.
 */
export function keptFormula(f: string): string | null {
  if (f === "" || f.length >= LIMITS.maxSheetFormulaChars * 4) return null;
  const src = f.replace(/_xlfn\.([A-Z.]+)\(/g, (m, name: string) =>
    XLFN_FUNCTIONS.has(name) ? `${name}(` : m,
  );
  return src.length < LIMITS.maxSheetFormulaChars && parseFormula(src).ok ? src : null;
}

/** The characters of a value's text in JSON lines: a string, an error code, or "=" and a formula. */
function textLength(c: RawCell): number {
  if (c === null) return 0;
  if (c.t === "s" || c.t === "e") return c.v.length;
  return c.t === "f" ? c.f.length + 1 : 0;
}

/**
 * Refuses an import once `bytes`, its estimated JSON lines, passes the sheet limit. A cell with a
 * value costs at least two bytes there (the value and a comma or bracket) and a data row's text at
 * least its length (a kept formula's source, or the cached value a dropped formula falls back to),
 * so a refusal here is a file whose sheet would be refused anyway, found before its cells fill
 * memory (10,001 rows of 100 cells fit the row and column bounds). Only an empty string or a
 * formula with no valid source and no cached value, which spreadsheet apps do not write, is
 * counted though it ends up blank.
 */
export function checkSheetBytes(bytes: number): void {
  if (bytes > LIMITS.maxSheetBytes) {
    throw new SheetImportError(
      `A sheet is at most ${LIMITS.maxSheetBytes / (1024 * 1024)} MB; this file holds more cells than that`,
    );
  }
}

/** The first worksheet's cells, column widths and frozen columns, as typed raw values. */
export function readXlsx(bytes: Uint8Array): RawSheet {
  if (bytes.byteLength > LIMITS.maxSheetImportBytes) {
    throw new SheetImportError(
      `An .xlsx import is at most ${Math.round(LIMITS.maxSheetImportBytes / (1024 * 1024))} MB`,
    );
  }
  const r = new Reader(bytes);
  const { path, others } = workbookSheets(r);
  const strings = sharedStrings(r);
  const { codes: styles, looks } = styleFormats(r);
  const cellLooks: (number[] | undefined)[] = [];
  const xml = r.text(path) ?? "";
  const rows: RawCell[][] = [];
  const widths = new Map<number, number>();
  let freezeCols = 0;
  let rowNum = 0;
  let col = -1;
  let cell: { t: string; s: number } | null = null;
  let f: FieldText | null = null;
  let fShared = false;
  let v: FieldText | null = null;
  let inline: FieldText | null = null;
  let field: "f" | "v" | "t" | null = null;
  let nextCol = 0;
  let colRanges = 0;
  let jsonBytes = 0;
  let formulasAsValues = 0;
  scanXml(xml, {
    open(name, a) {
      switch (name) {
        case "col": {
          // Only the columns a sheet holds (1 to maxSheetColumns) get a width, from at most that
          // many <col> ranges: Excel writes them in order without overlap, so more is no file
          // worth reading, and the work and the map stay bounded whatever min, max and count say.
          const min = Number(a.min ?? "");
          const max = Math.min(Number(a.max ?? ""), LIMITS.maxSheetColumns);
          const w = Number(a.width ?? "");
          if (!Number.isInteger(min) || min < 1 || !Number.isInteger(max) || max < min) break;
          if (!Number.isFinite(w) || w <= 0 || colRanges >= LIMITS.maxSheetColumns) break;
          colRanges++;
          for (let c = min; c <= max; c++) widths.set(c - 1, Math.round(w * 7 + 5));
          break;
        }
        case "pane":
          if (a.state === "frozen" || a.state === "frozenSplit")
            freezeCols = Math.trunc(Number(a.xSplit ?? "0")) || 0;
          break;
        case "row":
          rowNum = a.r ? Number(a.r) : rowNum + 1;
          nextCol = 0;
          checkRow(rowNum);
          break;
        case "c": {
          const m = a.r ? CELL_REF.exec(a.r) : null;
          col = m ? colNum(m[1] as string) : nextCol;
          // A cell's own reference names its row too, so it gets the same bound as <row r>:
          // rows[rowNum - 1] below must never reach past the rows a sheet holds.
          if (m) {
            rowNum = Number(m[2]);
            checkRow(rowNum);
          }
          nextCol = col + 1;
          cell = { t: a.t ?? "n", s: Number(a.s ?? "0") || 0 };
          f = null;
          fShared = false;
          v = null;
          inline = null;
          break;
        }
        case "f":
          field = "f";
          f = new FieldText(MAX_FORMULA_FIELD_CHARS);
          fShared = a.t === "shared" || a.t === "array" || a.t === "dataTable";
          break;
        case "v":
          field = "v";
          v = new FieldText(MAX_FIELD_CHARS);
          break;
        case "is":
          inline = new FieldText(MAX_FIELD_CHARS);
          break;
        case "t":
          if (inline !== null) field = "t";
          break;
        case "rPh":
          field = null;
          break;
      }
    },
    close(name) {
      if (name === "f" || name === "v" || name === "t") {
        field = null;
        return;
      }
      if (name !== "c" || !cell) return;
      if (col >= LIMITS.maxSheetColumns) {
        if (v !== null || inline !== null || (f !== null && f.length > 0)) {
          throw new SheetImportError(`A sheet has at most ${LIMITS.maxSheetColumns} columns`);
        }
        cell = null;
        return;
      }
      const value = rawValue(cell, v?.text() ?? null, inline?.text() ?? null, strings);
      // The formula is decided here, not after the table is built, so a cell is counted as what
      // it becomes: a kept formula by its source, a dropped one by the cached value it falls back
      // to (one long shared string can stand behind every cell of a small file).
      const src = f?.text() ?? "";
      const kept = src && !fShared ? keptFormula(src) : null;
      // A formula that falls back to its cached value (outside the allowlist, another sheet, or a
      // shared one) is counted for the import's warning; the header row's become names anyway.
      if (kept === null && (src !== "" || fShared) && rowNum > 1) formulasAsValues++;
      const out: RawCell = kept !== null ? { t: "f", f: kept, cached: value } : value;
      if (out !== null) {
        jsonBytes += 2 + (rowNum > 1 ? textLength(out) : 0);
        checkSheetBytes(jsonBytes);
        let row = rows[rowNum - 1];
        if (!row) {
          row = [];
          rows[rowNum - 1] = row;
        }
        row[col] = out;
        // A data cell's look, when its format maps to one (the header row keeps the sheet's own).
        if (rowNum > 1 && looks[cell.s]) {
          const at = cellLooks[rowNum - 1] ?? [];
          at[col] = cell.s;
          cellLooks[rowNum - 1] = at;
        }
      }
      cell = null;
    },
    text(s) {
      if (field === "f" && f !== null) f.add(s);
      else if (field === "v" && v !== null) v.add(s);
      else if (field === "t" && inline !== null) inline.add(s);
    },
  });
  return {
    rows,
    widths,
    freezeCols,
    styles,
    looks,
    cellLooks,
    otherSheets: others,
    formulasAsValues,
  };
}

function rawValue(
  cell: { t: string; s: number },
  v: string | null,
  inline: string | null,
  strings: string[],
): RawCell {
  switch (cell.t) {
    case "s": {
      const i = Number(v);
      return Number.isInteger(i) && i >= 0 && i < strings.length
        ? { t: "s", v: strings[i] as string }
        : null;
    }
    case "inlineStr":
      return inline === null ? null : { t: "s", v: unescapeExcel(inline) };
    case "str":
      return v === null ? null : { t: "s", v: unescapeExcel(v) };
    case "b":
      return v === null ? null : { t: "b", v: v.trim() === "1" };
    case "e":
      return v === null ? null : { t: "e", v: v.trim() };
    default: {
      if (v === null || v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? { t: "n", v: n, style: cell.s } : null;
    }
  }
}

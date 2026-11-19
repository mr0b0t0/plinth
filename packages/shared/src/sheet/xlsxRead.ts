// Reading an .xlsx file for an import: its ZIP container, the few SpreadsheetML parts a first
// worksheet needs (workbook, relationships, shared strings, styles, the sheet) and a small XML
// scanner. Bounded: the file is at most LIMITS.maxSheetImportBytes, the parts read are inflated
// up to LIMITS.maxSheetImportInflatedBytes in all, a small slice at a time (a ZIP bomb stops
// there), encrypted and ZIP64 archives are refused, and the XML scanner, linear in its input,
// refuses a DOCTYPE and expands only the five named entities and numeric character references.
// Rows, columns and cells are counted as they are read, so a small file cannot build a table the
// sheet limits would refuse. Nothing in the file is ever run: formulas are kept
// only when they parse as sheet formulas (the allowlist), otherwise their cached value is used.
import { Inflate } from "fflate";
import { LIMITS } from "../constants.ts";
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

/** Excel's _xHHHH_ escapes in strings (control characters it cannot write as XML). */
function unescapeExcel(s: string): string {
  return s.includes("_x")
    ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) =>
        String.fromCharCode(Number.parseInt(h, 16)),
      )
    : s;
}

// ---------- SpreadsheetML ----------

/** A cell as the import reads it, before column types are decided. */
export type RawCell =
  | null
  | { t: "s"; v: string }
  | { t: "n"; v: number; style: number }
  | { t: "b"; v: boolean }
  | { t: "e"; v: string }
  | { t: "f"; f: string; cached: RawCell };

export interface RawSheet {
  /** Rows by A1 row number - 1, each by column index. */
  rows: RawCell[][];
  /** Widths in pixels by column index. */
  widths: Map<number, number>;
  freezeCols: number;
  /** cellXfs index to number format code (or a built-in id as "#<id>"). */
  styles: string[];
}

function firstSheetPath(r: Reader): string {
  const wb = r.text("xl/workbook.xml");
  const rels = r.text("xl/_rels/workbook.xml.rels");
  let rid: string | null = null;
  if (wb) {
    scanXml(wb, {
      open(name, a) {
        if (name === "sheet" && rid === null) rid = a.id ?? null;
      },
      close() {},
      text() {},
    });
  }
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
    if (r.has(clean)) return clean;
  }
  if (r.has("xl/worksheets/sheet1.xml")) return "xl/worksheets/sheet1.xml";
  throw new SheetImportError("The .xlsx file has no worksheet");
}

function sharedStrings(r: Reader): string[] {
  const xml = r.text("xl/sharedStrings.xml");
  const out: string[] = [];
  if (!xml) return out;
  let cur: string | null = null;
  let inT = false;
  let skip = 0;
  scanXml(xml, {
    open(name) {
      if (name === "si") cur = "";
      else if (name === "t") inT = true;
      else if (name === "rPh" || name === "phoneticPr") skip++;
    },
    close(name) {
      if (name === "si" && cur !== null) {
        out.push(unescapeExcel(cur));
        cur = null;
      } else if (name === "t") inT = false;
      else if (name === "rPh" || name === "phoneticPr") skip--;
    },
    text(s) {
      if (cur !== null && inT && skip === 0) cur += s;
    },
  });
  return out;
}

const MAX_FORMAT_CODE = 255;

function styleFormats(r: Reader): string[] {
  const xml = r.text("xl/styles.xml");
  if (!xml) return [];
  const custom = new Map<number, string>();
  const xfs: string[] = [];
  let inCellXfs = false;
  scanXml(xml, {
    open(name, a) {
      // A code longer than Excel's own limit of 255 characters is read as General.
      if (name === "numFmt" && a.numFmtId !== undefined) {
        const code = a.formatCode ?? "";
        custom.set(Number(a.numFmtId), code.length > MAX_FORMAT_CODE ? "" : code);
      } else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) {
        const id = Number(a.numFmtId ?? "0");
        xfs.push(custom.get(id) ?? `#${id}`);
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
    text() {},
  });
  return xfs;
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
 * Refuses an import once `bytes`, its estimated JSON lines, passes the sheet limit. A cell with a
 * value costs at least two bytes there (the value and a comma or bracket) and a data row's text at
 * least its length, so a refusal here is a file whose sheet would be refused anyway, found before
 * its cells fill memory (10,001 rows of 100 cells fit the row and column bounds). Only an empty
 * string or a formula with no valid source and no cached value, which spreadsheet apps do not
 * write, is counted though it ends up blank.
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
  const path = firstSheetPath(r);
  const strings = sharedStrings(r);
  const styles = styleFormats(r);
  const xml = r.text(path) ?? "";
  const rows: RawCell[][] = [];
  const widths = new Map<number, number>();
  let freezeCols = 0;
  let rowNum = 0;
  let col = -1;
  let cell: { t: string; s: number } | null = null;
  let f: string | null = null;
  let fShared = false;
  let v: string | null = null;
  let inline: string | null = null;
  let field: "f" | "v" | "t" | null = null;
  let nextCol = 0;
  let colRanges = 0;
  let jsonBytes = 0;
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
          f = "";
          fShared = a.t === "shared" || a.t === "array" || a.t === "dataTable";
          break;
        case "v":
          field = "v";
          v = "";
          break;
        case "is":
          inline = "";
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
        if (v !== null || inline !== null || f) {
          throw new SheetImportError(`A sheet has at most ${LIMITS.maxSheetColumns} columns`);
        }
        cell = null;
        return;
      }
      const value = rawValue(cell, v, inline, strings);
      const out: RawCell = f && !fShared ? { t: "f", f, cached: value } : value;
      if (out !== null) {
        jsonBytes += 2 + (rowNum > 1 && (out.t === "s" || out.t === "e") ? out.v.length : 0);
        checkSheetBytes(jsonBytes);
        let row = rows[rowNum - 1];
        if (!row) {
          row = [];
          rows[rowNum - 1] = row;
        }
        row[col] = out;
      }
      cell = null;
    },
    text(s) {
      if (field === "f" && f !== null) f += s;
      else if (field === "v" && v !== null) v += s;
      else if (field === "t" && inline !== null) inline += s;
    },
  });
  return { rows, widths, freezeCols, styles };
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

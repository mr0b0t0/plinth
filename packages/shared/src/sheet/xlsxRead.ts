// Reading an .xlsx file for an import: its ZIP container, the few SpreadsheetML parts a first
// worksheet needs (workbook, relationships, shared strings, styles, the sheet) and a small XML
// scanner. Bounded: the file is at most LIMITS.maxSheetImportBytes, the parts read are inflated
// up to LIMITS.maxSheetImportInflatedBytes in all (a ZIP bomb stops there), encrypted and ZIP64
// archives are refused, and the XML scanner refuses a DOCTYPE and expands only the five named
// entities and numeric character references. Nothing in the file is ever run: formulas are kept
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
    const chunks: Uint8Array[] = [];
    if (e.method === 0) {
      this.count(data.length, cap);
      chunks.push(data);
    } else if (e.method === 8) {
      const inf = new Inflate((chunk) => {
        this.count(chunk.length, cap);
        chunks.push(chunk);
      });
      try {
        inf.push(data, true);
      } catch (err) {
        if (err instanceof SheetImportError) throw err;
        throw new SheetImportError(`The .xlsx part ${name} could not be decompressed`);
      }
    } else {
      throw new SheetImportError(
        `The .xlsx part ${name} uses a compression this import does not read`,
      );
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return new platform.TextDecoder().decode(all);
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

const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([0-9A-Fa-f]{1,6}));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Text with the five named entities and character references expanded; nothing else. */
export function xmlDecode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (m, named?: string, dec?: string, hex?: string) => {
    if (named) return NAMED[named] as string;
    const cp = dec ? Number(dec) : Number.parseInt(hex as string, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const TOKEN =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!/g;
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** Scan XML, calling the handler with local names (prefixes dropped). Refuses a DOCTYPE. */
export function scanXml(xml: string, h: XmlHandler): void {
  TOKEN.lastIndex = 0;
  let last = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    if (m.index > last) h.text(xmlDecode(xml.slice(last, m.index)));
    last = TOKEN.lastIndex;
    if (m[0] === "<!")
      throw new SheetImportError("The .xlsx file holds a DOCTYPE, which this import refuses");
    if (m[2] === undefined) {
      if (m[5] !== undefined) h.text(m[5]);
      continue;
    }
    const name = local(m[2]);
    if (m[1] === "/") {
      h.close(name);
      continue;
    }
    const attrs: Record<string, string> = Object.create(null);
    if (m[3]) {
      ATTR.lastIndex = 0;
      for (let a = ATTR.exec(m[3]); a; a = ATTR.exec(m[3])) {
        attrs[local(a[1] as string)] = xmlDecode(a[2] ?? a[3] ?? "");
      }
    }
    h.open(name, attrs, m[4] === "/");
    if (m[4] === "/") h.close(name);
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

function styleFormats(r: Reader): string[] {
  const xml = r.text("xl/styles.xml");
  if (!xml) return [];
  const custom = new Map<number, string>();
  const xfs: string[] = [];
  let inCellXfs = false;
  scanXml(xml, {
    open(name, a) {
      if (name === "numFmt" && a.numFmtId !== undefined)
        custom.set(Number(a.numFmtId), a.formatCode ?? "");
      else if (name === "cellXfs") inCellXfs = true;
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
  scanXml(xml, {
    open(name, a) {
      switch (name) {
        case "col": {
          const min = Number(a.min ?? "0");
          const max = Math.min(Number(a.max ?? "0"), min + LIMITS.maxSheetColumns);
          const w = Number(a.width ?? "");
          if (Number.isFinite(w) && w > 0) {
            for (let c = min; c <= max; c++) widths.set(c - 1, Math.round(w * 7 + 5));
          }
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

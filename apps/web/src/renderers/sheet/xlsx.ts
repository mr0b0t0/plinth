// A minimal .xlsx (SpreadsheetML) of one sheet, written by hand and zipped with fflate: the header
// row in bold, column widths, a frozen pane for the header and the frozen columns, number formats
// built from the column formats, text as inline strings (so text starting with = stays text),
// and formulas as <f> with the value Plinth computed cached beside them (fullCalcOnLoad makes
// Excel compute its own). Formulas come only from the sheet, whose functions are an allowlist of
// Excel's, so a downloaded workbook can never hold HYPERLINK, WEBSERVICE, DDE or an external
// reference. No macros and no external relationships; docProps holds the title only. Every text
// node and attribute goes through xmlText.
//
// Looks carry over where Excel has them: cell styles as cell formats (bold, italic, a solid fill
// in the colour's light value, alignment, wrapping, thin borders), and highlight rules and option
// colours as conditional formats over the column's data rows, as formulas that match what the
// page matches, the first that matches stopping the rest. CSV has none of them.
import {
  colLetter,
  isError,
  isFormula,
  isoDateSerial,
  lexFormula,
  literalText,
  optionColor,
  round15,
  SHEET_COLOR_HEX,
  SHEET_COLORS,
  type Sheet,
  type SheetCellStyle,
  type SheetColor,
  type SheetColumn,
  type SheetEvaluation,
  type SheetHighlightRule,
  type SheetNumberFormat,
  XLFN_FUNCTIONS,
} from "@plinth/shared";
import { strToU8, type Zippable, zipSync } from "fflate";

/**
 * Text safe in XML 1.0: & < > " ' escaped, and every character XML forbids (most controls, lone
 * surrogates, U+FFFE and U+FFFF) dropped.
 */
export function xmlText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + (s[i + 1] as string);
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    if (c === 0xfffe || c === 0xffff) continue;
    const ch = s[i] as string;
    out +=
      ch === "&"
        ? "&amp;"
        : ch === "<"
          ? "&lt;"
          : ch === ">"
            ? "&gt;"
            : ch === '"'
              ? "&quot;"
              : ch === "'"
                ? "&apos;"
                : ch;
  }
  return out;
}

/** A worksheet name Excel accepts: at most 31 characters, none of \ / ? * [ ] :, not quoted. */
export function sheetName(title: string): string {
  const name = title
    .replace(/[\\/?*[\]:\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  return name || "Sheet1";
}

/** A Plinth formula as Excel stores it: no leading =, and _xlfn. before newer functions. */
export function excelFormula(cell: string): string {
  const src = cell.slice(1);
  let toks: ReturnType<typeof lexFormula>;
  try {
    toks = lexFormula(src);
  } catch {
    return src;
  }
  let out = "";
  let last = 0;
  for (const t of toks) {
    if (t.t === "func" && XLFN_FUNCTIONS.has(t.name)) {
      out += `${src.slice(last, t.start)}_xlfn.`;
      last = t.start;
    }
  }
  return out + src.slice(last);
}

/** The Excel number format code for a column, or null for General. */
export function formatCode(
  col: SheetColumn,
  currencySymbol: (code: string) => string,
): string | null {
  if (col.type === "date") return "yyyy-mm-dd";
  if (col.type !== "number" || !col.format) return null;
  const f: SheetNumberFormat = col.format;
  const decimals = f.decimals ?? (f.style === "currency" ? 2 : f.style === "percent" ? 0 : -1);
  const frac = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  const grouping = f.grouping ?? true;
  if (f.style === "percent") return `0${frac}%`;
  // A plain number with no decimals set keeps General, which shows what the number needs.
  if (decimals < 0) return null;
  const base = `${grouping ? "#,##0" : "0"}${frac}`;
  if (f.style === "currency") {
    const sym = currencySymbol(f.currency ?? "");
    return `"${sym.replace(/"/g, "")}"${base}`;
  }
  return base;
}

/** The symbol Intl uses for a currency code ("€" for EUR), or the code itself. */
export function currencySymbol(code: string): string {
  try {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency: code }).formatToParts(
      1,
    );
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

const EXCEL_ERRORS = new Set(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#NULL!"]);

function attr(name: string, value: string | number): string {
  return ` ${name}="${xmlText(String(value))}"`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A formula's text as Excel reads it, for a highlight rule's value. */
function ruleOperand(v: unknown, col: SheetColumn): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(round15(v));
  if (typeof v === "string" && col.type === "date") return String(isoDateSerial(v) ?? 0);
  return `"${String(v).replace(/"/g, '""')}"`;
}

/**
 * A highlight rule as an Excel conditional format formula for the cell `ref` (the range's first),
 * written so it matches what the page matches: a comparison only a value of the same kind, an
 * empty cell only Empty, an error only Not empty, and Contains as text without case or
 * wildcards.
 */
export function ruleFormula(rule: SheetHighlightRule, ref: string, col: SheetColumn): string {
  const v = ruleOperand(rule.value, col);
  const kind =
    typeof rule.value === "boolean"
      ? `ISLOGICAL(${ref})`
      : typeof rule.value === "number" || col.type === "date"
        ? `ISNUMBER(${ref})`
        : `ISTEXT(${ref})`;
  switch (rule.when) {
    case "empty":
      return `IF(ISERROR(${ref}),FALSE,LEN(${ref})=0)`;
    case "not_empty":
      return `IF(ISERROR(${ref}),TRUE,LEN(${ref})>0)`;
    case "contains": {
      const needle = String(rule.value ?? "").replace(/[~*?]/g, "~$&");
      return `ISNUMBER(SEARCH("${needle.replace(/"/g, '""')}",${ref}))`;
    }
    case "between":
      return `AND(ISNUMBER(${ref}),${ref}>=${v},${ref}<=${ruleOperand(rule.to, col)})`;
    default:
      return `AND(${kind},${ref}${rule.when}${v})`;
  }
}

/** The sheet's .xlsx bytes. */
export function buildXlsx(sheet: Sheet, ev: SheetEvaluation, title: string): Uint8Array {
  const cols = sheet.header.columns;
  // Styles: 0 default, 1 the bold header, then one per distinct number format, then one per
  // distinct number format and cell style a cell has.
  const codes: string[] = [];
  const colFmt = cols.map((c) => {
    const code = formatCode(c, currencySymbol);
    if (code === null) return 0;
    let i = codes.indexOf(code);
    if (i < 0) i = codes.push(code) - 1;
    return 164 + i;
  });
  const colStyle = colFmt.map((id) => (id === 0 ? 0 : id - 164 + 2));
  const numFmts = codes
    .map((code, i) => `<numFmt${attr("numFmtId", 164 + i)}${attr("formatCode", code)}/>`)
    .join("");
  // Fonts: plain, bold, italic, bold italic. Fills: none, gray125 (Excel's own), then a solid fill
  // per sheet colour. Borders: none, then one per set of sides used.
  const fonts = ["", "<b/>", "<i/>", "<b/><i/>"].map(
    (f) => `<font>${f}<sz val="11"/><name val="Calibri"/></font>`,
  );
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    ...SHEET_COLORS.map(
      (c) =>
        `<fill><patternFill patternType="solid"><fgColor rgb="FF${SHEET_COLOR_HEX[c].fill}"/><bgColor indexed="64"/></patternFill></fill>`,
    ),
  ];
  const borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const borderIds = new Map<string, number>([["", 0]]);
  const borderOf = (sides: readonly string[]): number => {
    const key = sides.join(",");
    let id = borderIds.get(key);
    if (id === undefined) {
      const side = (s: string) =>
        sides.includes(s) ? `<${s} style="thin"><color rgb="FF3B434B"/></${s}>` : `<${s}/>`;
      id =
        borders.push(
          `<border>${side("left")}${side("right")}${side("top")}${side("bottom")}<diagonal/></border>`,
        ) - 1;
      borderIds.set(key, id);
    }
    return id;
  };
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    ...codes.map(
      (_c, i) =>
        `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    ),
  ];
  const xfIds = new Map<string, number>();
  /** The cell format of a data cell in column c with style `s` (its column's alone when none). */
  const cellXf = (c: number, s: SheetCellStyle | null | undefined): number => {
    if (!s) return colStyle[c] ?? 0;
    const numFmt = colFmt[c] ?? 0;
    const font = (s.bold ? 1 : 0) + (s.italic ? 2 : 0);
    const fill = s.fill ? 2 + SHEET_COLORS.indexOf(s.fill) : 0;
    const border = borderOf(s.border ?? []);
    const align =
      s.align || s.wrap
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.wrap ? ' wrapText="1"' : ""}/>`
        : "";
    const key = `${numFmt}|${font}|${fill}|${border}|${align}`;
    let id = xfIds.get(key);
    if (id === undefined) {
      id =
        xfs.push(
          `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
            `${numFmt ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}${fill ? ' applyFill="1"' : ""}` +
            `${border ? ' applyBorder="1"' : ""}${align ? ` applyAlignment="1">${align}</xf>` : "/>"}`,
        ) - 1;
      xfIds.set(key, id);
    }
    return id;
  };
  // Highlight rules and option colours become conditional formats over each column's data
  // rows, in the page's order: the rules first, each stopping the ones after it, then the options.
  const dxfs = SHEET_COLORS.map(
    (c) =>
      `<dxf><font><color rgb="FF${SHEET_COLOR_HEX[c].text}"/></font><fill><patternFill patternType="solid"><bgColor rgb="FF${SHEET_COLOR_HEX[c].fill}"/></patternFill></fill></dxf>`,
  );
  const lastRow = sheet.rows.length + 1;
  let priority = 0;
  const conditional: string[] = [];
  cols.forEach((col, c) => {
    if (lastRow < 2) return;
    const ref = `${colLetter(c)}2`;
    const rules: string[] = [];
    const rule = (formula: string, color: SheetColor) => {
      rules.push(
        `<cfRule type="expression" dxfId="${SHEET_COLORS.indexOf(color)}" priority="${++priority}" stopIfTrue="1"><formula>${xmlText(formula)}</formula></cfRule>`,
      );
    };
    for (const r of col.highlight ?? []) rule(ruleFormula(r, ref, col), r.color);
    for (const o of col.options ?? []) {
      const color = optionColor(col, o);
      if (color) rule(`EXACT(${ref},"${o.replace(/"/g, '""')}")`, color);
    }
    if (rules.length > 0) {
      conditional.push(
        `<conditionalFormatting sqref="${ref}:${colLetter(c)}${lastRow}">${rules.join("")}</conditionalFormatting>`,
      );
    }
  });
  // The cells' formats are known once the rows are written: the styles part is built after them.
  const stylesXml = () =>
    `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
    (codes.length ? `<numFmts count="${codes.length}">${numFmts}</numFmts>` : "") +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="${fills.length}">${fills.join("")}</fills>` +
    `<borders count="${borders.length}">${borders.join("")}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    `<dxfs count="${dxfs.length}">${dxfs.join("")}</dxfs>` +
    "</styleSheet>";

  const freeze = sheet.header.freeze?.cols ?? 0;
  const pane =
    freeze > 0
      ? `<pane xSplit="${freeze}" ySplit="1" topLeftCell="${colLetter(freeze)}2" activePane="bottomRight" state="frozen"/>`
      : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  const widths = cols
    .map((c, i) => {
      const px = c.width ?? 120;
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.round((px / 7) * 100) / 100}" customWidth="1"/>`;
    })
    .join("");

  const inline = (ref: string, text: string, style: number) =>
    `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;

  const rows: string[] = [];
  rows.push(
    `<row r="1">${cols.map((c, i) => inline(`${colLetter(i)}1`, c.name, 1)).join("")}</row>`,
  );
  sheet.rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells: string[] = [];
    const rowStyle = sheet.styles?.[ri];
    for (let c = 0; c < cols.length; c++) {
      const cell = row[c] ?? null;
      const look = rowStyle?.[c];
      const ref = `${colLetter(c)}${r}`;
      if (cell === null) {
        // An empty cell is written only for its style.
        if (look) cells.push(`<c r="${ref}" s="${cellXf(c, look)}"/>`);
        continue;
      }
      const col = cols[c] as SheetColumn;
      const s = cellXf(c, look);
      const sAttr = s ? ` s="${s}"` : "";
      if (isFormula(cell)) {
        const f = `<f>${xmlText(excelFormula(cell))}</f>`;
        const v = ev.value(r, c);
        if (typeof v === "number") cells.push(`<c r="${ref}"${sAttr}>${f}<v>${round15(v)}</v></c>`);
        else if (typeof v === "boolean")
          cells.push(`<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`);
        else if (typeof v === "string")
          cells.push(`<c r="${ref}"${sAttr} t="str">${f}<v>${xmlText(v)}</v></c>`);
        else if (isError(v) && EXCEL_ERRORS.has(v.error)) {
          cells.push(`<c r="${ref}"${sAttr} t="e">${f}<v>${xmlText(v.error)}</v></c>`);
        } else cells.push(`<c r="${ref}"${sAttr}>${f}</c>`);
        continue;
      }
      if (typeof cell === "number") cells.push(`<c r="${ref}"${sAttr}><v>${cell}</v></c>`);
      else if (typeof cell === "boolean")
        cells.push(`<c r="${ref}"${sAttr} t="b"><v>${cell ? 1 : 0}</v></c>`);
      else if (col.type === "date" && isoDateSerial(cell) !== null) {
        cells.push(`<c r="${ref}"${sAttr}><v>${isoDateSerial(cell)}</v></c>`);
      } else cells.push(inline(ref, literalText(cell), look ? s : 0));
    }
    rows.push(`<row r="${r}">${cells.join("")}</row>`);
  });

  const worksheet =
    `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<cols>${widths}</cols>` +
    `<sheetData>${rows.join("")}</sheetData>${conditional.join("")}` +
    "</worksheet>";

  const files: Zippable = {
    "[Content_Types].xml": strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        "</Relationships>",
    ),
    "docProps/core.xml": strToU8(
      `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:title>${xmlText(title)}</dc:title></cp:coreProperties>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
        `<sheets><sheet${attr("name", sheetName(title))} sheetId="1" r:id="rId1"/></sheets>` +
        '<calcPr fullCalcOnLoad="1"/></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    ),
    "xl/styles.xml": strToU8(stylesXml()),
    "xl/worksheets/sheet1.xml": strToU8(worksheet),
  };
  return zipSync(files, { level: 6 });
}

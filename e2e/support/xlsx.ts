// A small .xlsx for import tests: a ZIP of stored (uncompressed) parts, enough for Plinth's reader
// (it checks no CRC), with one worksheet of inline strings and numbers (and, if asked, the names of
// more sheets).

/** A ZIP of stored files. */
export function storedZip(files: Record<string, string>): Buffer {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], n: number) => a.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (a: number[], n: number) =>
    a.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = [...enc.encode(name)];
    const data = [...enc.encode(text)];
    const offset = parts.length;
    u32(parts, 0x04034b50);
    for (const n of [20, 0, 0, 0, 0]) u16(parts, n);
    u32(parts, 0);
    u32(parts, data.length);
    u32(parts, data.length);
    u16(parts, nameBytes.length);
    u16(parts, 0);
    parts.push(...nameBytes, ...data);
    u32(central, 0x02014b50);
    for (const n of [20, 20, 0, 0, 0, 0]) u16(central, n);
    u32(central, 0);
    u32(central, data.length);
    u32(central, data.length);
    for (const n of [nameBytes.length, 0, 0, 0, 0]) u16(central, n);
    u32(central, 0);
    u32(central, offset);
    central.push(...nameBytes);
    count++;
  }
  const cdOffset = parts.length;
  const end: number[] = [];
  u32(end, 0x06054b50);
  for (const n of [0, 0, count, count]) u16(end, n);
  u32(end, central.length);
  u32(end, cdOffset);
  u16(end, 0);
  return Buffer.from([...parts, ...central, ...end]);
}

const cellXml = (ref: string, v: string | number) =>
  typeof v === "number"
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

/**
 * An .xlsx whose first worksheet holds these rows (the first row names the columns). `others`
 * names more sheets in the workbook, which an import leaves out.
 */
export function xlsxOf(rows: (string | number)[][], others: string[] = []): Buffer {
  const cols = "ABCDEFGHIJ";
  const data = rows
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r.map((v, j) => cellXml(`${cols[j]}${i + 1}`, v)).join("")}</row>`,
    )
    .join("");
  return storedZip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Sheet1" r:id="rId1"/>${others
      .map((n, i) => `<sheet name="${n}" r:id="rId${i + 2}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${data}</sheetData></worksheet>`,
  });
}

// The sheet type: an agent sends JSON lines in content (MCP or REST), or a CSV or .xlsx with
// content_format, and Plinth stores sheet.jsonl in its canonical form, with no assets; the content
// host serves the strict typed shell around it. Checked here: publish and update on both wires,
// every fix-it refusal, canonical storage on the inline and bundle paths, restore, imports, and
// what the content and app hosts serve.
import { TYPE_REGISTRY } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { checkAsset, resolveSource } from "../src/services/artifactTypes.ts";
import { titleFromSource } from "../src/services/stage.ts";
import { gzip, tar } from "./fixtures/bundles/tar.ts";
import { HEADER, SHEET } from "./fixtures/sheets.ts";
import {
  agent,
  call,
  config,
  contentOrigin,
  enterContent,
  fetchWith,
  json,
  manifestOf,
  mcpClient,
  publish,
  storedFile,
  tool,
} from "./helpers.ts";

/** A ZIP of stored (uncompressed) files, enough for the .xlsx reader (it checks no CRC). */
function storedZip(files: Record<string, string>): Uint8Array {
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
  return new Uint8Array([...parts, ...central, ...end]);
}

const put = (auth: Record<string, string>, ref: string, body: Record<string, unknown>) =>
  call(`/api/v1/artifacts/${ref}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const publishSheet = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  publish(auth, { html: undefined, type: "sheet", title: "Q4 budget", content: SHEET, ...body });

function errorOf(r: { res: Response; body: any }) {
  expect(r.res.status).toBe(400);
  return r.body.error;
}

function payloadOf(html: string) {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html);
  expect(m, "payload block").not.toBeNull();
  return JSON.parse(m?.[1] ?? "null");
}

describe("sheets over REST", () => {
  it("publishes sheet.jsonl only, canonical, type sheet everywhere", async () => {
    const a = await agent();
    // Keys out of order, spaces, a trailing null and a final newline: stored canonical.
    const messy = `${JSON.stringify({ columns: JSON.parse(HEADER).columns, freeze: { cols: 1 }, v: 1, plinth: "sheet" })}\n[ "Apples", 3, 1.2, "=B2*C2", true ]\n["Pears",5,0.8,"=B3*C3",false]\n["Total",null,null,"=SUM(D2:D3)",null]\n`;
    const { res, body } = await publishSheet(a.auth, { content: messy });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ version: 1, type: "sheet", warnings: [] });
    const manifest = await manifestOf(body.id, 1);
    expect(manifest.map((m) => [m.path, m.content_type])).toEqual([
      ["sheet.jsonl", "text/plain; charset=utf-8"],
    ]);
    expect(await (await storedFile(body.id, 1, "sheet.jsonl"))?.text()).toBe(SHEET);
    const d = await json(await call(`/api/v1/artifacts/${body.slug}`, { headers: a.auth }));
    expect(d).toMatchObject({
      type: "sheet",
      content: SHEET,
      source_path: "sheet.jsonl",
      title: "Q4 budget",
      assets: [],
    });
    expect("html" in d).toBe(false);
    const list = await json(await call("/api/v1/artifacts?type=sheet", { headers: a.auth }));
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([body.id]);
  });

  it("has no title of its own", () => {
    expect(titleFromSource(TYPE_REGISTRY.sheet, SHEET)).toBeNull();
  });

  it("refuses every problem with the line and cell it is in", async () => {
    const a = await agent();
    const bad = [HEADER, '["Apples","three"]', '["Pears",1,"=SUMX(1)"]'].join("\n");
    const e = errorOf(await publishSheet(a.auth, { content: bad }));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe(
      "This sheet has 2 problems; the first ones are listed in details.issues",
    );
    expect(
      e.details.issues.map((i: { cell: string; message: string }) => [i.cell, i.message]),
    ).toEqual([
      ["B2", 'B2: "three" is not a number (column Qty is number)'],
      [
        "C3",
        expect.stringMatching(/^C3: SUMX is not a function sheets support \(supported: ABS, /),
      ],
    ]);
    const unknown = errorOf(
      await publishSheet(a.auth, {
        content: '{"plinth":"sheet","v":1,"columns":[{"name":"A","colour":"red"}]}',
      }),
    );
    expect(unknown.details.issues[0].message).toBe('line 1, column 1: unknown key "colour"');
    const csv = errorOf(await publishSheet(a.auth, { content: "Item,Qty\nApples,3\n" }));
    expect(csv.message).toMatch(/^content for type sheet is JSON lines: a header line/);
    expect(csv.message).toContain('content_format "csv"');
    const page = errorOf(await publishSheet(a.auth, { content: "<!doctype html><p>x</p>" }));
    expect(page.message).toMatch(/not HTML/);
    const html = errorOf(await publishSheet(a.auth, { content: undefined, html: "<p>x</p>" }));
    expect(html.message).toBe("type sheet takes sheet JSON lines in content, not html");
  });

  it("refuses every asset", async () => {
    const a = await agent();
    const e = errorOf(
      await publishSheet(a.auth, {
        assets: [{ path: "img/a.png", content: "iVBORw0KGgo=", encoding: "base64" }],
      }),
    );
    expect(e.message).toBe("A sheet has no assets: images and files are not part of a sheet");
    expect(() => checkAsset(TYPE_REGISTRY.sheet, "notes.txt", "")).toThrow(/no assets/);
    expect(() => checkAsset(TYPE_REGISTRY.sheet, "sheet.jsonl", "text/plain")).toThrow(
      /sheet.jsonl and index.html belong to the sheet/,
    );
  });

  it("refuses content_format for other types, and imports CSV and .xlsx into canonical JSON lines", async () => {
    expect(() =>
      resolveSource({ type: "doc", content: "# x", content_format: "csv" }, null),
    ).toThrow(/content_format is for type sheet/);
    expect(() => resolveSource({ html: "<p>x</p>", content_format: "jsonl" }, null)).toThrow(
      /content_format is for type sheet/,
    );
    const a = await agent();
    const csv = await publishSheet(a.auth, {
      content: "Item,Qty,Paid\nApples,3,TRUE\n=cmd,4,false\n",
      content_format: "csv",
    });
    expect(csv.res.status).toBe(201);
    expect(await (await storedFile(csv.body.id, 1, "sheet.jsonl"))?.text()).toBe(
      [
        '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"},{"name":"Paid","type":"checkbox"}]}',
        '["Apples",3,true]',
        '["\'=cmd",4,false]',
      ].join("\n"),
    );
    const book = storedZip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>N</t></is></c><c r="B1" t="inlineStr"><is><t>Double</t></is></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*2</f><v>4</v></c></row></sheetData></worksheet>',
    });
    let bin = "";
    for (const b of book) bin += String.fromCharCode(b);
    const x = await publishSheet(a.auth, { content: btoa(bin), content_format: "xlsx" });
    expect(x.res.status).toBe(201);
    expect(await (await storedFile(x.body.id, 1, "sheet.jsonl"))?.text()).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"N","type":"number"},{"name":"Double","type":"number"}]}\n[2,"=A2*2"]',
    );
    const broken = errorOf(
      await publishSheet(a.auth, { content: btoa("not a zip"), content_format: "xlsx" }),
    );
    expect(broken.message).toMatch(
      /^The xlsx file could not be imported: This is not an .xlsx file/,
    );
    // Too many rows is the row limit, never an internal error: a long CSV, and a tiny .xlsx that
    // names a far-off row in a cell reference.
    const tall = await publishSheet(a.auth, {
      content: `a\n${"1\n".repeat(150_000)}`,
      content_format: "csv",
    });
    expect(tall.res.status).toBe(400);
    expect(errorOf(tall).message).toMatch(/at most 10000 rows; this file has 150000/);
    const far = storedZip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row><row r="2"><c r="A50000000"><v>1</v></c></row></sheetData></worksheet>',
    });
    let farBin = "";
    for (const b of far) farBin += String.fromCharCode(b);
    const farRes = await publishSheet(a.auth, { content: btoa(farBin), content_format: "xlsx" });
    expect(farRes.res.status).toBe(400);
    expect(errorOf(farRes).message).toMatch(/at most 10000 rows under its header/);
    // An update imports too, and the stale base is refused as for any update.
    const up = await put(a.auth, csv.body.id, {
      content: "Item\nPlums\n",
      content_format: "csv",
      base_version: 1,
    });
    expect(up.status).toBe(200);
    expect(await (await storedFile(csv.body.id, 2, "sheet.jsonl"))?.text()).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"}]}\n["Plums"]',
    );
  });

  it("refuses an import that would spin or fill memory as invalid input, never a 500", async () => {
    const a = await agent();
    const book = (sheet: string) => {
      const zip = storedZip({
        "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheet,
      });
      let bin = "";
      for (const b of zip) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    // A <col> past 2^53 used to loop forever; it now gives no width and the sheet imports.
    const huge = await publishSheet(a.auth, {
      content: book(
        '<worksheet><cols><col min="9007199254740992" max="9007199254741200" width="10"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row></sheetData></worksheet>',
      ),
      content_format: "xlsx",
    });
    expect(huge.res.status).toBe(201);
    const pi = await publishSheet(a.auth, {
      content: book(`<worksheet><sheetData>${"<?".repeat(20_000)}`),
      content_format: "xlsx",
    });
    expect(pi.res.status).toBe(400);
    expect(errorOf(pi).message).toMatch(/XML is damaged/);
    const wide = await publishSheet(a.auth, {
      content: Array.from({ length: 6_000 }, () => Array(100).fill("1").join(",")).join("\n"),
      content_format: "csv",
    });
    expect(wide.res.status).toBe(400);
    expect(errorOf(wide).message).toMatch(/at most 1 MB; this file holds more cells/);
  });

  it("updates with content and base_version, refuses a stale base, and restores", async () => {
    const a = await agent();
    const { body: p } = await publishSheet(a.auth);
    const v2 = [HEADER, '["Apples",4,1.2,"=B2*C2",true]'].join("\n");
    expect((await put(a.auth, p.id, { content: v2, base_version: 1 })).status).toBe(200);
    const stale = await put(a.auth, p.id, { content: v2, base_version: 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.details.current_version).toBe(2);
    const html = await put(a.auth, p.id, { html: "<p>x</p>", base_version: 2 });
    expect((await json(html)).error.message).toBe(
      "This artifact is a sheet: send its sheet JSON lines as content. The type cannot change.",
    );
    const restored = await call(`/api/v1/artifacts/${p.id}/versions/1/restore`, {
      method: "POST",
      headers: { ...a.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2 }),
    });
    expect(restored.status).toBe(201);
    expect(await (await storedFile(p.id, 3, "sheet.jsonl"))?.text()).toBe(SHEET);
  });

  it("stores the canonical form from a bundle too", async () => {
    const a = await agent();
    const ticket = await json(
      await call("/api/v1/uploads", {
        method: "POST",
        headers: { ...a.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "sheet", title: "From a folder" }),
      }),
    );
    const res = await fetchWith({}, ticket.upload_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket.upload_token}` },
      body: await gzip(
        tar([{ name: "sheet.jsonl", data: `${SHEET.replace('["Pears"', '[ "Pears"')}\n` }]),
      ),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(await (await storedFile(body.id, 1, "sheet.jsonl"))?.text()).toBe(SHEET);
  });
});

describe("sheets over MCP", () => {
  it("publishes, reads and updates a sheet, and the descriptions say how", async () => {
    const a = await agent();
    const mcp = await mcpClient(a.token);
    const pub = await tool(mcp, "publish_artifact", {
      title: "Budget",
      type: "sheet",
      content: SHEET,
    });
    expect(pub.isError).toBe(false);
    expect(pub.data).toMatchObject({ version: 1, type: "sheet" });
    const got = await tool(mcp, "get_artifact", { id: pub.data.id });
    expect(got.data).toMatchObject({ type: "sheet", content: SHEET, source_path: "sheet.jsonl" });
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("publish_artifact")).toContain(
      'Pass type "sheet" with JSON lines in content',
    );
    expect(byName.get("update_artifact")).toContain("prefer edit_sheet to change a sheet's cells");
    expect(byName.get("get_artifact")).toContain('For type "sheet", content is its JSON lines');
    expect(mcp.getInstructions()).toContain(
      'For a table people sort, filter, calculate with or download (budget, tracker, list of records, price comparison), publish type "sheet" with sheet JSON lines in content instead of writing HTML: Plinth renders it as a spreadsheet.',
    );
    await mcp.close();
  });
});

describe("sheets on the content host", () => {
  async function opened(body: Record<string, unknown> = {}, vars?: Record<string, unknown>) {
    const a = await agent();
    const { body: p } = await publishSheet(a.auth, body);
    const { cookie } = await enterContent(p.id, vars ? { vars } : {});
    const get = (path: string) =>
      vars
        ? fetchWith(vars, `${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } })
        : call(`${contentOrigin(p.id)}${path}`, { headers: { Cookie: cookie ?? "" } });
    return { a, p, get };
  }

  it("serves the shell with the strict CSP and a sheet payload", async () => {
    const { get } = await opened();
    const res = await get("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self';");
    const html = await res.text();
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`,
    );
    expect(html).toContain('<main id="__plinth-sheet" class="plinth-sheet" tabindex="-1"></main>');
    expect(html).toContain('<script src="/__plinth/types/sheet/sheet.js"></script>');
    expect(payloadOf(html)).toEqual({
      v: 1,
      type: "sheet",
      path: "sheet.jsonl",
      app_origin: config().appOrigin,
      text: SHEET,
    });
  });

  it("keeps a hostile cell inside the data block", async () => {
    const evil = [HEADER, '["</script><script>alert(1)</script><!--"]'].join("\n");
    const { get } = await opened({ content: evil });
    const html = await (await get("/")).text();
    expect(html.match(/<script/gi)?.length).toBe(2);
    expect(payloadOf(html).text).toBe(evil);
  });

  it("serves sheet.jsonl as plain text with no script, and older versions", async () => {
    const { a, p, get } = await opened();
    const v2 = [HEADER, '["Plums"]'].join("\n");
    await put(a.auth, p.id, { content: v2, base_version: 1 });
    const raw = await get("/sheet.jsonl");
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("content-security-policy")).toBe(
      contentCsp(config(), { scripts: "none" }),
    );
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await raw.text()).toBe(v2);
    expect(payloadOf(await (await get("/__plinth/v/1/")).text()).text).toBe(SHEET);
  });

  it("serves the renderer files to the artifact, never on the app host", async () => {
    const { p } = await opened();
    const js = await call(`${contentOrigin(p.id)}/__plinth/types/sheet/sheet.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    const css = await call(`${contentOrigin(p.id)}/__plinth/types/sheet/sheet.css`);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    expect((await call(`${contentOrigin(p.id)}/__plinth/types/sheet/doc.js`)).status).toBe(404);
    expect((await call("/__plinth-renderers/sheet/sheet.js")).status).toBe(404);
  });

  it("keeps the sandbox on the shell under opaque isolation", async () => {
    const { get } = await opened({}, { CONTENT_ISOLATION: "opaque" });
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox [^;]*allow-scripts/);
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });
});

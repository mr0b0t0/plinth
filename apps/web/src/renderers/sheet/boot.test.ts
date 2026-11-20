// The sheet renderer, booted from a real shell's payload: the grid it builds (formats, links,
// checkboxes, errors, frozen columns, chunks), what it does with hostile cells, column names and
// titles (only fixed elements and attributes reach the DOM), sort, filter and the formula bar, and
// the app messages it acts on (only from its parent at the app origin).
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { CHUNK_ROWS } from "./grid.ts";
import { readSheetAppMessage } from "./protocol.ts";

const APP = "https://plinth.example.com";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 200 },
    { name: "Qty", type: "number" },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Share", type: "number", format: { style: "percent", decimals: 1 } },
    { name: "When", type: "date" },
    { name: "Paid", type: "checkbox" },
    { name: "Stage", type: "select", options: ["new", "done"] },
    { name: "Site", type: "url" },
  ],
  freeze: { cols: 1 },
});
const SHEET = [
  HEADER,
  '["Apples",3,1.25,0.125,"2026-01-02",true,"new","https://example.com/a"]',
  '["Pears",5,"=B3*0.2",0.5,"=E2+1",false,"done"]',
  '["Total","=SUM(B2:B3)","=1/0","=A5","=TODAY()"]',
  '["Loop","=B5+1"]',
].join("\n");

function mount(text = SHEET, title = "Budget") {
  const html = typedShellHtml(TYPE_REGISTRY.sheet, { title, text, base: "", appOrigin: APP });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.title = title;
  document.body.innerHTML = main + data;
}

interface Framed {
  win: Window;
  target: EventTarget;
  parent: { postMessage: ReturnType<typeof vi.fn> };
  print: ReturnType<typeof vi.fn>;
}

function framed(): Framed {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const print = vi.fn();
  const win = {
    document,
    parent,
    print,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent, print };
}

const msg = (m: Record<string, unknown>) => ({
  source: RENDERER_MESSAGE_SOURCE,
  v: RENDERER_PROTOCOL_VERSION,
  ...m,
});
const send = (f: Framed, data: unknown, origin = APP, source: unknown = f.parent) =>
  f.target.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
const cell = (a: string) => document.getElementById(`__plinth-cell-${a}`) as HTMLElement;
const text = (a: string) => cell(a).textContent;

let stop: (() => void) | undefined;
beforeEach(() => {
  document.documentElement.removeAttribute("data-ready");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
});

describe("the grid", () => {
  it("computes formulas and shows each column's format", () => {
    mount();
    stop = boot(framed().win, { today: 46_000 });
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(document.documentElement.getAttribute("data-rows")).toBe("4");
    expect(text("B4")).toBe("8");
    expect(text("C2")).toMatch(/1[.,]25/);
    expect(text("C2")).toContain("€");
    expect(text("D2")).toMatch(/12[.,]5\s?%/);
    expect(text("E2")).toBe("2026-01-02");
    expect(text("E3")).toBe("2026-01-03");
    expect(text("E4")).toBe("2025-12-09");
    expect(cell("F2").querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("Yes");
    expect(cell("F3").querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("No");
    const err = cell("C4").querySelector(".plinth-sheet__error") as HTMLElement;
    expect(err.textContent).toBe("#DIV/0!");
    expect(err.title).toBe("Division by zero");
    expect(text("B5")).toBe("#CYCLE!");
    const a = cell("H2").querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.com/a");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer nofollow");
    expect(cell("A1").getAttribute("aria-sort")).toBe("none");
  });

  it("keeps frozen columns in view by their left offsets", () => {
    mount();
    stop = boot(framed().win);
    expect(cell("A2").classList.contains("plinth-sheet__frozen")).toBe(true);
    expect(cell("A2").style.left).toBe("48px");
    expect(cell("B2").classList.contains("plinth-sheet__frozen")).toBe(false);
  });

  it("puts rows in chunks of 200", () => {
    const rows = Array.from({ length: CHUNK_ROWS * 2 + 5 }, (_, i) => `["r${i}",${i}]`);
    mount([HEADER, ...rows].join("\n"));
    stop = boot(framed().win);
    const bodies = document.querySelectorAll("tbody.plinth-sheet__chunk");
    expect([...bodies].map((b) => b.children.length)).toEqual([200, 200, 5]);
  });

  it("shows the raw cell in the formula bar", () => {
    mount();
    stop = boot(framed().win);
    const fx = () => document.querySelector(".plinth-sheet__fx")?.textContent;
    expect(fx()).toBe("A2Apples");
    cell("B4").focus();
    expect(fx()).toBe("B4=SUM(B2:B3)");
    cell("F2").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fx()).toBe("F2TRUE");
  });

  it("sorts by a header (ascending, descending, off) and filters, saving nothing", () => {
    mount();
    stop = boot(framed().win);
    const order = () =>
      [...document.querySelectorAll("tbody tr")].map((r) => (r as HTMLElement).dataset.row);
    const sortQty = () => (cell("B1").querySelector("button") as HTMLButtonElement).click();
    sortQty();
    expect(cell("B1").getAttribute("aria-sort")).toBe("ascending");
    // 3, 5, 8, then the error last.
    expect(order()).toEqual(["2", "3", "4", "5"]);
    sortQty();
    expect(cell("B1").getAttribute("aria-sort")).toBe("descending");
    expect(order()).toEqual(["4", "3", "2", "5"]);
    sortQty();
    expect(cell("B1").getAttribute("aria-sort")).toBe("none");
    expect(order()).toEqual(["2", "3", "4", "5"]);
    const input = document.querySelector(".plinth-sheet__filter-input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Filter rows");
    // The count shows only while a filter is set.
    expect(document.querySelector(".plinth-sheet__count")?.textContent).toBe("");
    input.value = "pear";
    input.dispatchEvent(new Event("input"));
    const shown = [...document.querySelectorAll("tbody tr")].filter(
      (r) => !(r as HTMLElement).hidden,
    );
    expect(shown.map((r) => (r as HTMLElement).dataset.row)).toEqual(["3"]);
    expect(document.querySelector(".plinth-sheet__count")?.textContent).toBe("1 of 4 rows");
  });

  it("says when the browser's budget ran out", () => {
    mount();
    stop = boot(framed().win, { budget: 5 });
    expect(document.documentElement.hasAttribute("data-exhausted")).toBe(true);
    expect(document.querySelector(".plinth-sheet__note")?.textContent).toMatch(/not calculated/);
    expect(text("B4")).toBe("#LIMIT!");
  });

  it("shows a fallback for a payload it cannot read", () => {
    mount('{"plinth":"sheet","v":1,"columns":[]}');
    stop = boot(framed().win);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
    expect(document.getElementById("__plinth-sheet")?.textContent).toBe(
      "This sheet could not be shown.",
    );
  });
});

describe("hostile text", () => {
  const ALLOWED = new Set(
    "main div span h1 p label input button table colgroup col thead tbody tr th td a script".split(
      " ",
    ),
  );

  it("never becomes markup, script or a link outside the allowlist", () => {
    const evil = [
      '<img src=x onerror="window.__pwned=1">',
      "</script><script>window.__pwned=1</script>",
      "<svg onload=alert(1)>",
      '"><a id="plinth" href="javascript:alert(1)">x</a>',
    ];
    const header = JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [
        { name: evil[0], type: "text" },
        { name: "Link", type: "url" },
      ],
    });
    // A payload that skipped the server's check: url cells must pass the link rule again here.
    const rows = [
      JSON.stringify([evil[1], "https://ok.example"]),
      JSON.stringify([evil[2], "javascript:alert(1)"]),
      JSON.stringify([evil[3], "java&#115;cript:alert(1)"]),
    ];
    const text = [header, ...rows].join("\n");
    // Bypass the parser's url rule as a forged payload would.
    const html = typedShellHtml(TYPE_REGISTRY.sheet, {
      title: evil[0] as string,
      text,
      base: "",
      appOrigin: APP,
    });
    const main = /<main [^>]*><\/main>/.exec(html)?.[0] as string;
    const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0] as string;
    document.body.innerHTML = main + data;
    stop = boot(framed().win);
    // The forged rows fail the parser, so the page shows the fallback; the valid parts render as text.
    const root = document.getElementById("__plinth-sheet") as HTMLElement;
    for (const e of [root, ...root.querySelectorAll("*")]) {
      expect(ALLOWED.has(e.tagName.toLowerCase()), e.tagName).toBe(true);
      for (const a of [...e.attributes]) {
        expect(a.name.startsWith("on"), a.name).toBe(false);
        if (a.name === "href") expect(a.value).toMatch(/^(https?:|mailto:)/);
        if (a.name === "id") expect(a.value).toMatch(/^__plinth-/);
      }
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders hostile cells and names as text when the sheet is valid", () => {
    const header = JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [{ name: '<img src=x onerror="window.__pwned=1">' }, { name: "Link", type: "url" }],
    });
    const rows = [
      JSON.stringify(["</script><script>window.__pwned=1</script>", "https://ok.example/?q=<b>"]),
      JSON.stringify(["<svg onload=alert(1)>", null]),
      JSON.stringify(['\'=HYPERLINK("https://evil.example")', null]),
    ];
    mount([header, ...rows].join("\n"), '<img src=x onerror="alert(1)">');
    stop = boot(framed().win);
    expect(document.documentElement.getAttribute("data-ready")).toBe("ok");
    expect(cell("A1").textContent).toBe('<img src=x onerror="window.__pwned=1">');
    expect(text("A2")).toBe("</script><script>window.__pwned=1</script>");
    expect(text("A3")).toBe("<svg onload=alert(1)>");
    expect(text("A4")).toBe('=HYPERLINK("https://evil.example")');
    expect(document.querySelector(".plinth-sheet__title")?.textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
    const root = document.getElementById("__plinth-sheet") as HTMLElement;
    expect(root.querySelectorAll("img, svg, script").length).toBe(0);
    for (const e of root.querySelectorAll("*")) {
      for (const a of [...e.attributes]) expect(a.name.startsWith("on"), a.name).toBe(false);
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("app messages", () => {
  it("prints and downloads only for its parent at the app origin", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const created: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created.push("blob:x");
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    send(f, msg({ type: "print" }), "https://evil.example");
    send(f, msg({ type: "print" }), APP, {});
    send(f, msg({ type: "export", format: "pdf" }));
    expect(f.print).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    send(f, msg({ type: "print" }));
    expect(f.print).toHaveBeenCalledTimes(1);
    send(f, msg({ type: "export", format: "csv" }));
    send(f, msg({ type: "export", format: "xlsx" }));
    expect(created).toHaveLength(2);
    expect(clicks).toHaveBeenCalledTimes(2);
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });

  it("reads only well-formed messages", () => {
    expect(readSheetAppMessage(msg({ type: "export", format: "csv" }))).toEqual({
      type: "export",
      format: "csv",
    });
    expect(readSheetAppMessage(msg({ type: "export", format: "xlsm" }))).toBeNull();
    expect(readSheetAppMessage({ type: "print" })).toBeNull();
    expect(readSheetAppMessage(msg({ type: "edit", on: true }))).toBeNull();
    expect(readSheetAppMessage(null)).toBeNull();
  });
});

// Editing a design system on its page (edit.ts), alone (solo): the token controls write only
// grammar-valid values in the form each is stored in; dark values, descriptions and tokens are
// added and removed with struct ops; a token in use cannot be removed; the guidelines and
// descriptions are formatted text, never Markdown; a component's status is in its ⋯; renames,
// component code, fonts and settings are an agent's, with Ask an agent posting a structural anchor;
// the draft's files come from its base version; a system too large to edit says so; and each
// example shows only its rendered preview.
import {
  designSystemToLive,
  parseDesignSystem,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { FIXTURE } from "./testFixture.ts";

const APP = "https://plinth.example.com";
// biome-ignore lint/suspicious/noExplicitAny: test fixtures are walked by path
type Json = Record<string, any>;

const SYSTEM = (): Json => {
  const ds = JSON.parse(JSON.stringify(FIXTURE)) as Json;
  ds.tokens.color.obj = { $value: { colorSpace: "oklch", components: [0.5, 0.1, 250], alpha: 1 } };
  ds.tokens.space.o = { $value: { value: 16, unit: "px" } };
  ds.tokens.weight = { $type: "fontWeight", w: { $value: 600 } };
  return ds;
};

function mount(ds: Json, live?: "room") {
  const html = typedShellHtml(TYPE_REGISTRY.design_system, {
    title: "T",
    text: JSON.stringify(ds),
    base: "",
    appOrigin: APP,
    ...(live ? { live } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

let posted: Json[] = [];
let stop: (() => void) | null = null;
beforeEach(() => {
  posted = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((m: unknown) => {
    posted.push(m as Json);
  });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  for (const n of document.head.querySelectorAll("link, style")) n.remove();
});

const send = (m: Json) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...m },
      origin: APP,
      source: window.parent as never,
    }),
  );
const tick = () => new Promise((r) => setTimeout(r, 0));
const root = () => document.getElementById("__plinth-design_system") as HTMLElement;
const row = (path: string) =>
  root().querySelector<HTMLElement>(`.ds-token[data-path="${path}"]`) as HTMLElement;

/** The draft as the frame hands it to the app (the storage form), parsed. */
let drafts = 0;
function draft(): Json {
  const nonce = `n${++drafts}`.padEnd(20, "n");
  send({ type: "collect", nonce });
  const d = posted.find((m) => m.type === "draft" && m.nonce === nonce);
  if (!d) throw new Error("no draft");
  return JSON.parse(d.text as string);
}

function setField(el: HTMLInputElement | HTMLSelectElement, value: string, event = "change") {
  el.value = value;
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

function editOn(ds: Json = SYSTEM(), base = 3) {
  mount(ds);
  stop = boot(window);
  send({ type: "edit", on: true, base });
}

/** Open a row's ⋯ menu and choose `label` (a sub-item after `then`). */
function choose(container: Element, label: string, then?: string) {
  const button = container.querySelector<HTMLButtonElement>(".plinth-doc__menu-button");
  button?.click();
  const items = () => [...document.querySelectorAll<HTMLElement>(".plinth-doc__menu-item")];
  const item = items().find((i) => i.textContent === label);
  if (!item)
    throw new Error(
      `no ${label}: ${items()
        .map((i) => i.textContent)
        .join(", ")}`,
    );
  item.click();
  if (then) {
    const sub = items().find((i) => i.textContent === then);
    if (!sub) throw new Error(`no ${then}`);
    sub.click();
  }
}

describe("token values", () => {
  it("write a colour as typed, or the picked one as hex, and keep an object's colour space", () => {
    editOn();
    const bg = row("color.bg");
    const [light, dark] = [...bg.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(light?.value).toBe("#ffffff");
    expect(dark?.value).toBe("#0d1117");
    setField(light as HTMLInputElement, "oklch(0.98 0.01 250)");
    expect(draft().tokens.color.bg.$value).toBe("oklch(0.98 0.01 250)");
    const swatch = row("color.fg").querySelector<HTMLInputElement>('input[type="color"]');
    setField(swatch as HTMLInputElement, "#2f4ac0", "input");
    expect(draft().tokens.color.fg.$value).toBe("#2f4ac0");
    // An object colour keeps its space and alpha: the picked sRGB colour in oklch components.
    const pick = row("color.obj").querySelector<HTMLInputElement>('input[type="color"]');
    setField(pick as HTMLInputElement, "#ff0000", "input");
    const obj = draft().tokens.color.obj.$value;
    expect(obj.colorSpace).toBe("oklch");
    expect(obj.alpha).toBe(1);
    expect(obj.components[0]).toBeCloseTo(0.62796, 4);
    expect(Object.keys(obj)).toEqual(["colorSpace", "components", "alpha"]);
  });

  it("keeps a dimension object an object, and refuses a value the grammar does not take", () => {
    editOn();
    const o = row("space.o");
    const [n] = [...o.querySelectorAll<HTMLInputElement>("input.ds-field--number")];
    setField(n as HTMLInputElement, "24");
    expect(draft().tokens.space.o.$value).toEqual({ value: 24, unit: "px" });
    // The object form takes px and rem only.
    expect([...o.querySelectorAll("option")].map((x) => x.textContent)).toEqual(["px", "rem"]);
    const fg = row("color.fg").querySelector<HTMLInputElement>('input[type="text"]');
    setField(fg as HTMLInputElement, "red; background: url(x)");
    expect(draft().tokens.color.fg.$value).toBe("#1f2328");
    expect(document.querySelector(".ds-notice")?.textContent).toMatch(/color\.fg/);
  });

  it("show numbers as stored, in text fields with the decimal keypad where they cannot be negative", () => {
    const ds = SYSTEM();
    ds.tokens.font.body.$value.letterSpacing = "-0.01em";
    editOn(ds);
    const fields = [
      ...row("font.body").querySelectorAll<HTMLInputElement>("input.ds-field--number"),
    ];
    const [size, line, spacing] = fields;
    // Never a locale number field, which would show "1,5" for 1.5.
    expect(fields.every((f) => f.type === "text")).toBe(true);
    expect(line?.value).toBe("1.5");
    expect([size?.inputMode, line?.inputMode, spacing?.inputMode]).toEqual([
      "decimal",
      "decimal",
      "text",
    ]);
    // A decimal comma, as a phone's keypad may type it, reads as a point.
    setField(line as HTMLInputElement, "1,4");
    expect(draft().tokens.font.body.$value.lineHeight).toBe(1.4);
  });

  it("set a weight with one select, keeping a keyword the token has as its own option", () => {
    const ds = SYSTEM();
    ds.tokens.weight.k = { $value: "bold" };
    editOn(ds);
    const w = row("weight.w");
    expect(w.querySelectorAll(".ds-token__controls :is(input, select)")).toHaveLength(1);
    setField(w.querySelector("select") as HTMLSelectElement, "500");
    expect(draft().tokens.weight.w.$value).toBe(500);
    const k = row("weight.k").querySelector("select") as HTMLSelectElement;
    expect(k.value).toBe("bold");
    expect([...k.options].map((o) => o.value).at(-1)).toBe("bold");
    setField(k, "700");
    expect(draft().tokens.weight.k.$value).toBe(700);
  });

  it("write a cubic Bézier from one field, and refuse anything but four numbers", () => {
    const ds = SYSTEM();
    ds.tokens.ease = { $type: "cubicBezier", $value: [0.4, 0, 0.2, 1] };
    editOn(ds);
    const f = row("ease").querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement;
    expect(f.value).toBe("0.4, 0, 0.2, 1");
    setField(f, "0.2 0 0 1");
    expect(draft().tokens.ease.$value).toEqual([0.2, 0, 0, 1]);
    setField(row("ease").querySelector('input[type="text"]') as HTMLInputElement, "0.2, 0");
    expect(draft().tokens.ease.$value).toEqual([0.2, 0, 0, 1]);
    expect(document.querySelector(".ds-notice")).not.toBeNull();
  });

  it("a colour token's sample is its picker, with only its text field beside it", () => {
    editOn();
    const bg = row("color.bg");
    // Light and dark: each sample holds its picker, and no "Light" or "Dark" on the row.
    const pickers = bg.querySelectorAll(".ds-token__pair > .ds-sample > input[type='color']");
    expect(pickers).toHaveLength(2);
    expect(bg.querySelectorAll(".ds-token__controls input[type='color']")).toHaveLength(0);
    expect(bg.querySelector(".ds-token__side-name")).toBeNull();
    setField(pickers[1] as HTMLInputElement, "#101010", "input");
    expect(draft().themes.dark.color.bg.$value).toBe("#101010");
  });

  it("names another token, and goes back to the value it stands for", () => {
    editOn();
    choose(row("color.fg"), "Use another token", "color.bg");
    expect(draft().tokens.color.fg.$value).toBe("{color.bg}");
    choose(row("color.accent"), "Use a value");
    expect(draft().tokens.color.accent.$value).toBe("#3355ff");
  });
});

describe("keys", () => {
  it("add and remove a dark value", () => {
    editOn();
    choose(row("color.brand.500"), "Add a dark value");
    expect(draft().themes.dark.color.brand["500"].$value).toBe("#3355ff");
    expect(
      row("color.brand.500").querySelectorAll('.ds-token__controls input[type="text"]'),
    ).toHaveLength(2);
    choose(row("color.brand.500"), "Remove dark value");
    expect(draft().themes.dark.color.brand).toBeUndefined();
  });

  it("add a description, change it, and remove it by emptying it", () => {
    editOn();
    choose(row("color.bg"), "Add a description");
    const f = row("color.bg").querySelector<HTMLInputElement>(".ds-token__desc-field");
    setField(f as HTMLInputElement, "The page ground");
    expect(draft().tokens.color.bg.$description).toBe("The page ground");
    const again = row("color.bg").querySelector<HTMLInputElement>(".ds-token__desc-field");
    setField(again as HTMLInputElement, "Ground");
    expect(draft().tokens.color.bg.$description).toBe("Ground");
    setField(row("color.bg").querySelector(".ds-token__desc-field") as HTMLInputElement, "");
    expect("$description" in draft().tokens.color.bg).toBe(false);
  });

  it("add a token to a group, and remove one only when nothing uses it", async () => {
    editOn();
    const group = root().querySelector('.ds-group[data-group="color"]') as HTMLElement;
    choose(group, "Add a token");
    const form = group.querySelector("form") as HTMLFormElement;
    (form.querySelector("input") as HTMLInputElement).value = "line";
    form.requestSubmit();
    expect(draft().tokens.color.line).toEqual({ $value: "#000000" });
    await tick();
    expect(row("color.line")).toBeTruthy();
    // color.brand.500 is color.accent's target: it stays, and the page says why.
    choose(row("color.brand.500"), "Remove");
    expect(document.querySelector(".ds-notice span")?.textContent).toBe(
      "Used by color.accent. Change those first.",
    );
    choose(row("color.line"), "Remove");
    const confirm = [...row("color.line").querySelectorAll<HTMLButtonElement>(".ds-form button")];
    confirm.find((b) => b.textContent === "Remove")?.click();
    expect(draft().tokens.color.line).toBeUndefined();
  });

  it("set a component's status from its ⋯, the pill staying beside the name", () => {
    editOn();
    const menu = (id: string) =>
      root().querySelector(`#ds-components-${id} > .ds-menu`) as HTMLElement;
    choose(menu("badge"), "Status", "Deprecated");
    expect(draft().components[1].status).toBe("deprecated");
    choose(menu("button"), "Status", "Beta");
    expect(draft().components[0].status).toBe("beta");
    expect(root().querySelector(".ds-component select")).toBeNull();
  });

  it("change the name in place, never to nothing", () => {
    editOn();
    const name = root().querySelector<HTMLInputElement>(".ds-name") as HTMLInputElement;
    expect(name.value).toBe("Acme UI");
    setField(name, "Acme Two");
    expect(draft().name).toBe("Acme Two");
    setField(root().querySelector(".ds-name") as HTMLInputElement, " ");
    expect(draft().name).toBe("Acme Two");
  });
});

describe("what stays with agents", () => {
  it("asks an agent to rename a token or a group, change a component, or the fonts and settings", () => {
    editOn();
    choose(row("color.bg"), "Rename: Ask an agent");
    choose(
      root().querySelector('.ds-group[data-group="color"]') as Element,
      "Rename: Ask an agent",
    );
    choose(root().querySelector("#ds-components-button > .ds-menu") as Element, "Ask an agent");
    // The header has one ⋯, and no line of fonts and settings.
    const header = root().querySelector(".ds-header") as Element;
    expect(header.querySelectorAll("button:not(.plinth-doc__menu-button)")).toHaveLength(0);
    choose(header, "Ask an agent");
    expect(posted.filter((m) => m.type === "ask").map((m) => m.anchor)).toEqual([
      { key: "token:color.bg", text: "color.bg" },
      { key: "group:color", text: "color" },
      { key: "component:button", text: "Button" },
      { key: "system:settings", text: "Fonts and settings" },
    ]);
  });

  it("never names or places a token only the draft has: just its kind, with no words", async () => {
    editOn();
    const group = root().querySelector('.ds-group[data-group="color"]') as HTMLElement;
    choose(group, "Add a token");
    const form = group.querySelector("form") as HTMLFormElement;
    (form.querySelector("input") as HTMLInputElement).value = "acme-rebrand-2027";
    form.requestSubmit();
    await tick();
    const added = row("color.acme-rebrand-2027");
    choose(added, "Rename: Ask an agent");
    // A published token next to it keeps its name.
    choose(row("color.bg"), "Rename: Ask an agent");
    const asks = posted.filter((m) => m.type === "ask");
    expect(asks.map((m) => m.anchor)).toEqual([
      { key: "token", text: "" },
      { key: "token:color.bg", text: "color.bg" },
    ]);
    expect(JSON.stringify(asks)).not.toContain("rebrand");
  });

  it("keys a published name too long for a key by its place in the published version", async () => {
    const ds = SYSTEM();
    const seg = "x".repeat(64);
    ds.tokens.zz = { $type: "color", [seg]: { [seg]: { $value: "#654321" } } };
    const path = `zz.${seg}.${seg}`;
    const parsed = parseDesignSystem(JSON.stringify(ds));
    if (!parsed.ok) throw new Error("fixture");
    const at = parsed.value.tokens.findIndex((t) => t.path === path);
    expect(at).toBeGreaterThan(0);
    editOn(ds);
    // A token added on the page before it moves its place in the draft, not in the version.
    const group = root().querySelector('.ds-group[data-group="color"]') as HTMLElement;
    choose(group, "Add a token");
    const form = group.querySelector("form") as HTMLFormElement;
    (form.querySelector("input") as HTMLInputElement).value = "aaa";
    form.requestSubmit();
    await tick();
    choose(row(path), "Rename: Ask an agent");
    const ask = posted.filter((m) => m.type === "ask").at(-1);
    expect(ask?.anchor).toEqual({ key: `token:${at}`, text: path });
  });

  it("says once, when editing starts, that a system published from code will not keep page changes in its next publish from code", () => {
    mount(SYSTEM());
    stop = boot(window);
    send({ type: "edit", on: true, base: 3 });
    expect(document.querySelector(".ds-notice")).toBeNull();
    send({ type: "edit", on: false });
    send({ type: "edit", on: true, base: 3, code: true });
    const notice = document.querySelector(".ds-notice") as HTMLElement;
    expect(notice.textContent).toContain(
      "This design system is published from code. Its next publish from code won't include changes made here.",
    );
    // Editing goes on; the notice has Dismiss only (Ask an agent is in the rows' menus).
    expect(row("color.bg").classList.contains("ds-token--editing")).toBe(true);
    expect([...notice.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss"]);
  });

  it("shows component code only as its rendered preview, and no source anywhere", () => {
    editOn();
    expect(root().querySelectorAll("pre, textarea")).toHaveLength(0);
    const figure = root().querySelector(".ds-example") as HTMLElement;
    expect(figure.querySelectorAll("button, [role=tab], [role=tablist]")).toHaveLength(0);
    expect(figure.querySelector("iframe")).toBeTruthy();
    expect(root().textContent).not.toContain("acme-btn--primary");
  });

  it("edits guidelines and descriptions as formatted text, with no Markdown shown", () => {
    editOn();
    const g = root().querySelector<HTMLElement>(
      '#ds-overview [data-text="guidelines"]',
    ) as HTMLElement;
    expect(g.classList.contains("plinth-doc--editing")).toBe(true);
    expect(g.querySelector("h1")?.firstChild?.textContent).toBe("Using Acme UI");
    expect(g.textContent).not.toContain("# ");
    const usage = root().querySelector('[data-text="component:button:usage"]') as HTMLElement;
    expect(usage.querySelector("li")?.textContent).toBe("Do: one per view");
    // The badge has no description: its place is there to write one in.
    expect(root().querySelector('[data-text="component:badge:description"]')).toBeTruthy();
  });

  it("names an empty text's place by what it holds: Description, Usage", () => {
    editOn();
    const place = (key: string) =>
      root().querySelector(`[data-text="${key}"] .plinth-doc__placeholder`)?.textContent;
    expect(place("component:badge:description")).toBe("Description");
    expect(place("component:badge:usage")).toBe("Usage");
    expect(
      root().querySelector<HTMLElement>('[data-text="component:badge:usage"]')?.dataset.placeholder,
    ).toBe("Usage");
  });
});

describe("files and size", () => {
  it("draws the draft with its base version's files: fonts and examples' images", () => {
    editOn(SYSTEM(), 3);
    const faces = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(faces).toContain('url("/__plinth/v/3/fonts/acme-mono.woff2")');
    const frame = root().querySelector<HTMLIFrameElement>(".ds-preview__frame");
    expect(frame?.srcdoc).toContain('<base href="/__plinth/v/3/">');
  });

  it("is not edited on the page past the projection's line cap, and says so", async () => {
    const ds = SYSTEM();
    // Many tokens, each a few projection lines: past 200,000 lines.
    const big: Json = { $type: "number" };
    for (let i = 0; i < 2000; i++) big[`n${i}`] = { $value: i, $description: "x" };
    ds.tokens.big = big;
    ds.guidelines = "\n".repeat(200_000);
    expect(designSystemToLive(JSON.stringify(ds)).split("\n").length).toBeGreaterThan(200_000);
    editOn(ds);
    await tick();
    const live = posted.filter((m) => m.type === "live").at(-1);
    expect(live).toMatchObject({ editing: false, unavailable: "too_large" });
    expect(document.querySelector(".ds-notice")?.textContent).toMatch(/too large to edit/);
  });
});

describe("typing the page cannot write as typed (solo)", () => {
  /** Opens `sel`'s first `tag`, types what cannot be written as typed (overlapping marks). */
  function stick(sel: string, tag = "p") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    root()
      .querySelector<HTMLElement>(`${sel} ${tag}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const el = root().querySelector<HTMLElement>(`${sel} [contenteditable='true']`);
    if (!el) throw new Error("no open block");
    el.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(400);
    vi.useRealTimers();
  }
  const collect = () => {
    const nonce = `n${++drafts}`.padEnd(20, "n");
    send({ type: "collect", nonce });
    return posted.find((m) => m.type === "draft" && m.nonce === nonce) as Json;
  };

  it("the app's kept copy has such typing in the guidelines, and it is never published as is", () => {
    editOn();
    stick('#ds-overview [data-text="guidelines"]');
    const d = collect();
    expect(d.unsavable).toBe(true);
    expect(JSON.parse(d.text).guidelines).toBe("# Using Acme UI\n\nabc");
  });

  it("and in a component's description, in the value's place", () => {
    editOn();
    stick('[data-text="component:button:description"]');
    const d = collect();
    expect(d.unsavable).toBe(true);
    expect(JSON.parse(d.text).components[0].description).toBe("abc");
    // The rest of the system is as it was.
    expect(JSON.parse(d.text).guidelines).toBe(FIXTURE.guidelines);
  });
});

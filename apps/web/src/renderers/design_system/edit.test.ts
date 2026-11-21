// Editing a design system on its page (edit.ts), alone (solo): the token controls write only
// grammar-valid values in the form each is stored in; dark values, descriptions and tokens are
// added and removed with struct ops; a token in use cannot be removed; the guidelines and
// descriptions are formatted text, never Markdown; a component's status is a select; renames,
// component code, fonts and settings are an agent's, with Ask an agent posting a structural anchor;
// the draft's files come from its base version; a system too large to edit says so; and each
// example shows only its rendered preview.
import {
  designSystemToLive,
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
    const [n] = [...o.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    setField(n as HTMLInputElement, "24");
    expect(draft().tokens.space.o.$value).toEqual({ value: 24, unit: "px" });
    // The object form takes px and rem only.
    expect([...o.querySelectorAll("option")].map((x) => x.textContent)).toEqual(["px", "rem"]);
    const fg = row("color.fg").querySelector<HTMLInputElement>('input[type="text"]');
    setField(fg as HTMLInputElement, "red; background: url(x)");
    expect(draft().tokens.color.fg.$value).toBe("#1f2328");
    expect(document.querySelector(".ds-notice")?.textContent).toMatch(/color\.fg/);
  });

  it("set a weight by number or keyword, whichever was used last", () => {
    editOn();
    const w = row("weight.w");
    setField(w.querySelector("select") as HTMLSelectElement, "bold");
    expect(draft().tokens.weight.w.$value).toBe("bold");
    setField(w.querySelector('input[type="number"]') as HTMLInputElement, "500");
    expect(draft().tokens.weight.w.$value).toBe(500);
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
    choose(row("color.brand.500"), "Remove the dark value");
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
    choose(row("color.brand.500"), "Remove this token");
    expect(document.querySelector(".ds-notice span")?.textContent).toBe(
      "Used by color.accent. Change those first.",
    );
    choose(row("color.line"), "Remove this token");
    const confirm = [...row("color.line").querySelectorAll<HTMLButtonElement>(".ds-form button")];
    confirm.find((b) => b.textContent === "Remove")?.click();
    expect(draft().tokens.color.line).toBeUndefined();
  });

  it("set a component's status", () => {
    editOn();
    const bar = root().querySelector("#ds-components-badge .ds-component__bar") as HTMLElement;
    setField(bar.querySelector("select") as HTMLSelectElement, "deprecated");
    expect(draft().components[1].status).toBe("deprecated");
    const button = root().querySelector("#ds-components-button .ds-component__bar select");
    setField(button as HTMLSelectElement, "beta");
    expect(draft().components[0].status).toBe("beta");
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
    choose(
      root().querySelector("#ds-components-button .ds-component__bar") as Element,
      "Ask an agent to change this component",
    );
    root()
      .querySelector<HTMLButtonElement>(
        '.ds-settings button[aria-label="Change fonts or settings: Ask an agent"]',
      )
      ?.click();
    expect(posted.filter((m) => m.type === "ask").map((m) => m.anchor)).toEqual([
      { key: "token:color.bg", text: "color.bg" },
      { key: "group:color", text: "color" },
      { key: "component:button", text: "Button" },
      { key: "system:settings", text: "Fonts and settings" },
    ]);
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

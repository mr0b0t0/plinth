// The value controls of a design system's token rows in edit mode (docs/spec.md "Design systems"):
// one control per token type, each writing the whole $value in the form it is stored in (a colour
// string stays a string, a colour object keeps its space and alpha, a dimension object stays an
// object) unless the person picks another form. Colours have a swatch that opens the browser's
// picker, with a text field beside it for any colour the grammar takes; an object colour converts
// the picked sRGB colour into its own space (colorSpaces.ts). A composite (shadow, border,
// typography) has one field per part, each by the rules of its own type, and a part that names
// another token picks one. Built with createElement only; every value reaches the page through
// .value or textContent. The room checks every value with the publish grammar again.
import {
  type ColorSpace,
  componentsOf,
  type DsTokenType,
  dsAliasOf,
  fromSrgb,
  hexToSrgb,
  srgbToHex,
  type Triple,
  toSrgb,
} from "@plinth/shared";

export interface ControlContext {
  doc: Document;
  /** What the controls are named after ("color.brand.500, dark"). */
  label: string;
  /** Tokens of `type` a value (or a part) may name, for the pickers. */
  targets(type: DsTokenType): string[];
  /** The person set a new value. */
  change(value: unknown): void;
  /** Ask before a change of form the person may not mean: `run` only on yes. */
  confirm(question: string, yes: string, run: () => void): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

let ids = 0;
const nextId = () => `ds-control-${++ids}`;

function input(ctx: ControlContext, type: string, label: string, value: string): HTMLInputElement {
  const i = ctx.doc.createElement("input");
  i.type = type;
  i.className = `ds-field ds-field--${type}`;
  i.value = value;
  i.setAttribute("aria-label", `${ctx.label}: ${label}`);
  i.id = nextId();
  return i;
}

function select(
  ctx: ControlContext,
  label: string,
  options: readonly (readonly [string, string])[],
  value: string,
): HTMLSelectElement {
  const s = ctx.doc.createElement("select");
  s.className = "ds-field ds-field--select";
  s.setAttribute("aria-label", `${ctx.label}: ${label}`);
  for (const [v, text] of options) {
    const o = ctx.doc.createElement("option");
    o.value = v;
    o.textContent = text;
    s.append(o);
  }
  s.value = value;
  return s;
}

function group(ctx: ControlContext, ...children: HTMLElement[]): HTMLElement {
  const g = ctx.doc.createElement("div");
  g.className = "ds-control";
  g.append(...children);
  return g;
}

/** A finite number from a field, or null. */
function numberOf(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `o` with `key` set to `value`, keeping the order of its keys (a new key goes last). */
function withKey(o: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = k === key ? value : o[k];
  if (!(key in o)) out[key] = value;
  return out;
}

// ---------- colours ----------

const NUM = String.raw`(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)`;
const SEP = String.raw`[\s,/]+`;
const FN_RE = new RegExp(
  `^(rgba?|oklch|oklab|color)\\(\\s*(srgb|display-p3)?\\s*${NUM}${SEP}${NUM}${SEP}${NUM}(?:${SEP}${NUM})?\\s*\\)$`,
  "i",
);

/** A CSS colour as sRGB components, as far as this page can tell (hex, rgb(), oklch(), oklab(), color()). */
export function cssColorToSrgb(s: string, doc?: Document): Triple | null {
  const t = s.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(t);
  if (hex) {
    const h = hex[1] as string;
    return hexToSrgb(`#${h.length <= 4 ? h.slice(0, 3) : h.slice(0, 6)}`);
  }
  const m = FN_RE.exec(t);
  if (m) {
    const fn = (m[1] as string).toLowerCase();
    const space = (m[2] ?? "").toLowerCase();
    const n = (i: number) => Number(m[3 + i * 2]);
    const pct = (i: number) => m[4 + i * 2] === "%";
    if (fn === "rgb" || fn === "rgba") {
      return [0, 1, 2].map((i) => (pct(i) ? n(i) / 100 : n(i) / 255)) as Triple;
    }
    if (fn === "oklch") return toSrgb("oklch", [pct(0) ? n(0) / 100 : n(0), n(1), n(2)]);
    if (fn === "oklab") return toSrgb("oklab", [pct(0) ? n(0) / 100 : n(0), n(1), n(2)]);
    if (fn === "color" && (space === "srgb" || space === "display-p3")) {
      return toSrgb(space as ColorSpace, [n(0), n(1), n(2)]);
    }
  }
  // A colour name, hsl() and the rest: the browser's own reading, as rgb().
  if (!doc?.defaultView || !/^[a-z]{3,24}$|^hsla?\(|^hwb\(/i.test(t)) return null;
  const probe = doc.createElement("span");
  probe.style.color = t;
  if (!probe.style.color) return null;
  doc.body.append(probe);
  const rgb = doc.defaultView.getComputedStyle(probe).color;
  probe.remove();
  const r = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(rgb);
  return r ? ([1, 2, 3].map((i) => Number(r[i]) / 255) as Triple) : null;
}

/** A colour value (a string, or an object in its space) as #rrggbb for the picker, or null. */
export function colorHex(v: unknown, doc?: Document): string | null {
  if (typeof v === "string") {
    const rgb = cssColorToSrgb(v, doc);
    return rgb ? srgbToHex(rgb) : null;
  }
  if (isObject(v) && typeof v.colorSpace === "string") {
    if (typeof v.hex === "string" && /^#[0-9a-f]{6}$/i.test(v.hex)) return v.hex.toLowerCase();
    const c = componentsOf(v.components);
    if (!c) return null;
    const space = v.colorSpace as ColorSpace;
    return srgbToHex(toSrgb(space, c));
  }
  return null;
}

/** An object colour as text, as the compiler writes it ("oklch(0.52 0.19 268)"). */
function objectColorText(v: Record<string, unknown>): string {
  const c = Array.isArray(v.components) ? v.components.join(" ") : "";
  const a = typeof v.alpha === "number" && v.alpha !== 1 ? ` / ${v.alpha}` : "";
  return v.colorSpace === "oklch" || v.colorSpace === "oklab"
    ? `${v.colorSpace}(${c}${a})`
    : `color(${String(v.colorSpace)} ${c}${a})`;
}

/** The picked colour (#rrggbb) written in the stored form: a hex string, or the object's own space. */
export function pickedColor(stored: unknown, hex: string): unknown {
  if (!isObject(stored)) return hex;
  const rgb = hexToSrgb(hex);
  if (!rgb) return stored;
  const space = (stored.colorSpace as ColorSpace) ?? "srgb";
  let out = withKey(stored, "components", fromSrgb(space, rgb));
  // A hex beside the components always says the same colour.
  if ("hex" in stored) out = withKey(out, "hex", hex.toLowerCase());
  return out;
}

function colorControl(ctx: ControlContext, value: unknown): HTMLElement {
  const swatch = input(ctx, "color", "colour", colorHex(value, ctx.doc) ?? "#000000");
  swatch.classList.add("ds-swatch");
  swatch.addEventListener("input", () => ctx.change(pickedColor(value, swatch.value)));
  const text = input(
    ctx,
    "text",
    "colour as text",
    typeof value === "string" ? value : isObject(value) ? objectColorText(value) : "",
  );
  text.spellcheck = false;
  text.addEventListener("change", () => {
    const t = text.value.trim();
    if (t === "") return;
    if (isObject(value)) {
      ctx.confirm(
        `Store this colour as text? It is stored in ${String(value.colorSpace)} components now.`,
        "Store as text",
        () => ctx.change(t),
      );
      return;
    }
    ctx.change(t);
  });
  return group(ctx, swatch, text);
}

// ---------- numbers with units ----------

const DIMENSION_UNITS = ["px", "rem", "em", "%"] as const;
const OBJECT_DIMENSION_UNITS = ["px", "rem"] as const;
const DURATION_UNITS = ["ms", "s"] as const;

function unitControl(
  ctx: ControlContext,
  value: unknown,
  units: readonly string[],
  objectUnits: readonly string[],
): HTMLElement {
  const asObject = isObject(value);
  let num = 0;
  let unit = units[0] as string;
  if (asObject) {
    num = typeof value.value === "number" ? value.value : 0;
    unit = typeof value.unit === "string" ? value.unit : unit;
  } else if (typeof value === "string") {
    const m = /^(-?(?:\d+|\d*\.\d+))([a-z%]*)$/.exec(value.trim());
    if (m) {
      num = Number(m[1]);
      unit = m[2] || unit;
    }
  }
  const allowed = asObject ? objectUnits : units;
  const n = input(ctx, "number", "number", String(num));
  n.step = "any";
  const u = select(
    ctx,
    "unit",
    allowed.map((x) => [x, x] as const),
    allowed.includes(unit) ? unit : (allowed[0] as string),
  );
  const write = () => {
    const v = numberOf(n.value);
    if (v === null) return;
    ctx.change(asObject ? withKey(withKey(value, "value", v), "unit", u.value) : `${v}${u.value}`);
  };
  n.addEventListener("change", write);
  u.addEventListener("change", write);
  return group(ctx, n, u);
}

const WEIGHT_KEYWORDS = [
  "thin",
  "extra-light",
  "light",
  "normal",
  "medium",
  "semi-bold",
  "bold",
  "extra-bold",
  "black",
] as const;

function weightControl(ctx: ControlContext, value: unknown): HTMLElement {
  const n = input(ctx, "number", "weight", typeof value === "number" ? String(value) : "");
  n.min = "1";
  n.max = "1000";
  n.step = "1";
  const k = select(
    ctx,
    "weight keyword",
    [["", "Number"], ...WEIGHT_KEYWORDS.map((w) => [w, w] as const)],
    typeof value === "string" ? value : "",
  );
  // The last one used wins.
  n.addEventListener("change", () => {
    const v = numberOf(n.value);
    if (v !== null) ctx.change(Math.round(v));
  });
  k.addEventListener("change", () => {
    if (k.value) ctx.change(k.value);
  });
  return group(ctx, n, k);
}

function numberControl(ctx: ControlContext, value: unknown): HTMLElement {
  const n = input(ctx, "number", "number", typeof value === "number" ? String(value) : "");
  n.step = "any";
  n.addEventListener("change", () => {
    const v = numberOf(n.value);
    if (v !== null) ctx.change(v);
  });
  return group(ctx, n);
}

function familyControl(ctx: ControlContext, value: unknown): HTMLElement {
  const list = Array.isArray(value);
  const t = input(
    ctx,
    "text",
    "font families",
    list ? (value as unknown[]).join(", ") : typeof value === "string" ? value : "",
  );
  t.spellcheck = false;
  t.addEventListener("change", () => {
    const s = t.value.trim();
    if (s === "") return;
    // The same form as stored: a comma string, or an array of names.
    ctx.change(
      list
        ? s
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : s,
    );
  });
  return group(ctx, t);
}

function bezierControl(ctx: ControlContext, value: unknown): HTMLElement {
  const v = Array.isArray(value) ? value : [0, 0, 1, 1];
  const names = ["x1", "y1", "x2", "y2"];
  const fields = names.map((name, i) => {
    const f = input(ctx, "number", name, String(v[i] ?? 0));
    f.step = "0.01";
    if (i % 2 === 0) {
      f.min = "0";
      f.max = "1";
    }
    return f;
  });
  for (const f of fields) {
    f.addEventListener("change", () => {
      const out = fields.map((x) => numberOf(x.value));
      if (out.every((x) => x !== null)) ctx.change(out);
    });
  }
  return group(ctx, ...fields);
}

// ---------- composites ----------

/** One part of a composite: its own type's control, or a token picker when it names one. */
function part(
  ctx: ControlContext,
  name: string,
  type: DsTokenType,
  value: unknown,
  set: (v: unknown) => void,
): HTMLElement {
  const words = PART_WORDS[name] ?? name;
  const sub: ControlContext = { ...ctx, label: `${ctx.label} ${words.toLowerCase()}`, change: set };
  const box = ctx.doc.createElement("div");
  box.className = "ds-part";
  const label = ctx.doc.createElement("span");
  label.className = "ds-part__name";
  label.textContent = words;
  box.append(label, valueControl(sub, type, value));
  return box;
}

/** What a composite's part is called on the page (its key is what the JSON says). */
const PART_WORDS: Record<string, string> = {
  color: "Color",
  offsetX: "X",
  offsetY: "Y",
  blur: "Blur",
  spread: "Spread",
  fontFamily: "Font",
  fontSize: "Size",
  fontWeight: "Weight",
  lineHeight: "Line height",
  letterSpacing: "Letter spacing",
  width: "Width",
  style: "Style",
};

const SHADOW_PARTS: [string, DsTokenType][] = [
  ["color", "color"],
  ["offsetX", "dimension"],
  ["offsetY", "dimension"],
  ["blur", "dimension"],
  ["spread", "dimension"],
];
const TYPOGRAPHY_PARTS: [string, DsTokenType][] = [
  ["fontFamily", "fontFamily"],
  ["fontSize", "dimension"],
  ["fontWeight", "fontWeight"],
  ["lineHeight", "number"],
  ["letterSpacing", "dimension"],
];

function compositeControl(ctx: ControlContext, type: DsTokenType, value: unknown): HTMLElement {
  const box = ctx.doc.createElement("div");
  box.className = "ds-control ds-control--parts";
  if (type === "shadow") {
    const layers = Array.isArray(value) ? value : [value];
    layers.forEach((layer, i) => {
      if (!isObject(layer)) return;
      const setLayer = (next: Record<string, unknown>) => {
        const all = layers.map((l, j) => (j === i ? next : l));
        ctx.change(Array.isArray(value) ? all : next);
      };
      for (const [name, t] of SHADOW_PARTS) {
        if (!(name in layer)) continue;
        box.append(part(ctx, name, t, layer[name], (v) => setLayer(withKey(layer, name, v))));
      }
    });
    return box;
  }
  if (!isObject(value)) return box;
  const parts: [string, DsTokenType][] =
    type === "border"
      ? [
          ["color", "color"],
          ["width", "dimension"],
        ]
      : TYPOGRAPHY_PARTS;
  for (const [name, t] of parts) {
    if (!(name in value)) continue;
    // A line height may be a number or a dimension: it keeps the form it has.
    const pt = name === "lineHeight" && typeof value[name] !== "number" ? "dimension" : t;
    box.append(part(ctx, name, pt, value[name], (v) => ctx.change(withKey(value, name, v))));
  }
  if (type === "border") {
    const styles = [
      "solid",
      "dashed",
      "dotted",
      "double",
      "groove",
      "ridge",
      "outset",
      "inset",
      "none",
    ];
    const s = select(
      ctx,
      "style",
      styles.map((x) => [x, x] as const),
      typeof value.style === "string" ? value.style : "solid",
    );
    s.addEventListener("change", () => ctx.change(withKey(value, "style", s.value)));
    const p = ctx.doc.createElement("div");
    p.className = "ds-part";
    const label = ctx.doc.createElement("span");
    label.className = "ds-part__name";
    label.textContent = PART_WORDS.style ?? "Style";
    p.append(label, s);
    box.append(p);
  }
  return box;
}

/** A value that names another token: pick the token. */
function aliasControl(ctx: ControlContext, type: DsTokenType, target: string): HTMLElement {
  const options = [target, ...ctx.targets(type).filter((p) => p !== target)];
  const s = select(
    ctx,
    "token",
    options.map((p) => [p, p] as const),
    target,
  );
  s.addEventListener("change", () => ctx.change(`{${s.value}}`));
  return group(ctx, s);
}

/** The control for one value of `type`, in the form it is stored in. */
export function valueControl(ctx: ControlContext, type: DsTokenType, value: unknown): HTMLElement {
  const alias = dsAliasOf(value);
  if (alias !== null) return aliasControl(ctx, type, alias);
  switch (type) {
    case "color":
      return colorControl(ctx, value);
    case "dimension":
      return unitControl(ctx, value, DIMENSION_UNITS, OBJECT_DIMENSION_UNITS);
    case "duration":
      return unitControl(ctx, value, DURATION_UNITS, DURATION_UNITS);
    case "fontWeight":
      return weightControl(ctx, value);
    case "number":
      return numberControl(ctx, value);
    case "fontFamily":
      return familyControl(ctx, value);
    case "cubicBezier":
      return bezierControl(ctx, value);
    case "shadow":
    case "border":
    case "typography":
      return compositeControl(ctx, type, value);
  }
}

/** A starting value for a new token of `type` (the person edits it next). */
export function starterValue(type: DsTokenType): unknown {
  switch (type) {
    case "color":
      return "#000000";
    case "dimension":
      return "8px";
    case "duration":
      return "200ms";
    case "fontWeight":
      return 400;
    case "number":
      return 1;
    case "fontFamily":
      return "system-ui";
    case "cubicBezier":
      return [0.4, 0, 0.2, 1];
    case "shadow":
      return { color: "#00000033", offsetX: "0px", offsetY: "1px", blur: "3px" };
    case "border":
      return { color: "#000000", width: "1px", style: "solid" };
    case "typography":
      return { fontFamily: "system-ui", fontSize: "16px" };
  }
}

// Colour conversions for a design system's colour objects ({ colorSpace, components }): a person
// picks a colour in the browser's sRGB picker, and the token keeps its own space, so the picked
// colour is written back in that space. The CSS Color 4 matrices for srgb, display-p3, oklab and
// oklch (D65 throughout), with components rounded to 5 decimals. Pure, no DOM.

export type ColorSpace = "srgb" | "display-p3" | "oklab" | "oklch";
export type Triple = [number, number, number];

export const COLOR_SPACE_NAMES: readonly ColorSpace[] = ["srgb", "display-p3", "oklab", "oklch"];

type M3 = readonly [Triple, Triple, Triple];

const mul = (m: M3, v: Triple): Triple => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const LIN_SRGB_TO_XYZ: M3 = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_LIN_SRGB: M3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const LIN_P3_TO_XYZ: M3 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const XYZ_TO_LIN_P3: M3 = [
  [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
];
const XYZ_TO_LMS: M3 = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_XYZ: M3 = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const LMS_TO_OKLAB: M3 = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_TO_LMS: M3 = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];

/** sRGB (and display-p3) transfer: encoded to linear light. */
function toLinear(c: number): number {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
}

function toGamma(c: number): number {
  const a = Math.abs(c);
  return a > 0.0031308 ? Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055) : 12.92 * c;
}

function xyzToOklab(xyz: Triple): Triple {
  const lms = mul(XYZ_TO_LMS, xyz).map(Math.cbrt) as Triple;
  return mul(LMS_TO_OKLAB, lms);
}

function oklabToXyz(lab: Triple): Triple {
  const lms = mul(OKLAB_TO_LMS, lab).map((c) => c ** 3) as Triple;
  return mul(LMS_TO_XYZ, lms);
}

function labToLch([l, a, b]: Triple): Triple {
  const c = Math.sqrt(a * a + b * b);
  // A grey has no hue; 0 keeps the components plain numbers.
  const h = c < 1e-7 ? 0 : ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  return [l, c, h];
}

function lchToLab([l, c, h]: Triple): Triple {
  const r = (h * Math.PI) / 180;
  return [l, c * Math.cos(r), c * Math.sin(r)];
}

/** A number rounded to 5 decimals, with -0 as 0. */
export function round5(n: number): number {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
}

/** sRGB components (0 to 1) as `space`'s components, rounded to 5 decimals. */
export function fromSrgb(space: ColorSpace, rgb: Triple): Triple {
  if (space === "srgb") return rgb.map(round5) as Triple;
  const xyz = mul(LIN_SRGB_TO_XYZ, rgb.map(toLinear) as Triple);
  let out: Triple;
  if (space === "display-p3") out = mul(XYZ_TO_LIN_P3, xyz).map(toGamma) as Triple;
  else {
    const lab = xyzToOklab(xyz);
    out = space === "oklab" ? lab : labToLch(lab);
  }
  return out.map(round5) as Triple;
}

/** `space`'s components as sRGB components (unclamped: a wide colour may fall outside 0 to 1). */
export function toSrgb(space: ColorSpace, components: Triple): Triple {
  if (space === "srgb") return [...components];
  let xyz: Triple;
  if (space === "display-p3") xyz = mul(LIN_P3_TO_XYZ, components.map(toLinear) as Triple);
  else xyz = oklabToXyz(space === "oklab" ? components : lchToLab(components));
  return mul(XYZ_TO_LIN_SRGB, xyz).map(toGamma) as Triple;
}

/** "#rrggbb" (or "#rgb") as sRGB components, or null. */
export function hexToSrgb(hex: string): Triple | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Triple;
}

/** sRGB components as "#rrggbb", each clamped to 0 to 1 first. */
export function srgbToHex(rgb: Triple): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** A colour object's components with "none" as 0, or null when they are not three numbers. */
export function componentsOf(v: unknown): Triple | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map((n) => (n === "none" ? 0 : n));
  return out.every((n) => typeof n === "number" && Number.isFinite(n)) ? (out as Triple) : null;
}

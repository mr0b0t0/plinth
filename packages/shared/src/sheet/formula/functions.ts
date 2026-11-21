// The functions formulas may call: a Map from the upper-cased name to its implementation (never an
// object, so "constructor" or "__proto__" cannot resolve). Each one keeps Excel's meaning, so a
// formula exports to .xlsx as written. Arities are in arity.ts, checked by the parser.
import type { Arg, EvalContext, RangeArg } from "./evaluate.ts";
import type { Node } from "./parser.ts";
import {
  compareValues,
  dateSerial,
  err,
  finite,
  isError,
  isRange,
  MAX_DATE_SERIAL,
  numberFromText,
  round15,
  type SheetError,
  serialDate,
  textCost,
  textSteps,
  toBoolean,
  toNumber,
  toText,
  type Value,
} from "./values.ts";

type Fn = (args: Arg[], ctx: EvalContext) => Value;
type LazyFn = (nodes: Node[], ctx: EvalContext) => Value;
export type FunctionDef = { lazy?: false; fn: Fn } | { lazy: true; fn: LazyFn };

/** One value from an argument: a one-cell range is its cell, a bigger one is #VALUE!. */
function scalar(a: Arg | undefined): Value {
  if (a === undefined) return null;
  if (!isRange(a)) return a;
  return a.height === 1 && a.width === 1 ? a.at(0, 0) : err("#VALUE!");
}

function num(a: Arg | undefined): number | SheetError {
  return toNumber(scalar(a));
}

function int(a: Arg | undefined): number | SheetError {
  const n = num(a);
  return isError(n) ? n : Math.trunc(n);
}

function text(a: Arg | undefined): string | SheetError {
  return toText(scalar(a));
}

/** compareValues, charging the text it lowercases (textCost). */
function compare(a: Value, b: Value, ctx: EvalContext): number {
  ctx.charge(textCost(a) + textCost(b));
  return compareValues(a, b);
}

// Characters as LEN, LEFT, RIGHT and MID count them: code points, a surrogate pair being one.
// Walked with an index, never spread into an array of characters.
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const pairAt = (t: string, i: number) =>
  i >= 0 && isHigh(t.charCodeAt(i)) && isLow(t.charCodeAt(i + 1));

/** The index `n` characters after `from` in `t` (or its end), charging the text walked. */
function forward(t: string, from: number, n: number, ctx: EvalContext): number {
  let i = from;
  for (let k = 0; k < n && i < t.length; k++) i += pairAt(t, i) ? 2 : 1;
  ctx.charge(textSteps(i - from));
  return i;
}

/** The index `n` characters before the end of `t` (or 0), charging the text walked. */
function backward(t: string, n: number, ctx: EvalContext): number {
  let i = t.length;
  for (let k = 0; k < n && i > 0; k++) i -= pairAt(t, i - 2) ? 2 : 1;
  ctx.charge(textSteps(t.length - i));
  return i;
}

/**
 * The numbers of the arguments, as SUM reads them: in ranges only numbers count (text, booleans
 * and empty cells are skipped); a value given directly is converted (TRUE is 1, "3" is 3). The
 * first error wins.
 */
function numbers(args: Arg[]): number[] | SheetError {
  const out: number[] = [];
  for (const a of args) {
    if (isRange(a)) {
      let bad: SheetError | null = null;
      a.each((v) => {
        if (bad) return;
        if (typeof v === "number") out.push(v);
        else if (isError(v)) bad = v;
      });
      if (bad) return bad;
      continue;
    }
    if (a === null) continue;
    if (isError(a)) return a;
    const n = toNumber(a);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

function withNumbers(f: (ns: number[]) => Value): Fn {
  return (args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : f(ns);
  };
}

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

function roundTo(x: number, digits: number, mode: "round" | "up" | "down"): number | SheetError {
  const d = Math.trunc(digits);
  const scale = 10 ** Math.abs(d);
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const scaled = d >= 0 ? round15(abs * scale) : round15(abs / scale);
  const r =
    mode === "round" ? Math.round(scaled) : mode === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return finite(sign * (d >= 0 ? r / scale : r * scale));
}

// ---------- criteria (COUNTIF, SUMIF, ...) ----------

/**
 * Wildcard match of a whole string: * is any run, ? any one character, ~ escapes the next. Case
 * is ignored. Linear backtracking to the last *, with its work charged to the budget.
 */
export function wildcardMatch(pattern: string, s: string, ctx: EvalContext): boolean {
  // The pattern is read and the text lowercased before the match starts.
  ctx.charge(textSteps(pattern.length + s.length));
  const p: { ch: string; star: boolean; any: boolean }[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "~" && i + 1 < pattern.length) {
      p.push({ ch: (pattern[++i] as string).toLowerCase(), star: false, any: false });
    } else if (c === "*") p.push({ ch: "", star: true, any: false });
    else if (c === "?") p.push({ ch: "", star: false, any: true });
    else p.push({ ch: c.toLowerCase(), star: false, any: false });
  }
  const t = s.toLowerCase();
  let pi = 0;
  let ti = 0;
  let starP = -1;
  let starT = 0;
  let work = 0;
  while (ti < t.length) {
    if (++work % 1024 === 0) ctx.charge(1024);
    const tok = p[pi];
    if (tok && !tok.star && (tok.any || tok.ch === t[ti])) {
      pi++;
      ti++;
    } else if (tok?.star) {
      starP = pi++;
      starT = ti;
    } else if (starP >= 0) {
      pi = starP + 1;
      ti = ++starT;
    } else return false;
  }
  while (pi < p.length && p[pi]?.star) pi++;
  return pi === p.length;
}

const hasWildcard = (s: string) => /[*?~]/.test(s);

type Criterion = (v: Value) => boolean;

/** A COUNTIF-style criterion: 5, ">5", "<>a", "a*", "" (empty cells), TRUE. */
function criterion(c: Value, ctx: EvalContext): Criterion | SheetError {
  if (isError(c)) return c;
  if (c === null) return (v) => v === null || v === "";
  if (typeof c === "number") return (v) => typeof v === "number" && compareValues(v, c) === 0;
  if (typeof c === "boolean") return (v) => v === c;
  // The criterion is read once here; each cell it is matched against pays for its own text.
  ctx.charge(textCost(c));
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c) as RegExpExecArray;
  const op = m[1] ?? "=";
  const rest = m[2] as string;
  const n = numberFromText(rest);
  const upper = rest.toUpperCase();
  const asBool = upper === "TRUE" ? true : upper === "FALSE" ? false : null;
  const cmp = (v: Value, target: Value): number | null => {
    if (typeof target === "number") return typeof v === "number" ? compareValues(v, target) : null;
    if (typeof target === "boolean")
      return typeof v === "boolean" ? compareValues(v, target) : null;
    return typeof v === "string" ? compare(v, target, ctx) : null;
  };
  const target: Value = n !== null ? n : asBool !== null ? asBool : rest;
  const lower = typeof target === "string" ? target.toLowerCase() : "";
  const sameText = (v: Value): boolean => {
    if (typeof v !== "string") return false;
    ctx.charge(textCost(v));
    return v.toLowerCase() === lower;
  };
  if (op === "=") {
    if (rest === "") return (v) => v === null || v === "";
    if (typeof target === "string") {
      return hasWildcard(target)
        ? (v) => typeof v === "string" && wildcardMatch(target, v, ctx)
        : sameText;
    }
    return (v) => cmp(v, target) === 0;
  }
  if (op === "<>") {
    if (rest === "") return (v) => v !== null && v !== "";
    if (typeof target === "string") {
      return hasWildcard(target)
        ? (v) => !(typeof v === "string" && wildcardMatch(target, v, ctx))
        : (v) => !sameText(v);
    }
    return (v) => cmp(v, target) !== 0;
  }
  return (v) => {
    const r = cmp(v, target);
    if (r === null) return false;
    return op === "<" ? r < 0 : op === ">" ? r > 0 : op === "<=" ? r <= 0 : r >= 0;
  };
}

/**
 * The positions (row-major over `shape`) where every (range, criterion) pair matches. Every range
 * must have the shape of the first one, else #VALUE!.
 */
function matchingCells(
  pairs: Arg[],
  ctx: EvalContext,
): { height: number; width: number; hits: boolean[] } | SheetError {
  if (pairs.length === 0 || pairs.length % 2 !== 0) return err("#VALUE!");
  const first = pairs[0] as Arg;
  if (!isRange(first)) return err("#VALUE!");
  const height = first.innerHeight;
  const width = first.innerWidth;
  const hits: boolean[] = new Array(height * width).fill(true);
  for (let k = 0; k < pairs.length; k += 2) {
    const r = pairs[k] as Arg;
    if (!isRange(r) || r.height !== first.height || r.width !== first.width) return err("#VALUE!");
    const crit = criterion(scalar(pairs[k + 1]), ctx);
    if (isError(crit)) return crit;
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) {
        const at = i * width + j;
        if (!hits[at]) continue;
        const v = i < r.innerHeight && j < r.innerWidth ? r.at(i, j) : null;
        hits[at] = crit(v);
      }
    }
  }
  return { height, width, hits };
}

/** Numbers of `target` at the matching positions, over the same shape. */
function pickNumbers(
  target: RangeArg,
  m: { height: number; width: number; hits: boolean[] },
): number[] | SheetError {
  const out: number[] = [];
  for (let i = 0; i < m.height; i++) {
    for (let j = 0; j < m.width; j++) {
      if (!m.hits[i * m.width + j]) continue;
      const v = i < target.height && j < target.width ? target.at(i, j) : null;
      if (typeof v === "number") out.push(v);
      else if (isError(v)) return v;
    }
  }
  return out;
}

function countMatches(m: { hits: boolean[] }): number {
  let n = 0;
  for (const h of m.hits) if (h) n++;
  return n;
}

// ---------- lookups ----------

/** Equality for lookups: numbers to 15 digits, text without case (with wildcards when asked). */
function lookupEquals(v: Value, want: Value, wild: boolean, ctx: EvalContext): boolean {
  if (v === null || isError(v)) return false;
  if (typeof want === "string" && typeof v === "string") {
    return wild && hasWildcard(want) ? wildcardMatch(want, v, ctx) : compare(v, want, ctx) === 0;
  }
  if (typeof want !== typeof v) return false;
  return compareValues(v, want) === 0;
}

/** The position (0-based) along a vector: exact, or the last one at most `want` (sorted data). */
function findIn(
  len: number,
  get: (i: number) => Value,
  want: Value,
  mode: "exact" | "le" | "ge",
  wild: boolean,
  ctx: EvalContext,
  reverse = false,
): number {
  if (mode === "exact") {
    for (let k = 0; k < len; k++) {
      const i = reverse ? len - 1 - k : k;
      if (lookupEquals(get(i), want, wild, ctx)) return i;
    }
    return -1;
  }
  let best = -1;
  for (let i = 0; i < len; i++) {
    const v = get(i);
    if (v === null || isError(v) || typeof v !== typeof want) continue;
    const c = compare(v, want, ctx);
    if (c === 0) return i;
    if (mode === "le") {
      if (c < 0) best = i;
      else break;
    } else if (c > 0) best = i;
    else break;
  }
  return best;
}

/** A 1D range's length and accessor, or null for a 2D one. */
function vector(r: RangeArg): { len: number; get: (i: number) => Value } | null {
  if (r.height === 1) {
    const len = Math.min(r.width, r.innerWidth);
    return { len, get: (i) => r.at(0, i) };
  }
  if (r.width === 1) {
    const len = Math.min(r.height, r.innerHeight);
    return { len, get: (i) => r.at(i, 0) };
  }
  return null;
}

function vlookup(args: Arg[], ctx: EvalContext, horizontal: boolean): Value {
  const want = scalar(args[0]);
  if (isError(want)) return want;
  const table = args[1];
  if (!table || !isRange(table)) return err("#VALUE!");
  const idx = int(args[2]);
  if (isError(idx)) return idx;
  const approx = args[3] === undefined || args[3] === null ? true : toBoolean(scalar(args[3]));
  if (isError(approx)) return approx;
  const span = horizontal ? table.height : table.width;
  if (idx < 1) return err("#VALUE!");
  if (idx > span) return err("#REF!");
  const len = horizontal
    ? Math.min(table.width, table.innerWidth)
    : Math.min(table.height, table.innerHeight);
  const get = (i: number) => (horizontal ? table.at(0, i) : table.at(i, 0));
  const at = findIn(len, get, want, approx ? "le" : "exact", !approx, ctx);
  if (at < 0) return err("#N/A");
  return horizontal ? table.at(idx - 1, at) : table.at(at, idx - 1);
}

// ---------- the table ----------

const F = new Map<string, FunctionDef>();
const def = (name: string, fn: Fn) => F.set(name, { fn });
const lazy = (name: string, fn: LazyFn) => F.set(name, { lazy: true, fn });

// math and statistics
def(
  "SUM",
  withNumbers((ns) => finite(sum(ns))),
);
def(
  "AVERAGE",
  withNumbers((ns) => (ns.length ? finite(sum(ns) / ns.length) : err("#DIV/0!"))),
);
// A loop, not Math.min(...ns): a range can hold more numbers than a call takes arguments.
def(
  "MIN",
  withNumbers((ns) => (ns.length ? ns.reduce((m, n) => Math.min(m, n)) : 0)),
);
def(
  "MAX",
  withNumbers((ns) => (ns.length ? ns.reduce((m, n) => Math.max(m, n)) : 0)),
);
def(
  "PRODUCT",
  withNumbers((ns) => (ns.length ? finite(ns.reduce((p, n) => p * n, 1)) : 0)),
);
def(
  "MEDIAN",
  withNumbers((ns) => {
    if (!ns.length) return err("#NUM!");
    const s = [...ns].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  }),
);
def(
  "STDEV",
  withNumbers((ns) => {
    if (ns.length < 2) return err("#DIV/0!");
    const mean = sum(ns) / ns.length;
    return finite(Math.sqrt(ns.reduce((s, n) => s + (n - mean) ** 2, 0) / (ns.length - 1)));
  }),
);
def("COUNT", (args) => {
  let n = 0;
  for (const a of args) {
    if (isRange(a))
      a.each((v) => {
        if (typeof v === "number") n++;
      });
    else if (typeof a === "number" || typeof a === "boolean") n++;
    else if (typeof a === "string" && numberFromText(a) !== null) n++;
  }
  return n;
});
def("COUNTA", (args) => {
  let n = 0;
  for (const a of args) {
    if (isRange(a))
      a.each((v) => {
        if (v !== null) n++;
      });
    else if (a !== null) n++;
  }
  return n;
});
def("COUNTBLANK", (args) => {
  const r = args[0] as Arg;
  if (!isRange(r)) return err("#VALUE!");
  let n = r.outside;
  r.each((v) => {
    if (v === null || v === "") n++;
  });
  return n;
});
def("COUNTIF", (args, ctx) => {
  const m = matchingCells(args, ctx);
  return isError(m) ? m : countMatches(m);
});
def("COUNTIFS", (args, ctx) => {
  const m = matchingCells(args, ctx);
  return isError(m) ? m : countMatches(m);
});
def("SUMIF", (args, ctx) => {
  const m = matchingCells(args.slice(0, 2), ctx);
  if (isError(m)) return m;
  const target = (args[2] ?? args[0]) as Arg;
  if (!isRange(target)) return err("#VALUE!");
  const ns = pickNumbers(target, m);
  return isError(ns) ? ns : finite(sum(ns));
});
def("SUMIFS", (args, ctx) => {
  const target = args[0] as Arg;
  if (!isRange(target)) return err("#VALUE!");
  const m = matchingCells(args.slice(1), ctx);
  if (isError(m)) return m;
  const first = args[1] as RangeArg;
  if (target.height !== first.height || target.width !== first.width) return err("#VALUE!");
  const ns = pickNumbers(target, m);
  return isError(ns) ? ns : finite(sum(ns));
});
def("AVERAGEIF", (args, ctx) => {
  const m = matchingCells(args.slice(0, 2), ctx);
  if (isError(m)) return m;
  const target = (args[2] ?? args[0]) as Arg;
  if (!isRange(target)) return err("#VALUE!");
  const ns = pickNumbers(target, m);
  if (isError(ns)) return ns;
  return ns.length ? finite(sum(ns) / ns.length) : err("#DIV/0!");
});
def("AVERAGEIFS", (args, ctx) => {
  const target = args[0] as Arg;
  if (!isRange(target)) return err("#VALUE!");
  const m = matchingCells(args.slice(1), ctx);
  if (isError(m)) return m;
  const first = args[1] as RangeArg;
  if (target.height !== first.height || target.width !== first.width) return err("#VALUE!");
  const ns = pickNumbers(target, m);
  if (isError(ns)) return ns;
  return ns.length ? finite(sum(ns) / ns.length) : err("#DIV/0!");
});
const rounding =
  (mode: "round" | "up" | "down"): Fn =>
  (args) => {
    const x = num(args[0]);
    if (isError(x)) return x;
    const d = num(args[1]);
    if (isError(d)) return d;
    return roundTo(x, d, mode);
  };
def("ROUND", rounding("round"));
def("ROUNDUP", rounding("up"));
def("ROUNDDOWN", rounding("down"));
def("INT", (args) => {
  const x = num(args[0]);
  return isError(x) ? x : Math.floor(x);
});
def("ABS", (args) => {
  const x = num(args[0]);
  return isError(x) ? x : Math.abs(x);
});
def("MOD", (args) => {
  const x = num(args[0]);
  if (isError(x)) return x;
  const y = num(args[1]);
  if (isError(y)) return y;
  if (y === 0) return err("#DIV/0!");
  return finite(x - y * Math.floor(x / y));
});
def("POWER", (args) => {
  const x = num(args[0]);
  if (isError(x)) return x;
  const y = num(args[1]);
  if (isError(y)) return y;
  if (x === 0 && y === 0) return err("#NUM!");
  if (x === 0 && y < 0) return err("#DIV/0!");
  return finite(x ** y);
});
def("SQRT", (args) => {
  const x = num(args[0]);
  if (isError(x)) return x;
  return x < 0 ? err("#NUM!") : Math.sqrt(x);
});
const toMultiple =
  (up: boolean): Fn =>
  (args) => {
    const x = num(args[0]);
    if (isError(x)) return x;
    const s = num(args[1]);
    if (isError(s)) return s;
    if (x === 0 || s === 0) return 0;
    if (x > 0 && s < 0) return err("#NUM!");
    const q = round15(x / s);
    const k = up ? Math.ceil(q) : Math.floor(q);
    // A negative number with a negative significance rounds away from zero (up) or toward it.
    const kk = x < 0 && s < 0 ? (up ? Math.floor(q) : Math.ceil(q)) : k;
    return finite(round15(kk * s));
  };
def("CEILING", toMultiple(true));
def("FLOOR", toMultiple(false));

// logic
lazy("IF", (nodes, ctx) => {
  const c = toBoolean(scalar(ctx.arg(nodes[0] as Node)));
  if (isError(c)) return c;
  const branch = c ? nodes[1] : nodes[2];
  if (branch === undefined) return c ? 0 : false;
  return scalar(ctx.arg(branch));
});
lazy("IFS", (nodes, ctx) => {
  if (nodes.length % 2 !== 0) return err("#VALUE!");
  for (let i = 0; i < nodes.length; i += 2) {
    const c = toBoolean(scalar(ctx.arg(nodes[i] as Node)));
    if (isError(c)) return c;
    if (c) return scalar(ctx.arg(nodes[i + 1] as Node));
  }
  return err("#N/A");
});
lazy("IFERROR", (nodes, ctx) => {
  const v = scalar(ctx.arg(nodes[0] as Node));
  return isError(v) ? scalar(ctx.arg(nodes[1] as Node)) : v;
});
lazy("IFNA", (nodes, ctx) => {
  const v = scalar(ctx.arg(nodes[0] as Node));
  return isError(v) && v.error === "#N/A" ? scalar(ctx.arg(nodes[1] as Node)) : v;
});
lazy("SWITCH", (nodes, ctx) => {
  const v = scalar(ctx.arg(nodes[0] as Node));
  if (isError(v)) return v;
  let i = 1;
  for (; i + 1 < nodes.length; i += 2) {
    const c = scalar(ctx.arg(nodes[i] as Node));
    if (isError(c)) return c;
    if (compare(v, c, ctx) === 0 && typeof v === typeof c)
      return scalar(ctx.arg(nodes[i + 1] as Node));
  }
  return i < nodes.length ? scalar(ctx.arg(nodes[i] as Node)) : err("#N/A");
});
/** The booleans of AND, OR and XOR: in ranges booleans and numbers (text skipped). */
function booleans(args: Arg[]): boolean[] | SheetError {
  const out: boolean[] = [];
  for (const a of args) {
    if (isRange(a)) {
      let bad: SheetError | null = null;
      a.each((v) => {
        if (bad) return;
        if (typeof v === "boolean") out.push(v);
        else if (typeof v === "number") out.push(v !== 0);
        else if (isError(v)) bad = v;
      });
      if (bad) return bad;
      continue;
    }
    if (a === null) continue;
    const b = toBoolean(a);
    if (isError(b)) return b;
    out.push(b);
  }
  return out.length ? out : err("#VALUE!");
}
def("AND", (args) => {
  const b = booleans(args);
  return isError(b) ? b : b.every(Boolean);
});
def("OR", (args) => {
  const b = booleans(args);
  return isError(b) ? b : b.some(Boolean);
});
def("XOR", (args) => {
  const b = booleans(args);
  return isError(b) ? b : b.filter(Boolean).length % 2 === 1;
});
def("NOT", (args) => {
  const b = toBoolean(scalar(args[0]));
  return isError(b) ? b : !b;
});
def("ISBLANK", (args) => scalar(args[0]) === null && isRange(args[0] as Arg));
def("ISNUMBER", (args) => typeof scalar(args[0]) === "number");
def("ISTEXT", (args) => typeof scalar(args[0]) === "string");
def("ISERROR", (args) => isError(scalar(args[0])));
def("ISNA", (args) => {
  const v = scalar(args[0]);
  return isError(v) && v.error === "#N/A";
});

// text
def("CONCAT", (args, ctx) => {
  let s = "";
  for (const a of args) {
    if (isRange(a)) {
      let bad: SheetError | null = null;
      a.each((v) => {
        if (bad) return;
        const t = toText(v);
        if (isError(t)) bad = t;
        else s += t;
        if (s.length > 32_767) bad = err("#VALUE!");
      });
      if (bad) return bad;
    } else {
      const t = toText(a);
      if (isError(t)) return t;
      s += t;
    }
    if (s.length > 32_767) return err("#VALUE!");
  }
  return ctx.text(s);
});
def("CONCATENATE", (args, ctx) => {
  let s = "";
  for (const a of args) {
    const t = text(a);
    if (isError(t)) return t;
    s += t;
    if (s.length > 32_767) return err("#VALUE!");
  }
  return ctx.text(s);
});
def("TEXTJOIN", (args, ctx) => {
  const delim = text(args[0]);
  if (isError(delim)) return delim;
  const skip = toBoolean(scalar(args[1]));
  if (isError(skip)) return skip;
  const parts: string[] = [];
  let size = 0;
  const add = (v: Value): SheetError | null => {
    const t = toText(v);
    if (isError(t)) return t;
    if (skip && t === "") return null;
    parts.push(t);
    size += t.length + delim.length;
    return size > 32_767 + delim.length ? err("#VALUE!") : null;
  };
  for (const a of args.slice(2)) {
    if (isRange(a)) {
      let bad: SheetError | null = null;
      if (!skip) {
        // Empty cells outside the sheet still join as "".
        for (let i = 0; i < a.height && !bad; i++) {
          for (let j = 0; j < a.width && !bad; j++) bad = add(a.at(i, j));
        }
      } else {
        a.each((v) => {
          if (!bad) bad = add(v);
        });
      }
      if (bad) return bad;
    } else {
      const bad = add(a);
      if (bad) return bad;
    }
  }
  return ctx.text(parts.join(delim));
});
def("LEN", (args, ctx) => {
  const t = text(args[0]);
  if (isError(t)) return t;
  ctx.charge(textCost(t));
  let n = 0;
  for (let i = 0; i < t.length; i += pairAt(t, i) ? 2 : 1) n++;
  return n;
});
const slice =
  (from: "left" | "right"): Fn =>
  (args, ctx) => {
    const t = text(args[0]);
    if (isError(t)) return t;
    const n = args[1] === undefined ? 1 : int(args[1]);
    if (isError(n)) return n;
    if (n < 0) return err("#VALUE!");
    return ctx.text(
      from === "left" ? t.slice(0, forward(t, 0, n, ctx)) : t.slice(backward(t, n, ctx)),
    );
  };
def("LEFT", slice("left"));
def("RIGHT", slice("right"));
def("MID", (args, ctx) => {
  const t = text(args[0]);
  if (isError(t)) return t;
  const start = int(args[1]);
  if (isError(start)) return start;
  const n = int(args[2]);
  if (isError(n)) return n;
  if (start < 1 || n < 0) return err("#VALUE!");
  const from = forward(t, 0, start - 1, ctx);
  return ctx.text(t.slice(from, forward(t, from, n, ctx)));
});
// UPPER, LOWER, PROPER and TRIM read all their text, whatever they return: TRIM of 32,767
// spaces returns "", and charging only what it returns made that read free.
const mapText =
  (f: (s: string) => string): Fn =>
  (args, ctx) => {
    const t = text(args[0]);
    if (isError(t)) return t;
    ctx.charge(textCost(t));
    return ctx.text(f(t));
  };
def(
  "UPPER",
  mapText((s) => s.toUpperCase()),
);
def(
  "LOWER",
  mapText((s) => s.toLowerCase()),
);
def(
  "PROPER",
  mapText((s) =>
    s
      .toLowerCase()
      .replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()),
  ),
);
def(
  "TRIM",
  mapText((s) => s.replace(/ +/g, " ").replace(/^ | $/g, "")),
);
def("SUBSTITUTE", (args, ctx) => {
  const t = text(args[0]);
  if (isError(t)) return t;
  const from = text(args[1]);
  if (isError(from)) return from;
  const to = text(args[2]);
  if (isError(to)) return to;
  if (from === "") return t;
  // The search reads the whole text, whatever it finds, and each match is a piece split off and
  // joined again: 32,767 matches are 32,767 pieces however short the text that holds them.
  ctx.charge(textCost(t));
  if (args[3] === undefined) {
    const parts = t.split(from);
    ctx.charge(parts.length - 1);
    if (t.length + (parts.length - 1) * (to.length - from.length) > 32_767) return err("#VALUE!");
    return ctx.text(parts.join(to));
  }
  const nth = int(args[3]);
  if (isError(nth)) return nth;
  if (nth < 1) return err("#VALUE!");
  let at = -1;
  for (let k = 0; k < nth; k++) {
    ctx.charge(1);
    at = t.indexOf(from, at + 1);
    if (at < 0) return t;
  }
  return ctx.text(t.slice(0, at) + to + t.slice(at + from.length));
});
def("REPT", (args, ctx) => {
  const t = text(args[0]);
  if (isError(t)) return t;
  const n = int(args[1]);
  if (isError(n)) return n;
  if (n < 0 || t.length * n > 32_767) return err("#VALUE!");
  return ctx.text(t.repeat(n));
});
const finder =
  (insensitive: boolean): Fn =>
  (args, ctx) => {
    const what = text(args[0]);
    if (isError(what)) return what;
    const within = text(args[1]);
    if (isError(within)) return within;
    const start = args[2] === undefined ? 1 : int(args[2]);
    if (isError(start)) return start;
    if (start < 1 || start > within.length + 1) return err("#VALUE!");
    // A search reads the text it searches (SEARCH lowercases all of it) and what it looks for.
    ctx.charge(textCost(within) + textCost(what));
    if (!insensitive || !hasWildcard(what)) {
      const at = insensitive
        ? within.toLowerCase().indexOf(what.toLowerCase(), start - 1)
        : within.indexOf(what, start - 1);
      return at < 0 ? err("#VALUE!") : at + 1;
    }
    const prefix = `${what}*`;
    for (let i = start - 1; i <= within.length; i++) {
      ctx.charge(1);
      if (wildcardMatch(prefix, within.slice(i), ctx)) return i + 1;
    }
    return err("#VALUE!");
  };
def("FIND", finder(false));
def("SEARCH", finder(true));
def("VALUE", (args) => {
  const v = scalar(args[0]);
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "string") return numberFromText(v) ?? err("#VALUE!");
  return v === null ? 0 : err("#VALUE!");
});
def("EXACT", (args, ctx) => {
  const a = text(args[0]);
  if (isError(a)) return a;
  const b = text(args[1]);
  if (isError(b)) return b;
  if (a.length !== b.length) return false;
  ctx.charge(textCost(a));
  return a === b;
});

// lookups
def("VLOOKUP", (args, ctx) => vlookup(args, ctx, false));
def("HLOOKUP", (args, ctx) => vlookup(args, ctx, true));
def("XLOOKUP", (args, ctx) => {
  const want = scalar(args[0]);
  if (isError(want)) return want;
  const look = args[1];
  const ret = args[2];
  if (!look || !ret || !isRange(look) || !isRange(ret)) return err("#VALUE!");
  const lv = vector(look);
  if (!lv) return err("#VALUE!");
  const mode = args[4] === undefined || args[4] === null ? 0 : int(args[4]);
  if (isError(mode)) return mode;
  const search = args[5] === undefined || args[5] === null ? 1 : int(args[5]);
  if (isError(search)) return search;
  if (![0, -1, 1, 2].includes(mode) || ![1, -1, 2, -2].includes(search)) return err("#VALUE!");
  const reverse = search < 0;
  let at = findIn(lv.len, lv.get, want, "exact", mode === 2, ctx, reverse);
  if (at < 0 && (mode === -1 || mode === 1)) {
    // The closest smaller (or larger) value, wherever it is.
    let best: Value = null;
    for (let i = 0; i < lv.len; i++) {
      const v = lv.get(i);
      if (v === null || isError(v) || typeof v !== typeof want) continue;
      const c = compare(v, want, ctx);
      if ((mode === -1 && c < 0) || (mode === 1 && c > 0)) {
        if (at < 0 || (mode === -1 ? compare(v, best, ctx) > 0 : compare(v, best, ctx) < 0)) {
          at = i;
          best = v;
        }
      }
    }
  }
  if (at < 0) return args[3] === undefined ? err("#N/A") : scalar(args[3]);
  const vertical = look.width === 1 && look.height !== 1;
  if (vertical) {
    if (ret.height !== look.height) return err("#VALUE!");
    return ret.width === 1 ? ret.at(at, 0) : err("#VALUE!");
  }
  if (ret.width !== look.width) return err("#VALUE!");
  return ret.height === 1 ? ret.at(0, at) : err("#VALUE!");
});
def("INDEX", (args) => {
  const r = args[0] as Arg;
  if (!isRange(r)) return r;
  const a = int(args[1]);
  if (isError(a)) return a;
  let row: number;
  let col: number;
  if (args[2] === undefined) {
    if (r.height === 1) [row, col] = [1, a];
    else if (r.width === 1) [row, col] = [a, 1];
    else return err("#REF!");
  } else {
    const b = int(args[2]);
    if (isError(b)) return b;
    [row, col] = [a, b];
  }
  if (row === 0 && r.height === 1) row = 1;
  if (col === 0 && r.width === 1) col = 1;
  if (row < 1 || col < 1) return err("#VALUE!");
  if (row > r.height || col > r.width) return err("#REF!");
  return r.at(row - 1, col - 1);
});
def("MATCH", (args, ctx) => {
  const want = scalar(args[0]);
  if (isError(want)) return want;
  const r = args[1];
  if (!r || !isRange(r)) return err("#N/A");
  const v = vector(r);
  if (!v) return err("#N/A");
  const type = args[2] === undefined || args[2] === null ? 1 : int(args[2]);
  if (isError(type)) return type;
  const mode = type === 0 ? "exact" : type > 0 ? "le" : "ge";
  const at = findIn(v.len, v.get, want, mode, type === 0, ctx);
  return at < 0 ? err("#N/A") : at + 1;
});

// dates (serials in the 1900 system)
function serialArg(a: Arg | undefined): number | SheetError {
  const n = num(a);
  if (isError(n)) return n;
  return n < 0 || n > MAX_DATE_SERIAL ? err("#NUM!") : Math.floor(n);
}
def("DATE", (args) => {
  let y = int(args[0]);
  if (isError(y)) return y;
  const m = int(args[1]);
  if (isError(m)) return m;
  const d = int(args[2]);
  if (isError(d)) return d;
  if (y < 0 || y > 9999) return err("#NUM!");
  if (y < 1900) y += 1900;
  const s = dateSerial(y, m, d);
  return s < 1 || s > MAX_DATE_SERIAL ? err("#NUM!") : s;
});
const datePart =
  (part: "y" | "m" | "d"): Fn =>
  (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    return serialDate(s)[part];
  };
def("YEAR", datePart("y"));
def("MONTH", datePart("m"));
def("DAY", datePart("d"));
def("WEEKDAY", (args) => {
  const s = serialArg(args[0]);
  if (isError(s)) return s;
  const type = args[1] === undefined ? 1 : int(args[1]);
  if (isError(type)) return type;
  // Serial 1 (1899-12-31) was a Sunday in this system's calendar.
  const sun0 = (((s - 1) % 7) + 7) % 7;
  if (type === 1) return sun0 + 1;
  if (type === 2) return ((sun0 + 6) % 7) + 1;
  if (type === 3) return (sun0 + 6) % 7;
  return err("#NUM!");
});
const monthShift =
  (endOfMonth: boolean): Fn =>
  (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    const months = int(args[1]);
    if (isError(months)) return months;
    const { y, m, d } = serialDate(s);
    const lastDay = dateSerial(y, m + months + 1, 0);
    const out = endOfMonth ? lastDay : Math.min(dateSerial(y, m + months, d), lastDay);
    return out < 1 || out > MAX_DATE_SERIAL ? err("#NUM!") : out;
  };
def("EDATE", monthShift(false));
def("EOMONTH", monthShift(true));
def("DAYS", (args) => {
  const a = serialArg(args[0]);
  if (isError(a)) return a;
  const b = serialArg(args[1]);
  if (isError(b)) return b;
  return a - b;
});
def("TODAY", (_args, ctx) => ctx.today());

/** Every function sheets support, by upper-cased name. */
export const SHEET_FUNCTIONS: ReadonlyMap<string, FunctionDef> = F;

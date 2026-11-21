// A design system's structural changes on its page (docs/spec.md "Design systems"): the ops that
// add or remove a key rather than replace a value a person holds, applied by the room and by every
// renderer with this same pure function. Pure and zod-free (liveDoc.ts holds the frame schema).
//
// - set_dark { token, value }: themes.dark.<token>.$value, creating the groups (and themes.dark);
// - clear_dark { token }: removes it, and any dark group left empty;
// - set_text { path, value }: an optional text that is absent: a token's $description, the root
//   description, or a component's description, usage or status;
// - clear_text { path }: removes one of those (emptying the field sends this, never "");
// - add_token { group, name, value, type? }: "<name>": { "$value": … } last in an existing group,
//   with $type only when the group gives none;
// - remove_token { path }: the token and its dark value; refused while an alias names it or a
//   component's (or the shared) CSS holds one of its variables (a typography token's parts too).
//
// Every op parses the JSON part, changes it, writes it again canonically (a new key goes last in
// its object, except that JavaScript keeps integer-like keys first, in order, which the canonical
// form already does, and the root's guidelines placeholder stays its last member), and checks the
// whole system with the publish rules. What it touches is the one run of lines that differs, found
// from both ends of the JSON part: a run that only inserts is a zero-length range at its place.
// Leases outside that run move by the line map.
import { LIMITS } from "./constants.ts";
import {
  DS_COMPONENT_STATUSES,
  DS_TOKEN_TYPES,
  type DsPath,
  type DsTokenType,
  dsAliasOf,
  dsDeclaredType,
  dsGet,
  dsJsonDepthWithin,
  dsWith,
  isDsName,
  parseDesignSystemValue,
} from "./designSystem.ts";
import {
  dsLiveSystem,
  dsPrettySize,
  dsProjectionParts,
  dsWithPlaceholderLast,
} from "./designSystemLive.ts";
import type { LineRange } from "./liveLines.ts";

export type DsStructOp =
  | { op: "set_dark"; token: string; value: unknown }
  | { op: "clear_dark"; token: string }
  | { op: "set_text"; path: string; value: string }
  | { op: "clear_text"; path: string }
  | { op: "add_token"; group: string; name: string; value: unknown; type?: DsTokenType }
  | { op: "remove_token"; path: string };

export const DS_STRUCT_KINDS = [
  "set_dark",
  "clear_dark",
  "set_text",
  "clear_text",
  "add_token",
  "remove_token",
] as const;

/** Why a design-system op was refused, for the renderer's words. */
export type DsStructProblem = "invalid" | "in_use";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "color.brand.500" as its segments, every one a name; null otherwise. */
export function dsTokenSegs(path: string): string[] | null {
  if (path === "" || path.length > 16 * 65) return null;
  const segs = path.split(".");
  if (segs.length > LIMITS.designSystem.maxDepth || !segs.every(isDsName)) return null;
  return segs;
}

/**
 * An optional text's path as set_text and clear_text name it, as a JSON path into `root`:
 * "description", "tokens.<token>.$description", or "components.<id>.description" (or usage, or
 * status). Null when it names nothing editable that way.
 */
export function dsTextPath(root: unknown, path: string): DsPath | null {
  if (path === "description") return ["description"];
  const tok = /^tokens\.(.+)\.\$description$/.exec(path);
  if (tok) {
    const segs = dsTokenSegs(tok[1] as string);
    const t = segs ? dsGet(root, ["tokens", ...segs]) : undefined;
    return segs && isObject(t) && Object.hasOwn(t, "$value")
      ? ["tokens", ...segs, "$description"]
      : null;
  }
  const comp = /^components\.([a-z][a-z0-9-]{0,47})\.(description|usage|status)$/.exec(path);
  if (comp) {
    const list = dsGet(root, ["components"]);
    if (!Array.isArray(list)) return null;
    const i = list.findIndex((c) => isObject(c) && c.id === comp[1]);
    return i < 0 ? null : ["components", i, comp[2] as string];
  }
  return null;
}

/** A design system's CSS variable for the token `segs` (as the compiler names it). */
export function dsTokenVar(root: unknown, segs: readonly string[]): string {
  const prefix = isObject(root) && typeof root.prefix === "string" ? root.prefix : "ds";
  return `--${prefix}-${segs.join("-")}`.toLowerCase();
}

/** Every token path an alias in `v` names (a $value, or a composite's parts). */
function aliasesIn(v: unknown, out: Set<string>): void {
  const a = dsAliasOf(v);
  if (a) out.add(a);
  else if (Array.isArray(v)) for (const x of v) aliasesIn(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) aliasesIn(x, out);
}

/** The variables a typography token adds besides its own (designSystem.ts TYPOGRAPHY_PARTS). */
const TYPOGRAPHY_PART_VARS = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
];

/**
 * Whether the token `segs` may compile to typography parts: its type (its own or its groups') is
 * typography, or its light or dark value is a typography object, or an alias it names (followed
 * as far as an alias chain may run) is one of those.
 */
function typographyLike(root: unknown, segs: readonly string[]): boolean {
  let at: readonly string[] | null = segs;
  for (let i = 0; at && i <= LIMITS.designSystem.maxAliasChain; i++) {
    if (dsDeclaredType(root, at) === "typography") return true;
    const light = dsGet(root, ["tokens", ...at, "$value"]);
    const dark = dsGet(root, ["themes", "dark", ...at, "$value"]);
    for (const v of [light, dark]) {
      if (isObject(v) && (Object.hasOwn(v, "fontFamily") || Object.hasOwn(v, "fontSize"))) {
        return true;
      }
    }
    const target: string | null = dsAliasOf(light) ?? dsAliasOf(dark);
    at = target === null ? null : dsTokenSegs(target);
  }
  return false;
}

/** Every $value under a tokens (or dark theme) tree, with its token path. */
function eachValue(node: unknown, segs: string[], f: (path: string, v: unknown) => void): void {
  if (!isObject(node)) return;
  if (Object.hasOwn(node, "$value")) {
    f(segs.join("."), node.$value);
    return;
  }
  for (const [k, child] of Object.entries(node)) {
    if (!k.startsWith("$")) eachValue(child, [...segs, k], f);
  }
}

/**
 * Who uses the token `path`: the tokens whose light or dark value is an alias of it (in part or
 * whole), and the components (by name, "shared styles" for the root CSS) whose CSS holds its
 * variable, or for a typography token one of its parts' (`<variable>-font-size` and the rest).
 * Empty when it may be removed.
 */
export function dsTokenUsers(root: unknown, path: string): string[] {
  const segs = dsTokenSegs(path);
  if (!segs || !isObject(root)) return [];
  const users: string[] = [];
  const check = (owner: string, v: unknown) => {
    if (owner === path) return;
    const s = new Set<string>();
    aliasesIn(v, s);
    if (s.has(path) && !users.includes(owner)) users.push(owner);
  };
  eachValue(root.tokens, [], check);
  eachValue(dsGet(root, ["themes", "dark"]), [], check);
  const name = dsTokenVar(root, segs);
  const parts = typographyLike(root, segs) ? `(?:-(?:${TYPOGRAPHY_PART_VARS.join("|")}))?` : "";
  // The variable itself (or a part's), not a longer one it is the start of (--acme-color-brand-500
  // in -5000).
  const re = new RegExp(`${name.replace(/[-]/g, "\\-")}${parts}(?![A-Za-z0-9_-])`, "i");
  if (typeof root.css === "string" && re.test(root.css)) users.push("shared styles");
  if (Array.isArray(root.components)) {
    for (const c of root.components) {
      if (isObject(c) && typeof c.css === "string" && re.test(c.css)) {
        users.push(typeof c.name === "string" ? c.name : String(c.id));
      }
    }
  }
  return users;
}

/** `root` without the key at `path`, and without every dark group (under themes.dark) left empty. */
function withoutDark(root: unknown, segs: readonly string[]): unknown {
  let next = dsWith(root, ["themes", "dark", ...segs], undefined);
  for (let k = segs.length - 1; k >= 1; k--) {
    const group = dsGet(next, ["themes", "dark", ...segs.slice(0, k)]);
    if (!isObject(group) || Object.keys(group).length > 0) break;
    next = dsWith(next, ["themes", "dark", ...segs.slice(0, k)], undefined);
  }
  return next;
}

/** The new JSON value an op makes of `root` (the projection's, placeholder kept), or a refusal. */
function change(root: Record<string, unknown>, op: DsStructOp): unknown | DsStructProblem {
  switch (op.op) {
    case "set_dark": {
      const segs = dsTokenSegs(op.token);
      const t = segs ? dsGet(root, ["tokens", ...segs]) : undefined;
      if (!segs || !isObject(t) || !Object.hasOwn(t, "$value")) return "invalid";
      if (dsGet(root, ["themes", "dark", ...segs]) !== undefined) return "invalid";
      let next: unknown = root;
      const ensure = (path: (string | number)[]) => {
        const at = dsGet(next, path);
        if (at === undefined) next = dsWith(next, path, {});
        else if (!isObject(at)) next = null;
      };
      for (const p of [["themes"], ["themes", "dark"]]) ensure(p);
      for (let k = 1; k <= segs.length && next !== null; k++) {
        ensure(["themes", "dark", ...segs.slice(0, k)]);
      }
      if (next === null) return "invalid";
      return dsWith(next, ["themes", "dark", ...segs, "$value"], op.value) ?? "invalid";
    }
    case "clear_dark": {
      const segs = dsTokenSegs(op.token);
      const d = segs ? dsGet(root, ["themes", "dark", ...segs]) : undefined;
      if (!segs || !isObject(d) || !Object.hasOwn(d, "$value")) return "invalid";
      return withoutDark(root, segs) ?? "invalid";
    }
    case "set_text": {
      const path = dsTextPath(root, op.path);
      if (!path || dsGet(root, path) !== undefined) return "invalid";
      if (typeof op.value !== "string" || op.value === "") return "invalid";
      if (path[path.length - 1] === "status") {
        if (!(DS_COMPONENT_STATUSES as readonly string[]).includes(op.value)) return "invalid";
      }
      return dsWith(root, path, op.value) ?? "invalid";
    }
    case "clear_text": {
      const path = dsTextPath(root, op.path);
      if (!path || dsGet(root, path) === undefined) return "invalid";
      return dsWith(root, path, undefined) ?? "invalid";
    }
    case "add_token": {
      const segs = op.group === "" ? [] : dsTokenSegs(op.group);
      if (!segs || !isDsName(op.name)) return "invalid";
      if (segs.length + 1 > LIMITS.designSystem.maxDepth) return "invalid";
      const group = dsGet(root, ["tokens", ...segs]);
      if (!isObject(group) || Object.hasOwn(group, "$value") || Object.hasOwn(group, op.name)) {
        return "invalid";
      }
      const declared = dsDeclaredType(root, segs);
      if (op.type !== undefined && !(DS_TOKEN_TYPES as readonly string[]).includes(op.type)) {
        return "invalid";
      }
      if (declared !== null && op.type !== undefined && op.type !== declared) return "invalid";
      const token: Record<string, unknown> = { $value: op.value };
      if (declared === null && op.type !== undefined) token.$type = op.type;
      return dsWith(root, ["tokens", ...segs, op.name], token) ?? "invalid";
    }
    case "remove_token": {
      const segs = dsTokenSegs(op.path);
      const t = segs ? dsGet(root, ["tokens", ...segs]) : undefined;
      if (!segs || !isObject(t) || !Object.hasOwn(t, "$value")) return "invalid";
      if (dsTokenUsers(root, op.path).length > 0) return "in_use";
      let next = dsWith(root, ["tokens", ...segs], undefined);
      if (dsGet(next, ["themes", "dark", ...segs]) !== undefined) next = withoutDark(next, segs);
      return next ?? "invalid";
    }
  }
}

/** One run of differing lines between `a` and `b`, found from both ends: [start, endA) became [start, endB). */
function changedRun(a: readonly string[], b: readonly string[]) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

export interface DsStructResult {
  lines: string[];
  /** Where each old line is now, or -1 for a line the op removed or rewrote. */
  map: number[];
  /** What the op removed or rewrote, or the point it inserted at (a zero-length range). */
  touched: LineRange[];
}

let memo: { lines: readonly string[]; key: string; out: DsStructResult | DsStructProblem } | null =
  null;

/**
 * Apply a design-system op to the draft `lines` (a projection): the new lines, how the untouched
 * ones moved, and what it touched; or why not ("in_use": remove_token of a token in use;
 * "invalid": anything else, a result the publish rules refuse included). The room asks what an op
 * touches before it applies it: the last answer is kept for the same lines and op.
 */
export function applyDesignSystemStruct(
  lines: readonly string[],
  op: DsStructOp,
): DsStructResult | DsStructProblem {
  // A value nested past what a system may hold is refused before anything writes it out.
  if ("value" in op && !dsJsonDepthWithin(op.value)) return "invalid";
  const key = JSON.stringify(op);
  if (memo && memo.lines === lines && memo.key === key) return memo.out;
  const out = applyNow(lines, op);
  memo = { lines, key, out };
  return out;
}

function applyNow(lines: readonly string[], op: DsStructOp): DsStructResult | DsStructProblem {
  const p = dsProjectionParts(lines);
  if (!p) return "invalid";
  const changed = change(p.root, op);
  if (changed === "invalid" || changed === "in_use" || !isObject(changed)) {
    return changed === "in_use" ? "in_use" : "invalid";
  }
  // A new root key (themes, description) goes before the placeholder, which stays last.
  const next = dsWithPlaceholderLast(changed);
  const limits = {
    maxLines: LIMITS.maxLiveProjectionLines,
    maxChars: LIMITS.maxLiveProjectionChars,
  };
  if (!dsPrettySize(next, limits)) return "invalid";
  const json = JSON.stringify(next, null, 2).split("\n");
  const out = [...json, ...lines.slice(p.end + 1)];
  const system = dsLiveSystem(out);
  if (!system || !parseDesignSystemValue(system).ok) return "invalid";
  const old = lines.slice(0, p.end + 1);
  const run = changedRun(old, json);
  const delta = run.endB - run.endA;
  const map = lines.map((_, i) => (i < run.start ? i : i < run.endA ? -1 : i + delta));
  return { lines: out, map, touched: [{ start: run.start, end: run.endA }] };
}

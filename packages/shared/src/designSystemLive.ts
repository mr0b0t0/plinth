// A design system's live draft (docs/spec.md "Design systems", "Editing"): the lines the room and
// the renderer share while people edit it on its page. A token value is one JSON line, but the
// guidelines are one long JSON string (up to 200 KB) that a line lease cannot share, so the draft is
// not system.json itself but a line projection of it. Pure and zod-free: the room, the renderer and
// the describers use it.
//
// The projection (designSystemToLive): the JSON without its guidelines, written JSON.stringify(…, null, 2),
// with "guidelines": null standing at their key (or, when there are none, after themes, else after
// tokens), then the guidelines Markdown as lines of their own after the root's closing "}". That
// "}" is the first line that is exactly "}", since pretty JSON indents every other one. Every line
// of the JSON part is canonical (JSON.stringify of its value), which the rules keep edit by edit,
// so one JSON value is always the same lines and a lease on them is a lease on that value.
//
// The storage form (designSystemFromLive): the guidelines go back in place of the placeholder (or the key goes
// when they are empty), written with 2 spaces when that fits LIMITS.maxDesignSystemBytes, and
// compact otherwise. An agent's publish keeps its own bytes; only a Publish from the page writes this
// form, and it never fails on size where the agent's version fit, since compact JSON is the
// smallest spelling of the same value.
import { LIMITS } from "./constants.ts";
import {
  type DsPath,
  dsEditableKind,
  dsSetOwn,
  dsValueProblem,
  parseDesignSystemValue,
} from "./designSystem.ts";
import type { LiveDocErrorCode } from "./liveDoc.ts";
import { joinLines, splitLines } from "./liveLines.ts";
import { utf8Length } from "./utf8.ts";

const L = LIMITS.designSystem;
const GUIDELINES = "guidelines";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The line of the projection's root "}" (the end of its JSON part), or -1 when there is none. */
export function dsProjectionEnd(lines: readonly string[]): number {
  return lines.indexOf("}");
}

/** The root's keys with `guidelines` at `key` set to `value` (undefined drops it). */
function withGuidelines(root: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const k of Object.keys(root)) {
    if (k === GUIDELINES) {
      placed = true;
      if (value !== undefined) dsSetOwn(out, k, value);
      continue;
    }
    dsSetOwn(out, k, root[k]);
  }
  if (!placed && value !== undefined) dsSetOwn(out, GUIDELINES, value);
  return out;
}

/** The projection's JSON value with the placeholder, for a system that has no guidelines key. */
function withPlaceholder(root: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(root, GUIDELINES)) return withGuidelines(root, null);
  const keys = Object.keys(root);
  const after = keys.includes("themes") ? "themes" : keys.includes("tokens") ? "tokens" : null;
  const out: Record<string, unknown> = {};
  if (after === null) dsSetOwn(out, GUIDELINES, null);
  for (const k of keys) {
    dsSetOwn(out, k, root[k]);
    if (k === after) dsSetOwn(out, GUIDELINES, null);
  }
  return out;
}

/**
 * A stored system.json as the draft's lines. A source that is not a JSON object with string (or no)
 * guidelines is returned as it is: it is not a draft the rules accept (valid), so nothing edits it.
 */
export function designSystemToLive(source: string): string {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch {
    return source;
  }
  if (!isObject(root)) return source;
  const g = Object.hasOwn(root, GUIDELINES) ? root[GUIDELINES] : undefined;
  if (g !== undefined && typeof g !== "string") return source;
  const json = JSON.stringify(withPlaceholder(root), null, 2);
  return g ? `${json}\n${g}` : json;
}

/** The JSON part's value and the guidelines of the draft `lines`, or null for no projection. */
export function dsProjectionParts(
  lines: readonly string[],
): { root: Record<string, unknown>; guidelines: string; end: number } | null {
  const end = dsProjectionEnd(lines);
  if (end < 0) return null;
  let root: unknown;
  try {
    root = JSON.parse(joinLines(lines.slice(0, end + 1)));
  } catch {
    return null;
  }
  if (!isObject(root) || !Object.hasOwn(root, GUIDELINES) || root[GUIDELINES] !== null) return null;
  return { root, guidelines: joinLines(lines.slice(end + 1)), end };
}

/**
 * The design system the draft `lines` hold, as a parsed system.json value (its guidelines back in
 * place, or gone when empty), or null when the lines are not a projection.
 */
export function dsLiveSystem(lines: readonly string[]): Record<string, unknown> | null {
  const p = dsProjectionParts(lines);
  return p ? withGuidelines(p.root, p.guidelines === "" ? undefined : p.guidelines) : null;
}

/**
 * The draft as system.json: 2-space JSON when that fits LIMITS.maxDesignSystemBytes, compact JSON
 * otherwise. A text that is not a projection is returned as it is.
 */
export function designSystemFromLive(live: string): string {
  const value = dsLiveSystem(splitLines(live));
  if (!value) return live;
  const pretty = JSON.stringify(value, null, 2);
  return utf8Length(pretty) <= LIMITS.maxDesignSystemBytes ? pretty : JSON.stringify(value);
}

/** Where a JSON string token that starts at `from` (a `"`) ends: the index after its closing quote. */
function stringEnd(s: string, from: number): number {
  for (let i = from + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) i++;
    else if (c === 0x22) return i + 1;
  }
  return -1;
}

/** Leading spaces of a line. */
function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 0x20) i++;
  return i;
}

/** The line is an object member (`"key": …`), not an array element or a bracket. */
function isMemberLine(body: string): boolean {
  if (body.charCodeAt(0) !== 0x22) return false;
  const e = stringEnd(body, 0);
  return e > 0 && body.charCodeAt(e) === 0x3a && body.charCodeAt(e + 1) === 0x20;
}

/**
 * The bytes the draft would take as compact JSON (JSON.stringify of its system), the smallest a
 * Publish can store, counted line by line without building it: a JSON-part line counts its bytes
 * without its indent and without the space after a member's `":`, the placeholder's `null` gives
 * way to the guidelines as a JSON string (each line JSON-escaped, plus 2 for the `\n` between two),
 * and with no guidelines the placeholder member goes with one comma. A text that is not a
 * projection counts its own bytes.
 */
export function dsCompactBytes(lines: readonly string[]): number {
  const end = dsProjectionEnd(lines);
  if (end < 0) return utf8Length(joinLines(lines));
  let n = 0;
  let rootMembers = 0;
  for (let i = 0; i <= end; i++) {
    const line = lines[i] as string;
    const indent = indentOf(line);
    const body = line.slice(indent);
    n += utf8Length(body);
    if (isMemberLine(body)) {
      n -= 1;
      if (indent === 2) rootMembers++;
    }
  }
  const g = lines.slice(end + 1);
  const guidelines = joinLines(g);
  if (guidelines === "") {
    // `"guidelines":null` and the comma before or after it.
    return n - 17 - (rootMembers > 1 ? 1 : 0);
  }
  let escaped = 2 + 2 * (g.length - 1);
  for (const line of g) escaped += utf8Length(JSON.stringify(line)) - 2;
  return n - 4 + escaped;
}

/** Past what a draft may hold: more than LIMITS.maxLiveProjectionLines lines, or no storage form fits. */
export function liveDesignSystemTooLarge(live: string): boolean {
  let lines = 1;
  for (let i = live.indexOf("\n"); i !== -1; i = live.indexOf("\n", i + 1)) {
    if (++lines > LIMITS.maxLiveProjectionLines) return true;
  }
  return dsCompactBytes(splitLines(live)) > LIMITS.maxDesignSystemBytes;
}

// ---------- value nodes ----------

/** One JSON value of the projection's JSON part: its path, its lines and how it is written. */
export interface DsLiveNode {
  path: (string | number)[];
  /** Its first line (the key line of a member). */
  start: number;
  /** Exclusive: one past its last line (the closing bracket of an object or array). */
  end: number;
  /** Spaces before its key. */
  indent: number;
  /** Its last line ends with a comma (a member or element follows). */
  comma: boolean;
}

/**
 * Every member and array element of the JSON part (the lines up to `end`, the root's "}"), with its
 * path and the lines of its whole value: one line for a scalar or an empty object or array, from
 * its key line to its closing bracket otherwise. The lines must be canonical (2-space pretty JSON);
 * a line that does not read as such ends the index there.
 */
export function dsIndexNodes(lines: readonly string[], end = dsProjectionEnd(lines)): DsLiveNode[] {
  const out: DsLiveNode[] = [];
  if (end < 1 || lines[0] !== "{") return out;
  const stack: {
    path: (string | number)[];
    array: boolean;
    next: number;
    open: DsLiveNode | null;
  }[] = [{ path: [], array: false, next: 0, open: null }];
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const indent = indentOf(line);
    const body = line.slice(indent);
    const top = stack[stack.length - 1];
    if (!top) break;
    const c = body.charCodeAt(0);
    if (c === 0x7d || c === 0x5d) {
      // "}" or "]": the value the top frame opened ends here.
      stack.pop();
      if (top.open) {
        top.open.end = i + 1;
        top.open.comma = body.endsWith(",");
      }
      continue;
    }
    let key: string | number;
    let rest: string;
    if (top.array) {
      key = top.next++;
      rest = body;
    } else {
      const e = stringEnd(body, 0);
      if (body.charCodeAt(0) !== 0x22 || e < 0 || body.slice(e, e + 2) !== ": ") break;
      try {
        key = JSON.parse(body.slice(0, e)) as string;
      } catch {
        break;
      }
      rest = body.slice(e + 2);
    }
    const comma = rest.endsWith(",");
    const value = comma ? rest.slice(0, -1) : rest;
    const node: DsLiveNode = { path: [...top.path, key], start: i, end: i + 1, indent, comma };
    out.push(node);
    if (value === "{" || value === "[") {
      node.end = -1;
      node.comma = false;
      stack.push({ path: node.path, array: value === "[", next: 0, open: node });
    }
  }
  return out;
}

/** The node at exactly the lines [start, end), or null. */
export function dsNodeAtRange(
  lines: readonly string[],
  start: number,
  end: number,
): DsLiveNode | null {
  for (const n of dsIndexNodes(lines)) {
    if (n.start === start && n.end === end) return n;
    if (n.start > start) break;
  }
  return null;
}

/** The node at `path`, or null. */
export function dsNodeAtPath(lines: readonly string[], path: DsPath): DsLiveNode | null {
  const want = JSON.stringify(path);
  return dsIndexNodes(lines).find((n) => JSON.stringify(n.path) === want) ?? null;
}

/**
 * A node's lines with `value`, written as the whole JSON part writes it: the key (none for an array
 * element), then JSON.stringify(value, null, 2) at the node's indent, and its comma when it had one.
 */
export function dsNodeLines(
  node: Pick<DsLiveNode, "path" | "indent" | "comma">,
  value: unknown,
): string[] {
  const key = node.path[node.path.length - 1];
  const pad = " ".repeat(node.indent);
  const head = typeof key === "string" ? `${pad}${JSON.stringify(key)}: ` : pad;
  const parts = (JSON.stringify(value, null, 2) ?? "null").split("\n");
  const out = parts.map((p, i) => (i === 0 ? head + p : pad + p));
  if (node.comma) out[out.length - 1] += ",";
  return out;
}

const NOT_A_VALUE: unique symbol = Symbol("not a value");

/**
 * The value an edit's lines `ins` put in `node`'s place, when they are exactly that node written
 * canonically with a new value (its key, its indent and its comma kept); NOT_A_VALUE otherwise.
 */
export function dsReadNodeEdit(
  node: Pick<DsLiveNode, "path" | "indent" | "comma">,
  ins: readonly string[],
): unknown | typeof NOT_A_VALUE {
  const key = node.path[node.path.length - 1];
  const text = joinLines(ins);
  const head = `${" ".repeat(node.indent)}${typeof key === "string" ? `${JSON.stringify(key)}: ` : ""}`;
  if (!text.startsWith(head)) return NOT_A_VALUE;
  let raw = text.slice(head.length);
  if (node.comma) {
    if (!raw.endsWith(",")) return NOT_A_VALUE;
    raw = raw.slice(0, -1);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NOT_A_VALUE;
  }
  const canonical = dsNodeLines(node, value);
  if (canonical.length !== ins.length || canonical.some((l, i) => l !== ins[i])) return NOT_A_VALUE;
  return value;
}

/** Whether dsReadNodeEdit read a value. */
export function dsIsNodeValue(v: unknown): boolean {
  return v !== NOT_A_VALUE;
}

// ---------- the rules ----------

/**
 * Why an edit that replaces `del` lines at `start` with `ins` is refused, or null. In the JSON part
 * it must replace exactly one editable value (dsEditableKind) with that value written canonically
 * at the same key, indent and comma, and the new value must pass the publish rules on the whole
 * system (dsValueProblem); in the guidelines part, any lines, as a doc's, within
 * LIMITS.designSystem.maxGuidelinesBytes. No edit spans both parts or touches the root's braces.
 */
export function checkDesignSystemEdit(
  lines: readonly string[],
  start: number,
  del: number,
  ins: readonly string[],
): LiveDocErrorCode | null {
  const end = dsProjectionEnd(lines);
  if (end < 0) return "invalid";
  if (start > end) {
    const g = [...lines.slice(end + 1, start), ...ins, ...lines.slice(start + del)];
    return utf8Length(joinLines(g)) > L.maxGuidelinesBytes ? "too_large" : null;
  }
  if (del === 0 || ins.length === 0 || start + del > end) return "invalid";
  const node = dsNodeAtRange(lines, start, start + del);
  if (!node) return "invalid";
  const system = dsLiveSystem(lines);
  if (!system || dsEditableKind(system, node.path) === null) return "invalid";
  const value = dsReadNodeEdit(node, ins);
  if (!dsIsNodeValue(value)) return "invalid";
  return dsValueProblem(system, node.path, value) ? "invalid" : null;
}

/**
 * A whole draft the design system rules hold: a projection whose JSON part is canonical, whose
 * guidelines fit their limit, and whose system passes the publish rules (parseDesignSystem), so
 * its storage form (designSystemFromLive) is a system.json the publish hook accepts.
 */
export function validDesignSystemDraft(live: string): boolean {
  const lines = splitLines(live);
  const p = dsProjectionParts(lines);
  if (!p) return false;
  if (JSON.stringify(p.root, null, 2) !== joinLines(lines.slice(0, p.end + 1))) return false;
  if (utf8Length(p.guidelines) > L.maxGuidelinesBytes) return false;
  const system = withGuidelines(p.root, p.guidelines === "" ? undefined : p.guidelines);
  return parseDesignSystemValue(system).ok;
}

/**
 * Two design systems compared the way the review and outside() compare them: by their
 * projections, so a version that only spells the same JSON another way (white space, a compact
 * file) is no change.
 */
export function sameDesignSystem(a: string, b: string): boolean {
  return designSystemToLive(a) === designSystemToLive(b);
}

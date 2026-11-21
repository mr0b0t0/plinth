// A design system's live draft (docs/spec.md "Design systems", "Editing"): the lines the room and
// the renderer share while people edit it on its page. A token value is one JSON line, but the
// guidelines are one long JSON string (up to 200 KB) that a line lease cannot share, so the draft is
// not system.json itself but a line projection of it. Pure and zod-free: the room, the renderer and
// the describers use it.
//
// The projection (designSystemToLive): the JSON without its guidelines, written JSON.stringify(…, null, 2),
// with "guidelines": null as the root's last member wherever the file had the key, then the
// guidelines Markdown as lines of their own after the root's closing "}" (none at all when the file
// has no guidelines key; one empty line for "guidelines": ""). That "}" is the first line that is
// exactly "}", since pretty JSON indents every other one, and the placeholder is the line before
// it. Every line of the JSON part is canonical (JSON.stringify of its value), which the rules keep
// edit by edit, so one JSON value is always the same lines and a lease on them is a lease on that
// value. A file too deep or too large to write out that way (LIMITS.maxLiveProjectionLines,
// maxLiveProjectionChars, designSystem.maxJsonDepth) is not projected: it is not a draft.
//
// The storage form (designSystemFromLive): the guidelines go back as the last key (the key goes when
// no line follows the JSON part), written with 2 spaces when that fits LIMITS.maxDesignSystemBytes,
// and compact otherwise. So designSystemToLive(designSystemFromLive(x)) is x for every draft the
// rules accept, and the draft row (which stores this form) loads back as the same lines. An agent's
// publish keeps its own bytes; only a Publish from the page writes this form, and it never fails
// on size where the agent's version fit, since compact JSON is the smallest spelling of the same
// value.
import { LIMITS } from "./constants.ts";
import {
  type DsPath,
  dsEditableKind,
  dsJsonDepthWithin,
  dsSetOwn,
  dsValueProblem,
  parseDesignSystemValue,
} from "./designSystem.ts";
import type { LiveDocErrorCode } from "./liveDoc.ts";
import { joinLines, splitLines } from "./liveLines.ts";
import { utf8Length } from "./utf8.ts";

const L = LIMITS.designSystem;
const GUIDELINES = "guidelines";
/** The placeholder's line: the root's last member, so the line just before the root's "}". */
const PLACEHOLDER_LINE = '  "guidelines": null';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The line of the projection's root "}" (the end of its JSON part), or -1 when there is none. */
export function dsProjectionEnd(lines: readonly string[]): number {
  return lines.indexOf("}");
}

/**
 * Whether the lines have a projection's shape: "{", then its JSON part ending in the placeholder
 * and the root's "}" at `end`. A cheap test (the values are not read): a file the room could not
 * project fails it, since its guidelines are a string or absent.
 */
function projectionShaped(lines: readonly string[], end: number): boolean {
  return end > 1 && lines[0] === "{" && lines[end - 1] === PLACEHOLDER_LINE;
}

/**
 * The length of what dsNodeLines writes for `value` (`key` characters of key and ": " before it on
 * its first line, every line after `indent` spaces, a "," at the end when `comma`), and its lines,
 * counted without writing it; null as soon as either passes its limit. JSON.stringify(…, null, 2)
 * of a small value can be huge (each level of nesting indents every line inside it), so the room
 * counts first.
 */
export function dsPrettySize(
  value: unknown,
  o: { indent?: number; key?: number; comma?: boolean; maxLines: number; maxChars: number },
): { lines: number; chars: number } | null {
  type Item =
    | { v: unknown; depth: number; key: number; comma: boolean }
    | { close: true; depth: number; comma: boolean };
  const indent = o.indent ?? 0;
  const stack: Item[] = [{ v: value, depth: 0, key: o.key ?? 0, comma: o.comma ?? false }];
  let lines = 0;
  // Each line adds its own "\n" before it; the first has none.
  let chars = -1;
  for (let it = stack.pop(); it; it = stack.pop()) {
    const ind = indent + 2 * it.depth;
    const comma = it.comma ? 1 : 0;
    lines++;
    if ("close" in it) {
      chars += 1 + ind + 1 + comma;
    } else if (typeof it.v === "object" && it.v !== null) {
      const items: [number, unknown][] = Array.isArray(it.v)
        ? it.v.map((x): [number, unknown] => [0, x])
        : Object.entries(it.v)
            .filter(([, x]) => x !== undefined && typeof x !== "function")
            .map(([k, x]): [number, unknown] => [JSON.stringify(k).length + 2, x]);
      if (items.length === 0) {
        chars += 1 + ind + it.key + 2 + comma;
      } else {
        chars += 1 + ind + it.key + 1;
        stack.push({ close: true, depth: it.depth, comma: it.comma });
        for (let i = items.length - 1; i >= 0; i--) {
          const [key, v] = items[i] as [number, unknown];
          stack.push({ v, depth: it.depth + 1, key, comma: i < items.length - 1 });
        }
      }
    } else {
      chars += 1 + ind + it.key + (JSON.stringify(it.v) ?? "null").length + comma;
    }
    if (lines > o.maxLines || chars > o.maxChars) return null;
  }
  return { lines, chars };
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

/**
 * `root` with `guidelines` moved to (or added as) its last key, set to null: the projection's JSON
 * value. Also how a structural op keeps the placeholder last when it adds a root key.
 */
export function dsWithPlaceholderLast(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(root)) if (k !== GUIDELINES) dsSetOwn(out, k, root[k]);
  dsSetOwn(out, GUIDELINES, null);
  return out;
}

/**
 * A stored system.json as the draft's lines. A source that is not a JSON object with string (or no)
 * guidelines, or that nests or writes out past what a draft may hold, is returned as it is: it is
 * not a draft the rules accept (valid, and liveDesignSystemTooLarge says so), so nothing edits it.
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
  const value = dsWithPlaceholderLast(root);
  // Counted before it is written: nesting multiplies the indentation, and JSON.stringify recurses.
  if (!dsJsonDepthWithin(value)) return source;
  const limits = {
    maxLines: LIMITS.maxLiveProjectionLines,
    maxChars: LIMITS.maxLiveProjectionChars,
  };
  if (!dsPrettySize(value, limits)) return source;
  const json = JSON.stringify(value, null, 2);
  return g === undefined ? json : `${json}\n${g}`;
}

/**
 * The JSON part's value and the guidelines of the draft `lines` (null when no line follows the JSON
 * part: the file has no guidelines key), or null for no projection.
 */
export function dsProjectionParts(
  lines: readonly string[],
): { root: Record<string, unknown>; guidelines: string | null; end: number } | null {
  const end = dsProjectionEnd(lines);
  if (!projectionShaped(lines, end)) return null;
  let root: unknown;
  try {
    root = JSON.parse(joinLines(lines.slice(0, end + 1)));
  } catch {
    return null;
  }
  if (!isObject(root) || !Object.hasOwn(root, GUIDELINES) || root[GUIDELINES] !== null) return null;
  const guidelines = end + 1 < lines.length ? joinLines(lines.slice(end + 1)) : null;
  return { root, guidelines, end };
}

/**
 * The design system the draft `lines` hold, as a parsed system.json value (its guidelines back as
 * its last key, or gone when no line follows the JSON part), or null when the lines are not a
 * projection.
 */
export function dsLiveSystem(lines: readonly string[]): Record<string, unknown> | null {
  const p = dsProjectionParts(lines);
  return p ? withGuidelines(p.root, p.guidelines ?? undefined) : null;
}

/**
 * The draft as system.json: 2-space JSON when that fits LIMITS.maxDesignSystemBytes, compact JSON
 * otherwise, with the guidelines last (absent when no line follows the JSON part). A text that is
 * not a projection is returned as it is.
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
 * and with no line after the JSON part the placeholder member goes with one comma. A text that is
 * not a projection counts its own bytes.
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
  if (g.length === 0) {
    // `"guidelines":null` and the comma before or after it.
    return n - 17 - (rootMembers > 1 ? 1 : 0);
  }
  let escaped = 2 + 2 * (g.length - 1);
  for (const line of g) escaped += utf8Length(JSON.stringify(line)) - 2;
  return n - 4 + escaped;
}

/**
 * Past what a draft may hold: more than LIMITS.maxLiveProjectionLines lines, or no storage form
 * fits, or not a projection at all (a file designSystemToLive could not write out as one, since it
 * nests or writes out too large, is shown read-only with "too large to edit on the page").
 */
export function liveDesignSystemTooLarge(live: string): boolean {
  let lines = 1;
  for (let i = live.indexOf("\n"); i !== -1; i = live.indexOf("\n", i + 1)) {
    if (++lines > LIMITS.maxLiveProjectionLines) return true;
  }
  const all = splitLines(live);
  if (!projectionShaped(all, dsProjectionEnd(all))) return true;
  return dsCompactBytes(all) > LIMITS.maxDesignSystemBytes;
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
  // Counted first: the canonical lines are exactly as long as the edit's, or it is not one, and
  // writing out a small, deeply nested value could take far more than the frame.
  const size = dsPrettySize(value, {
    indent: node.indent,
    key: head.length - node.indent,
    comma: node.comma,
    maxLines: ins.length,
    maxChars: text.length,
  });
  if (!size || size.lines !== ins.length || size.chars !== text.length) return NOT_A_VALUE;
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
  if (!projectionShaped(lines, end)) return "invalid";
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
  const keys = Object.keys(p.root);
  if (keys[keys.length - 1] !== GUIDELINES || !dsJsonDepthWithin(p.root)) return false;
  if (JSON.stringify(p.root, null, 2) !== joinLines(lines.slice(0, p.end + 1))) return false;
  if (p.guidelines !== null && utf8Length(p.guidelines) > L.maxGuidelinesBytes) return false;
  const system = withGuidelines(p.root, p.guidelines ?? undefined);
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

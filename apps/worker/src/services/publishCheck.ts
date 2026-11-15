// Publish warnings (docs/spec.md, "Publish warnings"): what a version's own files reference but will
// not load once served. Advisory only, never a reason to refuse a publish. A pure module: the stager
// passes the text files that arrived in this request, the version's final manifest paths and the
// CSP sources the content host will send (content/csp.ts contentSources), so the warnings and the
// CSP cannot disagree.
//
// The scanners are hand-written single-pass tokenizers (no regular expressions over the input), so
// their cost is linear in the input whatever it holds. They aim at what builds emit (Vite, esbuild,
// hand-written pages): HTML attributes, CSS url() and @import, JS import specifiers. They do not
// try to understand every JavaScript construct; a reference they miss is only a warning not given.
import { LIMITS, type PublishWarning } from "@plinth/shared";
import type { ContentSources } from "../content/csp.ts";
import type { FileEntry } from "./storage.ts";

export interface ScanInput {
  /** Text files whose bytes arrived in this request (others are not scanned). */
  files: FileEntry[];
  /** Every path of the version's final manifest, the source included. */
  manifestPaths: Set<string>;
  sources: ContentSources;
  isolation: "origin" | "opaque";
  /** Files left out of the scan by the stager's budget. */
  unscanned?: string[];
  /**
   * Text files reused from the version before without their bytes in this request ({path,
   * sha256} or a carry-forward): not re-checked, so a file they import that is gone goes unseen.
   */
  reused?: string[];
}

type Directive = keyof ContentSources | "navigate" | "any";

interface Ref {
  url: string;
  directive: Directive;
}

const ROOT_ABSOLUTE =
  "loads the current version's file even when an older version is viewed, and fails under the path fallback. Build with relative URLs (Vite base: './')";
const OPAQUE =
  "This instance runs opaque isolation: module scripts, crossorigin links and web fonts load with Origin: null and fail. Build a classic bundle (Vite: build.modulePreload false and an iife/legacy output)";

/** Echo text from a caller's file safely: at most 200 characters, control characters escaped. */
export function echo(s: string): string {
  const cut = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  let out = "";
  for (const ch of cut) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

const decoder = new TextDecoder();

function kindOf(f: FileEntry): "html" | "css" | "js" | null {
  const t = f.contentType.toLowerCase();
  if (t.startsWith("text/html")) return "html";
  if (t.startsWith("text/css")) return "css";
  if (t.startsWith("text/javascript") || t.startsWith("application/javascript")) return "js";
  return null;
}

export function scanPublish(input: ScanInput): PublishWarning[] {
  const out: PublishWarning[] = [];
  let budget = LIMITS.maxScanBytes;
  const unscanned = [...(input.unscanned ?? [])];
  for (const f of input.files) {
    const kind = kindOf(f);
    if (!kind) continue;
    if (f.bytes.byteLength > LIMITS.maxScanFileBytes || f.bytes.byteLength > budget) {
      unscanned.push(f.path);
      continue;
    }
    budget -= f.bytes.byteLength;
    const text = decoder.decode(f.bytes);
    const found: Ref[] = [];
    const flags = { opaque: false };
    if (kind === "html") scanHtml(text, found, flags);
    else if (kind === "css") scanCss(text, found, flags, "img");
    else scanJs(text, found, flags);
    checkRefs(f.path, found, input, out);
    if (flags.opaque && input.isolation === "opaque") {
      out.push({ code: "opaque_module", file: f.path, message: OPAQUE });
    }
  }
  const reused = input.reused ?? [];
  if (unscanned.length + reused.length > 0) {
    const parts: string[] = [];
    if (unscanned.length > 0) {
      parts.push(
        `${unscanned.length} file(s) were not checked for references: the check reads at most ${LIMITS.maxScanFileBytes / 1024 / 1024} MB per file and ${LIMITS.maxScanBytes / 1024 / 1024} MB per publish`,
      );
    }
    if (reused.length > 0) {
      parts.push(
        `${reused.length} file(s) reused unchanged from the version before were not re-checked (their bytes were not sent), so a file they load that this version left out goes unnoticed; a bundle (start_upload) checks every file`,
      );
    }
    out.push({
      code: "not_scanned",
      file: echo(unscanned[0] ?? reused[0] ?? ""),
      count: unscanned.length + reused.length,
      // Information, not something to fix: the files are published; only the reference check
      // did not read them.
      message: `${parts.join(". ")}. No action needed`,
    });
  }
  return cap(out);
}

function cap(warnings: PublishWarning[]): PublishWarning[] {
  const max = LIMITS.maxWarnings;
  if (warnings.length <= max) return warnings;
  const kept = warnings.slice(0, max - 1);
  const rest = warnings.slice(max - 1);
  const first = rest[0] as PublishWarning;
  kept.push({
    code: first.code,
    file: first.file,
    count: rest.length,
    message: `and ${rest.length} more`,
  });
  return kept;
}

// ---------- reference rules ----------

function lower(s: string): string {
  return s.toLowerCase();
}

function stripQueryAndFragment(u: string): string {
  let end = u.length;
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (c === "?" || c === "#") {
      end = i;
      break;
    }
  }
  return u.slice(0, end);
}

function schemeOf(u: string): string | null {
  for (let i = 0; i < u.length && i < 32; i++) {
    const c = u.charCodeAt(i);
    if (c === 58 /* : */) return i > 0 ? lower(u.slice(0, i)) : null;
    const ok =
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      (i > 0 && ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46));
    if (!ok) return null;
  }
  return null;
}

function hostOf(rest: string): string {
  // rest starts after "//"
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "/" || c === "?" || c === "#") {
      end = i;
      break;
    }
  }
  let host = rest.slice(0, end);
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.lastIndexOf(":");
  if (colon >= 0 && !host.endsWith("]")) host = host.slice(0, colon);
  return lower(host);
}

/** Resolve a relative path against a file's directory; null when it climbs above the root. */
function resolveRelative(fromFile: string, rel: string): string | null {
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")).split("/") : [];
  const parts = [...dir];
  const segs = rel.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    if (seg === "" || seg === ".") {
      if (i === segs.length - 1 && seg === "") parts.push("");
      continue;
    }
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  let path = parts.filter((p, i) => p !== "" || i === parts.length - 1).join("/");
  if (path === "" || path.endsWith("/")) path += "index.html";
  return path;
}

function checkRefs(file: string, refs: Ref[], input: ScanInput, out: PublishWarning[]): void {
  let rootAbsolute = 0;
  let firstRoot = "";
  const seen = new Set<string>();
  for (const r of refs) {
    const raw = r.url.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    // Template placeholders left in a file are not references.
    if (raw.includes("${") || raw.includes("{{")) continue;
    const key = `${r.directive} ${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scheme = schemeOf(raw);
    if (scheme !== null) {
      if (scheme === "http") {
        const host = raw.length > 7 && raw.slice(5, 7) === "//" ? hostOf(raw.slice(7)) : "";
        out.push({
          code: "insecure_url",
          file,
          ref: echo(raw),
          ...(host ? { host: echo(host) } : {}),
          message: "http: is blocked on an https page; use https",
        });
      } else if (scheme === "https") {
        checkHost(file, raw, hostOf(raw.slice(8)), r.directive, input, out);
      }
      // data:, blob:, mailto:, javascript: and other schemes are not files.
      continue;
    }
    if (raw.startsWith("//")) {
      checkHost(file, raw, hostOf(raw.slice(2)), r.directive, input, out);
      continue;
    }
    if (raw.startsWith("/")) {
      rootAbsolute += 1;
      if (!firstRoot) firstRoot = raw;
      continue;
    }
    let rel = stripQueryAndFragment(raw);
    if (rel === "") continue;
    try {
      rel = decodeURIComponent(rel);
    } catch {
      // keep it as written
    }
    const path = resolveRelative(file, rel);
    if (path === null || !input.manifestPaths.has(path)) {
      out.push({
        code: "missing_file",
        file,
        ref: echo(raw),
        message: `${echo(raw)} is not in this version${path ? ` (looked for ${echo(path)})` : ""}`,
      });
    }
  }
  if (rootAbsolute > 0) {
    out.push({
      code: "root_absolute",
      file,
      ref: echo(firstRoot),
      count: rootAbsolute,
      message: `${echo(firstRoot)} ${ROOT_ABSOLUTE}`,
    });
  }
}

function checkHost(
  file: string,
  raw: string,
  host: string,
  directive: Directive,
  input: ScanInput,
  out: PublishWarning[],
): void {
  if (directive === "navigate" || directive === "any") return;
  if (input.sources[directive].includes(host)) return;
  out.push({
    code: "blocked_host",
    file,
    ref: echo(raw),
    host: echo(host),
    message: `${echo(host)} is not allowed for ${directive === "base" ? "<base>" : `${directive}s`} on this instance's content host (GET /api/v1/config lists cdn_allowlist)`,
  });
}

// ---------- HTML ----------

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
}

function isNameChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  return !isSpace(c) && c !== ">" && c !== "/" && c !== "=" && c !== '"' && c !== "'" && c !== "<";
}

const LINK_RELS = new Set([
  "stylesheet",
  "modulepreload",
  "preload",
  "icon",
  "shortcut",
  "apple-touch-icon",
  "manifest",
  "prefetch",
]);

/** Find `needle` (lowercase ASCII) in `s` from `from`, ignoring ASCII case. -1 if absent. */
function indexOfCi(s: string, needle: string, from: number): number {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  for (let i = from; i + n <= s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== first) continue;
    let j = 1;
    for (; j < n; j++) {
      let d = s.charCodeAt(i + j);
      if (d >= 65 && d <= 90) d += 32;
      if (d !== needle.charCodeAt(j)) break;
    }
    if (j === n) return i;
  }
  return -1;
}

function scanHtml(s: string, refs: Ref[], flags: { opaque: boolean }): void {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s[lt + 1] === "!" || s[lt + 1] === "?" || s[lt + 1] === "/") {
      const end = s.indexOf(">", lt + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Tag name
    let j = lt + 1;
    while (j < n && isNameChar(s[j])) j++;
    const tag = lower(s.slice(lt + 1, j));
    if (tag === "") {
      i = lt + 1;
      continue;
    }
    // Attributes
    const attrs = new Map<string, string>();
    while (j < n) {
      while (j < n && (isSpace(s[j]) || s[j] === "/")) j++;
      if (j >= n || s[j] === ">") break;
      const ns = j;
      while (j < n && isNameChar(s[j])) j++;
      if (j === ns) {
        j++;
        continue;
      }
      const name = lower(s.slice(ns, j));
      while (j < n && isSpace(s[j])) j++;
      let value = "";
      if (s[j] === "=") {
        j++;
        while (j < n && isSpace(s[j])) j++;
        const q = s[j];
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, j + 1);
          value = s.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(s[j]) && s[j] !== ">") j++;
          value = s.slice(vs, j);
        }
      }
      if (!attrs.has(name)) attrs.set(name, decodeEntities(value));
    }
    i = j + 1;
    onTag(tag, attrs, refs, flags);
    // Raw text elements: scan their content and skip to the closing tag.
    if (tag === "script" || tag === "style") {
      const close = indexOfCi(s, `</${tag}`, i);
      const body = s.slice(i, close < 0 ? n : close);
      if (tag === "style") scanCss(body, refs, flags, "img");
      else if (!attrs.has("src")) {
        const type = lower(attrs.get("type") ?? "");
        if (type === "" || type === "module" || type.includes("javascript")) {
          scanJs(body, refs, flags);
        }
      }
      i = close < 0 ? n : close;
    } else if (tag === "textarea" || tag === "title") {
      const close = indexOfCi(s, `</${tag}`, i);
      i = close < 0 ? n : close;
    }
  }
}

function decodeEntities(v: string): string {
  if (!v.includes("&")) return v;
  return v
    .split("&amp;")
    .join("&")
    .split("&quot;")
    .join('"')
    .split("&#39;")
    .join("'")
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">");
}

function onTag(
  tag: string,
  attrs: Map<string, string>,
  refs: Ref[],
  flags: { opaque: boolean },
): void {
  const src = attrs.get("src");
  if (tag === "script") {
    const type = lower(attrs.get("type") ?? "");
    if (type === "module" || attrs.has("crossorigin")) flags.opaque = true;
    if (src !== undefined) refs.push({ url: src, directive: "script" });
  } else if (src !== undefined) {
    const directive: Directive =
      tag === "img" || tag === "input"
        ? "img"
        : tag === "iframe" || tag === "frame"
          ? "frame"
          : tag === "audio" || tag === "video" || tag === "source" || tag === "track"
            ? "media"
            : "any";
    refs.push({ url: src, directive });
  }
  const srcset = attrs.get("srcset");
  if (srcset !== undefined) {
    for (const cand of srcset.split(",")) {
      const t = cand.trim();
      let k = 0;
      while (k < t.length && !isSpace(t[k])) k++;
      if (k > 0) refs.push({ url: t.slice(0, k), directive: tag === "source" ? "any" : "img" });
    }
  }
  const poster = attrs.get("poster");
  if (poster !== undefined) refs.push({ url: poster, directive: "img" });
  if (tag === "link") {
    const href = attrs.get("href");
    const rels = lower(attrs.get("rel") ?? "")
      .split(" ")
      .filter((r) => r !== "");
    if (attrs.has("crossorigin") || rels.includes("modulepreload")) flags.opaque = true;
    if (href !== undefined && rels.some((r) => LINK_RELS.has(r))) {
      const as = lower(attrs.get("as") ?? "");
      const directive: Directive = rels.includes("stylesheet")
        ? "style"
        : rels.includes("modulepreload")
          ? "script"
          : rels.includes("manifest")
            ? "manifest"
            : rels.includes("preload") || rels.includes("prefetch")
              ? as === "style"
                ? "style"
                : as === "script"
                  ? "script"
                  : as === "font"
                    ? "font"
                    : as === "image"
                      ? "img"
                      : "any"
              : "img";
      refs.push({ url: href, directive });
    }
  }
  if (tag === "base") {
    const href = attrs.get("href");
    if (href !== undefined) refs.push({ url: href, directive: "base" });
  }
  if (tag === "meta" && lower(attrs.get("http-equiv") ?? "") === "refresh") {
    const content = attrs.get("content") ?? "";
    const at = indexOfCi(content, "url=", 0);
    if (at >= 0) {
      let u = content.slice(at + 4).trim();
      if ((u.startsWith("'") && u.endsWith("'")) || (u.startsWith('"') && u.endsWith('"')))
        u = u.slice(1, -1);
      refs.push({ url: u, directive: "navigate" });
    }
  }
  const style = attrs.get("style");
  if (style !== undefined) scanCss(style, refs, flags, "img");
}

// ---------- CSS ----------

function scanCss(
  s: string,
  refs: Ref[],
  flags: { opaque: boolean },
  urlDirective: Directive,
): void {
  const n = s.length;
  let i = 0;
  // Depth of braces and the depth at which an @font-face block opened (-1: not inside one).
  let depth = 0;
  let fontFaceDepth = -1;
  let pendingFontFace = false;
  while (i < n) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === "{") {
      depth++;
      if (pendingFontFace) {
        fontFaceDepth = depth;
        pendingFontFace = false;
      }
      i++;
      continue;
    }
    if (c === "}") {
      if (depth === fontFaceDepth) fontFaceDepth = -1;
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (c === "@") {
      const nameEnd = (() => {
        let k = i + 1;
        while (k < n && isNameChar(s[k]) && s[k] !== "(" && s[k] !== ";" && s[k] !== "{") k++;
        return k;
      })();
      const at = lower(s.slice(i + 1, nameEnd));
      if (at === "font-face") pendingFontFace = true;
      if (at === "import") {
        let k = nameEnd;
        while (k < n && isSpace(s[k])) k++;
        const q = s[k];
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, k + 1);
          refs.push({ url: s.slice(k + 1, end < 0 ? n : end), directive: "style" });
          i = end < 0 ? n : end + 1;
          continue;
        }
        if (indexOfCi(s.slice(k, k + 4), "url(", 0) === 0) {
          const r = readUrl(s, k + 4);
          refs.push({ url: r.url, directive: "style" });
          i = r.end;
          continue;
        }
      }
      i = nameEnd;
      continue;
    }
    if ((c === "u" || c === "U") && indexOfCi(s.slice(i, i + 4), "url(", 0) === 0) {
      // url( starts a token unless it continues an identifier (my-url(...) is not url()).
      const prev = s[i - 1];
      if (prev === undefined || !(isIdent(prev) || prev === "-")) {
        const r = readUrl(s, i + 4);
        const inFont = fontFaceDepth >= 0;
        if (inFont) flags.opaque = true;
        refs.push({ url: r.url, directive: inFont ? "font" : urlDirective });
        i = r.end;
        continue;
      }
    }
    i++;
  }
}

function readUrl(s: string, from: number): { url: string; end: number } {
  const n = s.length;
  let k = from;
  while (k < n && isSpace(s[k])) k++;
  const q = s[k];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, k + 1);
    const url = s.slice(k + 1, end < 0 ? n : end);
    const close = s.indexOf(")", end < 0 ? n : end);
    return { url, end: close < 0 ? n : close + 1 };
  }
  const close = s.indexOf(")", k);
  const url = s.slice(k, close < 0 ? n : close).trim();
  return { url, end: close < 0 ? n : close + 1 };
}

// ---------- JavaScript ----------

function isIdent(c: string | undefined): boolean {
  if (c === undefined) return false;
  const k = c.charCodeAt(0);
  return (
    (k >= 97 && k <= 122) ||
    (k >= 65 && k <= 90) ||
    (k >= 48 && k <= 57) ||
    k === 36 ||
    k === 95 ||
    k > 127
  );
}

/** Characters after which a "/" starts a regular expression literal, not a division. */
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void"]);

interface JsToken {
  kind: "word" | "string" | "punct";
  value: string;
}

/**
 * Tokens of interest from JavaScript source: identifiers, string literals and punctuation, with
 * comments, template literals and regular expressions skipped. Linear in the input.
 */
function* jsTokens(s: string): Generator<JsToken> {
  const n = s.length;
  let i = 0;
  let prevSignificant = "";
  let prevWord = "";
  while (i < n) {
    const c = s[i] as string;
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      let value = "";
      let start = k;
      while (k < n && s[k] !== c && s[k] !== "\n") {
        if (s[k] === "\\") {
          value += s.slice(start, k);
          k += 2;
          start = k;
          continue;
        }
        k++;
      }
      value += s.slice(start, Math.min(k, n));
      i = k + 1;
      prevSignificant = '"';
      prevWord = "";
      yield { kind: "string", value };
      continue;
    }
    if (c === "`") {
      // A template literal, nested ${ } expressions skipped by depth only. One without
      // substitutions is a plain string (bundlers such as Vite emit import(`./chunk.js`)).
      let k = i + 1;
      let depthT = 0;
      let substituted = false;
      while (k < n) {
        const d = s[k];
        if (d === "\\") {
          k += 2;
          continue;
        }
        if (depthT === 0 && d === "`") break;
        if (d === "$" && s[k + 1] === "{") {
          depthT++;
          substituted = true;
          k += 2;
          continue;
        }
        if (depthT > 0 && d === "}") depthT--;
        k++;
      }
      const value = s.slice(i + 1, Math.min(k, n));
      i = k + 1;
      prevSignificant = '"';
      prevWord = "";
      if (!substituted && !value.includes("\\")) yield { kind: "string", value };
      continue;
    }
    if (c === "/") {
      const regexStart =
        prevSignificant === "" ||
        REGEX_AFTER.has(prevSignificant) ||
        (prevWord !== "" && REGEX_AFTER_WORDS.has(prevWord));
      if (regexStart) {
        let k = i + 1;
        let inClass = false;
        while (k < n && s[k] !== "\n") {
          const d = s[k];
          if (d === "\\") {
            k += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          k++;
        }
        k++;
        while (k < n && isIdent(s[k])) k++;
        i = k;
        prevSignificant = '"';
        prevWord = "";
        continue;
      }
    }
    if (isIdent(c)) {
      let k = i + 1;
      while (k < n && isIdent(s[k])) k++;
      const value = s.slice(i, k);
      i = k;
      prevSignificant = "a";
      prevWord = value;
      yield { kind: "word", value };
      continue;
    }
    i++;
    prevSignificant = c;
    prevWord = "";
    yield { kind: "punct", value: c };
  }
}

/** Module specifiers that name a file: relative, root-absolute or a URL (bare names are left). */
function isFileSpecifier(v: string): boolean {
  return (
    v.startsWith("./") ||
    v.startsWith("../") ||
    v.startsWith("/") ||
    v.startsWith("https:") ||
    v.startsWith("http:")
  );
}

function scanJs(s: string, refs: Ref[], flags: { opaque: boolean }): void {
  // A small state machine over the token stream:
  // import "x" | import ... from "x" | export ... from "x" | import("x") | new URL("x", import.meta.url)
  let state:
    | "none"
    | "import"
    | "export"
    | "from"
    | "dynamicOpen"
    | "new"
    | "newUrl"
    | "newUrlOpen"
    | "newUrlArg" = "none";
  let prev: JsToken | null = null;
  let pendingUrl = "";
  for (const t of jsTokens(s)) {
    const afterDot = prev?.kind === "punct" && prev.value === ".";
    switch (state) {
      case "import":
        if (t.kind === "string") {
          if (isFileSpecifier(t.value)) refs.push({ url: t.value, directive: "script" });
          state = "none";
        } else if (t.kind === "punct" && t.value === "(") {
          flags.opaque = true;
          state = "dynamicOpen";
        } else if (t.kind === "punct" && t.value === ".") {
          state = "none"; // import.meta
        } else if (t.kind === "word" && t.value === "from") {
          state = "from";
        } else if (t.kind === "punct" && t.value === ";") {
          state = "none";
        }
        break;
      case "export":
        if (t.kind === "word" && t.value === "from") state = "from";
        else if (t.kind === "punct" && (t.value === ";" || t.value === "=" || t.value === "("))
          state = "none";
        else if (
          t.kind === "word" &&
          ["function", "class", "const", "let", "var", "default", "async"].includes(t.value)
        )
          state = "none";
        break;
      case "from":
        if (t.kind === "string" && isFileSpecifier(t.value))
          refs.push({ url: t.value, directive: "script" });
        state = "none";
        break;
      case "dynamicOpen":
        if (t.kind === "string" && isFileSpecifier(t.value))
          refs.push({ url: t.value, directive: "script" });
        state = "none";
        break;
      case "new":
        state = t.kind === "word" && t.value === "URL" ? "newUrl" : "none";
        break;
      case "newUrl":
        state = t.kind === "punct" && t.value === "(" ? "newUrlOpen" : "none";
        break;
      case "newUrlOpen":
        if (t.kind === "string") {
          pendingUrl = t.value;
          state = "newUrlArg";
        } else state = "none";
        break;
      case "newUrlArg":
        // Expect: , import . meta . url
        if (t.kind === "word" && t.value === "url" && afterDot) {
          if (isFileSpecifier(pendingUrl) || !schemeOf(pendingUrl))
            refs.push({ url: pendingUrl, directive: "any" });
          state = "none";
        } else if (t.kind === "punct" && t.value === ")") state = "none";
        break;
      default:
        break;
    }
    if (state === "none" && t.kind === "word" && !afterDot) {
      if (t.value === "import") state = "import";
      else if (t.value === "export") state = "export";
      else if (t.value === "new") state = "new";
    }
    prev = t;
  }
}

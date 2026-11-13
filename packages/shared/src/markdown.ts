// A small, escape-first Markdown renderer for comments. Comment text is untrusted: the whole source
// is HTML-escaped before any markup is recognized, so the only tags in the output are the ones this
// file writes, and the only attribute values are escaped text or a URL with an allowed scheme.
//
// Supported: paragraphs and line breaks, **bold**, *em*, `code`, fenced code blocks, "- " lists,
// "> " quotes, @mention highlight, and links ([text](url) and bare URLs) to http:, https: and
// mailto: only. Everything else stays escaped text.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const LINK_ATTRS = 'rel="noopener noreferrer nofollow" target="_blank"';

/**
 * Allowed link targets, tested on already-escaped text. Escaping does not touch letters, ":" or
 * "/", so an escaped URL starts with the same scheme as the raw one, and the browser decodes the
 * entities in the attribute back to exactly the URL that was checked.
 */
const SAFE_URL_RE = /^(?:https?:\/\/[^\s\0/?#]|mailto:[^\s\0])[^\s\0]*$/i;

/** A bare URL in escaped text. Stops at whitespace and at any entity other than &amp;. */
const BARE_URL_RE = /\bhttps?:\/\/(?:[^\s&\0]|&amp;)+/gi;

/** [text](url) in escaped text. The URL may not contain whitespace or parentheses. */
const LINK_RE = /\[([^\]\n]+)\]\(([^\s()]+)\)/g;

/** Same token rule as parseMentions in mentions.ts. "&#39;" ends in ";", so @ after it matches. */
const MENTION_RE = /(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,79})/g;

const MAX_QUOTE_DEPTH = 8;

/** Render comment Markdown to safe HTML. */
export function renderMarkdown(src: string): string {
  // NUL is the placeholder delimiter below; it never survives into the output.
  const clean = src.replace(/\r\n?/g, "\n").replace(/\0/g, "�");
  return renderBlocks(escapeHtml(clean).split("\n"), 0);
}

function isFence(line: string): boolean {
  return /^ {0,3}```/.test(line);
}

function listItem(line: string): string | null {
  const m = /^ {0,3}- (.*)$/.exec(line);
  return m ? (m[1] ?? "") : null;
}

function quoteLine(line: string): string | null {
  const m = /^ {0,3}&gt; ?(.*)$/.exec(line);
  return m ? (m[1] ?? "") : null;
}

/** Lines are already escaped. */
function renderBlocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (isFence(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or end of input)
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    if (listItem(line) !== null) {
      const items: string[] = [];
      for (let item = listItem(lines[i] ?? ""); item !== null; item = listItem(lines[i] ?? "")) {
        items.push(`<li>${renderInline(item)}</li>`);
        i++;
        if (i >= lines.length) break;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && quoteLine(line) !== null) {
      const inner: string[] = [];
      for (let q = quoteLine(lines[i] ?? ""); q !== null; q = quoteLine(lines[i] ?? "")) {
        inner.push(q);
        i++;
        if (i >= lines.length) break;
      }
      out.push(`<blockquote>${renderBlocks(inner, depth + 1)}</blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || isFence(l) || listItem(l) !== null) break;
      if (para.length > 0 && depth < MAX_QUOTE_DEPTH && quoteLine(l) !== null) break;
      para.push(l);
      i++;
    }
    out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

/** Inline markup on one escaped line. Finished HTML is parked in placeholders until the end. */
function renderInline(text: string): string {
  const parked: string[] = [];
  const park = (html: string) => {
    parked.push(html);
    return `\0${parked.length - 1}\0`;
  };

  let s = text.replace(/`([^`]+)`/g, (_, code: string) => park(`<code>${code}</code>`));

  s = s.replace(LINK_RE, (whole, label: string, url: string) => {
    if (!SAFE_URL_RE.test(url)) return whole;
    return park(`<a href="${url}" ${LINK_ATTRS}>${emphasis(label)}</a>`);
  });

  s = s.replace(BARE_URL_RE, (raw: string) => {
    // Leave trailing punctuation outside the link: "see https://x.com." links "https://x.com".
    const m = /^(.*?)([.,;:!?)\]]*)$/.exec(raw);
    const url = m?.[1] ?? raw;
    const tail = m?.[2] ?? "";
    if (!SAFE_URL_RE.test(url)) return raw;
    return `${park(`<a href="${url}" ${LINK_ATTRS}>${url}</a>`)}${tail}`;
  });

  s = s.replace(MENTION_RE, (_, pre: string, name: string) => {
    const handle = name.replace(/\.+$/, "");
    const dots = name.slice(handle.length);
    return `${pre}${park(`<span class="mention">@${handle}</span>`)}${dots}`;
  });

  s = emphasis(s);

  // Restore parked HTML. A link's text may hold an earlier placeholder (inline code), and an entry
  // only ever refers to entries parked before it, so the recursion ends.
  const restore = (str: string): string =>
    str.replace(/\0(\d+)\0/g, (_, n: string) => restore(parked[Number(n)] ?? ""));
  return restore(s);
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
}

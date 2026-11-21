// A doc rendered block by block, for on-page editing (#36). The Markdown is parsed once, its
// top-level tokens are grouped into blocks with the source lines markdown-it records for them
// (token.map), and each group is rendered with the same env, so heading ids and reference links
// come out exactly as a whole-document render gives them: joining the blocks' HTML is the doc's
// HTML. Each block goes through the unchanged sanitizer on its own.
//
// Line ranges live in a WeakMap keyed by the block's top-level nodes, never in the DOM (no data-*
// attributes), so the sanitizer's allowlist stays as it is and a page can never forge a range.
import type { Token } from "markdown-it";
import { markdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

/** Source lines of a block: [start, end), 0-based, end exclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

export interface Block extends LineSpan {
  /** The block's HTML from the Markdown layer, before the sanitizer. */
  html: string;
  /**
   * The lines its tokens came from, inside [start, end): the rest of the range is blank lines and
   * the reference definitions that follow it (or, for the first block, come before it), which the
   * formatted-text editor keeps byte for byte.
   */
  core: LineSpan;
}

const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

/**
 * The doc's top-level blocks in order. A block's range also takes the non-blank lines that follow
 * it up to the next block (reference definitions, which render nothing), so every line that is not
 * blank belongs to a block the editor can open; a doc that starts with such lines gives them to
 * its first block.
 */
export function parseBlocks(text: string): Block[] {
  const md = markdown();
  const env = {};
  const tokens = md.parse(text, env);
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i] as Token;
    let j = i;
    let depth = 0;
    do {
      depth += (tokens[j] as Token).nesting;
      j++;
    } while (depth > 0 && j < tokens.length);
    const group = tokens.slice(i, j);
    const prevEnd = out.at(-1)?.end ?? 0;
    const start = first.map?.[0] ?? prevEnd;
    const end = Math.max(first.map?.[1] ?? start, start);
    let coreEnd = end;
    while (coreEnd > start && isBlank(lines[coreEnd - 1])) coreEnd--;
    out.push({
      start,
      end,
      html: md.renderer.render(group, md.options, env),
      core: { start, end: coreEnd },
    });
    i = j;
  }
  for (let k = 0; k < out.length; k++) {
    const b = out[k] as Block;
    const limit = out[k + 1]?.start ?? lines.length;
    let end = b.end;
    for (let n = b.end; n < limit; n++) if (!isBlank(lines[n])) end = n + 1;
    b.end = end;
  }
  const first = out[0];
  if (first) {
    let s = 0;
    while (s < first.start && isBlank(lines[s])) s++;
    first.start = s;
  }
  return out;
}

const ranges = new WeakMap<Node, LineSpan>();

/** The source lines of a top-level node the BlockCache rendered, if it is one. */
export function rangeOf(node: Node): LineSpan | undefined {
  return ranges.get(node);
}

/**
 * Sanitized nodes for blocks, reused across renders when a block's HTML is unchanged, so typing
 * in one block does not rebuild (or reload the images of) the rest of the page.
 */
export class BlockCache {
  private prev = new Map<string, Node[][]>();
  private next = new Map<string, Node[][]>();

  /**
   * `prepare` sees each block's sanitized nodes before they are used: the doc renderer points
   * images at the version on screen with it once a version was shown in place (follow.ts).
   */
  constructor(
    private readonly doc: Document,
    private readonly prepare?: (fragment: DocumentFragment) => void,
  ) {}

  /** The nodes of one block, recorded with its current range. */
  nodes(block: Block): Node[] {
    const reuse = this.prev.get(block.html)?.shift();
    const nodes = reuse ?? this.fresh(block.html);
    const list = this.next.get(block.html);
    if (list) list.push(nodes);
    else this.next.set(block.html, [nodes]);
    for (const n of nodes) ranges.set(n, { start: block.start, end: block.end });
    return nodes;
  }

  private fresh(html: string): Node[] {
    const fragment = sanitizeHtml(html, this.doc);
    this.prepare?.(fragment);
    return Array.from(fragment.childNodes);
  }

  /** Ends a render: nodes not used in it are dropped. */
  commit(): void {
    this.prev = this.next;
    this.next = new Map();
  }
}

/**
 * Makes `root`'s children exactly `desired`, in order, moving as few nodes as it can. Nodes that
 * stay keep their place, so a focused textarea among them is never detached (which would blur it).
 */
export function reconcile(root: Node, desired: readonly Node[]): void {
  const want = new Set(desired);
  for (const n of Array.from(root.childNodes)) if (!want.has(n)) root.removeChild(n);
  let cursor = root.firstChild;
  for (const n of desired) {
    if (n === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    root.insertBefore(n, cursor);
  }
}

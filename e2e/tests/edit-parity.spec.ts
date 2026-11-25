// Opening a block to edit it on the page moves nothing (#36): the block keeps the page's own look in
// its own place. For every block of a doc that has each kind the editor draws (text with every mark,
// a soft and a hard line break, headings, tight, loose and nested lists, a quote, a code block with
// a line wider than the column, a narrow and a wide table, a divider, and one shown read-only),
// the block is measured as the page shows it, opened, and measured again: the block's box, every
// element in it, every line of its text, and where the next block starts must all be where they
// were. The same runs over a design system's guidelines (the doc's editor on the site's page) and
// a slide's blocks (the same editor on a scaled slide). Each project runs it at its own width
// (desktop, and phone width in "mobile").
import { expect, type Frame, type Page, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ACME_ASSETS, acmeWith, stubGoogleFonts } from "../support/designSystem.ts";
import { shotsDir } from "../support/shots.ts";
import { CURRENT_FRAME, expectEditing, saveStatus } from "../support/viewer.ts";

const DOC = [
  "# Release plan",
  "",
  "A first paragraph with **bold**, *italic*, `inline code`, ~~struck~~ and a [link](https://example.com/) in it,",
  "on a second source line joined by a soft break, long enough to wrap on a phone and on a desktop.",
  "",
  "A hard break ends this line\\",
  "and this one starts after it.",
  "",
  "## Scope",
  "",
  "- Tight bullet one",
  "- Tight bullet two, with enough words in it to wrap onto a second line at phone width",
  "  - A nested bullet",
  "",
  "1. Loose ordered one",
  "",
  "2. Loose ordered two",
  "",
  "> A quote with a paragraph",
  "> over two source lines.",
  "",
  "```",
  'const line = "a code line long enough that it scrolls sideways in its block instead of wrapping onto the next line";',
  "```",
  "",
  "| Name | Qty |",
  "| --- | ---: |",
  "| Apples | 3 |",
  "| Pears | 14 |",
  "",
  "| Identifier | Implementation | Responsibility | Configuration | Availability | Quarterly revenue by region | Net revenue retention |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| alpha | Worker | Routing requests | wrangler.toml | Always | Up in EMEA and down in APAC | 112 percent |",
  "",
  "---",
  "",
  "- A list item that holds a code fence, which the editor shows read-only:",
  "",
  "  ```",
  "  echo held",
  "  ```",
  "",
  "### Last heading",
  "",
  "The last paragraph.",
  "",
].join("\n");

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shape {
  block: Box;
  /** Every element in the block, in document order: its tag and box. */
  parts: { tag: string; box: Box }[];
  /** Every line box of the block's text, in document order. */
  lines: Box[];
  /** Where the next block starts (null: the last block). */
  next: number | null;
  /** How far the block's own content reaches sideways (a table or code that scrolls). */
  scrollWidth: number;
}

/** With PLINTH_E2E_SHOTS set, some of the doc's blocks are saved shown and open, for review. */
const SHOTS = shotsDir("edit-parity");

/** The element whose children are the blocks being measured. */
const CONTAINER = "[data-parity]";

/**
 * Measures the block that is child `index` of the CONTAINER in the frame. Open, it is the editor's
 * content (or, for a block shown read-only, the block inside its panel); the editor's own controls
 * are left out.
 */
function measure(frame: Frame, index: number): Promise<Shape> {
  return frame.evaluate(
    ([sel, i]) => {
      const container = document.querySelector(sel) as HTMLElement;
      const top = container.children[i] as HTMLElement;
      const controls =
        ".plinth-rich__toolbar, .plinth-rich__link, .plinth-rich__corner, .plinth-rich__alt, .plinth-doc__blockbar, .plinth-doc__holder, .plinth-doc__menu";
      let el: HTMLElement = top;
      if (top.matches(".plinth-doc__open, .plinth-slides__open")) {
        el = top.querySelector(".plinth-rich__content") as HTMLElement;
      } else if (top.classList.contains("plinth-doc__selected")) {
        el = [...top.children].find((c) => !c.matches(controls)) as HTMLElement;
      }
      const box = (r: DOMRect) => ({
        x: r.left + scrollX,
        y: r.top + scrollY,
        w: r.width,
        h: r.height,
      });
      // Left out: what is not drawn (a heading's "#", hidden while editing), the paragraph a tight
      // list item's text is drawn in while it is edited, and inline elements (a link, bold, inline
      // code): their words are measured below.
      const parts = [...el.querySelectorAll<HTMLElement>("*")]
        .filter(
          (e) =>
            !e.closest(controls) &&
            getComputedStyle(e).display !== "inline" &&
            e.tagName !== "BR" &&
            !e.classList.contains("plinth-rich__soft") &&
            !e.classList.contains("plinth-rich__tight") &&
            e.getClientRects().length > 0,
        )
        .map((e) => ({ tag: e.tagName, box: box(e.getBoundingClientRect()) }));
      // The text's lines as they are seen: every word on one line (the same top) makes one box,
      // however the text is split into nodes. Words, not runs of text: a space at the end of a line
      // is drawn nowhere, kept or not.
      const byTop = new Map<number, { left: number; right: number; top: number; bottom: number }>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const rects: DOMRect[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest(controls)) continue;
        for (const w of (n.nodeValue ?? "").matchAll(/\S+/g)) {
          range.setStart(n, w.index);
          range.setEnd(n, w.index + w[0].length);
          rects.push(...range.getClientRects());
        }
      }
      for (const r of rects) {
        if (r.width === 0) continue;
        const key = Math.round(r.top + scrollY);
        const l = byTop.get(key);
        if (!l) byTop.set(key, { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        else {
          l.left = Math.min(l.left, r.left);
          l.right = Math.max(l.right, r.right);
          l.bottom = Math.max(l.bottom, r.bottom);
        }
      }
      const lines = [...byTop.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, l]) => box(new DOMRect(l.left, l.top, l.right - l.left, l.bottom - l.top)));
      const after = top.nextElementSibling as HTMLElement | null;
      const scroller = el.matches(".plinth-doc__table, pre") ? el : null;
      return {
        block: box(el.getBoundingClientRect()),
        parts,
        lines,
        next: after ? after.getBoundingClientRect().top + scrollY : null,
        scrollWidth: scroller ? scroller.scrollWidth : el.getBoundingClientRect().width,
      };
    },
    [CONTAINER, index] as const,
  );
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** What differs between the two shapes, as lines a person can read; empty when they match. */
function differences(read: Shape, open: Shape): string[] {
  const out: string[] = [];
  const cmp = (what: string, a: Box, b: Box) => {
    for (const k of ["x", "y", "w", "h"] as const) {
      if (!near(a[k], b[k])) out.push(`${what} ${k}: ${a[k].toFixed(1)} → ${b[k].toFixed(1)}`);
    }
  };
  cmp("block", read.block, open.block);
  if (read.parts.length !== open.parts.length) {
    out.push(
      `elements: ${read.parts.map((p) => p.tag).join(",")} → ${open.parts.map((p) => p.tag).join(",")}`,
    );
  } else {
    for (const [i, p] of read.parts.entries()) {
      const o = open.parts[i] as Shape["parts"][number];
      if (p.tag !== o.tag) out.push(`element ${i}: ${p.tag} → ${o.tag}`);
      else cmp(`${p.tag} ${i}`, p.box, o.box);
    }
  }
  if (read.lines.length !== open.lines.length) {
    out.push(`lines of text: ${read.lines.length} → ${open.lines.length}`);
  } else {
    for (const [i, l] of read.lines.entries()) cmp(`line ${i}`, l, open.lines[i] as Box);
  }
  if (read.next !== null && open.next !== null && !near(read.next, open.next)) {
    out.push(`next block: ${read.next.toFixed(1)} → ${open.next.toFixed(1)}`);
  }
  if (!near(read.scrollWidth, open.scrollWidth)) {
    out.push(`content width: ${read.scrollWidth} → ${open.scrollWidth}`);
  }
  return out;
}

/**
 * Waits until the CONTAINER's blocks stay the same for a few frames: a page may draw them again
 * a moment after a block closes (a design system draws its guidelines again).
 */
async function settled(frame: Frame): Promise<void> {
  await frame.evaluate(async (sel) => {
    const shape = () =>
      [...(document.querySelector(sel)?.children ?? [])]
        .map((c) => `${c.tagName}.${c.className}:${c.textContent?.length}`)
        .join("|");
    const frameDone = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
    let last = shape();
    for (let still = 0; still < 3; ) {
      await frameDone();
      const now = shape();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }, CONTAINER);
}

const OPENED = ".plinth-doc__open, .plinth-doc__selected, .plinth-slides__open";

/**
 * Opens each block of the CONTAINER in turn, as a person does, and returns what moved, block by
 * block. `blocks` lists the children to open (all of them when absent).
 */
async function compareBlocks(
  page: Page,
  frame: Frame,
  blocks?: number[],
  shots?: { name: string; at: number[] },
): Promise<string[]> {
  const container = frame.locator(CONTAINER);
  const count = await container.locator(":scope > *").count();
  const opened = frame.locator(`:is(${OPENED})`);
  const failures: string[] = [];
  for (const i of blocks ?? [...Array(count).keys()]) {
    await settled(frame);
    const block = await container.locator(":scope > *").nth(i).elementHandle();
    if (!block) throw new Error(`no block ${i + 1}`);
    const tag = await block.evaluate((e) => e.tagName);
    const label = `${tag.toLowerCase()} "${((await block.textContent()) ?? "").trim().slice(0, 30)}"`;
    const read = await measure(frame, i);
    const shot = SHOTS && shots?.at.includes(i) ? `${SHOTS}/${shots.name}-block${i + 1}` : null;
    if (shot) await block.screenshot({ path: `${shot}-shown.png` });
    if (tag === "HR") {
      // A divider is a line too thin to aim at: it opens from the keyboard.
      await block.focus();
      await page.keyboard.press("Enter");
    } else {
      // Inside its first line, as a person clicks into text.
      await block.click({ position: { x: 4, y: 4 }, timeout: 5_000 });
    }
    await expect(opened, label).toHaveCount(1);
    // The page may draw the block's surroundings again when it opens (a slide does): the open
    // block's parent is the container from here on.
    const at = await opened.evaluate((e, sel) => {
      for (const c of document.querySelectorAll(sel)) c.removeAttribute("data-parity");
      const parent = e.parentElement as HTMLElement;
      parent.setAttribute("data-parity", "");
      return [...parent.children].indexOf(e);
    }, CONTAINER);
    expect(at, label).toBe(i);
    const open = await measure(frame, i);
    if (shot) await opened.screenshot({ path: `${shot}-open.png` });
    const diff = differences(read, open);
    if (diff.length > 0) failures.push(`block ${i + 1}, ${label}:\n  ${diff.join("\n  ")}`);
    await page.keyboard.press("Escape");
    await expect(opened, label).toHaveCount(0);
  }
  return failures;
}

/** Publishes `input` as the owner's agent and opens it on the page, in edit mode. */
async function openArtifact(page: Page, input: Record<string, unknown>, editing: string) {
  const owner = uniqueEmail("parity-owner");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Release plan",
    html: undefined,
    visibility: "allowlist",
    ...input,
  });
  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}`);
  await expectEditing(page, editing);
  await expect(saveStatus(page)).not.toContainText("Connecting", { timeout: 10_000 });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("the artifact frame is not attached");
  return frame;
}

test("every block of a doc opens for editing exactly where and as the page shows it", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const frame = await openArtifact(page, { type: "doc", content: DOC }, "main.plinth-doc--editing");
  await frame
    .locator("main.plinth-doc--editing")
    .evaluate((e) => e.setAttribute("data-parity", ""));
  expect(await frame.locator(`${CONTAINER} > *`).count()).toBe(14);
  // The paragraph with a soft break, the tight list, the code block and the wide table.
  const failures = await compareBlocks(page, frame, undefined, {
    name: info.project.name,
    at: [1, 4, 7, 9],
  });
  expect(failures, failures.join("\n")).toEqual([]);
});

test("a design system's guidelines open for editing as the page shows them", async ({ page }) => {
  test.setTimeout(120_000);
  await stubGoogleFonts(page);
  const content = acmeWith((ds) => {
    ds.guidelines = DOC;
  });
  const frame = await openArtifact(
    page,
    { type: "design_system", content, assets: ACME_ASSETS },
    ".plinth-doc--editing",
  );
  const guide = frame.locator(".plinth-doc--editing", {
    has: frame.locator("h1", { hasText: "Release plan" }),
  });
  await guide.scrollIntoViewIfNeeded();
  await guide.evaluate((e) => e.setAttribute("data-parity", ""));
  expect(await frame.locator(`${CONTAINER} > *`).count()).toBe(14);
  const failures = await compareBlocks(page, frame);
  expect(failures, failures.join("\n")).toEqual([]);
});

const DECK = [
  "# Release plan",
  "",
  "A paragraph with **bold** and `code` on a first source line,",
  "and a second one joined to it by a soft break.",
  "",
  "- Tight bullet one",
  "- Tight bullet two",
  "",
  "| Name | Qty |",
  "| --- | ---: |",
  "| Apples | 3 |",
  "",
  "> A quote over",
  "> two source lines.",
  "",
  "```",
  'const line = "a code line long enough to reach the edge of the slide and then go on past it";',
  "```",
  "",
].join("\n");

test("every block of a slide opens for editing exactly where and as the slide shows it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const frame = await openArtifact(
    page,
    { type: "slides", content: DECK },
    ".plinth-slides[data-editing]",
  );
  const blocks = frame.locator('.plinth-slides__frame[data-active] [data-plinth-edit="text"]');
  const n = await blocks.count();
  expect(n).toBe(6);
  const failures: string[] = [];
  for (let k = 0; k < n; k++) {
    // The block's parent is the container, wherever the slide's layout puts the block.
    const index = await blocks.nth(k).evaluate((e) => {
      for (const c of document.querySelectorAll("[data-parity]")) c.removeAttribute("data-parity");
      const parent = e.parentElement as HTMLElement;
      parent.setAttribute("data-parity", "");
      return [...parent.children].indexOf(e);
    });
    failures.push(...(await compareBlocks(page, frame, [index])));
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

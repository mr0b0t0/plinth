// Editing a deck on its page (slides-text, docs/spec.md "Slides"), under origin isolation with live
// rooms: edit mode draws every raw slide and edits slide text as formatted text, with no Markdown
// shown; speaker notes are edited in their panel and stay notes; deck settings are one popover
// from the ⋯ menu; an emptied New deck shows its placeholder with Publish off; a deck that opens
// with a bare `---` keeps its settings when slide 1 is retitled or emptied; two editors see each
// other's edits, and a struct op is held while it would touch a part someone holds; and an
// agent's version during the page edits is never merged: the review shows both decks.
//
// With PLINTH_VISUAL_DIR set, the visual pass also saves screenshots there (one per project).
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const PIXEL = {
  path: "chart.png",
  content:
    "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAoklEQVR42u3RAQ0AAAjDsMtBE+qQig9oMgVrqkeHiwWABViABViABViAAQuwAAuwAAuwAAMWYAEWYAEWYAEWYMACLMACLMACLMCABViABViABViAAQuwAAuwAAuwAAswYAEWYAEWYAEWYMACLMACLMACLMCAXQAswAIswAIswAIMWIAFWIAFWIAFGLAAC7AAC7AAC7AAAxZgARZgARZgAf7VAqkWvDL39XofAAAAAElFTkSuQmCC",
  encoding: "base64",
  content_type: "image/png",
};

/** The skill's own example deck (SKILL.md "Slides"). */
const SKILL = [
  "---",
  "aspect: 16:9",
  "footer: Q4 review",
  "---",
  "",
  "# Q4 review",
  "",
  "Revenue, hiring and what comes next",
  "",
  "Note: Welcome everyone.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "- Up 18% on Q3",
  "- Two new enterprise accounts",
  "",
  "![Revenue by month](chart.png)",
  "",
  "Note: The September dip was a billing change.",
  "",
].join("\n");

interface Setup {
  slug: string;
  id: string;
  token: string;
  owner: string;
  editor: string;
}

async function setup(page: Page, content = SKILL): Promise<Setup> {
  const owner = uniqueEmail("deck-owner");
  const editor = uniqueEmail("deck-editor");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Q4 review",
    type: "slides",
    content,
    html: undefined,
    visibility: "allowlist",
    assets: [PIXEL],
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: editor, role: "editor" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return { slug: art.slug, id: art.id, token, owner, editor };
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const activeSlide = (page: Page) => frameOf(page).locator(".plinth-slides__frame[data-active]");
const strip = (page: Page) => page.getByRole("region", { name: "Editing on the page" });
const openField = (page: Page) =>
  frameOf(page).locator('.plinth-slides__open [contenteditable="true"]');

async function openAs(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  return page;
}

async function startEditing(page: Page) {
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  await expect(strip(page)).toBeVisible();
  await expect(frameOf(page).locator(".plinth-slides[data-editing]")).toHaveCount(1);
  await expect(strip(page)).not.toContainText("Connecting", { timeout: 10_000 });
  await expect(strip(page)).not.toContainText("Not connected");
}

/** Go to raw slide `n` in edit mode (the deck's own Previous and Next controls). */
async function showSlide(page: Page, n: number) {
  for (let i = 0; i < 5; i++) {
    const at = Number(await activeSlide(page).getAttribute("data-n"));
    if (at === n) return;
    const name = at < n ? "Next slide" : "Previous slide";
    await frameOf(page).getByRole("button", { name }).click({ force: true });
  }
  await expect(activeSlide(page)).toHaveAttribute("data-n", String(n));
}

async function publish(page: Page, version: number) {
  await strip(page).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(strip(page)).toContainText(`Published as v${version}`, { timeout: 10_000 });
}

async function contentOf(page: Page, id: string): Promise<string> {
  return (await apiGet(page.request, `/artifacts/${id}`)).body.content as string;
}

async function shoot(page: Page, name: string) {
  const dir = process.env.PLINTH_VISUAL_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png` });
}

test("edit a slide title and its notes in place, publish v2; Compare lists it; restore v1 as v3", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);

  // Each text element is a focus stop named by its role, and no Markdown shows anywhere.
  const title = activeSlide(page).locator("h1");
  await expect(title).toHaveAttribute("aria-label", "Slide 1, heading 1, editable");
  await expect(frameOf(page).locator("textarea")).toHaveCount(0);
  await shoot(page, "edit-mode");
  await title.click();
  const field = openField(page);
  await expect(field).toBeFocused();
  await expect(field).toHaveText("Q4 review");
  await page.keyboard.press("End");
  await page.keyboard.type(" and Q1 plan");
  await expect(field).toHaveText("Q4 review and Q1 plan");
  await expect(strip(page)).toContainText(/Draft saved|Saving draft/);
  await page.keyboard.press("Escape");
  await expect(activeSlide(page).locator("h1")).toHaveText("Q4 review and Q1 plan");

  // The speaker notes, in their panel: the marker stays on its line.
  const notes = activeSlide(page).getByRole("region", { name: "Notes for slide 1" });
  await expect(notes).toContainText("Welcome everyone.");
  await notes.getByRole("button", { name: "Notes for slide 1, editable" }).click();
  const noteField = notes.locator('[contenteditable="true"]');
  await expect(noteField).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" Thanks for coming.");
  await shoot(page, "notes");
  await page.keyboard.press("Escape");
  await expect(notes).toContainText("Welcome everyone. Thanks for coming.");

  await publish(page, 2);
  const v2 = await contentOf(page, s.id);
  expect(v2).toBe(
    SKILL.replace("# Q4 review", "# Q4 review and Q1 plan").replace(
      "Note: Welcome everyone.",
      "Note: Welcome everyone. Thanks for coming.",
    ),
  );

  // Leaving edit mode shows v2, and its notes stay notes.
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else await strip(page).getByRole("button", { name: "Done" }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(frameOf(page).locator(".plinth-slides[data-editing]")).toHaveCount(0);
  await expect(
    frameOf(page).locator('.plinth-slides__frame[data-n="1"] .plinth-slides__slide h1'),
  ).toHaveText("Q4 review and Q1 plan", { timeout: 10_000 });
  await expect(frameOf(page).locator('.plinth-slides__frame[data-n="1"] h1')).toHaveCount(1);
  await expect(frameOf(page).locator(".plinth-slides__handout").first()).toContainText(
    "Welcome everyone. Thanks for coming.",
  );

  await page.goto(`/a/${s.slug}/compare?from=1&to=2`);
  await expect(page.getByRole("region", { name: "Changes" })).toContainText("Title changed");
  await page.goto(`/a/${s.slug}/history`);
  await page
    .locator('li[data-version="1"]')
    .getByRole("button", { name: "More actions for v1" })
    .click();
  await page.getByRole("menuitem", { name: "Restore v1" }).click();
  await page
    .getByRole("dialog", { name: "Restore v1?" })
    .getByRole("button", { name: "Restore v1" })
    .click();
  await expect(page.getByText("Restored v1")).toBeVisible();
  expect(await contentOf(page, s.id)).toBe(SKILL);
});

test("New deck: backspace the title, see the placeholder and Publish off, type a title, publish v2", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const email = uniqueEmail("new-deck");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByRole("menu", { name: "New" })
    .getByRole("menuitem", { name: "Slide deck" })
    .click();
  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  await expect(strip(page)).toBeVisible();
  const field = openField(page);
  await expect(field).toHaveText("Untitled deck", { timeout: 15_000 });
  await expect(field).toBeFocused();
  // Its text is selected: Backspace empties it.
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText("");
  await page.keyboard.press("Escape");
  const placeholder = activeSlide(page).getByRole("button", { name: /Slide 1, empty/ });
  await expect(placeholder).toHaveText("Click to add a title");
  const publishBtn = strip(page).getByRole("button", { name: "Publish", exact: true });
  await expect(publishBtn).toHaveAttribute("aria-disabled", "true");
  await shoot(page, "empty-deck");
  await placeholder.click();
  await expect(openField(page)).toBeFocused();
  await page.keyboard.type("Q1 plan");
  await expect(publishBtn).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await publish(page, 2);
  const slug = new URL(page.url()).pathname.split("/")[2] as string;
  expect((await apiGet(page.request, `/artifacts/${slug}`)).body.content).toBe("# Q1 plan\n");
});

test("a deck that opens with a bare ---: slide 1 retitled 'Date: 3 March', then emptied, keeps the settings", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const deck = "---\nIntro text\n\n---\n\n# Next\n";
  const s = await setup(page, deck);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  // Raw slide 1 is the empty one before the bare ---: it shows, labelled, in edit mode.
  await expect(activeSlide(page)).toHaveAttribute("data-n", "2");
  await activeSlide(page).locator("p").click();
  await expect(openField(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Date: 3 March");
  await page.keyboard.press("Escape");
  await publish(page, 2);
  let text = await contentOf(page, s.id);
  expect(text).toBe("---\nDate\\: 3 March\n\n---\n\n# Next\n");
  // Backspacing it away trims the bare --- first.
  await activeSlide(page).locator("p").click();
  await expect(openField(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await publish(page, 3);
  text = await contentOf(page, s.id);
  expect(text.startsWith("---")).toBe(false);
  expect(text).toContain("# Next");
});

test("deck settings from the ⋯ menu write the front matter", async ({ page }) => {
  test.setTimeout(90_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Slide size and footer…" }).click();
  const pop = frameOf(page).getByRole("dialog", { name: "Slide size and footer" });
  await expect(pop).toBeVisible();
  // The dialog itself has focus: no setting shows a focus ring before a key moves it.
  await expect(pop).toBeFocused();
  await shoot(page, "settings");
  await pop.getByLabel("Aspect").selectOption("4:3");
  await pop.getByLabel("Footer").fill("Q1 plan");
  await pop.getByRole("button", { name: "Apply" }).click();
  await expect(pop).toHaveCount(0);
  await expect(frameOf(page).locator("html")).toHaveAttribute("data-aspect", "4:3");
  await publish(page, 2);
  expect(await contentOf(page, s.id)).toBe(
    SKILL.replace("aspect: 16:9\nfooter: Q4 review", "aspect: 4:3\nfooter: Q1 plan"),
  );
});

test("an image offers Ask an agent and opens the Ask dialog with its anchor", async ({ page }) => {
  test.setTimeout(90_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  await showSlide(page, 2);
  await activeSlide(page).getByRole("button", { name: "Slide 2, image" }).click();
  await frameOf(page).getByRole("button", { name: "Ask an agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ask an agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Slide 2, image 1");
  // The description is where typing goes: it has focus, not the chip's Stop pointing.
  await expect(dialog.getByPlaceholder("Describe the change…")).toBeFocused();
  await shoot(page, "ask");
});

test("two editors on a deck: one edits a title while the other adds notes; a held part refuses the op", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page, "# One\n\nalpha\n\n---\n\n# Two\n\nbeta\n");
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.editor, s.slug);
  await startEditing(page);
  await startEditing(other);

  // The owner types in slide 1's paragraph; the editor adds notes to slide 2 meanwhile.
  await activeSlide(page).locator("p").click();
  await expect(openField(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(", edited");
  await showSlide(other, 2);
  await activeSlide(other).getByRole("button", { name: "Add speaker notes" }).click();
  const theirNotes = activeSlide(other).locator(
    '.plinth-slides__notepad-edit [contenteditable="true"]',
  );
  await expect(theirNotes).toBeFocused();
  // Notes left empty are no notes: they type some.
  await other.keyboard.type("Say hi");
  await page.keyboard.type(" more");
  await expect(openField(page)).toHaveText("alpha, edited more");
  // Adding notes to slide 1, where the owner types, is held.
  await showSlide(other, 1);
  await activeSlide(other).getByRole("button", { name: "Add speaker notes" }).click();
  // Named by a first name from the address (deck-owner-…@ reads "Deck"), never the address.
  await expect(frameOf(other).locator(".plinth-slides__live")).toHaveText(
    "Deck is editing slide 1.",
  );
  await page.keyboard.press("Escape");
  await publish(page, 2);
  const text = await contentOf(page, s.id);
  expect(text).toContain("alpha, edited more");
  expect(text).toContain("Note:\nSay hi");
  await other.context().close();
});

test("an agent's version during the page edits is never merged: the review shows both decks", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  await showSlide(page, 2);
  await activeSlide(page).locator("ul").click();
  await expect(openField(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" (rounded)");
  await page.keyboard.press("Escape");
  await expect(strip(page)).toContainText(/Draft saved|Saving draft/);

  const client = await mcpClient(s.token);
  try {
    const r = await tool<{ version: number; warnings: { code: string; message: string }[] }>(
      client,
      "update_artifact",
      {
        id: s.id,
        base_version: 1,
        content: SKILL.replace("## Revenue", "## Revenue and costs"),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.data.warnings.map((w) => w.code)).toContain("live_draft");
  } finally {
    await client.close();
  }
  await expect(strip(page)).toContainText("v2 was published while you edited", {
    timeout: 10_000,
  });
  await strip(page).getByRole("button", { name: "Review changes" }).click();
  const review = frameOf(page).getByRole("region", { name: "Review v2 and your changes" });
  await expect(review).toBeVisible();
  await expect(review.locator(".plinth-slides__frame").first()).toBeVisible();
  await shoot(page, "review");
  await review.getByRole("button", { name: "Publish your changes", exact: true }).click();
  await expect(strip(page)).toContainText("Published as v3", { timeout: 10_000 });
  const v3 = await contentOf(page, s.id);
  expect(v3).toContain("- Two new enterprise accounts (rounded)");
  expect(v3).toContain("## Revenue\n");
});

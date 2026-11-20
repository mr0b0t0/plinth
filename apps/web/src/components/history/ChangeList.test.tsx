import type { ArtifactDetail } from "@plinth/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CHOICES, EDIT_CHOICES } from "../viewer/boardSettings.ts";
import { ChangeList } from "./ChangeList.tsx";
import { versionChanges } from "./useChanges.ts";

afterEach(cleanup);

const noFiles = { added: [], removed: [], replaced: [], more: 0, same: 0 };

function detail(over: Partial<ArtifactDetail> & Record<string, unknown>): ArtifactDetail {
  return {
    id: "a1",
    slug: "notes",
    title: "Notes",
    type: "html",
    html: "",
    version: 1,
    source_path: "index.html",
    assets: [],
    ...over,
  } as unknown as ArtifactDetail;
}

describe("ChangeList", () => {
  it("lists each change as text, with its place and its values", () => {
    render(
      <ChangeList
        changes={{
          truncated: false,
          items: [
            {
              kind: "changed",
              where: "Row 7, “Qty”",
              what: "B7 changed",
              before: "12",
              after: "14",
            },
            {
              kind: "changed",
              where: "Under “Pricing”",
              what: "Paragraph changed",
              before: "We charge ten euros a month for each seat, billed yearly.",
              after: "We charge twelve euros a month for each seat, billed yearly.",
            },
            { kind: "added", where: "", what: "Heading “FAQ” added" },
            { kind: "added", where: "Under “FAQ”", what: "Paragraph added", after: "Ask us." },
            {
              kind: "removed",
              where: "Under “FAQ”",
              what: "Paragraph removed",
              before: "We answer every question within two working days, by email or phone.",
            },
          ],
        }}
        files={noFiles}
      />,
    );
    const region = screen.getByRole("region", { name: "Changes" });
    const items = within(region).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "B7 changedRow 7, “Qty”Before: 12 → , after: 14",
      "Paragraph changedUnder “Pricing”BeforeWe charge ten euros a month for each seat, billed yearly.AfterWe charge twelve euros a month for each seat, billed yearly.",
      "Heading “FAQ” added",
      // One side only: its text alone, with no Before or After label.
      "Paragraph addedUnder “FAQ”Ask us.",
      "Paragraph removedUnder “FAQ”We answer every question within two working days, by email or phone.",
    ]);
    // Only the paragraph with both sides carries the labels.
    expect(within(region).getAllByText("Before")).toHaveLength(1);
    expect(within(region).getAllByText("After")).toHaveLength(1);
    // No file changed: no file rows.
    expect(within(region).queryByText(/^File /)).toBeNull();
  });

  it("shows text that looks like markup as text, never as markup", () => {
    const { container } = render(
      <ChangeList
        changes={{
          truncated: false,
          items: [
            {
              kind: "added",
              where: "",
              what: "Text added",
              after: '<img src=x onerror="alert(1)">',
            },
          ],
        }}
        files={null}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
  });

  it("says when nothing changed, when the list is cut, and while it is worked out", () => {
    const { rerender } = render(<ChangeList changes={null} files={null} />);
    expect(screen.getByRole("region", { name: "Changes" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Working out what changed…")).toBeTruthy();
    rerender(<ChangeList changes={{ items: [], truncated: false }} files={null} />);
    expect(screen.getByText("Nothing changed in the content.")).toBeTruthy();
    rerender(
      <ChangeList
        changes={{ items: [{ kind: "changed", where: "", what: "Text changed" }], truncated: true }}
        files={null}
      />,
    );
    expect(screen.getByText("More changed than this list shows.")).toBeTruthy();
  });

  it("lists added, removed and replaced files as rows of the list, and counts the rest", () => {
    render(
      <ChangeList
        changes={{ items: [], truncated: false }}
        files={{
          added: [{ path: "img/new.png", kind: "added", after: 12_400 }],
          removed: [{ path: "old.css", kind: "removed", before: 820 }],
          replaced: [{ path: "chart.png", kind: "replaced", before: 1000, after: 3_100_000 }],
          more: 3,
          same: 1,
        }}
      />,
    );
    const region = screen.getByRole("region", { name: "Changes" });
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual([
      "File “img/new.png” added12.4 KB",
      "File “old.css” removed820 B",
      "File “chart.png” replaced1 KB → 3.1 MB",
    ]);
    expect(within(region).getByText("And 3 more files.")).toBeTruthy();
    expect(within(region).queryByText("Nothing changed in the content.")).toBeNull();
  });
});

describe("versionChanges", () => {
  it("describes two loaded versions by their type, with their files", () => {
    const a = detail({
      type: "doc",
      html: undefined,
      content: "# Plan\n\nOne.",
      source_path: "content.md",
      assets: [{ path: "a.png", size_bytes: 10, content_type: "image/png", sha256: null }],
    });
    const b = detail({
      type: "doc",
      html: undefined,
      content: "# Plan\n\nTwo.",
      source_path: "content.md",
      assets: [{ path: "a.png", size_bytes: 11, content_type: "image/png", sha256: null }],
    });
    expect(versionChanges(a, b)).toEqual({
      changes: {
        truncated: false,
        // "One." and "Two." share no content word: one paragraph removed, another added.
        items: [
          { kind: "removed", where: "Under “Plan”", what: "Paragraph removed", before: "One." },
          { kind: "added", where: "Under “Plan”", what: "Paragraph added", after: "Two." },
        ],
      },
      files: {
        added: [],
        removed: [],
        replaced: [{ path: "a.png", kind: "replaced", before: 10, after: 11 }],
        more: 0,
        same: 0,
      },
    });
  });

  it("lists a whiteboard's settings in the Board settings dialog's labels", () => {
    const board = (background: string, edit: string) =>
      detail({
        type: "whiteboard",
        html: undefined,
        content: JSON.stringify({ v: 1, background, edit }),
        source_path: "board.json",
      });
    const label = (list: readonly { value: string; label: string }[], v: string) =>
      list.find((c) => c.value === v)?.label;
    const { changes } = versionChanges(board("dots", "editors"), board("grid", "commenters"));
    expect(changes.items.map((i) => i.what)).toEqual([
      `Background: ${label(BACKGROUND_CHOICES, "dots")} → ${label(BACKGROUND_CHOICES, "grid")}`,
      `Who can change the board: ${label(EDIT_CHOICES, "editors")} → ${label(EDIT_CHOICES, "commenters")}`,
    ]);
    expect(changes.items.map((i) => i.what)).toEqual([
      "Background: Dots → Grid",
      "Who can change the board: Editors only → Commenters and editors",
    ]);
  });
});

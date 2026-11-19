import type { ArtifactDetail } from "@plinth/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
        heading="What changed from v1 to v2"
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
          ],
        }}
        files={noFiles}
      />,
    );
    const region = screen.getByRole("region", { name: "What changed from v1 to v2" });
    const items = within(region).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "~B7 changedRow 7, “Qty”Before: 12 → , after: 14",
      "~Paragraph changedUnder “Pricing”BeforeWe charge ten euros a month for each seat, billed yearly.AfterWe charge twelve euros a month for each seat, billed yearly.",
      "+Heading “FAQ” added",
    ]);
    expect(within(region).getByRole("heading", { name: "Files" })).toBeTruthy();
    expect(within(region).getByText("No files changed.")).toBeTruthy();
  });

  it("shows text that looks like markup as text, never as markup", () => {
    const { container } = render(
      <ChangeList
        heading="What changed"
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
    const { rerender } = render(<ChangeList heading="H" changes={null} files={null} />);
    expect(screen.getByRole("region", { name: "H" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Working out what changed…")).toBeTruthy();
    rerender(<ChangeList heading="H" changes={{ items: [], truncated: false }} files={null} />);
    expect(screen.getByText("Nothing changed in the content.")).toBeTruthy();
    rerender(
      <ChangeList
        heading="H"
        changes={{ items: [{ kind: "changed", where: "", what: "Text changed" }], truncated: true }}
        files={null}
      />,
    );
    expect(screen.getByText(/differ in more places than the list shows/)).toBeTruthy();
  });

  it("lists added, removed and replaced files with sizes, and counts the rest", () => {
    render(
      <ChangeList
        heading="H"
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
    const files = screen.getByRole("region", { name: "Files" });
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual(["Addedimg/new.png12.4 KB", "Removedold.css820 B", "Replacedchart.png1 KB → 3.1 MB"]);
    expect(within(files).getByText("And 3 more files. 1 file is the same in both.")).toBeTruthy();
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
        items: [
          {
            kind: "changed",
            where: "Under “Plan”",
            what: "Paragraph changed",
            before: "One.",
            after: "Two.",
          },
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
});

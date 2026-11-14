import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceDiff } from "./SourceDiff.tsx";

afterEach(cleanup);

describe("SourceDiff", () => {
  it("labels the diff with the content file of a doc", () => {
    const { container } = render(
      <SourceDiff
        from={1}
        to={2}
        fileName="content.md"
        oldHtml={"# Plan\n\nOne\n"}
        newHtml={"# Plan\n\nTwo\n"}
        oldAssets={[]}
        newAssets={[]}
      />,
    );
    expect(container.querySelector(".hx-file")?.textContent).toBe("content.md");
    expect(screen.getByRole("table", { name: "Changes to content.md from v1 to v2" })).toBeTruthy();
    expect(screen.getByText("Neither version has files besides content.md.")).toBeTruthy();
    expect(container.textContent).not.toContain("index.html");
  });

  it("says the content file is identical", () => {
    render(
      <SourceDiff
        from={1}
        to={2}
        fileName="content.md"
        sourceLabel="Markdown"
        oldHtml="# Same"
        newHtml="# Same"
        oldAssets={[]}
        newAssets={[]}
      />,
    );
    expect(screen.getByText(/The Markdown of/).textContent).toContain("is identical");
  });

  it("defaults to index.html for pages", () => {
    const { container } = render(
      <SourceDiff
        from={2}
        to={3}
        oldHtml="<p>a</p>"
        newHtml="<p>b</p>"
        oldAssets={[]}
        newAssets={[]}
      />,
    );
    expect(container.querySelector(".hx-file")?.textContent).toBe("index.html");
    expect(screen.getByRole("table", { name: "Changes to index.html from v2 to v3" })).toBeTruthy();
    expect(screen.getByText("Neither version has files besides index.html.")).toBeTruthy();
  });
});

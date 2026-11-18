import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactCard, ArtifactRow } from "./ArtifactRow.tsx";

afterEach(cleanup);

const NOW = Date.parse("2026-11-14T12:00:00Z");

const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: "art1",
  slug: "plan",
  title: "Release plan",
  type: "html",
  visibility: "allowlist",
  current_version: 2,
  version_count: 2,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/plan",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  ...over,
});

function badges(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll(".pl-badge"), (b) => b.textContent ?? "");
}

describe("ArtifactRow and ArtifactCard", () => {
  for (const [name, View] of [
    ["row", ArtifactRow],
    ["card", ArtifactCard],
  ] as const) {
    it(`shows the Doc badge on a doc's ${name}`, () => {
      const { container } = render(
        <ul>
          <View artifact={summary({ type: "doc" })} now={NOW} />
        </ul>,
      );
      const item = container.querySelector("li") as HTMLElement;
      expect(badges(item)).toEqual(["Doc"]);
      expect(within(item).getByText("Doc")).toBeTruthy();
    });

    it(`shows no type badge on an HTML page's ${name}`, () => {
      const { container } = render(
        <ul>
          <View artifact={summary()} now={NOW} />
        </ul>,
      );
      const item = container.querySelector("li") as HTMLElement;
      expect(badges(item)).toEqual([]);
      expect(within(item).queryByText("Doc")).toBeNull();
    });
  }
});

describe("ArtifactCard thumbnail", () => {
  const URL_V2 = "http://app.localhost:8787/api/v1/artifacts/art1/thumbnail?version=2";
  const card = (over: Partial<ArtifactSummary> = {}) => {
    const { container } = render(
      <ul>
        <ArtifactCard artifact={summary(over)} now={NOW} />
      </ul>,
    );
    const thumb = container.querySelector(".pl-dash__thumb") as HTMLElement;
    return {
      thumb,
      img: () => thumb.querySelector("img"),
      placeholder: () => thumb.querySelector(".pl-dash__paper"),
    };
  };

  it("shows only the placeholder when the instance takes no thumbnails", () => {
    const c = card({ thumbnail_url: null });
    expect(c.img()).toBeNull();
    expect(c.placeholder()?.textContent).toContain("RP");
  });

  it("keeps the placeholder until the image loads, then shows the image", () => {
    const c = card({ thumbnail_url: URL_V2 });
    const img = c.img() as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(URL_V2);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.hasAttribute("data-loaded")).toBe(false);
    expect(c.placeholder()).not.toBeNull();
    fireEvent.load(img);
    expect(c.img()?.hasAttribute("data-loaded")).toBe(true);
    expect(c.placeholder()).toBeNull();
  });

  it("falls back to the placeholder when the image fails (no capture yet)", () => {
    const c = card({ thumbnail_url: URL_V2 });
    fireEvent.error(c.img() as HTMLImageElement);
    expect(c.img()).toBeNull();
    expect(c.placeholder()).not.toBeNull();
  });
});

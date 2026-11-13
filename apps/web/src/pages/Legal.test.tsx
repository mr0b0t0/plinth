import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGAL_DOC_IDS, LEGAL_DOCS } from "../components/viewer/legalDocs.tsx";
import { stubApi } from "../components/viewer/test-utils.ts";
import Legal from "./Legal.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Legal", () => {
  it.each(LEGAL_DOC_IDS)("renders %s as a marked template naming the operator", (doc) => {
    stubApi();
    render(<Legal params={{ doc }} />);
    expect(screen.getByRole("heading", { level: 1, name: LEGAL_DOCS[doc].title })).toBeTruthy();
    expect(
      screen.getByText("Template — not legal advice; the operator must replace this text."),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("Aconite Software & Investments, Lda.");
    expect(document.title).toBe(`${LEGAL_DOCS[doc].title} · Plinth`);
  });

  it("covers the DSA and GDPR headings an EU host needs", () => {
    const headings = (id: keyof typeof LEGAL_DOCS) => LEGAL_DOCS[id].sections.map((s) => s.heading);
    expect(headings("terms")).toContain("Notice and action (Digital Services Act)");
    expect(headings("privacy")).toEqual(
      expect.arrayContaining(["Controller", "Data we process", "Your rights"]),
    );
    expect(headings("acceptable-use")).toContain("Reporting content");
  });

  it("is not found for any other document", async () => {
    stubApi();
    render(<Legal params={{ doc: "cookies" }} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
